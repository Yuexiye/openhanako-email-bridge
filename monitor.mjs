/**
 * hanako 邮件监听服务
 * 
 * 通过 ClawEmail WebSocket Push 实时接收新邮件通知（支持多账号），
 * 保存邮件内容到本地存档。事件驱动，无需 cron 轮询。
 * 
 * 运行方式：pm2 start ecosystem.config.cjs --name "email-monitor"
 * 
 * 多账号配置方式（.env）：
 *   CLAWEMAIL_API_KEY=...          # 共享 API Key
 *   CLAWEMAIL_ADDRESS=...          # 主账号
 *   CLAWEMAIL_EXTRA_ADDRESSES=...  # 额外账号，逗号分隔
 *   EMAIL_IDENTITY_MAP=...         # 访客意识映射，addr=identity,addr=identity
 *   EMAIL_INTERNAL_CONTACTS=...    # 内部联系人，逗号分隔
 */

import { MailClient } from "@clawemail/node-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import { buildFromEnv } from "./identity.mjs";

// ── 加载 .env（使用 dotenv，支持引号、注释、转义） ───────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(__dirname, ".env") });
} catch {
  // dotenv 未安装时 fallback 到简单解析
  const envFile = path.join(__dirname, ".env");
  try {
    const lines = fs.readFileSync(envFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // 去除引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {}
}

// ── 配置 ────────────────────────────────────────────────
function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`缺少环境变量 ${name}，请设置后重启`);
  return val;
}

const API_KEY = requireEnv("CLAWEMAIL_API_KEY");
const PRIMARY_EMAIL = requireEnv("CLAWEMAIL_ADDRESS");
const EXTRA_EMAILS = (process.env.CLAWEMAIL_EXTRA_ADDRESSES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// 构建账号列表，每个账号有 id 和 email
const ACCOUNTS = [
  { id: "default", email: PRIMARY_EMAIL },
  ...EXTRA_EMAILS.map(email => {
    const prefix = email.split("@")[0];
    const id = prefix.includes(".") ? prefix.split(".").pop() : prefix;
    return { id, email };
  }),
];

const CONFIG = {
  apiKey: API_KEY,
  homeEmail: process.env.CLAWEMAIL_HOME_EMAIL || "",
  dataDir: path.join(__dirname, "data"),
  // Token 刷新失败保护
  maxTokenRetries: 5,
  tokenRetryDelayMs: 5000,
  // 重连保护
  maxReconnectRetries: 10,
  reconnectBaseDelayMs: 2000,
  // 访客意识
  awareness: (() => {
    const awareness = buildFromEnv();
    // 兜底：把 ACCOUNTS 里的地址也自动纳入映射（如果 EMAIL_IDENTITY_MAP 没配）
    for (const acc of ACCOUNTS) {
      const lower = acc.email.toLowerCase();
      if (!awareness.map.has(lower)) {
        awareness.map.set(lower, acc.id.toLowerCase());
      }
    }
    return awareness;
  })(),
};

// ── 初始化 ─────────────────────────────────────────────
fs.mkdirSync(CONFIG.dataDir, { recursive: true });

const PENDING_DIR = path.join(CONFIG.dataDir, "_pending");
fs.mkdirSync(PENDING_DIR, { recursive: true });

// ── 日志 ────────────────────────────────────────────────
function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const entry = data ? `[${ts}] [${level}] ${msg} ${JSON.stringify(data)}` : `[${ts}] [${level}] ${msg}`;
  console.log(entry);
}

// ── 已处理记录（按账号分片，避免并发冲突） ──────────────
function getProcessedFile(accountId) {
  return path.join(CONFIG.dataDir, `_processed_${accountId}.json`);
}

function getProcessedSet(accountId) {
  try { return new Set(JSON.parse(fs.readFileSync(getProcessedFile(accountId), "utf-8"))); } catch { return new Set(); }
}

function saveProcessedSet(accountId, set) {
  fs.writeFileSync(getProcessedFile(accountId), JSON.stringify([...set]));
}

// ── 验证码提取 ────────────────────────────────────────
function extractCode(text) {
  const nearMatch = text.match(/验证码[是为：:]\s*(\d{4,8})/);
  if (nearMatch) return nearMatch[1];
  const anyMatch = text.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return anyMatch ? anyMatch[1] : null;
}

