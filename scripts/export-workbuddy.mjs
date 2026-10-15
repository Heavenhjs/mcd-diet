#!/usr/bin/env node
/**
 * 把 WorkBuddy 会话记录导出成 workbuddy.md（麦当劳程序员节大赛 × WorkBuddy 专项奖励要求的文件）。
 *
 * 用法：
 *   node scripts/export-workbuddy.mjs <会话记录.jsonl> [输出路径]
 *
 * 会话记录一般在：
 *   <WorkBuddy 数据目录>/projects/<工作区 slug>/<sessionId>.jsonl
 *
 * 导出时会对 Token / 密钥 / 本机用户名做脱敏 —— 参赛声明的信息安全条款要求
 * 提交材料里不得出现真实凭证，而开发对话里往往聊过 Token。
 */
import fs from 'node:fs';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'workbuddy.md';

if (!SRC) {
  console.error('用法：node scripts/export-workbuddy.mjs <会话记录.jsonl> [输出路径]');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`找不到会话记录：${SRC}`);
  process.exit(1);
}

/* ---------- 脱敏 ---------- */
// 注意：不要用「长随机串一律脱敏」这种粗暴规则 —— 会话 ID 本身就是 36 位随机串，
// 而它恰恰是核验要用的字段。所以这里按「已知凭证字面量 + 凭证形态」定向脱敏。
const USER = process.env.USERNAME || process.env.USER || 'user';

/** 从 .env / 环境变量里收集真实凭证值，逐个按字面量脱敏 */
function collectSecrets() {
  const found = new Set();
  const envFiles = ['.env', '.env.local'];
  for (const f of envFiles) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/i.exec(line);
      if (m && m[2] && m[2].length >= 8) found.add(m[2].replace(/^["']|["']$/g, ''));
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|PASSWORD)/i.test(k) && typeof v === 'string' && v.length >= 8) found.add(v);
  }
  return [...found];
}

const SECRETS = [
  // 形如 Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer <REDACTED>'],
  // 常见凭证前缀
  [/\b(?:sk|pk|ghp|gho|github_pat|glpat|AKLT)[-_]?[A-Za-z0-9_-]{16,}/g, '<REDACTED-TOKEN>'],
  // 本机用户名
  [new RegExp(`Users[\\\\/]${USER}`, 'g'), 'Users/<user>'],
  // 从 .env 读到的真实值
  ...collectSecrets().map((s) => [new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<REDACTED-TOKEN>']),
];

const redact = (s) => {
  let out = String(s ?? '');
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
};

/* ---------- 读取 ---------- */
const rows = fs
  .readFileSync(SRC, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const textOf = (m) =>
  (Array.isArray(m.content) ? m.content : [])
    .filter((p) => p && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');

const stripInjected = (t) =>
  redact(t)
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<user-context[\s\S]*?<\/user-context>/g, '')
    .replace(/<identity_context>[\s\S]*?<\/identity_context>/g, '')
    .replace(/<memory>[\s\S]*?<\/memory>/g, '')
    .replace(/<wecom_[a-z_]+>[\s\S]*?<\/wecom_[a-z_]+>/g, '')
    .trim();

/** 只要用户真正敲进去的内容：优先取 <user_query>，否则剥掉注入的上下文块 */
const userText = (m) => {
  const raw = textOf(m);
  const qs = [...raw.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((x) => x[1].trim());
  if (qs.length) return redact(qs.join('\n\n'));
  return stripInjected(raw);
};

/* ---------- 统计 ---------- */
const msgs = rows.filter((r) => r.type === 'message');
const userMsgs = msgs
  .filter((m) => m.role === 'user')
  .map(userText)
  .filter((t) => t && !t.startsWith('<'));

const calls = rows.filter((r) => r.type === 'function_call');
const toolCount = {};
for (const c of calls) {
  const n = c.name || c.toolName || c.function?.name || '(unknown)';
  toolCount[n] = (toolCount[n] || 0) + 1;
}

const stamps = rows.map((r) => r.timestamp).filter((t) => typeof t === 'number');
const t0 = Math.min(...stamps);
const t1 = Math.max(...stamps);
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

const titles = rows.filter((r) => r.type === 'ai-title').map((r) => r.aiTitle);
const sid = rows.find((r) => r.sessionId)?.sessionId ?? '(未知)';

/* ---------- 生成 ---------- */
const L = [];
L.push('# WorkBuddy 开发对话上下文');
L.push('');
L.push('> 本文件由 WorkBuddy 会话记录自动导出，用于核验「麦当劳程序员节创意开发大赛 × WorkBuddy 专项奖励」的联动条件。');
L.push('> 导出前已对全部 Token / 密钥 / 本机用户名做脱敏处理。');
L.push('');
L.push('## 会话元信息');
L.push('');
L.push('| 项目 | 值 |');
L.push('| --- | --- |');
L.push(`| 会话 ID | \`${sid}\` |`);
L.push('| 使用工具 | WorkBuddy（CodeBuddy Agent） |');
if (titles.length) L.push(`| 会话主题 | ${titles.map((t) => `「${t}」`).join(' → ')} |`);
L.push(`| 开始时间 | ${fmt(t0)} |`);
L.push(`| 结束时间 | ${fmt(t1)} |`);
L.push(`| 用户输入轮次 | ${userMsgs.length} |`);
L.push(`| 工具调用次数 | ${calls.length} |`);
L.push('');
L.push('## 工具调用统计');
L.push('');
L.push('| 工具 | 调用次数 |');
L.push('| --- | --- |');
for (const [n, c] of Object.entries(toolCount).sort((a, b) => b[1] - a[1])) {
  L.push(`| \`${n}\` | ${c} |`);
}
L.push('');
L.push('## 对话正文');
L.push('');
let turn = 0;
for (const m of msgs) {
  if (m.role === 'user') {
    const t = userText(m);
    if (!t || t.startsWith('<')) continue;
    turn++;
    L.push(`### 用户 #${turn}`);
    L.push('');
    L.push('```text');
    L.push(t.slice(0, 4000));
    L.push('```');
    L.push('');
  } else if (m.role === 'assistant') {
    const t = redact(textOf(m)).trim();
    if (!t) continue;
    L.push('**WorkBuddy：**');
    L.push('');
    L.push(t.length > 6000 ? t.slice(0, 6000) + '\n\n…（本条回复过长，此处截断）' : t);
    L.push('');
  }
}

fs.writeFileSync(OUT, L.join('\n'), 'utf8');

const body = fs.readFileSync(OUT, 'utf8');
const leaked = SECRETS.some(([re]) => new RegExp(re.source).test(body));
console.log(`已写入 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`);
console.log(`用户轮次 ${userMsgs.length}，工具调用 ${calls.length}`);
console.log(leaked ? '⚠ 脱敏复查发现残留，请人工检查' : '✓ 脱敏复查通过');
if (leaked) process.exitCode = 1;
