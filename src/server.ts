#!/usr/bin/env node
/**
 * 【附加入口】本地 Web 界面（零依赖）
 *
 * 这是 CLI 的一层「展示壳」，不重写任何业务逻辑：
 * 它把查询串翻译成 CLI 参数，调用 cli.ts 的 analyzeDiet()，
 * 再把 toJsonPayload() 的结果发给前端渲染。
 *
 * 因此网页上算出来的分数和终端里**必然是同一个**——
 * 94 项自检保护的也是同一份代码。
 *
 * 用法：
 *   npm run serve                 # 默认 http://127.0.0.1:5178
 *   node dist/server.js --port 3000
 *
 * 路由：
 *   GET /               单页界面
 *   GET /api/analyze    跑一次分析，返回 JSON
 *   GET /api/health     健康检查 + 是否配了 Token
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { analyzeDiet, loadDotEnv, parseArgs, PROJECT_ROOT, toJsonPayload } from './cli.js';
import { CLIENT_VERSION, McpError } from './mcp.js';

const HOST = process.env.MCD_WEB_HOST ?? process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.MCD_WEB_PORT ?? process.env.PORT ?? 5178);
const UI_FILE = path.join(PROJECT_ROOT, 'web', 'index.html');
const TMP_DIR = path.join(PROJECT_ROOT, 'out');

/* ------------------------------------------------------------------ *
 * 请求串行化
 *
 * fetchCatalog() 会往 out/cache/ 写文件。并发的两个请求同时写同一个缓存文件
 * 有互相截断的风险，所以这里用一条 promise 链把分析串起来。
 * 本工具是本地单机演示用途，串行的代价（每次约 1.7 秒）完全可以接受。
 * ------------------------------------------------------------------ */

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/* ------------------------------------------------------------------ *
 * 查询串 → CLI 参数
 * ------------------------------------------------------------------ */

/** 只放行这些参数，避免从网页端传入任意文件路径或环境变量。 */
function buildArgv(q: URLSearchParams): { argv: string[]; errors: string[] } {
  const argv: string[] = [];
  const errors: string[] = [];

  const str = (k: string): string | undefined => {
    const v = q.get(k);
    return v === null || v.trim() === '' ? undefined : v.trim();
  };
  const flag = (k: string, name: string): void => {
    const v = q.get(k);
    if (v !== null && v !== '' && v !== '0' && v !== 'false') argv.push(name);
  };

  const items = str('items');
  if (items) argv.push('--items', items);

  // 注意：orderJson 也是合法的输入来源，必须算进「有没有给输入」的判断里，
  // 否则粘贴了订单 JSON 也会被当成「什么都没填」而在解析之前就被拦下。
  const hasInlineOrder = Boolean(q.get('orderJson') && q.get('orderJson')!.trim());

  const fromHistory = str('fromHistory');
  if (fromHistory) {
    // --from-history 的计数是可选的，这里只在明确给了 >1 的值时才带上
    const n = Number(fromHistory);
    if (Number.isInteger(n) && n > 1) argv.push('--from-history', String(n));
    else argv.push('--from-history');
  }

  const goal = str('goal');
  if (goal) argv.push('--goal', goal);

  const meal = str('meal');
  if (meal) argv.push('--meal', meal);

  const store = str('store');
  if (store) argv.push('--store', store);

  const storeName = str('storeName');
  if (storeName) argv.push('--store-name', storeName);

  const city = str('city');
  const keyword = str('keyword');
  if (city) argv.push('--city', city);
  if (keyword) argv.push('--keyword', keyword);

  const top = str('top');
  if (top && Number.isInteger(Number(top))) argv.push('--top', top);

  const maxAdd = str('maxAdd');
  if (maxAdd && Number.isInteger(Number(maxAdd))) argv.push('--max-add', maxAdd);

  const minCoverage = str('minCoverage');
  if (minCoverage && !Number.isNaN(Number(minCoverage))) argv.push('--min-coverage', minCoverage);

  const orderType = str('orderType');
  if (orderType) argv.push('--order-type', orderType);

  const beType = str('beType');
  if (beType) argv.push('--be-type', beType);

  const beCode = str('beCode');
  if (beCode) argv.push('--be-code', beCode);

  // --set 允许重复（键=值，可写成 set=energy:500&set=sodium:600 或 set=energy=500）
  for (const raw of q.getAll('set')) {
    const normalized = raw.trim().replace(':', '=');
    if (normalized) argv.push('--set', normalized);
  }

  flag('allowRepeat', '--allow-repeat');
  flag('demo', '--demo');
  flag('refresh', '--refresh');

  // 网页端永远不写文件、不用 ANSI 颜色
  argv.push('--no-out', '--no-color');
  if (q.get('price') === '0' || q.get('price') === 'false') argv.push('--no-price');

  if (!items && !fromHistory && !hasInlineOrder) {
    errors.push('请填写「今天吃了什么」，或改为从历史订单读取');
  }
  if ((city && !keyword) || (!city && keyword)) {
    errors.push('--city 与 --keyword 必须成对提供');
  }

  return { argv, errors };
}

