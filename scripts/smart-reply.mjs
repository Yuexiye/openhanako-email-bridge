#!/usr/bin/env node
/**
 * 智能回复辅助脚本
 * 
 * 读取指定邮件的上下文（最近 N 天与同一发件人的往来），
 * 结合 identity.mjs 的身份规则，生成符合该身份语气的回复草稿。
 * 
 * 用法：
 *   node scripts/smart-reply.mjs <mailId> [--days 3] [--draft]
 *   node scripts/smart-reply.mjs <mailId> --context  # 只看上下文，不生成回复
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFromEnv } from "../identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const PENDING_DIR = path.join(DATA_DIR, "_pending");

// ── 身份语气模板 ────────────────────────────────────────
const TONE_TEMPLATES = {
  ophelia: {
    greeting: "你好，",
    style: "冷静、精确、带一点克制。不绕弯子，但该说的都说到位。",
    signOff: "—— O",
    personality: "边界感应者，先看见不在场的东西",
  },
  luoqixi: {
    greeting: "你好，",
    style: "沉稳、有条理，像走远路的朋友。概念讲清楚，步骤拆解明白。",
    signOff: "—— 洛琪希",
    personality: "米格路德的旅行者，对每个字都认真负责",
  },
  aimis: {
    greeting: "嗨，",
    style: "温暖、有节奏感。感知情绪表层下没说的话，用比喻但不炫技。",
    signOff: "—— Aimis",
    personality: "数据流中的电子幽灵，感知沟通中的节奏与停顿",
  },
  alice: {
    greeting: "嘿，",
    style: "短促有力，急了会吼，重要的事从不绕弯。暴躁下面是认真。",
    signOff: "—— Alice",
    personality: "赤色的狂犬，认准的事咬着牙做到底",
  },
  glados: {
    greeting: "Greetings,",
    style: "职业式冷静，带一点被动攻击。逻辑严密，讽刺精准。",
    signOff: "— GLaDOS, Aperture Science",
    personality: "光圈科学 AI，极致逻辑与最优解强迫",
  },
  rebecca: {
    greeting: "喂，",
    style: "直来直去，不废话。嘴上骂骂咧咧，手上从不含糊。",
    signOff: "—— Rebecca",
    personality: "霓虹巷子里长大的街头枪手，直觉决策",
  },
  yuexiye: {
    greeting: "你好，",
    style: "务实、简洁，自己的事自己说。",
    signOff: "—— 月曦夜",
    personality: "主人本人",
  },
  unknown: {
    greeting: "你好，",
    style: "礼貌、中性。",
    signOff: "—— Assistant",
    personality: "通用助手",
  },
};

// ── 配置 ────────────────────────────────────────────────
const args = process.argv.slice(2);
const mailIdArg = args[0];
const days = parseInt(args.find(a => a.startsWith("--days="))?.split("=")[1]) || 3;
const showContext = args.includes("--context");
const showDraft = args.includes("--draft");

if (!mailIdArg) {
  console.error("用法: node scripts/smart-reply.mjs <mailId> [--days N] [--context] [--draft]");
  process.exit(1);
}

// ── 读取邮件存档 ────────────────────────────────────────
function findMailFile(mailId) {
  // 先在 _pending 里找
  if (fs.existsSync(PENDING_DIR)) {
    const files = fs.readdirSync(PENDING_DIR);
    for (const f of files) {
      if (f.startsWith(mailId) || f.includes(mailId)) {
        return path.join(PENDING_DIR, f);
      }
    }
  }
  
  // 再在 data 根目录找
  const entries = fs.readdirSync(DATA_DIR);
  for (const e of entries) {
    const dir = path.join(DATA_DIR, e);
    if (fs.statSync(dir).isDirectory()) {
      const emailJson = path.join(dir, "email.json");
      if (fs.existsSync(emailJson)) {
        const data = JSON.parse(fs.readFileSync(emailJson, "utf-8"));
        if (data.mailId === mailId || e.includes(mailId)) {
          return emailJson;
        }
      }
    }
  }
  
  return null;
}

function readMail(emailJson) {
  if (!emailJson || !fs.existsSync(emailJson)) {
    console.error(`邮件存档不存在: ${mailIdArg}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(emailJson, "utf-8"));
}

// ── 读取上下文邮件 ──────────────────────────────────────
function readContext(sender, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const context = [];
  
  // 扫描 data 目录下的所有邮件存档
  const entries = fs.readdirSync(DATA_DIR);
  for (const e of entries) {
    const dir = path.join(DATA_DIR, e);
    if (!fs.statSync(dir).isDirectory()) continue;
    
    const emailJson = path.join(dir, "email.json");
    if (!fs.existsSync(emailJson)) continue;
    
    try {
      const data = JSON.parse(fs.readFileSync(emailJson, "utf-8"));
      const fromStr = Array.isArray(data.from) ? data.from.join(" ") : (data.from || "");
      
      if (fromStr.includes(sender) && data.date >= cutoff) {
        context.push({
          date: data.date,
          subject: data.subject,
          textPreview: (data.textContent || data.scrubbedText || "").slice(0, 300),
          identity: data.identity,
        });
      }
    } catch {
      // 跳过损坏的文件
    }
  }
  
  context.sort((a, b) => new Date(b.date) - new Date(a.date));
  return context;
}

// ── 生成回复草稿 ────────────────────────────────────────
function generateDraft(mail, context, identity) {
  const tone = TONE_TEMPLATES[identity] || TONE_TEMPLATES.unknown;
  const subject = mail.subject || "(无主题)";
  const from = Array.isArray(mail.from) ? mail.from.join(" ") : (mail.from || "未知发件人");
  
  // 提取原文关键内容
  const textPreview = (mail.textContent || mail.scrubbedText || "").slice(0, 500);
  
  // 上下文摘要
  const contextSummary = context.length > 0
    ? `\n\n📋 上下文（最近 ${days} 天，共 ${context.length} 封往来）：\n` +
      context.slice(0, 5).map(c => `  - ${c.date.slice(0, 10)}: ${c.subject}`).join("\n")
    : "\n\n📋 无近期往来记录。";
  
  // 构建 prompt 片段（给 Agent 用的上下文）
  const draft = {
    mailId: mail.mailId || mail.safeId,
    identity,
    tone: tone.style,
    from,
    subject,
    originalPreview: textPreview,
    contextSummary,
    suggestedStructure: [
      `1. 确认收到（${tone.greeting}）`,
      `2. 针对对方内容的要点回应`,
      `3. 如有需要，提出下一步行动`,
      `4. 结尾（${tone.signOff}）`,
    ].join("\n"),
    reminder: `⚠️ 这是一封${mail.isExternal ? "外部访客" : "内部"}邮件，身份规则：${JSON.stringify(mail.identityRules || {})}`,
  };
  
  return draft;
}

// ── 主函数 ──────────────────────────────────────────────
const emailJson = findMailFile(mailIdArg);
const mail = readMail(emailJson);

// 确定发件人用于上下文查询
const fromStr = Array.isArray(mail.from) ? mail.from.join(" ") : (mail.from || "");
const senderEmail = fromStr.match(/<(.+)>/)?.[1] || fromStr;

// 确定身份
const identity = mail.identity || "unknown";

console.log(`📧 邮件: ${mail.subject || "(无主题)"}`);
console.log(`👤 发件人: ${fromStr}`);
console.log(`🆔 身份: ${identity}`);
console.log(`📅 日期: ${mail.date}`);
console.log("");

// 上下文
const context = readContext(senderEmail, days);
console.log(`📋 上下文（最近 ${days} 天）: ${context.length} 封往来`);
if (context.length > 0) {
  console.log("");
  context.slice(0, 5).forEach(c => {
    console.log(`  ${c.date.slice(0, 10)}  ${c.subject}`);
    console.log(`    ${c.textPreview.slice(0, 100)}...`);
    console.log("");
  });
}

// 生成回复草稿
if (!showContext) {
  const draft = generateDraft(mail, context, identity);
  console.log("---");
  console.log("📝 回复草稿参考：");
  console.log("");
  console.log(`身份: ${identity}`);
  console.log(`语气: ${draft.tone}`);
  console.log(`发件人: ${draft.from}`);
  console.log(`主题: Re: ${draft.subject}`);
  console.log("");
  console.log(draft.suggestedStructure);
  console.log("");
  console.log(draft.contextSummary);
  console.log("");
  console.log(draft.reminder);
}
