/**
 * ClawEmail 后端 — 封装 @clawemail/node-sdk + mail-cli
 *
 * SDK 提供：读、写、回复、附件下载、WebSocket 推送
 * mail-cli 提供：列表、搜索、移动、标记（CLI 不返回正文）
 *
 * 不提供：转发（SDK 没有 forward 命令，CLI 也没有）
 */

import { MailClient } from "@clawemail/node-sdk";
import { spawn } from "node:child_process";
import path from "node:path";

// ── mail-cli 子进程封装 ─────────────────────────────────

// Windows 上 .cmd 文件需要 cmd.exe /c 调用，否则 spawn 会报 EINVAL 或参数解析错
// spawn("cmd.exe", ["/c", MAIL_CLI, ...args]) 是最可靠的模式
const MAIL_CLI = "mail-cli.cmd";

// Windows 上 mail-cli/agently-cli 是 .cmd 文件
// 必须用 shell: true + 完整命令字符串，避免 cmd.exe /c 的二次参数解析问题
function runMailCli(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    // 用空格连接参数，转义参数中的双引号
    const escapedArgs = args.map(a => {
      if (a.includes(' ') || a.includes('"')) {
        return `"${a.replace(/"/g, '\\"')}"`;
      }
      return a;
    });
    const cmd = `mail-cli.cmd --json ${escapedArgs.join(' ')}`;
    const proc = spawn(cmd, {
      encoding: "utf-8",
      timeout,
      windowsHide: true,
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`mail-cli exit ${code}: ${stderr.trim()}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`mail-cli JSON parse failed: ${stdout.slice(0, 100)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`spawn mail-cli failed: ${err.message}`));
    });
  });
}

// ── MailClient 工厂 ────────────────────────────────────

function createClient(apiKey, user, logger = null) {
  return new MailClient({
    apiKey,
    user,
    logger: logger || {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}

// ── 列表/搜索（用 mail-cli） ───────────────────────────

export async function listMessages(fid = "1", options = {}) {
  const { from, subject, keyword, limit = 20, since, before, unread, fts } = options;
  const args = ["mail", "list", `--fid=${fid}`, `--limit=${limit}`];
  if (from) args.push(`--from=${from}`);
  if (subject) args.push(`--subject=${subject}`);
  if (keyword) args.push(`--keyword=${keyword}`);
  if (since) args.push(`--since=${since}`);
  if (before) args.push(`--before=${before}`);
  if (unread) args.push("--unread");
  if (fts) args.push("--fts");

  const result = await runMailCli(args);
  return result.data || [];
}

export async function searchMessages(keyword, options = {}) {
  const { from, subject, since, before, unread, limit = 20 } = options;
  const args = ["mail", "search", `--fid=${options.fid || "1"}`, `--keyword=${keyword}`, `--limit=${limit}`];
  if (from) args.push(`--from=${from}`);
  if (subject) args.push(`--subject=${subject}`);
  if (since) args.push(`--since=${since}`);
  if (before) args.push(`--before=${before}`);
  if (unread) args.push("--unread");

  const result = await runMailCli(args);
  return result.data || [];
}

export async function listFolders() {
  return new Promise((resolve, reject) => {
    const proc = spawn("mail-cli.cmd folder list", {
      encoding: "utf-8",
      timeout: 10000,
      windowsHide: true,
      shell: true,
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`mail-cli folder list failed`));
      const lines = stdout.split("\n").filter(l => l.trim());
      const folders = lines.map(line => {
        const match = line.match(/^(\d+)\s+(.+?)(?:\s+unread=(\d+))?$/);
        if (match) {
          return { id: match[1], name: match[2], unread: parseInt(match[3] || "0") };
        }
        return { raw: line };
      });
      resolve(folders);
    });
    proc.on("error", reject);
  });
}

// ── 读取邮件（用 SDK） ─────────────────────────────────

export async function readMessage(apiKey, user, messageId, options = {}) {
  const { markRead = false } = options;
  const client = createClient(apiKey, user);
  return await client.mail.read({ id: messageId, markRead });
}

export async function downloadAttachment(apiKey, user, messageId, partId, outputPath) {
  const client = createClient(apiKey, user);
  const att = await client.mail.getAttachment({ id: messageId, part: partId });
  await att.writeFile(outputPath);
  return {
    filename: att.filename,
    contentType: att.contentType,
    size: att.size,
    outputPath,
  };
}

// ── 发送/回复（用 SDK） ───────────────────────────────

export async function sendMail(apiKey, user, options) {
  const { to, cc, bcc, subject, body, html = false, priority = 3, attachments = [] } = options;
  if (!to || to.length === 0) throw new Error("sendMail: 'to' is required");
  if (!subject) throw new Error("sendMail: 'subject' is required");
  if (!body) throw new Error("sendMail: 'body' is required");

  const client = createClient(apiKey, user);
  return await client.mail.send({
    to: Array.isArray(to) ? to : [to],
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
    subject,
    body,
    html,
    priority,
    attachments: attachments.map(a => ({
      filename: a.filename || path.basename(a.path),
      path: a.path,
      contentType: a.contentType,
    })),
  });
}

export async function replyToMail(apiKey, user, messageId, options) {
  const { body, html = false, toAll = false, cc, attachments = [] } = options;
  if (!body) throw new Error("replyToMail: 'body' is required");

  const client = createClient(apiKey, user);
  return await client.mail.reply({
    id: messageId,
    body,
    html,
    toAll,
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    attachments: attachments.map(a => ({
      filename: a.filename || path.basename(a.path),
      path: a.path,
      contentType: a.contentType,
    })),
  });
}

// ── 移动/标记（用 mail-cli） ──────────────────────────

export async function moveMessage(messageId, targetFid) {
  return runMailCli(["move", `--ids=${messageId}`, `--fid=${targetFid}`]);
}

export async function markRead(messageId, read = true) {
  return runMailCli(["mark", `--ids=${messageId}`, read ? "--read" : "--unread"]);
}

// ── 实时监听（用 SDK） ─────────────────────────────────

export function watch(apiKey, user, onMessage) {
  const client = createClient(apiKey, user);
  client.ws.onMessage(async ({ mailId }) => {
    if (onMessage) await onMessage(mailId);
  });
  client.ws.connect();

  return {
    disconnect: () => client.ws.disconnect(),
    isConnected: () => client.ws.isConnected(),
    client,
  };
}