/**
 * 【核心文件 1 / 3】营养累加
 *
 * 职责：
 *   1. 把 MCP 返回的原始负载解析成干净的「营养记录」（含紧凑表格文本格式）
 *   2. 把订单项匹配到营养记录：目录命中 → 套餐按组成求和 → 名称精确 → 包含（唯一）→ 相似
 *   3. 逐项累加出这一顿的营养总量
 *
 * 铁律：匹配不上就记为 UNKNOWN，营养贡献按 0 计并显著标出，
 *      绝不用同类餐品、均值或常识去「补」一个数字。所有营养数值只可能来自 MCP。
 */

import {
  addFacts,
  emptyFacts,
  NUTRIENT_KEYS,
  type CandidateProduct,
  type Component,
  type MatchType,
  type MenuRecord,
  type NutritionFacts,
  type NutritionRecord,
  type OrderLine,
  type ResolvedLine,
} from './types.js';
import { asNumber, asString, collectObjectArrays, mergeHomogeneousArrays, pickField } from './mcp.js';
import { extractPackedTableText, parsePackedTable } from './packed.js';

/* ------------------------------------------------------------------ *
 * 名称归一化
 * ------------------------------------------------------------------ */

/**
 * 品牌噪声词。
 *
 * 注意：这里**故意不含「套餐 / 三件套 / 单人餐」这类词**。
 * 一旦剥掉，「牛气满满套餐」会和营养库里的「牛气满满」撞成同一条，
 * 于是套餐被当单品算 —— 这是最隐蔽的一类估算错误。
 */
const NOISE = /麦当劳|mcdonald'?s|™|®/g;

/** 量词：剥离后「麦乐鸡5块」与「5块麦乐鸡」才能对上 */
const UNITS = /[块个杯条根片袋只盒粒张份串]/g;
/** 规格词单独成桶，避免「小杯玉米杯」和「大杯玉米杯」混为一谈 */
const SIZES = /[中大迷你超大]/g;

const SIZE_RE = /[中大迷你超大]/g;

function toHalfWidth(input: string): string {
  return input
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 归一化名称 —— 这是全项目判定「是不是同一个东西」的唯一口径。
 *
 * 输出形如 `基名#数字#规格`，例如：
 *   麦乐鸡5块   → 麦乐鸡#5#
 *   5块麦乐鸡   → 麦乐鸡#5#
 *   麦乐鸡-5块  → 麦乐鸡#5#
 *   麦乐鸡4块   → 麦乐鸡#4#      ← 与上面区分开，不会互相推荐
 *   雪碧（小杯）→ 雪碧##小
 *   小杯玉米杯  → 玉米##小
 *   大杯玉米杯  → 玉米##大
 */
export function normalizeName(input: string): string {
  const lowered = toHalfWidth(input)
    .toLowerCase()
    .replace(/[\s\-_/\\.,，。、:：;；!！?？'"“”‘’()（）[\]【】{}<>·・×*+#&@~～]/g, '')
    .replace(NOISE, '');

  const numbers = (lowered.match(/\d+/g) ?? []).sort();
  const sizes = (lowered.match(SIZE_RE) ?? []).sort();
  const base = lowered
    .replace(/\d+/g, '')
    .replace(new RegExp(SIZE_RE.source, 'g'), '')
    .replace(UNITS, '');

  return `${base}#${numbers.join('.')}#${sizes.join('.')}`;
}

/** 只保留基名部分，用于包含匹配 */
function baseOf(key: string): string {
  return key.split('#')[0] ?? '';
}

/** 数字桶与规格桶 */
function bucketsOf(key: string): { nums: string; sizes: string } {
  const [, nums = '', sizes = ''] = key.split('#');
  return { nums, sizes };
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 0) return out;
  if (s.length === 1) {
    out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice 相似度，对中文短名（菜名）比编辑距离更稳 */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 名字看起来像不像一个「组合套餐」—— 这类名字禁止走相似/包含匹配 */
export function looksLikeCombo(name: string): boolean {
  return /(三件套|四件套|五件套|件套|套餐|随心选|随心配|双人餐|单人餐|分享餐|四宫格|全家桶|组合|拼盘|\d+\s*件)/.test(name);
}

/* ------------------------------------------------------------------ *
 * 字段读取
 * ------------------------------------------------------------------ */

/** 把一层嵌套对象里的原始字段摊平，兼容 { nutrition: { energy: ... } } 这类包装 */
function readingView(obj: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 === null || typeof v2 !== 'object') {
          view[k2] = v2;
          view[`${k}.${k2}`] = v2;
        }
      }
    }
  }
  return view;
}

