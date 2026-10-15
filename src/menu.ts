/**
 * 菜单目录构建：把「麦当劳 MCP 能卖什么」和「营养库有什么」拼成一份可推荐的候选池
 *
 * 实测到的三条硬事实（决定了本模块的形态）：
 *
 *  1. query-meals 返回的 meals[] 只有 { code, tags }，**没有名称也没有价格**。
 *     想拿到名称必须对每个 code 调一次 query-meal-detail。124 个码约 26 秒，
 *     所以必须落磁盘缓存，否则每次跑都等半分钟。
 *
 *  2. 套餐的营养必须靠拆解：rounds[].choices[] 里 isDefault===1 且 quantity>0 的项，
 *     倍率取 **round.quantity**（实测 round.quantity 与 choice.quantity 会分歧：
 *     四宫格 round=3/choice=1；也见过 isDefault=1 但 quantity=0 的未选中项，
 *     只看 isDefault 会把「鱼牛汉堡四件套」多算 442 kcal）。
 *
 *  3. 拆解必须完整：只要有任何一项组成查不到营养，整个套餐就不进候选池，
 *     而不是「有多少算多少」—— 那等于用 0 顶替缺失项，就是估算。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  asNumber,
  asString,
  assertBusinessOk,
  isBusinessFailure,
  pickField,
  TOOLS,
  unwrapData,
  type ToolGateway,
} from './mcp.js';
import {
  buildNutritionIndex,
  factsFromComponents,
  looksLikeCombo,
  matchNutrition,
  normalizeName,
  parseMenuRecords,
  parseNutritionRecordsDetailed,
  type NutritionIndex,
} from './nutrition.js';
import {
  emptyFacts,
  NUTRIENT_KEYS,
  type CandidateProduct,
  type CatalogStats,
  type Component,
  type MealChoice,
  type MealDetail,
  type MealRound,
  type NutritionFacts,
} from './types.js';

/* ------------------------------------------------------------------ *
 * query-meal-detail 解析
 * ------------------------------------------------------------------ */

/** 从 query-meal-detail 的返回里解析出餐品详情 */
export function parseMealDetail(payload: unknown): MealDetail | null {
  const data = unwrapData(payload);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;

  const code = asString(pickField(o, ['code', 'productCode', 'mealCode']));
  const name = asString(pickField(o, ['name', 'productName', 'mealName']));
  if (!code || !name) return null;

  const rawRounds = pickField(o, ['rounds', 'roundList', 'groups']);
  const rounds: MealRound[] = [];

  if (Array.isArray(rawRounds)) {
    for (const rr of rawRounds) {
      if (!rr || typeof rr !== 'object') continue;
      const r = rr as Record<string, unknown>;
      const rawChoices = pickField(r, ['choices', 'choiceList', 'options']);
      const choices: MealChoice[] = [];

      if (Array.isArray(rawChoices)) {
        for (const rc of rawChoices) {
          if (!rc || typeof rc !== 'object') continue;
          const c = rc as Record<string, unknown>;
          const cName = asString(pickField(c, ['name', 'productName', 'itemName']));
          if (!cName) continue;
          // isDefault 实测有 1/0、true/false 两种写法；缺失时按「不是默认」处理
          const defRaw = pickField(c, ['isDefault', 'default', 'isSelected']);
          const isDefault = defRaw === 1 || defRaw === true || defRaw === '1' || defRaw === 'true';
          const qty = asNumber(pickField(c, ['quantity', 'qty', 'count']));
          choices.push({
            code: asString(pickField(c, ['code', 'productCode', 'itemCode'])),
            name: cName,
            isDefault,
            quantity: qty === undefined ? (isDefault ? 1 : 0) : qty,
            diffPrice: asString(pickField(c, ['diffPrice', 'priceDiff'])),
          });
        }
      }

      rounds.push({
        id: asNumber(pickField(r, ['id', 'roundId'])),
        name: asString(pickField(r, ['name', 'roundName', 'title'])) ?? '',
        quantity: asNumber(pickField(r, ['quantity', 'qty', 'count'])) ?? 1,
        choices,
      });
    }
  }

  return {
    code,
    name,
    rounds,
    image: asString(pickField(o, ['image', 'imageUrl', 'img'])),
    supportModify: pickField(o, ['supportModify']) === true || pickField(o, ['supportModify']) === 1,
  };
}

/** 一个 round 里被默认选中、且数量大于 0 的项 */
function selectedChoices(round: MealRound): MealChoice[] {
  return round.choices.filter((c) => c.isDefault && c.quantity > 0);
}

