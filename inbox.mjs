/**
 * inbox.mjs — 助手邮箱统一管理入口
 * 
 * 按目标 account 自动选 backend：
 *   - @claw.163.com → clawemail.js（SDK + mail-cli）
 *   - @agent.qq.com → agentqq.js（agently-cli）
 * 
 * 白名单逻辑（identity.mjs）：
 *   - 内部联系人（EMAIL_INTERNAL_CONTACTS）→ 直接发送
 *   - 外部 → 写入 _pending_send/ 队列，桌面通知确认
 * 
 * 用法（作为模块）：
 *   import { listMessages, readMessage, send, reply, ... } from "./inbox.mjs";
 * 
 * 用法（CLI）：
 *   node inbox.mjs list ophelia@claw.163.com [--limit=20]
 *   node inbox.mjs read ophelia@claw.163.com <messageId>
 *   node inbox.mjs send ophelia@claw.163.com --to=x@y.com --subject="..." --body="..."
 *   node inbox.mjs reply ophelia@claw.163.com <messageId> --body="..."
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFromEnv } from "./identity.mjs";
import * as clawemail from "./clawemail-backend.mjs";
import * as agentqq from "./agentqq-backend.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PENDING_SEND_DIR = path.join(DATA_DIR, "_pending_send");
const ENV_PATH = path.join(__dirname, ".env");

// ── 加载 .env ──────────────────────────────────────────

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// ── 后端选择 ────────────────────────────────────────────

/**
 * 根据邮箱地址选 backend
 */
function selectBackend(email) {
  if (!email) throw new Error("selectBackend: email is required");
  const lower = email.toLowerCase();
  if (lower.endsWith("@claw.163.com")) return "clawemail";
  if (lower.endsWith("@agent.qq.com")) return "agentqq";
  throw new Error(`selectBackend: unknown domain for ${email}`);
}

/**
 * 解析 account 配置（从 .env 映射中找 API Key）
 */
function resolveAccountConfig(email) {
  const apiKey = process.env.CLAWEMAIL_API_KEY;
  if (!apiKey) {
    throw new Error("CLAWEMAIL_API_KEY not set in .env");
  }
  return {
    backend: selectBackend(email),
    email,
    apiKey,
  };
}

// ── 账号配置缓存 ────────────────────────────────────────

const accountCache = new Map();

function getAccount(email) {
  if (accountCache.has(email)) return accountCache.get(email);
  const config = resolveAccountConfig(email);
  accountCache.set(email, config);
  return config;
}

// ── 白名单检查 ──────────────────────────────────────────

const awareness = buildFromEnv();

/**
 * 判断发件人是否需要确认
 * @param {object} email - 邮件对象 { from: "Name <addr@x.com>" }
 * @returns {boolean} true = 需要确认
 */
function needsConfirmation(email) {
  const from = Array.isArray(email.from) ? email.from.join(" ") : (email.from || "");
  const fromStr = from.toLowerCase();
  
  // 内部联系人白名单
  for (const contact of awareness.internalContacts) {
    if (fromStr.includes(contact.toLowerCase())) return false;
  }
  
  // 自己发的邮件（多个 account 互相发）
  const ownEmails = [
    process.env.CLAWEMAIL_ADDRESS,
    ...(process.env.CLAWEMAIL_EXTRA_ADDRESSES || "").split(",").map(s => s.trim()),
    ...(process.env.AGENTQQ_EXTRA_ADDRESSES || "").split(",").map(s => s.trim()),
  ].filter(Boolean).map(e => e.toLowerCase());
  
  for (const own of ownEmails) {
    if (fromStr.includes(own)) return false;
  }
  
  return true;
}

// ── 待发送队列（外部邮件确认用） ───────────────────────

function queuePendingSend(account, operation, targetEmail, payload) {
  fs.mkdirSync(PENDING_SEND_DIR, { recursive: true });
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(PENDING_SEND_DIR, `${id}.json`);
  const entry = {
    id,
    account,
    operation, // "send" | "reply" | "forward"
    targetEmail,
    payload,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return entry;
}

// ── 统一 API ───────────────────────────────────────────

/**
 * 列出邮件
 */
export async function listMessages(accountEmail, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.listMessages(options.fid || "1", options);
  }
  return await agentqq.listMessages(options);
}

/**
 * 搜索邮件
 */
export async function searchMessages(accountEmail, keyword, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.searchMessages(keyword, options);
  }
  return await agentqq.searchMessages(keyword, options);
}

/**
 * 读取邮件
 */
export async function readMessage(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.readMessage(config.apiKey, accountEmail, messageId, options);
  }
  return await agentqq.readMessage(messageId);
}

/**
 * 下载附件
 */
export async function downloadAttachment(accountEmail, messageId, partId, outputDir) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.downloadAttachment(config.apiKey, accountEmail, messageId, partId, outputDir);
  }
  return await agentqq.downloadAttachment(messageId, partId, outputDir);
}