// ── 桌面通知（使用 node-notifier，避免命令注入） ────────
function desktopNotify(title, body) {
  try {
    notifier.notify({
      title: `📬 ${title.slice(0, 60)}`,
      message: body.slice(0, 200),
      sound: false,
      wait: false,
    });
  } catch (e) {
    log("WARN", "桌面通知发送失败", { err: e.message });
  }
}

// ── 延迟函数 ───────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 指数退避 ───────────────────────────────────────────
function exponentialBackoff(attempt, baseDelay) {
  return Math.min(baseDelay * Math.pow(2, attempt), 60000); // 最大 60 秒
}

// ── 邮件处理 ────────────────────────────────────────────
async function processNewEmail(client, mailId, accountEmail, accountId) {
  log("INFO", "收到新邮件通知", { mailId, account: accountId });

  // 去重（按账号分片）
  const processed = getProcessedSet(accountId);
  if (processed.has(mailId)) { log("INFO", "跳过已处理邮件"); return; }

  try {
    // 1. 读取邮件内容
    const email = await client.mail.read({ id: mailId, markRead: true });
    log("INFO", "已读取邮件", {
      from: email.from,
      subject: email.subject?.slice(0, 40),
      hasAttachments: !!email.attachments?.length,
    });

    // 2. 访客意识路由（按收件人身份分流 + 对外意识）
    const awareness = CONFIG.awareness;
    const { identity, rules, isExternal } = awareness.route(email, accountEmail);
    log("INFO", "访客意识路由", { identity, priority: rules.priority, isExternal });

    // 3. 对外意识：外部访客隐私过滤
    let scrubText = null;
    if (isExternal) {
      scrubText = awareness.scrub(email.text?.content || email.html?.content || "");
      log("INFO", "对外意识：已启用隐私脱敏", { identity });
    }

    // 4. 跳过自己发出的邮件
    const fromArr = Array.isArray(email.from) ? email.from : [email.from || ""];
    if (fromArr.some(f => f.includes(accountEmail))) {
      log("INFO", "跳过自己发出的邮件", { accountEmail, identity });
      processed.add(mailId); saveProcessedSet(accountId, processed);
      return;
    }

    const fromStr = fromArr.join(" ");
    const subjectStr = email.subject || "";
    const textContent = email.text?.content || email.html?.content || "";
    const effectiveText = scrubText || textContent;
    const isCodeWhitelist = /验证码|verification code|verify code/i.test(subjectStr);
    const isSystemNotification = /noreply@|no-reply@|notifications@/i.test(fromStr) ||
                                  /verify your email|please verify/i.test(subjectStr);

    // 5. 对外部系统通知（非验证码）直接跳过
    if (isExternal && isSystemNotification && !isCodeWhitelist) {
      log("INFO", "对外部系统通知，跳过", { identity });
      processed.add(mailId); saveProcessedSet(accountId, processed);
      return;
    }

    // 6. 内部邮件的系统通知跳过逻辑保持不变
    if (!isExternal && !isCodeWhitelist && (
        /noreply@|no-reply@|notifications@/i.test(fromStr) ||
        /verify your email|please verify/i.test(subjectStr))) {
      log("INFO", "跳过系统通知邮件");
      processed.add(mailId); saveProcessedSet(accountId, processed);
      return;
    }

    // 7. 保存邮件到本地存档（含身份标签 + 对外意识）
    const safeId = mailId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const emailDir = path.join(CONFIG.dataDir, safeId);
    fs.mkdirSync(emailDir, { recursive: true });
    fs.writeFileSync(path.join(emailDir, "email.json"), JSON.stringify({
      mailId, from: email.from, to: email.to,
      subject: email.subject, date: email.date,
      textContent,                  // 原始文本（本地完整保留）
      scrubbedText: scrubText,      // 脱敏文本（对外部邮件）
      hasHtml: !!email.html?.content,
      identity,
      identityRules: rules,
      isExternal,
      replyDecision: rules.shouldAutoReply ? "auto" : (rules.requireReply ? "manual" : "none"),
      autoTags: rules.autoTag,
      attachments: email.attachments?.map(a => ({
        id: a.id, filename: a.filename, contentType: a.contentType, size: a.size
      })),
    }, null, 2));

    // 8. 下载附件
    if (email.attachments?.length) {
      for (const att of email.attachments) {
        try {
          const stream = await client.mail.getAttachment({ id: mailId, part: att.id });
          await stream.writeFile(path.join(emailDir, att.filename || `attachment_${att.id}`));
          log("INFO", "附件已保存", { filename: att.filename });
        } catch (e) {
          log("WARN", "附件下载失败", { id: att.id, err: e.message });
        }
      }
    }

    // 9. 写入待处理队列（等 hanako 来取）
    const pendingFile = path.join(PENDING_DIR, `${safeId}.json`);
    fs.writeFileSync(pendingFile, JSON.stringify({
      mailId, safeId,
      from: fromStr,
      subject: email.subject,
      date: email.date,
      textContent,                  // 原始
      scrubbedText: scrubText,      // 脱敏（外部邮件）
      textPreview: effectiveText.slice(0, 200),
      identity,
      identityRules: rules,
      isExternal,
      replyDecision: rules.shouldAutoReply ? "auto" : (rules.requireReply ? "manual" : "none"),
      autoTags: rules.autoTag,
      emailDir,
      hasAttachments: !!(email.attachments?.length),
      receivedAt: new Date().toISOString(),
    }, null, 2));
    log("INFO", "已加入待处理队列", { pendingFile, replyDecision: rules.shouldAutoReply ? "auto" : (rules.requireReply ? "manual" : "none") });

    // 10. 标记已处理，清理待处理队列
    processed.add(mailId);
    saveProcessedSet(accountId, processed);
    try { fs.unlinkSync(pendingFile); } catch {}
    log("INFO", "邮件处理完成", { mailId, replyDecision: rules.shouldAutoReply ? "auto" : (rules.requireReply ? "manual" : "none") });

    // 11. 桌面通知（身份感知 + 对外意识脱敏）
    const senderName = fromStr.split("<")[0].trim() || "新邮件";
    let notifyBody;
    const previewSource = isExternal ? (scrubText || textContent) : textContent;
    if (isCodeWhitelist && textContent) {
      const code = extractCode(textContent);
      notifyBody = code
        ? `验证码：${code}`
        : `📧 ${email.subject || "(无主题)"}`;
    } else if (previewSource) {
      const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 80);
      notifyBody = `${email.subject || "(无主题)"}\n${preview}`;
    } else {
      notifyBody = `${email.subject || "(无主题)"}`;
    }

    // 身份感知：为通知加上身份前缀 + 外部访客标记
    const identityBadge = identity !== "unknown" ? `[${identity}]` : "[外部]";
    const externalBadge = isExternal ? "🔒" : "";
    desktopNotify(`${externalBadge}${identityBadge} ${senderName}`, notifyBody);

  } catch (e) {
    log("ERROR", "处理邮件失败", { mailId, err: e.message, stack: e.stack?.slice(0, 200) });
  }

  // 确保已处理记录持久化
  try { saveProcessedSet(accountId, getProcessedSet(accountId)); } catch {}
}