/**
 * 把套餐详情拆成组成项。
 *
 * 返回 null 表示「这个商品本来就不是套餐」（没有任何 round 有默认选中项），
 * 返回 components 表示可以拆解；incomplete 表示有 round 缺默认项（组成不确定，须排除）。
 */
export function componentsOf(detail: MealDetail): { components: Component[]; incomplete: boolean } {
  const roundsWithDefault = detail.rounds.filter((r) => selectedChoices(r).length > 0);
  if (roundsWithDefault.length === 0) return { components: [], incomplete: false };

  const incomplete = roundsWithDefault.length !== detail.rounds.length;
  const components: Component[] = [];
  for (const round of roundsWithDefault) {
    for (const c of selectedChoices(round)) {
      components.push({
        name: c.name,
        // 倍率取 round.quantity（实测可靠），退而求其次才用 choice.quantity
        qty: round.quantity > 0 ? round.quantity : c.quantity,
        code: c.code,
      });
    }
  }
  return { components, incomplete };
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

interface CatalogCache {
  fetchedAt: string;
  storeCode: string;
  orderType: number;
  beType: number;
  nutrition: unknown;
  menu: unknown;
  details: Record<string, unknown>;
  detailFailures: Array<{ code: string; reason: string }>;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 菜单每天变，12 小时足够

function cacheFile(cacheDir: string, storeCode: string, orderType: number, beType: number): string {
  return path.join(cacheDir, `mcd-catalog-${storeCode}-ot${orderType}-bt${beType}.json`);
}

/* ------------------------------------------------------------------ *
 * 目录抓取
 * ------------------------------------------------------------------ */

export interface CatalogOptions {
  storeCode: string;
  orderType?: number;
  beType?: number;
  /** orderType=2（外送/团餐）必须带 beCode */
  beCode?: string;
  cacheDir: string;
  /** 关掉缓存读写 */
  noCache?: boolean;
  /** 忽略缓存强制重抓 */
  refresh?: boolean;
  ttlMs?: number;
  verbose?: boolean;
  onProgress?: (msg: string) => void;
}

export interface Catalog {
  index: NutritionIndex;
  products: CandidateProduct[];
  byCode: Map<string, CandidateProduct>;
  byName: Map<string, CandidateProduct>;
  stats: CatalogStats;
  /** 门店/订单上下文 */
  storeCode: string;
  orderType: number;
  beType: number;
  /** 抓取过程用到的 MCP Tool，写进报告的出处 */
  provenance: string[];
}

/** 组装 query-meals / query-meal-detail 的入参（实测的必填与禁忌） */
export function storeArgs(opts: { storeCode: string; orderType: number; beType: number; beCode?: string }): Record<string, unknown> {
  const args: Record<string, unknown> = {
    storeCode: opts.storeCode,
    orderType: opts.orderType,
    beType: opts.beType,
  };
  // 实测：到店场景(orderType=1)传 beCode 会直接报错，必须省略
  if (opts.orderType !== 1 && opts.beCode) args.beCode = opts.beCode;
  return args;
}

export interface NearbyStore {
  storeCode?: string;
  storeName?: string;
  address?: string;
  distance?: number;
  businessStatus?: boolean;
}

/**
 * 按城市 + 关键词查门店，返回服务端给出的顺序（实测按 distance 升序）。
 *
 * 实测坑：
 *  - `searchType` 必须传 2（按位置搜索）。1 是搜「我的收藏门店」，新用户收藏为空直接报 600050。
 *  - `city` 与 `keyword` 必须同时提供，缺一个报 600058。
 *  - `beType` 必传，且只接受 1（到店自提）与 5（得来速）。
 */
export async function searchStores(
  gateway: ToolGateway,
  opts: { city: string; keyword: string; beType?: number },
): Promise<NearbyStore[]> {
  const payload = await gateway.callTool(TOOLS.queryNearbyStores, {
    beType: opts.beType === 5 ? 5 : 1,
    searchType: 2,
    city: opts.city,
    keyword: opts.keyword,
  });
  const data = unwrapData(payload);
  if (!Array.isArray(data)) return [];
  return data.filter((x): x is NearbyStore => !!x && typeof x === 'object' && !!(x as NearbyStore).storeCode);
}


export async function fetchCatalog(gateway: ToolGateway, opts: CatalogOptions): Promise<Catalog> {
  const orderType = opts.orderType ?? 1;
  const beType = opts.beType ?? 1;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const log = opts.onProgress ?? (() => {});
  const provenance: string[] = [];

  let raw: CatalogCache | null = null;
  let fromCache = false;
  const file = cacheFile(opts.cacheDir, opts.storeCode, orderType, beType);
  // 缓存只对实时通道启用：演示模式必须自洽，
  // 否则 --demo 会读到上一次真实抓取的缓存，演示结果就变成了真实数据的残影。
  const cacheEnabled = gateway.isLive && !opts.noCache;

  if (cacheEnabled && !opts.refresh) {
    try {
      const text = await readFile(file, 'utf8');
      const parsed = JSON.parse(text) as CatalogCache;
      const age = Date.now() - new Date(parsed.fetchedAt).getTime();
      if (age >= 0 && age < ttl) {
        raw = parsed;
        fromCache = true;
        log(`命中菜单缓存（${Math.round(age / 60000)} 分钟前抓取）：${path.relative(process.cwd(), file)}`);
      }
    } catch {
      /* 没有缓存或缓存损坏都直接重抓 */
    }
  }

  if (!raw) {
    log('抓取营养库（list-nutrition-foods）…');
    const nutritionRaw = await gateway.callTool(TOOLS.listNutritionFoods, {});
    assertBusinessOk(nutritionRaw, TOOLS.listNutritionFoods);
    provenance.push(`${TOOLS.listNutritionFoods}（营养库，紧凑表格文本）`);

    const menuArgs = storeArgs({ storeCode: opts.storeCode, orderType, beType, beCode: opts.beCode });
    log(`抓取菜单（query-meals storeCode=${opts.storeCode} orderType=${orderType} beType=${beType}）…`);
    const menuRaw = await gateway.callTool(TOOLS.queryMeals, menuArgs);
    assertBusinessOk(menuRaw, TOOLS.queryMeals);
    provenance.push(`${TOOLS.queryMeals}（门店 ${opts.storeCode} 在售菜单）`);

    const menuRecords = parseMenuRecords(menuRaw);
    const codes = menuRecords.map((m) => m.code);
    log(`菜单 ${codes.length} 个餐品码，逐个取详情（query-meal-detail）×${codes.length}…`);

    const details: Record<string, unknown> = {};
    const detailFailures: Array<{ code: string; reason: string }> = [];
    let done = 0;
    for (const code of codes) {
      try {
        const detailRaw = await gateway.callTool(TOOLS.queryMealDetail, { ...menuArgs, code });
        if (isBusinessFailure(detailRaw)) {
          detailFailures.push({ code, reason: (detailRaw as { message?: string }).message ?? '业务失败' });
        } else {
          details[code] = detailRaw;
        }
      } catch (err) {
        detailFailures.push({ code, reason: (err as Error).message });
      }
      done++;
      if (done % 25 === 0) log(`  详情进度 ${done}/${codes.length}`);
    }
    provenance.push(`${TOOLS.queryMealDetail} × ${codes.length}（补齐餐品名称与套餐组成）`);

    raw = {
      fetchedAt: new Date().toISOString(),
      storeCode: opts.storeCode,
      orderType,
      beType,
      nutrition: nutritionRaw,
      menu: menuRaw,
      details,
      detailFailures,
    };

    if (cacheEnabled) {
      try {
        await mkdir(opts.cacheDir, { recursive: true });
        await writeFile(file, JSON.stringify(raw), 'utf8');
        log(`菜单缓存已写入 ${path.relative(process.cwd(), file)}`);
      } catch (err) {
        log(`菜单缓存写入失败（不影响本次结果）：${(err as Error).message}`);
      }
    }
  }

  /* --- 从原始负载构建候选池 --- */

  const nutritionParsed = parseNutritionRecordsDetailed(raw.nutrition);
  const index = buildNutritionIndex(nutritionParsed.records, {
    format: nutritionParsed.format,
    declaredRows: nutritionParsed.declaredRows,
  });

  const menuRecords = parseMenuRecords(raw.menu);
  const categoryByCode = new Map<string, string | undefined>();
  const tagsByCode = new Map<string, string[]>();
  for (const m of menuRecords) {
    categoryByCode.set(m.code, m.category);
    tagsByCode.set(m.code, m.tags);
  }

  const products: CandidateProduct[] = [];
  const excluded: CatalogStats['excluded'] = [];
  let detailOk = 0;

  for (const rec of menuRecords) {
    const detailRaw = raw.details[rec.code];
    const detail = detailRaw ? parseMealDetail(detailRaw) : null;
    if (!detail) {
      excluded.push({ code: rec.code, name: rec.name ?? `(code ${rec.code})`, reason: '未取到餐品详情（query-meal-detail 失败）' });
      continue;
    }
    detailOk++;

    const category = categoryByCode.get(rec.code);
    const tags = rec.tags.length > 0 ? rec.tags : (tagsByCode.get(rec.code) ?? []);
    const { components, incomplete } = componentsOf(detail);
    const hasComponents = components.length > 0;

    // 规则一：有组成就按组成求和 —— 套餐绝不拿自己的名字去营养库碰运气
    if (hasComponents) {
      if (incomplete) {
        excluded.push({ code: rec.code, name: detail.name, reason: '套餐存在未选定项，组成不确定（拆解会少算）' });
        continue;
      }
      const summed = factsFromComponents(components, index);
      if (!summed.ok) {
        excluded.push({
          code: rec.code,
          name: detail.name,
          reason: `组成项在营养库无对应：${summed.missing.join('、')}`,
        });
        continue;
      }
      products.push({
        code: rec.code,
        name: detail.name,
        category,
        tags,
        kind: 'combo',
        facts: summed.facts,
        components,
        match: { type: 'combo', confidence: 1 },
      });
      continue;
    }

    // 规则二：没有组成才做名称匹配；套餐类名字禁止宽松匹配
    if (looksLikeCombo(detail.name)) {
      excluded.push({ code: rec.code, name: detail.name, reason: '套餐名但无可拆解组成，拒绝宽松匹配' });
      continue;
    }
    const m = matchNutrition(detail.name, index);
    if (!m.matched) {
      excluded.push({ code: rec.code, name: detail.name, reason: '营养库无对应条目' });
      continue;
    }
    products.push({
      code: rec.code,
      name: detail.name,
      category,
      tags,
      kind: 'single',
      facts: m.matched.facts,
      components: [],
      match: { type: m.matchType, confidence: m.confidence, sourceName: m.matched.name },
    });
  }

  const byCode = new Map(products.map((p) => [p.code, p]));
  const byName = new Map<string, CandidateProduct>();
  for (const p of products) {
    const k = normalizeName(p.name);
    if (!byName.has(k)) byName.set(k, p);
  }

  const stats: CatalogStats = {
    nutritionRows: index.records.length,
    nutritionDeclaredRows: index.declaredRows ?? index.records.length,
    menuCodes: menuRecords.length,
    detailOk,
    detailFailed: menuRecords.length - detailOk,
    poolSize: products.length,
    singles: products.filter((p) => p.kind === 'single').length,
    combos: products.filter((p) => p.kind === 'combo').length,
    excluded,
    fromCache,
    fetchedAt: raw?.fetchedAt ?? new Date().toISOString(),
  };

  return { index, products, byCode, byName, stats, storeCode: opts.storeCode, orderType, beType, provenance };
}

/** 小工具：给一组组成项算总营养（报告里展示拆解过程用） */
export function sumFacts(list: Array<{ facts: NutritionFacts; qty: number }>): NutritionFacts {
  const out = emptyFacts();
  for (const item of list) for (const k of NUTRIENT_KEYS) out[k] += item.facts[k] * item.qty;
  return out;
}

/**
 * 只取营养库，不碰门店菜单。
 * 用在「没有门店编码」的场景：仍然可以盘点这顿吃了多少，只是给不出加餐推荐。
 */
export async function fetchNutritionOnly(gateway: ToolGateway): Promise<Catalog> {
  const nutritionRaw = await gateway.callTool(TOOLS.listNutritionFoods, {});
  assertBusinessOk(nutritionRaw, TOOLS.listNutritionFoods);

  const parsed = parseNutritionRecordsDetailed(nutritionRaw);
  const index = buildNutritionIndex(parsed.records, { format: parsed.format, declaredRows: parsed.declaredRows });

  return {
    index,
    products: [],
    byCode: new Map(),
    byName: new Map(),
    stats: {
      nutritionRows: index.records.length,
      nutritionDeclaredRows: index.declaredRows ?? index.records.length,
      menuCodes: 0,
      detailOk: 0,
      detailFailed: 0,
      poolSize: 0,
      singles: 0,
      combos: 0,
      excluded: [],
      fromCache: false,
      fetchedAt: new Date().toISOString(),
    },
    storeCode: '',
    orderType: 1,
    beType: 1,
    provenance: [`${TOOLS.listNutritionFoods}（仅营养库：没有门店编码，无法取在售菜单）`],
  };
}