const NAME_KEYS = [
  'productName', 'mealName', 'foodName', 'itemName', 'comboName', 'cnName', 'skuName',
  'name', 'title', 'food', 'product', 'label',
  '餐品名称', '商品名称', '名称', '菜品名称',
];

const CODE_KEYS = [
  'productCode', 'mealCode', 'itemCode', 'foodCode', 'skuCode', 'spuCode', 'goodsCode',
  'code', 'sku', 'id', '商品编码', '餐品编码', '编码',
];

const CALORIE_KEYS = ['energyKcal', 'kcal', 'calorie', 'calories', 'energy', '能量', '热量', '卡路里'];

/** 营养库实测列名 → 内部营养素键 */
const PACKED_COLUMN_MAP: Record<string, keyof NutritionFacts | 'energyKj'> = {
  energykcal: 'energy',
  kcal: 'energy',
  能量: 'energy',
  energykj: 'energyKj',
  protein: 'protein',
  蛋白质: 'protein',
  fat: 'fat',
  脂肪: 'fat',
  carbohydrate: 'carb',
  carbs: 'carb',
  碳水化合物: 'carb',
  sodium: 'sodium',
  钠: 'sodium',
  calcium: 'calcium',
  钙: 'calcium',
};

function readEnergy(
  view: Record<string, unknown>,
  defaultUnit: 'kj' | 'kcal',
): { kcal: number; unit: NutritionRecord['energyUnit'] } {
  const keys = Object.keys(view);

  // 1) 键名里显式带单位
  for (const k of keys) {
    const v = asNumber(view[k]);
    if (v === undefined) continue;
    if (/kj|千焦/i.test(k)) return { kcal: v / 4.184, unit: 'kJ-explicit' };
    if (/kcal|千卡|大卡/i.test(k)) return { kcal: v, unit: 'kcal' };
  }

  // 2) 值字符串里带单位
  for (const k of keys) {
    if (!CALORIE_KEYS.some((c) => k.toLowerCase().includes(c.toLowerCase()))) continue;
    const raw = view[k];
    const v = asNumber(raw);
    if (v === undefined) continue;
    const s = String(raw);
    if (/kj|千焦/i.test(s)) return { kcal: v / 4.184, unit: 'kJ-explicit' };
    if (/kcal|千卡|大卡/i.test(s)) return { kcal: v, unit: 'kcal' };
    // 3) 没有单位信息：按配置的默认口径处理，并在报告中明示
    return defaultUnit === 'kcal' ? { kcal: v, unit: 'kcal' } : { kcal: v / 4.184, unit: 'kJ-assumed' };
  }

  return { kcal: 0, unit: 'kcal' };
}

function readGram(view: Record<string, unknown>, keys: string[]): number {
  const v = asNumber(pickField(view, keys));
  return v === undefined ? 0 : v;
}

/* ------------------------------------------------------------------ *
 * 营养记录解析
 * ------------------------------------------------------------------ */

export interface ParseOptions {
  /**
   * 当营养数据的能量字段没有标明单位时采用的默认口径。
   * 麦当劳中国官方营养信息表以千焦(kJ)标示能量，故默认 'kj'。
   */
  energyUnitDefault?: 'kj' | 'kcal';
}