// ── 启动时扫描已有未读邮件 ──────────────────────
async function scanExistingUnread(client) {
  try {
    log("INFO", "扫描已有未读邮件...");
    const unread = await client.transport.listMessages({ fid: 1, unread: true, limit: 50 });
    if (unread.length === 0) { log("INFO", "没有未读邮件"); return; }
    log("INFO", "发现未读邮件", { count: unread.length });
    for (const msg of unread) {
      await processNewEmail(client, msg.id, client.user, client.accountId);
    }
  } catch (e) {
    log("WARN", "扫描未读邮件失败", { err: e.message });
  }
}

// ── 启动单个账号的监听（含重连逻辑） ────────────────────
async function startAccount(account) {
  let tokenRetryCount = 0;
  let reconnectRetryCount = 0;

  async function connectWithRetry() {
    while (true) {
      try {
        log("INFO", `[${account.id}] 正在连接 ${account.email} ...`);

        const client = new MailClient({
          user: account.email,
          apiKey: CONFIG.apiKey,
          logger: {
            info: (msg, data) => log("WS", `[${account.id}] ${msg}`, data && typeof data === "object" ? data : { msg: data }),
            warn: (msg, data) => log("WS_WARN", `[${account.id}] ${msg}`, data && typeof data === "object" ? data : { msg: data }),
            error: (msg, data) => log("WS_ERROR", `[${account.id}] ${msg}`, data && typeof data === "object" ? data : { msg: data }),
          },
        });

        // 挂载账号标识，方便后续使用
        client.accountId = account.id;

        // Token 获取（带重试保护）
        try {
          await client.getAccessToken();
          tokenRetryCount = 0; // 重置计数器
          log("INFO", `[${account.id}] MailClient 验证通过`);
        } catch (e) {
          tokenRetryCount++;
          if (tokenRetryCount > CONFIG.maxTokenRetries) {
            log("ERROR", `[${account.id}] Token 获取失败超过上限 (${CONFIG.maxTokenRetries} 次)，退出进程`, { err: e.message });
            process.exit(1);
          }
          const backoff = exponentialBackoff(tokenRetryCount, CONFIG.tokenRetryDelayMs);
          log("WARN", `[${account.id}] Token 获取失败 (第 ${tokenRetryCount} 次)，${backoff}ms 后重试...`);
          await delay(backoff);
          continue;
        }

        // 消息处理
        client.ws.onMessage(async (notification) => {
          if (notification?.mailId) {
            await processNewEmail(client, notification.mailId, account.email, account.id);
          }
        });

        // 断开重连（指数退避 + 上限）
        client.ws.onDisconnect(async (reason) => {
          log("WARN", `[${account.id}] WebSocket 断开: ${reason}`);
          reconnectRetryCount++;

          if (reconnectRetryCount > CONFIG.maxReconnectRetries) {
            log("ERROR", `[${account.id}] 重连次数超过上限 (${CONFIG.maxReconnectRetries} 次)，退出进程`);
            process.exit(1);
          }

          const backoff = exponentialBackoff(reconnectRetryCount, CONFIG.reconnectBaseDelayMs);
          log("INFO", `[${account.id}] 将在 ${backoff}ms 后尝试重连 (第 ${reconnectRetryCount}/${CONFIG.maxReconnectRetries} 次)...`);
          await delay(backoff);

          try {
            await client.ws.connect();
            reconnectRetryCount = 0; // 连接成功后重置
            log("INFO", `[${account.id}] 重连成功`);
          } catch (e) {
            log("ERROR", `[${account.id}] 重连失败`, { err: e.message });
            // 触发下一次 onDisconnect 循环
          }
        });

        await client.ws.connect();
        reconnectRetryCount = 0;
        log("INFO", `[${account.id}] ✅ WebSocket 推送已连接`);

        await scanExistingUnread(client);

        return client;

      } catch (e) {
        log("ERROR", `[${account.id}] 连接失败`, { err: e.message });
        const backoff = exponentialBackoff(reconnectRetryCount, CONFIG.reconnectBaseDelayMs);
        await delay(backoff);
      }
    }
  }

  return connectWithRetry();
}

