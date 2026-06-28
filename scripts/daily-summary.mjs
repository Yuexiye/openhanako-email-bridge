#!/usr/bin/env node
/**
 * 每日邮件摘要 → 桌面通知
 * 
 * 扫描 data/_pending/ 和 data/_pending_send/，
 * 早上定时跑一次，弹一个总览通知。
 * 
 * 用法：
 *   node scripts/daily-summary.mjs          # 桌面通知
 *   node scripts/daily-summary.mjs --json   # JSON 输出（调试）
 *   node scripts/daily-summary.mjs --identity=ophelia  # 按身份过滤
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const PENDING_DIR = path.join(DATA_DIR, "_pending");
const PENDING_SEND_DIR = path.join(DATA_DIR, "_pending_send");

// ── 配置 ────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const identityFilter = args.find(a => a.startsWith("--identity="))?.split("=")[1];

// ── 读取待处理邮件 ──────────────────────────────────────
function readPendingMails() {
  if (!fs.existsSync(PENDING_DIR)) return [];
  const mails = [];
  for (const f of fs.readdirSync(PENDING_DIR).filter(f => f.endsWith(".json"))) {
    try {
      mails.push(JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), "utf-8")));
    } catch {}
  }
  return mails.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
}

function readPendingSends() {
  if (!fs.existsSync(PENDING_SEND_DIR)) return [];
  const sends = [];
  for (const f of fs.readdirSync(PENDING_SEND_DIR).filter(f => f.endsWith(".json"))) {
    try {
      sends.push(JSON.parse(fs.readFileSync(path.join(PENDING_SEND_DIR, f), "utf-8")));
    } catch {}
  }
  return sends.filter(s => s.status === "pending")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ── 生成摘要 ────────────────────────────────────────────
function generateSummary() {
  const pending = readPendingMails();
  const pendingSends = readPendingSends();
  
  // 按身份分组待收邮件
  const byIdentity = {};
  for (const mail of pending) {
    const id = mail.identity || "unknown";
    if (!byIdentity[id]) byIdentity[id] = [];
    byIdentity[id].push(mail);
  }
  
  // 过滤身份
  const groups = identityFilter 
    ? { [identityFilter]: byIdentity[identityFilter] || [] }
    : byIdentity;
  
  // 按账号分组待发送
  const sendsByAccount = {};
  for (const send of pendingSends) {
    const acc = send.account || "unknown";
    if (!sendsByAccount[acc]) sendsByAccount[acc] = [];
    sendsByAccount[acc].push(send);
  }
  
  return {
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    pendingMails: pending.length,
    pendingSends: pendingSends.length,
    byIdentity: Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, {
        count: v.length,
        urgent: v.filter(m => isUrgent(m)).length,
        codes: v.filter(m => isCode(m)).length,
      }])
    ),
    sendsByAccount: Object.fromEntries(
      Object.entries(sendsByAccount).map(([k, v]) => [k, v.length])
    ),
    groups,
    pendingSendsList: pendingSends,
  };
}

function isUrgent(mail) {
  const subject = (mail.subject || "").toLowerCase();
  const from = (mail.from || "").toLowerCase();
  return ["紧急", "urgent", "alert", "告警", "error", "fail"].some(k => 
    subject.includes(k) || from.includes(k));
}

function isCode(mail) {
  return /验证码|verification code|verify code/i.test(mail.textContent || "");
}

// ── 输出 ────────────────────────────────────────────────

function buildNotification(summary) {
  const parts = [];
  parts.push(`📧 邮件摘要 ${summary.date}`);
  parts.push("");
  parts.push(`待处理：${summary.pendingMails} 封`);
  
  if (summary.pendingSends > 0) {
    parts.push(`⏳ 待确认发送：${summary.pendingSends} 封`);
  }
  
  parts.push("");
  for (const [identity, stats] of Object.entries(summary.byIdentity)) {
    if (stats.count === 0) continue;
    let line = `${identity}: ${stats.count} 封`;
    if (stats.urgent > 0) line += ` 🔴${stats.urgent}`;
    if (stats.codes > 0) line += ` 🟡${stats.codes}`;
    parts.push(line);
  }
  
  return parts.join("\n");
}

function sendNotification(summary) {
  const message = buildNotification(summary);
  const title = `📬 助手邮箱摘要 ${summary.date}`;
  
  notifier.notify({
    title: title.slice(0, 60),
    message: message.slice(0, 200),
    sound: true,
    wait: false,
  });
  console.log("桌面通知已发送");
}

// ── 主函数 ──────────────────────────────────────────────
const summary = generateSummary();

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  sendNotification(summary);
}