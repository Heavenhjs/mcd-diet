/**
 * 价格获取：实时优先，失败降级本地参考均价
 *
 * 实测契约（calculate-price）：
 *   · 必填 storeCode / orderType(整数) / beType(整数)
 *   · orderType=1（到店）时**绝不能传 beCode**，传了直接报错
 *   · 返回 data.{productOriginalPrice, productPrice, originalPrice, discount, price, productList[]}
 *     所有金额单位是 **分**（1590 = ¥15.90），productList[].subtotal 是「单价×数量」
 *   · 售罄/不可售会返回 success:false, code=60006
 *
 * 单位处理规则（同时兼容两个接口）：
 *   整数值 → 分；带小数的值（如 query-order 的 "9.9"）→ 元。
 *   实测 calculate-price 全为整数（分），query-order 全为字符串小数（元）。
 *   可用 --price-unit fen|yuan|auto 强制覆盖。
 *
 * 限流友好：推荐集合只发 **一次** calculate-price 请求（批量带全部商品），
 * 从 productList 里按 productCode 取回每样的单价，而不是每样发一次。
 */

import { readFile } from 'node:fs/promises';
import { asNumber, asString, pickField, TOOLS, unwrapData, type ToolGateway } from './mcp.js';
import type { PriceInfo, Recommendation } from './types.js';
import { diceSimilarity, normalizeName } from './nutrition.js';

export type PriceUnit = 'auto' | 'fen' | 'yuan';

export interface PriceContext {
  gateway: ToolGateway;
  storeCode?: string;
  storeName?: string;
  /** 1=到店（含得来速），2=外送（含团餐） */
  orderType: number;
  beType: number;
  /** orderType=2 时必填 */
  beCode?: string;
  unit?: PriceUnit;
  verbose?: boolean;
  /** 本地参考均价文件路径 */
  baselinePath?: string;
}

/** 把原始金额换算成元 */
export function toYuan(raw: number, unit: PriceUnit = 'auto'): number {
  if (!Number.isFinite(raw)) return 0;
  const effective: 'fen' | 'yuan' =
    unit === 'auto' ? (Number.isInteger(raw) ? 'fen' : 'yuan') : unit;
  return effective === 'fen' ? raw / 100 : raw;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * 本地参考均价（降级兜底）
 * ------------------------------------------------------------------ */

interface BaselineFile {
  _note?: string;
  _asOf?: string;
  default?: number | null;
  items?: Record<string, number>;
}

const EMPTY_BASELINE: BaselineFile = { items: {}, default: null };

export async function loadBaseline(filePath: string): Promise<BaselineFile> {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text) as BaselineFile;
  } catch {
    return EMPTY_BASELINE;
  }
}

function baselineLookup(file: BaselineFile, name: string): number | null {
  const items = file.items ?? {};
  const target = normalizeName(name);
  if (!target) return file.default ?? null;

  let exact: number | null = null;
  let bestFuzzy: { score: number; value: number } | null = null;

  for (const [key, value] of Object.entries(items)) {
    if (typeof value !== 'number') continue;
    const k = normalizeName(key);
    if (!k) continue;
    if (k === target) {
      exact = value;
      break;
    }
    const d = diceSimilarity(k, target);
    if (d >= 0.85 && (!bestFuzzy || d > bestFuzzy.score)) bestFuzzy = { score: d, value };
  }

  if (exact !== null) return exact;
  if (bestFuzzy) return bestFuzzy.value;
  return file.default ?? null;
}

/* ------------------------------------------------------------------ *
 * calculate-price
 * ------------------------------------------------------------------ */

export interface PriceQueryItem {
  code: string;
  qty: number;
}

export interface PriceQueryResult {
  /** 订单/商品总金额（元） */
  total: number | null;
  /** 按 productCode 索引的单价（元） */
  perCode: Map<string, number>;
  /** 原始返回，便于调试 */
  raw: unknown;
  /** 失败原因（成功时为 undefined） */
  error?: string;
}

/** 构造 calculate-price 的入参（实测的必填与禁忌） */
export function buildPriceArgs(ctx: Pick<PriceContext, 'storeCode' | 'orderType' | 'beType' | 'beCode'>, items: PriceQueryItem[]): Record<string, unknown> {
  const args: Record<string, unknown> = {
    storeCode: ctx.storeCode,
    orderType: ctx.orderType,
    beType: ctx.beType,
    items: items.map((i) => ({ productCode: i.code, quantity: i.qty })),
    needTableware: false,
  };
  // 实测：到店(orderType=1) 传 beCode 会报错，必须省略
  if (ctx.orderType !== 1 && ctx.beCode) args.beCode = ctx.beCode;
  return args;
}