/* ------------------------------------------------------------------ *
 * 分析
 * ------------------------------------------------------------------ */

interface ApiOk {
  ok: true;
  data: Record<string, unknown>;
  elapsedMs: number;
}
interface ApiErr {
  ok: false;
  error: string;
  hint?: string;
  detail?: string[];
}

async function runAnalyze(q: URLSearchParams): Promise<{ status: number; body: ApiOk | ApiErr }> {
  const { argv, errors } = buildArgv(q);
  if (errors.length > 0) {
    return { status: 400, body: { ok: false, error: errors[0]!, detail: errors } };
  }

  // 粘贴订单 JSON：写到 out/ 下一个临时文件再让解析层按文件读，
  // 复用 parseOrderFile() 的全套字段容错，而不是在这里另写一套解析。
  const inlineJson = q.get('orderJson');
  let tmpFile: string | undefined;
  if (inlineJson && inlineJson.trim()) {
    try {
      JSON.parse(inlineJson);
    } catch (err) {
      return { status: 400, body: { ok: false, error: `订单 JSON 解析失败：${(err as Error).message}` } };
    }
    await mkdir(TMP_DIR, { recursive: true });
    tmpFile = path.join(TMP_DIR, `.web-order-${randomBytes(6).toString('hex')}.json`);
    await writeFile(tmpFile, inlineJson, 'utf8');
    argv.push('--order', tmpFile);
  }

  const started = Date.now();
  try {
    const { args, errors: argErrors } = parseArgs(argv);
    if (argErrors.length > 0) {
      return { status: 400, body: { ok: false, error: argErrors[0]!, detail: argErrors } };
    }

    const report = await serialize(() => analyzeDiet(args));
    return { status: 200, body: { ok: true, data: toJsonPayload(report), elapsedMs: Date.now() - started } };
  } catch (err) {
    if (err instanceof McpError) {
      return { status: 502, body: { ok: false, error: `MCP 接入失败：${err.message}`, hint: err.hint } };
    }
    return { status: 500, body: { ok: false, error: (err as Error).message } };
  } finally {
    if (tmpFile) await unlink(tmpFile).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '只支持 GET' });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      sendHtml(res, await readFile(UI_FILE, 'utf8'));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `读不到界面文件 ${UI_FILE}：${(err as Error).message}` });
    }
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: CLIENT_VERSION,
      hasToken: Boolean(process.env.MCD_MCP_TOKEN),
      mcpUrl: process.env.MCD_MCP_URL ?? 'https://mcp.mcd.cn',
    });
    return;
  }

  if (url.pathname === '/api/analyze') {
    const { status, body } = await runAnalyze(url.searchParams);
    sendJson(res, status, body);
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  sendJson(res, 404, { ok: false, error: `没有这个路由：${url.pathname}` });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function readPortArg(argv: string[]): number | undefined {
  const i = argv.indexOf('--port');
  if (i !== -1 && argv[i + 1] && Number.isInteger(Number(argv[i + 1]))) return Number(argv[i + 1]);
  return undefined;
}

async function main(): Promise<void> {
  await loadDotEnv(PROJECT_ROOT);
  await loadDotEnv(process.cwd());

  const port = readPortArg(process.argv.slice(2)) ?? PORT;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: (err as Error).message });
      else res.end();
    });
  });

  server.listen(port, HOST, () => {
    const address = `http://${HOST}:${port}`;
    console.log('');
    console.log(`  mcd-dev-diet v${CLIENT_VERSION} —— 膳食盘点与加餐推荐`);
    console.log('');
    console.log(`  界面地址：${address}`);
    console.log(`  数据通道：${process.env.MCD_MCP_TOKEN ? '麦当劳 MCP Server（实时）' : '未配 MCD_MCP_TOKEN —— 只能勾选「演示模式」'}`);
    console.log('');
    console.log('  Ctrl+C 停止');
    console.log('');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用，换一个：node dist/server.js --port 5179`);
    } else {
      console.error('服务启动失败：', err.message);
    }
    process.exitCode = 1;
  });
}

main().catch((err) => {
  console.error('未预料的错误：', err);
  process.exitCode = 1;
});