export interface NutritionParseResult {
  records: NutritionRecord[];
  /** 紧凑表格声明的行数（用于核对是否解析齐全） */
  declaredRows?: number;
  /** 数据通道形态，写进报告 */
  format: 'packed-table' | 'json-objects';
}

/**
 * 从 list-nutrition-foods 的返回里解析营养记录。
 *
 * 实测该 Tool 的 data 是「紧凑表格文本」，不是 JSON 对象数组，
 * 所以先尝试 packed 解析，再回退到结构遍历（兼容服务端改回 JSON 的情况）。
 */
export function parseNutritionRecordsDetailed(payload: unknown, opts: ParseOptions = {}): NutritionParseResult {
  const packedText = extractPackedTableText(payload);

  if (packedText) {
    const table = parsePackedTable(packedText);
    const records: NutritionRecord[] = [];
    const seen = new Set<string>();

    for (const row of table.rows) {
      const pick = (col: string): unknown => {
        const key = Object.keys(row).find((k) => k.toLowerCase() === col.toLowerCase());
        return key === undefined ? undefined : row[key];
      };

      const name = asString(pick('productName')) ?? asString(pick('name')) ?? asString(pick('餐品名称'));
      if (!name) continue;
      const normName = normalizeName(name);
      if (!normName || seen.has(normName)) continue; // 实测存在重名行（纯牛奶（盒装）出现两次）
      seen.add(normName);

      const facts = emptyFacts();
      let unit: NutritionRecord['energyUnit'] = 'kcal';
      let sawKcal = false;

      for (const [col, value] of Object.entries(row)) {
        const target = PACKED_COLUMN_MAP[col.toLowerCase().replace(/[\s_\-]/g, '')];
        if (!target) continue;
        const num = asNumber(value);
        if (num === undefined) continue;
        if (target === 'energy') {
          facts.energy = num;
          sawKcal = true;
        } else if (target === 'energyKj') {
          // 只有在没有 kcal 列时才回退用 kJ
          if (!sawKcal) {
            facts.energy = num / 4.184;
            unit = 'kJ-explicit';
          }
        } else {
          facts[target] = num;
        }
      }

      if (sawKcal) unit = 'kcal';
      records.push({ name, normName, facts, energyUnit: unit, raw: row as Record<string, unknown> });
    }

    return { records, declaredRows: table.declaredRows, format: 'packed-table' };
  }

  return { records: parseNutritionRecordsFromObjects(payload, opts), format: 'json-objects' };
}

function looksLikeNutritionRecord(obj: Record<string, unknown>): boolean {
  const view = readingView(obj);
  if (asString(pickField(view, NAME_KEYS)) === undefined) return false;
  const keyStr = Object.keys(view).join('|');
  const hits = [
    CALORIE_KEYS.some((c) => keyStr.toLowerCase().includes(c.toLowerCase())),
    /protein|蛋白质/i.test(keyStr),
    /fat|脂肪/i.test(keyStr),
    /carb|碳水/i.test(keyStr),
    /sodium|钠/i.test(keyStr),
    /calcium|钙/i.test(keyStr),
  ].filter(Boolean).length;
  return hits >= 2;
}

