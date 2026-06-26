/**
 * AgentQQ CLI 轮询适配器
 * 
 * 通过 agently-cli 命令行工具轮询新邮件，输出格式与 ClawEmail 完全一致，
 * 可无缝接入 monitor.mjs 的统一处理管道。
 * 
 * 轮询间隔：60 秒（可通过 POLL_INTERVAL_SEC 环境变量覆盖）
 * 
 * 依赖：npm install -g @tencent-qqmail/agently-cli
 * 前置条件：agently-cli auth login 已完成 OAuth 授权
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────
const POLL_INTERVAL_SEC = parseInt(process.env.AGENTQQ_POLL_INTERVAL_SEC || "60", 10);
const AGENTQQ_ADDRESSES = (process.env.AGENTQQ_EXTRA_ADDRESSES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// AgentQQ 地址列表（+me 返回的主地址 + 额外地址）
function getAgentQQAddresses() {
  const addresses = [];
  try {
    // 通过 "+me" 获取主邮箱地址
    const result = execFileSync("agently-cli", ["+me"], { encoding: "utf-8", timeout: 15000 });
    const match = result.match(/邮箱地址\s+(\S+)\s+已授权/);
    if (match) {
      addresses.push(match[1]);
    }
  } catch (e) {
    console.warn("[AGENTQQ] 获取主邮箱失败:", e.message.slice(0, 100));
  }

  // 追加额外地址
  for (const addr of AGENTQQ_ADDRESSES) {
    if (!addresses.includes(addr)) {
      addresses.push(addr);
    }
  }

  return addresses;
}

// ── 解析 CLI 邮件列表输出 ───────────────────────────────
function parseMessageList(output) {
  const messages = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    // 格式：{"id":"msg_xxx","from":"xxx","to":"xxx","subject":"xxx","date":"xxx",...}
    const jsonMatch = line.match(/^\{.*\}$/);
    if (jsonMatch) {
      try {
        const msg = JSON.parse(jsonMatch[0]);
        if (msg.id) {
          messages.push(msg);
        }
      } catch {}
    }
  }

  return messages;
}

// ── 调用 CLI 拉取邮件 ───────────────────────────────────
function fetchMessages(address, limit = 10) {
  try {
    const result = execFileSync(
      "agently-cli",
      ["message", "+list", "--limit", String(limit)],
      { encoding: "utf-8", timeout: 30000 }
    );
    return parseMessageList(result);
  } catch (e) {
    console.warn(`[AGENTQQ] 拉取邮件失败 (${address}):`, e.message.slice(0, 100));
    return [];
  }
}

// ── 调用 CLI 读取邮件详情 ───────────────────────────────
function readMessage(msgId) {
  try {
    const result = execFileSync(
      "agently-cli",
      ["message", "+read", "--id", msgId],
      { encoding: "utf-8", timeout: 30000 }
    );
    // CLI 输出可能是 JSON 或格式化文本，尝试解析
    try {
      return JSON.parse(result);
    } catch {
      // 如果不是 JSON，返回原始文本
      return { raw: result, id: msgId };
    }
  } catch (e) {
    console.warn(`[AGENTQQ] 读取邮件失败 (${msgId}):`, e.message.slice(0, 100));
    return null;
  }
}

// ── 下载附件 ────────────────────────────────────────────
function downloadAttachment(msgId, attId, outputDir) {
  try {
    execFileSync(
      "agently-cli",
      ["attachment", "+download", "--msg", msgId, "--att", attId, "--output", outputDir],
      { encoding: "utf-8", timeout: 60000 }
    );
    return true;
  } catch (e) {
    console.warn(`[AGENTQQ] 附件下载失败 (${msgId}/${attId}):`, e.message.slice(0, 100));
    return false;
  }
}

// ── 轮询循环 ────────────────────────────────────────────
async function pollLoop(processCallback, identityMap) {
  const addresses = getAgentQQAddresses();
  
  if (addresses.length === 0) {
    console.warn("[AGENTQQ] 未检测到任何邮箱地址，请检查 CLI 是否已授权");
    return;
  }

  console.log(`[AGENTQQ] 检测到 ${addresses.length} 个邮箱地址`, addresses);

  // 已处理的邮件 ID 集合（按地址分片，避免跨地址冲突）
  const processed = new Map();
  for (const addr of addresses) {
    processed.set(addr, new Set());
  }

  while (true) {
    for (const address of addresses) {
      const addrProcessed = processed.get(address) || new Set();
      
      try {
        const messages = fetchMessages(address, 10);
        
        for (const msg of messages) {
          if (addrProcessed.has(msg.id)) continue;
          
          // 读取邮件详情
          const detail = readMessage(msg.id);
          if (!detail) continue;

          // 构建与 ClawEmail 一致的邮件对象
          const email = {
            id: msg.id,
            from: detail.from || msg.from || "",
            to: detail.to || address,
            subject: detail.subject || msg.subject || "",
            date: detail.date || msg.date || new Date().toISOString(),
            text: { content: detail.text?.content || detail.raw?.split("\n").slice(-5).join("\n") || "" },
            html: detail.html ? { content: detail.html?.content || "" } : null,
            attachments: detail.attachments || [],
            headers: detail.headers || {},
          };

          // 传递给统一处理管道
          await processCallback(email, address, "agentqq");
          
          addrProcessed.add(msg.id);
        }

        processed.set(address, addrProcessed);

      } catch (e) {
        console.error(`[AGENTQQ] 轮询 ${address} 失败:`, e.message.slice(0, 200));
      }
    }

    // 等待下一个轮询周期
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_SEC * 1000));
  }
}

// ── 导出 ────────────────────────────────────────────────
export {
  pollLoop,
  fetchMessages,
  readMessage,
  downloadAttachment,
  getAgentQQAddresses,
  parseMessageList,
};