/** 调一次 calculate-price，拿回总价与每样单价 */
export async function queryPrices(ctx: PriceContext, items: PriceQueryItem[]): Promise<PriceQueryResult> {
  const perCode = new Map<string, number>();
  if (items.length === 0) return { total: null, perCode, raw: null };

  if (!ctx.storeCode) {
    return { total: null, perCode, raw: null, error: '缺少门店编码，无法实时询价' };
  }
  if (!ctx.gateway.isLive) {
    return { total: null, perCode, raw: null, error: '演示模式不做实时询价' };
  }

  const args = buildPriceArgs(ctx, items);
  if (ctx.verbose) console.error('[price] calculate-price 入参：', JSON.stringify(args));

  try {
    const raw = await ctx.gateway.callTool(TOOLS.calculatePrice, args);
    const data = unwrapData(raw);
    if (!data || typeof data !== 'object') {
      return { total: null, perCode, raw, error: '返回结构无法识别' };
    }
    const o = data as Record<string, unknown>;

    // 总价：优先 price / productPrice（实测为应付总额，单位分）
    const totalRaw =
      asNumber(pickField(o, ['price', 'productPrice', 'payablePrice', 'totalPrice'])) ??
      asNumber(pickField(o, ['productOriginalPrice', 'originalPrice']));
    const total = totalRaw === undefined ? null : toYuan(totalRaw, ctx.unit);

    // 每样单价：productList[].subtotal 是「单价×数量」
    const list = pickField(o, ['productList', 'productDetailList', 'items']);
    if (Array.isArray(list)) {
      for (const el of list) {
        if (!el || typeof el !== 'object') continue;
        const e = el as Record<string, unknown>;
        const code = asString(pickField(e, ['productCode', 'code', 'itemCode']));
        if (!code) continue;
        const qty = asNumber(pickField(e, ['quantity', 'qty'])) ?? 1;
        const sub =
          asNumber(pickField(e, ['subtotal', 'productSubtotal'])) ??
          asNumber(pickField(e, ['unitPrice', 'productPrice', 'price']));
        if (sub === undefined) continue;
        const yuan = toYuan(sub, ctx.unit);
        perCode.set(code, round2(qty > 1 ? yuan / qty : yuan));
      }
    }

    return { total: total === null ? null : round2(total), perCode, raw };
  } catch (err) {
    return { total: null, perCode, raw: null, error: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ *
 * 挂价格
 * ------------------------------------------------------------------ */

export interface AttachPricesOptions {
  /** 需要询价的推荐（通常只有 picked 那几条 + 少量候选） */
  recs: Recommendation[];
  ctx: PriceContext;
  baseline: BaselineFile;
  /** 最多对几条走实时询价（一次批量请求，不是一次一条） */
  maxLive?: number;
}

/**
 * 给推荐结果补价格，原地修改 rec.price。
 *
 * 只发一次 calculate-price（批量带全部待询价商品），
 * 超过 maxLive 条的部分直接用本地参考均价，避免打爆限流。
 */
export async function attachPrices(opts: AttachPricesOptions): Promise<{ live: number; baseline: number; unavailable: number; note: string }> {
  const { recs, ctx, baseline } = opts;
  const maxLive = opts.maxLive ?? 8;
  const unitLabel = ctx.unit && ctx.unit !== 'auto' ? `（强制按${ctx.unit === 'fen' ? '分' : '元'}解读）` : '（整数按分、小数按元）';

  const targets = recs.slice(0, maxLive);
  const result = await queryPrices(ctx, targets.map((r) => ({ code: r.code, qty: 1 })));

  const baselineNote = baseline._asOf ? `本地参考均价（基准 ${baseline._asOf}）` : '本地参考均价';
  let live = 0;
  let baselineCount = 0;
  let unavailable = 0;
  const notes: string[] = [];

  if (result.error) notes.push(`实时询价未成功：${result.error}`);

  for (const rec of recs) {
    const hit = result.perCode.get(rec.code);
    if (hit !== undefined && hit > 0) {
      rec.price = { amount: round2(hit), currency: 'CNY', source: 'mcp-live', note: `MCP calculate-price 实时价${unitLabel}` };
      live++;
      continue;
    }
    if (result.total !== null && recs.length === 1 && !rec.price.amount) {
      // 只有一样商品时，总价就是它的价
      rec.price = { amount: result.total, currency: 'CNY', source: 'mcp-live', note: `MCP calculate-price 实时价${unitLabel}` };
      live++;
      continue;
    }
    const fb = baselineLookup(baseline, rec.name);
    if (fb !== null) {
      rec.price = {
        amount: round2(fb),
        currency: 'CNY',
        source: 'baseline',
        note: ctx.gateway.isLive ? `${baselineNote}（该品未取到实时价，已降级）` : `${baselineNote}（演示模式）`,
      };
      baselineCount++;
    } else {
      rec.price = { amount: null, currency: 'CNY', source: 'unavailable', note: '实时与本地均价均不可得，不编造金额' };
      unavailable++;
    }
  }

  if (result.total !== null) notes.push(`推荐组合实时总价 ¥${result.total.toFixed(2)}`);

  return { live, baseline: baselineCount, unavailable, note: notes.join('；') };
}

/** 供 probe 用：打印关键 Tool 的 schema */
export function summarizeSchema(spec: { inputSchema?: Record<string, unknown> } | undefined): string {
  if (!spec) return '（未在 tools/list 中找到该 Tool）';
  const schema = spec.inputSchema;
  if (!schema) return '（该 Tool 未声明 inputSchema）';
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const lines = Object.keys(props).map((k) => {
    const p = props[k] as Record<string, unknown> | undefined;
    const desc = asString(p?.description);
    const short = desc ? ` — ${desc.split(/[\n。]/)[0]!.slice(0, 70)}` : '';
    return `    - ${k}${required.includes(k) ? ' (必填)' : ''}${short}`;
  });
  return ['  参数：', ...(lines.length ? lines : ['    (无)'])].join('\n');
}
