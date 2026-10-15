/**
 * 订单输入解析
 *
 * 三种入口（对应需求里的「订单 JSON 或手输」）：
 *   1. 订单 JSON 文件 —— 直接吃 MCP query-order / order-list 的返回
 *   2. 手输文本 —— "巨无霸x1, 中薯条x1"
 *   3. 历史订单 —— 由 CLI 调 order-list 拉最近一单
 *
 * 实测两处坑，这里都做了统一：
 *   · order-list 的明细字段是 comboItemList[].{name, quantity}
 *   · query-order 的明细字段是 comboItemList[].{itemName, itemQuantity}
 *   同一个 MCP 的两个订单接口，套餐组成的键名居然不一样，必须都认。
 */

import { readFile } from 'node:fs/promises';
import { asNumber, asString, pickField, unwrapData } from './mcp.js';
import { normalizeName } from './nutrition.js';
import type { Component, OrderLine } from './types.js';

const ITEM_NAME_KEYS = [
  'productName', 'itemName', 'mealName', 'foodName', 'comboName', 'skuName', 'goodsName',
  'name', 'title', 'product', 'food', 'label',
  '餐品名称', '商品名称', '名称',
];

const ITEM_QTY_KEYS = [
  'quantity', 'itemQuantity', 'qty', 'num', 'count', 'number', 'productCount', 'buyCount', 'itemCount',
  '份数', '数量', '个数',
];

const ITEM_CODE_KEYS = [
  'productCode', 'itemCode', 'mealCode', 'foodCode', 'skuCode', 'spuCode', 'goodsCode',
  'code', 'sku', '商品编码', '餐品编码', '编码',
];

const COMBO_ITEM_KEYS = ['comboItemList', 'comboItems', 'childList', 'subItems', 'items', 'detailList'];

/* ------------------------------------------------------------------ *
 * 订单信封
 * ------------------------------------------------------------------ */

export interface OrderRecord {
  orderId?: string;
  storeCode?: string;
  storeName?: string;
  createTime?: string;
  orderType?: string;
  beType?: string;
  beCode?: string;
  orderStatus?: string;
  realTotalAmount?: string;
  productList: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

function toOrderRecord(obj: Record<string, unknown>): OrderRecord | null {
  const rawList = pickField(obj, ['orderProductList', 'productList', 'products', 'meals', 'items']);
  if (!Array.isArray(rawList)) return null;
  const productList = rawList.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
  if (productList.length === 0) return null;

  return {
    orderId: asString(pickField(obj, ['orderId', 'orderNo', 'orderCode', '订单号'])),
    storeCode: asString(pickField(obj, ['storeCode', 'storeId', '门店编码'])),
    storeName: asString(pickField(obj, ['storeName', 'store', '门店名称'])),
    createTime: asString(pickField(obj, ['createTime', 'orderTime', 'orderDate', 'payTime', '下单时间'])),
    orderType: asString(pickField(obj, ['orderType'])),
    beType: asString(pickField(obj, ['beType'])),
    beCode: asString(pickField(obj, ['beCode'])),
    orderStatus: asString(pickField(obj, ['orderStatus', 'status', '订单状态'])),
    realTotalAmount: asString(pickField(obj, ['realTotalAmount', 'totalAmount', 'payAmount', '实付金额'])),
    productList,
    raw: obj,
  };
}

/**
 * 从 order-list 的返回里取出订单记录数组。
 * 实测结构：{ success, data: { list: [ {orderId, orderProductList:[...]}, ... ] } }
 */
export function extractOrders(payload: unknown): OrderRecord[] {
  const data = unwrapData(payload);
  const out: OrderRecord[] = [];

  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, depth + 1);
      return;
    }
    const rec = toOrderRecord(node as Record<string, unknown>);
    if (rec) {
      out.push(rec);
      return; // 不再深入这个订单内部
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
  };

  walk(data, 0);
  return out;
}

/** 取最近一单（按 createTime 降序；没有时间就按返回顺序，MCP 已按时间倒序） */
export function pickLatestOrder(payload: unknown): OrderRecord | null {
  const orders = extractOrders(payload);
  if (orders.length === 0) return null;
  const withTime = orders.filter((o) => !!o.createTime);
  if (withTime.length === orders.length) {
    return [...orders].sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)))[0]!;
  }
  return orders[0]!;
}

/* ------------------------------------------------------------------ *
 * 明细解析
 * ------------------------------------------------------------------ */

/** 把 comboItemList 里的组成项统一成 Component */
function toComponents(obj: Record<string, unknown>): Component[] {
  const raw = pickField(obj, COMBO_ITEM_KEYS);
  if (!Array.isArray(raw)) return [];
  const out: Component[] = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object') continue;
    const c = el as Record<string, unknown>;
    const name = asString(pickField(c, ITEM_NAME_KEYS));
    if (!name) continue;
    const qty = asNumber(pickField(c, ITEM_QTY_KEYS));
    out.push({
      name,
      qty: qty !== undefined && qty > 0 ? Math.round(qty) : 1,
      code: asString(pickField(c, ITEM_CODE_KEYS)),
    });
  }
  return out;
}