/**
 * 发送邮件
 * @param {string} accountEmail - 发件账号
 * @param {object} options - { to, cc, bcc, subject, body, ... }
 * @param {object} context - { originalEmail } 外部邮件发送时需传入原文用于白名单判断
 * @returns {object} { sent: true, result } 或 { queued: true, queueId }
 */
export async function sendMail(accountEmail, options, context = {}) {
  const config = getAccount(accountEmail);
  
  // 白名单判断：只在回复/转发场景需要外部邮件判断
  // 主动发送不经过白名单（用户明确意图）
  if (context.originalEmail && needsConfirmation(context.originalEmail)) {
    const queueEntry = queuePendingSend(accountEmail, "send", options.to, options);
    return { queued: true, queueId: queueEntry.id, reason: "external_recipient" };
  }
  
  let result;
  if (config.backend === "clawemail") {
    result = await clawemail.sendMail(config.apiKey, accountEmail, options);
  } else {
    result = await agentqq.sendMail(options);
  }
  return { sent: true, result };
}

/**
 * 回复邮件
 * @param {string} accountEmail
 * @param {string} messageId
 * @param {object} options - { body, replyAll, ... }
 * @returns {object} { sent, result } 或 { queued, queueId }
 */
export async function reply(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  
  // 先读取原邮件判断白名单
  let originalEmail;
  try {
    originalEmail = await readMessage(accountEmail, messageId);
  } catch (e) {
    throw new Error(`reply: failed to read original email: ${e.message}`);
  }
  
  // 外部邮件 → 队列
  if (needsConfirmation(originalEmail)) {
    const queueEntry = queuePendingSend(accountEmail, "reply", messageId, options);
    return { queued: true, queueId: queueEntry.id, reason: "external_sender", originalEmail };
  }
  
  // 内部邮件 → 直接发
  let result;
  if (config.backend === "clawemail") {
    result = await clawemail.replyToMail(config.apiKey, accountEmail, messageId, options);
  } else {
    result = await agentqq.replyToMail(messageId, options);
  }
  return { sent: true, result };
}

/**
 * 转发邮件
 */
export async function forward(accountEmail, messageId, options = {}) {
  const config = getAccount(accountEmail);
  
  // 转发需要先读原邮件判断
  let originalEmail;
  try {
    originalEmail = await readMessage(accountEmail, messageId);
  } catch (e) {
    throw new Error(`forward: failed to read original email: ${e.message}`);
  }
  
  if (needsConfirmation(originalEmail)) {
    const queueEntry = queuePendingSend(accountEmail, "forward", options.to, { messageId, ...options });
    return { queued: true, queueId: queueEntry.id, reason: "external_sender", originalEmail };
  }
  
  let result;
  if (config.backend === "clawemail") {
    // ClawEmail SDK 没有 forward，回退到 send + 引用原邮件
    throw new Error("forward: ClawEmail backend does not support forward. Use reply or send instead.");
  } else {
    result = await agentqq.forwardMail(messageId, options);
  }
  return { sent: true, result };
}

/**
 * 移动邮件
 */
export async function moveMessage(accountEmail, messageId, targetFid) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.moveMessage(messageId, targetFid);
  }
  throw new Error("moveMessage: AgentQQ backend move not implemented (CLI limitation)");
}

/**
 * 标记已读/未读
 */
export async function markRead(accountEmail, messageId, read = true) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.markRead(messageId, read);
  }
  return await agentqq.markRead(messageId, read);
}

/**
 * 列出文件夹
 */
export async function listFolders(accountEmail) {
  const config = getAccount(accountEmail);
  if (config.backend === "clawemail") {
    return await clawemail.listFolders();
  }
  return await agentqq.listFolders();
}

// ── CLI 入口 ────────────────────────────────────────────

const COMMANDS = {
  list: async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    return await listMessages(email, opts);
  },
  search: async ([email, keyword, ...rest]) => {
    const opts = parseOptions(rest);
    return await searchMessages(email, keyword, opts);
  },
  read: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await readMessage(email, messageId, opts);
  },
  send: async ([email, ...rest]) => {
    const opts = parseOptions(rest);
    return await sendMail(email, opts);
  },
  reply: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await reply(email, messageId, opts);
  },
  forward: async ([email, messageId, ...rest]) => {
    const opts = parseOptions(rest);
    return await forward(email, messageId, opts);
  },
  move: async ([email, messageId, targetFid]) => {
    return await moveMessage(email, messageId, targetFid);
  },
  "mark-read": async ([email, messageId]) => {
    return await markRead(email, messageId, true);
  },
  folders: async ([email]) => {
    return await listFolders(email);
  },
};

function parseOptions(args) {
  const opts = {};
  for (const arg of args) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      opts[key] = val;
    }
  }
  return opts;
}

// Detect CLI mode: if this script is run directly (not imported)
const isCliMode = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCliMode) {
  const [cmd, ...args] = process.argv.slice(2);
  if (COMMANDS[cmd]) {
    try {
      const result = await COMMANDS[cmd](args);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Available: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(1);
  }
}