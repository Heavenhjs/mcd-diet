/**
 * Web 界面冒烟测试（自启动服务，无外部依赖）
 *
 * 做两件事：
 *   1. 打通 HTTP 接口 —— 各输入模式、错误处理、静态资源
 *   2. 用真实接口数据驱动前端的 render() —— 验证页面真能画出东西
 *
 * 第 2 步是重点：只做语法检查不足以发现问题（比如 $('items') 取到 null，
 * 或 delta 忘了从 0~1 换算成「分」），必须真跑一遍渲染才看得出来。
 *
 * 用法：
 *   npm run test:ui              # 自动起服务、跑完自动关
 *   BASE=http://127.0.0.1:5178 npm run test:ui   # 打已有服务
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const PORT = Number(process.env.TEST_PORT ?? 5179);
const EXTERNAL = process.env.BASE;
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;

let child;
let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};

/* ---------------- 起服务 ---------------- */
async function waitForHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${timeoutMs} ms 内没等到 ${BASE}/api/health`);
}

if (!EXTERNAL) {
  child = spawn(process.execPath, ['dist/server.js', '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}

const cleanup = () => { if (child && !child.killed) child.kill(); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

/* ---------------- 1. 接口 ---------------- */
const api = (params) => fetch(`${BASE}/api/analyze?` + new URLSearchParams(params)).then((r) => r.json());

let health;
try {
  health = await waitForHealth();
  console.log(`\n服务就绪：${BASE}　Token=${health.hasToken ? '已配（实时）' : '未配（只能演示模式）'}\n`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log('一、HTTP 接口');

const r1 = await api({ items: '板烧鸡腿堡x1,冰美式中杯x1', goal: '减脂', meal: '午餐' });
ok('手输单品：返回成功', r1.ok === true, r1.ok ? `${r1.elapsedMs}ms` : r1.error);
if (r1.ok) {
  ok('手输单品：覆盖率 100%', r1.data.coverage === 1);
  ok('手输单品：两条餐品都识别到', r1.data.items.length === 2);
  ok('手输单品：有加餐建议', r1.data.recommendations.length > 0, `${r1.data.recommendations.length} 条`);
  ok('手输单品：价格是数字且有来源', typeof r1.data.recommendations[0].price.amount === 'number' &&
    ['mcp-live', 'baseline'].includes(r1.data.recommendations[0].price.source),
    r1.data.recommendations[0].price.source);
}

const r2 = await api({ items: '巨无霸x1', goal: '减脂', demo: '1' });
ok('演示模式：走本地快照', r2.ok && r2.data.context.source === 'demo');

const r3 = await api({ fromHistory: '1', goal: '减脂' });
ok('历史订单：返回成功', r3.ok === true, r3.ok ? `覆盖率 ${Math.round(r3.data.coverage * 100)}%` : r3.error);
if (r3.ok) {
  ok('历史订单：覆盖率不足时被抑制', r3.data.coverage < 0.5 ? r3.data.suppressed !== null : true,
    r3.data.suppressed ? '已拒答' : '覆盖率足够，正常出建议');
}

const r4 = await api({
  orderJson: JSON.stringify({ orderProductList: [{ productName: '巨无霸', quantity: 1 }, { productName: '中薯条', quantity: 1 }] }),
  goal: '减脂',
});
ok('粘贴订单 JSON：返回成功', r4.ok === true, r4.ok ? `score ${r4.data.score.score100}` : r4.error);
if (r4.ok) ok('粘贴订单 JSON：两项都识别到', r4.data.items.length === 2);

const r5 = await api({ items: '精选单人餐三件套x1', goal: '维持' });
ok('套餐：返回成功', r5.ok === true);
if (r5.ok) ok('套餐：拆成组成项后能算出营养', r5.data.items[0]?.facts?.energy > 0, `${r5.data.items[0]?.facts?.energy} kcal`);

const e1 = await api({ goal: '减脂' });
ok('空输入：报可读错误', e1.ok === false && /今天吃了什么/.test(e1.error), e1.error);

const e2 = await api({ orderJson: '{不是json' });
ok('非法 JSON：报解析错误', e2.ok === false && /JSON/.test(e2.error), e2.error);

const e3 = await api({ items: '巨无霸x1', city: '福州' });
ok('city 缺 keyword：参数校验拦截', e3.ok === false && /成对/.test(e3.error), e3.error);

const homeRes = await fetch(`${BASE}/`);
ok('首页可访问', homeRes.status === 200 && (await homeRes.text()).includes('mcd-dev-diet'));
const notFound = await fetch(`${BASE}/nope`);
ok('未知路由返回 404', notFound.status === 404);

/* ---------------- 2. 前端渲染 ---------------- */
console.log('\n二、前端渲染（用真实接口数据驱动 render）');

if (!r1.ok) {
  console.log('  跳过：上面接口没拿到数据');
} else {
  const captured = { html: [], listeners: [] };
  const makeEl = (id) => ({
    id, _html: '', value: '', checked: false, disabled: false, textContent: '', className: '', dataset: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; captured.html.push({ id, html: v }); },
    addEventListener(ev) { captured.listeners.push(`${id}:${ev}`); },
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() {},
  });
  const els = new Map();
  const document = {
    getElementById: (id) => (els.has(id) || els.set(id, makeEl(id)), els.get(id)),
    querySelector: (sel) => (/button\[aria-pressed="true"\]/.test(sel) ? { dataset: { v: '减脂' } } : null),
    addEventListener() {},
  };
  const sandbox = {
    document, window: {}, console, URLSearchParams, setTimeout, clearTimeout, Math, JSON, Number, String, Set, Boolean,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ json: async () => health }),
  };
  sandbox.globalThis = sandbox;

  const page = await readFile('web/index.html', 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok('页面里有 <script> 块', scripts.length > 0);

  const ctx = vm.createContext(sandbox);
  let loadErr;
  try { for (const js of scripts) new vm.Script(js).runInContext(ctx); } catch (err) { loadErr = err; }
  ok('脚本装载不抛错', !loadErr, loadErr?.message ?? '');
  ok('示例按钮已渲染', (els.get('chips')?._html ?? '').includes('chip'));

  const before = captured.html.length;
  const render = vm.runInContext('render', ctx);
  const data = r1.data;
  let renderErr;
  try { render(data, r1.elapsedMs); } catch (err) { renderErr = err; }
  ok('render() 不抛错', !renderErr, renderErr?.message ?? '');
  const out = captured.html.slice(before).map((x) => x.html).join('\n');

  ok('画出平衡分区块', out.includes('这顿的平衡分'));
  ok('画出营养盘点表', out.includes('营养盘点'));
  ok('画出吃了什么表', out.includes('这顿吃了什么'));
  ok('画出加餐建议', out.includes('还能加点啥'));
  ok('分数按 0~100 展示', out.includes(data.score.score100.toFixed(1)), String(data.score.score100));
  ok('delta 已换算成「分」而非 0~1 小数',
    !out.includes('+' + data.recommendations[0].delta.toFixed(2)) && out.includes('+' + (data.recommendations[0].delta * 100).toFixed(1)),
    `delta=${data.recommendations[0].delta} → +${(data.recommendations[0].delta * 100).toFixed(1)}`);
  ok('价格格式化为 ¥xx.xx', /¥\d+\.\d{2}/.test(out));
  ok('门店名已展示', out.includes(data.context.storeName));

  // 边界：无建议 / 拒答
  const noRec = { ...data, recommendations: [], removals: [], ranked: [], unknown: [{ name: '测试项', qty: 1 }] };
  const b2 = captured.html.length;
  let e4;
  try { render(noRec, 0); } catch (err) { e4 = err; }
  ok('无建议时不抛错', !e4, e4?.message ?? '');
  const out2 = captured.html.slice(b2).map((x) => x.html).join('\n');
  ok('无建议时提示转向减项', out2.includes('再加任何一样都会拉低平衡分'));
  ok('未匹配项单独提示', out2.includes('未匹配'));

  const sup = { ...data, recommendations: [], suppressed: { reason: '测试拒答原因' } };
  const b3 = captured.html.length;
  let e5;
  try { render(sup, 0); } catch (err) { e5 = err; }
  ok('拒答场景不抛错', !e5, e5?.message ?? '');
  ok('拒答原因已展示', captured.html.slice(b3).map((x) => x.html).join('\n').includes('测试拒答原因'));
}

/* ---------------- 汇总 ---------------- */
console.log('');
if (fails.length === 0) console.log(`全部通过：${pass} 项断言。\n`);
else {
  console.log(`${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
}
cleanup();