function toOrderLine(obj: Record<string, unknown>, withComponents = true): OrderLine | null {
  const name = asString(pickField(obj, ITEM_NAME_KEYS));
  if (!name) return null;
  const qtyRaw = asNumber(pickField(obj, ITEM_QTY_KEYS));
  const qty = qtyRaw !== undefined && qtyRaw > 0 ? Math.round(qtyRaw) : 1;
  const components = withComponents ? toComponents(obj) : [];
  return {
    name,
    normName: normalizeName(name),
    code: asString(pickField(obj, ITEM_CODE_KEYS)),
    qty,
    components: components.length > 0 ? components : undefined,
    raw: obj,
  };
}

/**
 * 从订单负载里抽出点餐明细。
 *
 * 优先走「订单对象 → orderProductList」这条实测路径；
 * 若结构不认识，再退回通用的「最像商品明细的数组」启发式，保证自定义 JSON 也能吃。
 */
export function extractOrderLines(payload: unknown): OrderLine[] {
  const data = unwrapData(payload);

  // 路径 A：标准订单结构
  const orders = extractOrders(data);
  if (orders.length > 0) {
    const latest = pickLatestOrder(data) ?? orders[0]!;
    const lines = latest.productList.map((o) => toOrderLine(o)).filter((l): l is OrderLine => !!l);
    if (lines.length > 0) return mergeOrderLines(lines);
  }

  // 路径 B：直接给了一个商品数组（自定义 JSON / 手写 fixture）
  const collected: Record<string, unknown>[][] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objs = node.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length > 0) collected.push(objs);
      for (const el of node) walk(el, depth + 1);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
  };
  walk(data, 0);

  const scored = collected
    .map((arr) => {
      let score = 0;
      for (const o of arr) {
        if (asString(pickField(o, ITEM_NAME_KEYS)) === undefined) continue;
        score += 1;
        if (asNumber(pickField(o, ITEM_QTY_KEYS)) !== undefined) score += 2.5;
        if (asString(pickField(o, ITEM_CODE_KEYS)) !== undefined) score += 1.5;
      }
      return { arr, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const lines = scored[0]!.arr.map((o) => toOrderLine(o)).filter((l): l is OrderLine => !!l);
    if (lines.length > 0) return mergeOrderLines(lines);
  }

  // 路径 C：整个负载就是一个单品
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const single = toOrderLine(data as Record<string, unknown>);
    if (single) return [single];
  }

  return [];
}

/** 同名同编码的合并份数；带组成明细的优先保留明细 */
export function mergeOrderLines(lines: OrderLine[]): OrderLine[] {
  const map = new Map<string, OrderLine>();
  for (const l of lines) {
    const key = `${l.code ?? ''}::${l.normName}`;
    const prev = map.get(key);
    if (prev) {
      prev.qty += l.qty;
      if (!prev.components && l.components) prev.components = l.components;
    } else {
      map.set(key, { ...l });
    }
  }
  return [...map.values()];
}

/** 读订单 JSON 文件 */
export async function parseOrderFile(filePath: string): Promise<OrderLine[]> {
  const text = await readFile(filePath, 'utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`订单文件不是合法 JSON：${filePath}（${(err as Error).message}）`);
  }
  const lines = extractOrderLines(payload);
  if (lines.length === 0) {
    throw new Error(
      `没能从 ${filePath} 里识别出点餐明细。可直接使用 MCP query-order / order-list 的原始返回，` +
        `也接受简化结构：{"items":[{"productName":"巨无霸","quantity":1}]}`,
    );
  }
  return lines;
}

/**
 * 解析手输文本。
 *
 * 数量写法（重要）：
 *   ✅ "巨无霸x2" / "巨无霸×2" / "巨无霸*2" / "巨无霸 2"
 *   ⚠️ 直接写 "麦乐鸡5块" 会被当成一个菜名（qty=1），因为麦当劳确实有「麦乐鸡5块」这个商品，
 *      要两份请写 "麦乐鸡5块x2"。
 */
export function parseInlineItems(text: string): OrderLine[] {
  const tokens = text
    .split(/[,，、;；\n\r]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const lines: OrderLine[] = [];
  for (const token of tokens) {
    let name = token;
    let qty = 1;

    const explicit = token.match(/^(.+?)\s*[x×*]\s*(\d+)\s*(?:份|个|杯|块|只|盒|条|袋)?$/i);
    const spaced = token.match(/^(.+?)\s+(\d+)\s*(?:份|个|杯|块|只|盒|条|袋)?$/);

    if (explicit) {
      name = explicit[1]!.trim();
      qty = Number(explicit[2]);
    } else if (spaced) {
      name = spaced[1]!.trim();
      qty = Number(spaced[2]);
    }

    if (!name) continue;
    lines.push({ name, normName: normalizeName(name), qty: qty > 0 ? qty : 1 });
  }

  if (lines.length === 0) {
    throw new Error('没能从 --items 里解析出任何餐品。示例：--items "巨无霸x1,中薯条x1"');
  }
  return mergeOrderLines(lines);
}