// ── 主函数 ──────────────────────────────────────────────
async function main() {
  log("INFO", "=".repeat(50));
  log("INFO", `hanako 邮件监听服务启动`);
  log("INFO", `账号数: ${ACCOUNTS.length}`, { accounts: ACCOUNTS.map(a => a.id) });
  log("INFO", "访客意识映射", { map: Object.fromEntries(CONFIG.awareness.map) });
  log("INFO", "内部联系人", { contacts: Array.from(CONFIG.awareness.internalContacts) });

  // 多账号并行启动，互不阻塞
  const startResults = await Promise.allSettled(
    ACCOUNTS.map(account => startAccount(account))
  );

  const clients = [];
  for (let i = 0; i < startResults.length; i++) {
    const result = startResults[i];
    if (result.status === "fulfilled") {
      clients.push(result.value);
      log("INFO", `[${ACCOUNTS[i].id}] 启动成功`);
    } else {
      log("ERROR", `[${ACCOUNTS[i].id}] 启动失败`, { err: result.reason });
    }
  }

  if (clients.length === 0) {
    log("ERROR", "所有账号启动失败，退出");
    process.exit(1);
  }

  // 信号处理
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  // 未捕获异常：打日志后退出，让 PM2 重启
  process.on("uncaughtException", (e) => {
    log("ERROR", "未捕获异常", { err: e.message, stack: e.stack?.slice(0, 500) });
    process.exit(1);
  });

  // 未处理的 Promise 拒绝
  process.on("unhandledRejection", (reason, promise) => {
    log("ERROR", "未处理的 Promise 拒绝", { reason: String(reason) });
  });

  async function gracefulShutdown() {
    log("INFO", "正在停止服务...");
    for (const c of clients) {
      try { c.ws.disconnect(); } catch {}
    }
    log("INFO", "服务已停止");
    process.exit(0);
  }
}

main();