/** 兼容分支：服务端若把营养库改回 JSON 对象数组 */
export function parseNutritionRecordsFromObjects(payload: unknown, opts: ParseOptions = {}): NutritionRecord[] {
  const defaultUnit = opts.energyUnitDefault ?? 'kj';
  const arrays = collectObjectArrays(payload);
  const scored = arrays
    .map((arr) => ({ arr, hits: arr.filter((o) => looksLikeNutritionRecord(o)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.arr.length - a.arr.length);

  const chosen = scored.length > 0 ? mergeHomogeneousArrays(arrays, scored[0]!.arr) : arrays.flat();
  const records: NutritionRecord[] = [];
  const seen = new Set<string>();

  for (const obj of chosen) {
    const view = readingView(obj);
    const name = asString(pickField(view, NAME_KEYS));
    if (!name || !looksLikeNutritionRecord(obj)) continue;
    const normName = normalizeName(name);
    if (!normName || seen.has(normName)) continue;
    seen.add(normName);

    const energy = readEnergy(view, defaultUnit);
    const facts: NutritionFacts = {
      energy: energy.kcal,
      protein: readGram(view, ['protein', 'proteinG', 'proteinContent', '蛋白质', '蛋白质g']),
      fat: readGram(view, ['fat', 'fatG', 'fatContent', '脂肪', '脂肪g']),
      carb: readGram(view, ['carbohydrate', 'carbohydrates', 'carb', 'carbs', 'carbG', '碳水化合物', '碳水']),
      sodium: readGram(view, ['sodium', 'sodiumMg', 'sodiumContent', '钠', '钠mg']),
      calcium: readGram(view, ['calcium', 'calciumMg', 'calciumContent', '钙', '钙mg']),
    };

    records.push({
      code: asString(pickField(view, CODE_KEYS)),
      name,
      normName,
      facts,
      energyUnit: energy.unit,
      raw: obj,
    });
  }
  return records;
}

/** 旧签名保留，便于单测与外部调用 */
export function parseNutritionRecords(payload: unknown, opts: ParseOptions = {}): NutritionRecord[] {
  return parseNutritionRecordsDetailed(payload, opts).records;
}

/* ------------------------------------------------------------------ *
 * 菜单记录解析
 * ------------------------------------------------------------------ */

/**
 * 从 query-meals 解析菜单条目。
 *
 * 实测 meals[] 元素只有 { code, tags }，**没有 name**。
 * 所以这里不再要求 name，只要 code 就收；名称由 query-meal-detail 补齐。
 */
export function parseMenuRecords(payload: unknown): MenuRecord[] {
  const arrays = collectObjectArrays(payload);
  const scored = arrays
    .map((arr) => ({
      arr,
      hits: arr.filter((o) => asString(pickField(readingView(o), CODE_KEYS)) !== undefined).length,
    }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.arr.length - a.arr.length);

  // 菜单是 categories[].meals[] 嵌套，必须把所有同构数组合并，否则只会拿到第一个分类
  const chosen = scored.length > 0 ? mergeHomogeneousArrays(arrays, scored[0]!.arr) : [];
  const records: MenuRecord[] = [];
  const seen = new Set<string>();

  for (const obj of chosen) {
    const view = readingView(obj);
    const code = asString(pickField(view, CODE_KEYS));
    if (!code || seen.has(code)) continue;
    seen.add(code);

    const name = asString(pickField(view, NAME_KEYS));
    const rawTags = pickField(view, ['tags', 'tagList', 'labels', '标签', '标记']);
    const tags = Array.isArray(rawTags)
      ? rawTags
          .map((t) =>
            asString(t) ??
            (t && typeof t === 'object' ? asString(pickField(t as Record<string, unknown>, NAME_KEYS)) : undefined),
          )
          .filter((t): t is string => !!t)
      : [];

    records.push({
      code,
      name,
      normName: name ? normalizeName(name) : undefined,
      category: asString(pickField(view, ['category', 'categoryName', 'type', 'groupName', '分类', '类别'])),
      tags,
      raw: obj,
    });
  }

  return records;
}

/* ------------------------------------------------------------------ *
 * 索引与匹配
 * ------------------------------------------------------------------ */

export interface NutritionIndex {
  records: NutritionRecord[];
  byNorm: Map<string, NutritionRecord>;
  /** 因缺少单位信息而按默认口径处理的条数 */
  assumedUnitCount: number;
  /** 数据通道形态 */
  format: 'packed-table' | 'json-objects';
  declaredRows?: number;
}

export function buildNutritionIndex(records: NutritionRecord[], meta: { format?: NutritionIndex['format']; declaredRows?: number } = {}): NutritionIndex {
  const byNorm = new Map<string, NutritionRecord>();
  let assumedUnitCount = 0;

  for (const r of records) {
    if (r.energyUnit === 'kJ-assumed') assumedUnitCount++;
    if (!byNorm.has(r.normName)) byNorm.set(r.normName, r);
  }

  return { records, byNorm, assumedUnitCount, format: meta.format ?? 'json-objects', declaredRows: meta.declaredRows };
}

export interface MatchResult {
  matched: NutritionRecord | null;
  matchType: MatchType;
  confidence: number;
  /** 命中的营养库条目名（可能是变体，用于报告说明） */
  sourceName?: string;
}

export const DEFAULT_FUZZY_MIN = 0.75;

/**
 * 单条名称 → 营养记录。
 *
 * 分四道关卡，一道比一道宽松，但都有明确的不匹配出口：
 *   1. 归一化名称精确匹配
 *   2. 包含匹配 —— 只允许「营养库条目名更长且唯一」，且规格桶必须一致
 *      （「可乐」会同时命中 可乐中杯/大杯/小杯 三个 → 直接拒绝，绝不猜尺寸）
 *   3. 相似度匹配 —— 套餐类名字禁止走这一步
 */
export function matchNutrition(name: string, index: NutritionIndex, fuzzyMin = DEFAULT_FUZZY_MIN): MatchResult {
  const norm = normalizeName(name);
  if (!norm) return { matched: null, matchType: 'none', confidence: 0 };

  // 第 1 级：归一化精确匹配
  const exact = index.byNorm.get(norm);
  if (exact) return { matched: exact, matchType: 'exact', confidence: 1, sourceName: exact.name };

  const comboish = looksLikeCombo(name);
  const { sizes } = bucketsOf(norm);
  const normBase = baseOf(norm);

  // 第 2 级：包含匹配（营养库名字更长，且唯一，规格一致）
  if (normBase.length >= 2) {
    const candidates = index.records.filter((r) => {
      const rk = r.normName;
      const { sizes: rSizes } = bucketsOf(rk);
      if (rSizes !== sizes) return false; // 规格不一致一律不认
      const rBase = baseOf(rk);
      return rBase.length > normBase.length && rBase.includes(normBase);
    });
    if (candidates.length === 1) {
      const hit = candidates[0]!;
      return { matched: hit, matchType: 'contains', confidence: 0.9, sourceName: hit.name };
    }
    // 多于一个候选说明有歧义（尺寸/口味），宁可判为未匹配，也不替用户做选择
  }

  // 第 3 级：相似度。套餐名不走这一步，否则「巨无霸三件套」会被算成「巨无霸」
  if (!comboish) {
    let best: { record: NutritionRecord; score: number } | null = null;
    for (const r of index.records) {
      const { sizes: rSizes } = bucketsOf(r.normName);
      if (rSizes !== sizes) continue;
      const s = diceSimilarity(normBase, baseOf(r.normName));
      if (s >= fuzzyMin && (!best || s > best.score)) best = { record: r, score: s };
    }
    if (best) return { matched: best.record, matchType: 'fuzzy', confidence: round3(best.score), sourceName: best.record.name };
  }

  return { matched: null, matchType: 'none', confidence: 0 };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * 累加
 * ------------------------------------------------------------------ */

export interface AccumulateResult {
  lines: ResolvedLine[];
  totals: NutritionFacts;
  unknown: OrderLine[];
  /** 匹配成功的份数占比 */
  coverage: number;
  assumptions: string[];
}

export function scaleFacts(facts: NutritionFacts, qty: number): NutritionFacts {
  const out = emptyFacts();
  for (const k of NUTRIENT_KEYS) out[k] = facts[k] * qty;
  return out;
}

/** 把一组组成项按营养库求和（任何一项查不到就整体判失败，绝不部分估算） */
export function factsFromComponents(
  components: Component[],
  index: NutritionIndex,
): { facts: NutritionFacts; ok: boolean; missing: string[]; sources: string[] } {
  let facts = emptyFacts();
  const missing: string[] = [];
  const sources: string[] = [];

  for (const c of components) {
    const m = matchNutrition(c.name, index);
    if (!m.matched) {
      missing.push(c.name);
      continue;
    }
    facts = addFacts(facts, scaleFacts(m.matched.facts, c.qty > 0 ? c.qty : 1));
    sources.push(`${c.qty > 0 ? c.qty : 1}×${m.matched.name}`);
  }

  return { facts, ok: missing.length === 0, missing, sources };
}

export interface AccumulateOptions {
  fuzzyMin?: number;
  /** 菜单目录：用于把订单项直接对到「能算出营养的可下单商品」 */
  menuByCode?: Map<string, CandidateProduct>;
  menuByName?: Map<string, CandidateProduct>;
}

/** 把订单按营养记录展开并累加 */
export function accumulate(order: OrderLine[], index: NutritionIndex, opts: AccumulateOptions = {}): AccumulateResult {
  const lines: ResolvedLine[] = [];
  const unknown: OrderLine[] = [];
  let totals = emptyFacts();
  let matchedQty = 0;
  let totalQty = 0;

  for (const line of order) {
    const qty = line.qty > 0 ? line.qty : 1;
    totalQty += qty;

    let matched: NutritionRecord | null = null;
    let matchType: MatchType = 'none';
    let confidence = 0;

    // 优先级 1：订单自带套餐组成（order-list / query-order 都会给）
    if (line.components && line.components.length > 0) {
      const summed = factsFromComponents(line.components, index);
      if (summed.ok) {
        matched = {
          name: line.name,
          normName: line.normName,
          facts: summed.facts,
          energyUnit: 'kcal',
          raw: { components: summed.sources },
        };
        matchType = 'combo';
        confidence = 1;
      }
    }

    // 优先级 2：命中菜单目录（编码优先，再名称）
    if (!matched && opts.menuByCode && line.code) {
      const hit = opts.menuByCode.get(line.code);
      if (hit) {
        matched = { name: hit.name, normName: normalizeName(hit.name), facts: hit.facts, energyUnit: 'kcal', raw: hit as unknown as Record<string, unknown> };
        matchType = 'menu';
        confidence = 1;
      }
    }
    if (!matched && opts.menuByName) {
      const hit = opts.menuByName.get(line.normName);
      if (hit) {
        matched = { name: hit.name, normName: normalizeName(hit.name), facts: hit.facts, energyUnit: 'kcal', raw: hit as unknown as Record<string, unknown> };
        matchType = 'menu';
        confidence = 1;
      }
    }

    // 优先级 3：直接对营养库做名称匹配
    if (!matched) {
      const m = matchNutrition(line.name, index, opts.fuzzyMin);
      matched = m.matched;
      matchType = m.matchType;
      confidence = m.confidence;
    }

    const facts = matched ? scaleFacts(matched.facts, qty) : emptyFacts();
    if (matched) {
      matchedQty += qty;
      totals = addFacts(totals, facts);
    } else {
      unknown.push(line);
    }

    lines.push({ line: { ...line, qty }, matched, matchType, confidence, facts });
  }

  const assumptions: string[] = [];
  if (unknown.length > 0) {
    assumptions.push(
      `有 ${unknown.length} 项在 MCP 营养库中未找到对应记录（${unknown
        .map((u) => u.name)
        .join('、')}），已按 0 计入总量并单独列出 —— 本 Skill 不做任何营养估算。`,
    );
  }
  if (index.assumedUnitCount > 0) {
    assumptions.push(
      `有 ${index.assumedUnitCount} 条营养记录的能量字段未随数据返回单位，按中国麦当劳营养信息表惯例（千焦 kJ）换算为千卡。`,
    );
  }

  return {
    lines,
    totals,
    unknown,
    coverage: totalQty === 0 ? 0 : matchedQty / totalQty,
    assumptions,
  };
}
