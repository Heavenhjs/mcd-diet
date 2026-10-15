/**
 * 【核心文件 2 / 3】推荐逻辑（含软评分）
 *
 * 评分：软评分，越接近目标越高，全程没有任何硬阈值。
 *   单营养素得分 s(x) = 1 / (1 + (d / half)²)，其中 d = x - target
 *     - d > 0 时 half = halfHigh，d < 0 时 half = halfLow（双侧容差可以不对称）
 *     - half = Infinity 表示该侧不扣分（钠低于目标不罚、钙高于目标不罚）
 *   性质：s(target) = 1；s 随 |x - target| 平滑单调衰减；处处连续可导，不存在「过线就归零」的断崖。
 *
 * 聚合：加权算术均值与加权几何均值的混合（几何均值占比 0.4），
 *   让「某一项严重不达标」的短板被放大，同时保持平滑单调。
 *
 * 推荐：在「菜单 ∩ 营养库 − 已点菜品」的候选池上做贪心搜索，每一步选当前收益最大的一个。
 *   已被点过的菜默认排除（编码 + 归一化名称 + 受控包含关系三重判定），可用 --allow-repeat 放开。
 */

import {
  addFacts,
  NUTRIENT_KEYS,
  NUTRIENT_META,
  type CandidateProduct,
  type MealScore,
  type NutrientKey,
  type NutrientScore,
  type NutritionFacts,
  type Recommendation,
  type RecommendOutcome,
  type RemovalSuggestion,
  type ResolvedLine,
  type TargetProfile,
} from './types.js';
import { normalizeName } from './nutrition.js';

/* ------------------------------------------------------------------ *
 * 软评分
 * ------------------------------------------------------------------ */

/** 单营养素软评分，值域 (0, 1]，目标点取 1 */
export function softScore(value: number, target: number, halfLow: number, halfHigh: number): number {
  const d = value - target;
  const half = d >= 0 ? halfHigh : halfLow;
  if (!Number.isFinite(half)) return 1; // 该侧不扣分
  if (half <= 0) return d === 0 ? 1 : 0; // 防御：零容差退化为硬判定（正常配置不会走到）
  const u = d / half;
  return 1 / (1 + u * u);
}

type Band = NutrientScore['band'];

function bandOf(value: number, target: number, halfLow: number, halfHigh: number): Band {
  const ratio = target > 0 ? value / target : 1;
  if (halfLow === Infinity) {
    if (ratio <= 1.1) return 'on-target';
    if (ratio <= 1.35) return 'above';
    return 'far-above';
  }
  if (halfHigh === Infinity) {
    if (ratio >= 1) return 'free';
    if (ratio >= 0.7) return 'below';
    return 'far-below';
  }
  if (ratio < 0.7) return 'far-below';
  if (ratio < 0.9) return 'below';
  if (ratio <= 1.1) return 'on-target';
  if (ratio <= 1.35) return 'above';
  return 'far-above';
}

export type Aggregate = 'balanced' | 'mean';

export interface ScoreOptions {
  aggregate?: Aggregate;
  /** 聚合时几何均值的占比，默认 0.4 */
  geometricShare?: number;
  /** 这顿的空热量能量占比，0~1；由 emptyCalorieTendency 逐项加权算出 */
  emptyShare?: number;
  /** 能量质量维度的权重，默认 1.6；减脂档会更高（见 targets.ts 的 GOAL_PRESETS） */
  qualityWeight?: number;
}

/** 能量质量维度的默认权重 */
export const QUALITY_WEIGHT = 1.6;

/** 每 100 kcal 的蛋白质参考密度（g）：达到这个密度即视为「这一口不是空热量」 */
const PROTEIN_DENSITY_REF = 4;
/** 每 100 kcal 的钙参考密度（mg） */
const CALCIUM_DENSITY_REF = 50;

/**
 * 单个餐品的「空热量倾向」e ∈ [0, 1)。
 * 0 = 每一口能量都带着蛋白质和钙（如纯牛奶）；接近 1 = 纯能量、营养密度低（如含糖可乐）。
 * 对能量为 0 的餐品（水、无糖茶）返回 0，避免把它误判成空热量。
 */
export function emptyCalorieTendency(facts: NutritionFacts): number {
  if (facts.energy <= 0) return 0;
  const per100 = 100 / facts.energy;
  const proteinDensity = facts.protein * per100;
  const calciumDensity = facts.calcium * per100;
  const pd = proteinDensity / (proteinDensity + PROTEIN_DENSITY_REF);
  const cd = calciumDensity / (calciumDensity + CALCIUM_DENSITY_REF);
  return (1 - pd) * (1 - cd);
}

function qualityLabel(score: number): string {
  if (score >= 0.85) return '优秀';
  if (score >= 0.7) return '良好';
  if (score >= 0.5) return '一般';
  if (score >= 0.3) return '偏低';
  return '很差';
}

/** 一顿饭相对目标的软评分 */
export function scoreMeal(totals: NutritionFacts, profile: TargetProfile, opts: ScoreOptions = {}): MealScore {
  const aggregate = opts.aggregate ?? 'balanced';
  const gShare = Math.min(Math.max(opts.geometricShare ?? 0.4, 0), 1);
  const emptyShare = Math.min(Math.max(opts.emptyShare ?? 0, 0), 1);

  const perNutrient = {} as Record<NutrientKey, NutrientScore>;
  let weightSum = 0;
  let arithSum = 0;
  let geoLogSum = 0;

  for (const key of NUTRIENT_KEYS) {
    const t = profile[key];
    const value = totals[key];
    const s = softScore(value, t.target, t.halfLow, t.halfHigh);
    const ratio = t.target > 0 ? value / t.target : 0;

    perNutrient[key] = {
      key,
      label: NUTRIENT_META[key].label,
      unit: NUTRIENT_META[key].unit,
      value,
      target: t.target,
      score: s,
      ratio,
      gap: t.target - value,
      band: bandOf(value, t.target, t.halfLow, t.halfHigh),
    };

    weightSum += t.weight;
    arithSum += s * t.weight;
    // 几何项：地板 0.01，避免 log(0)
    geoLogSum += Math.log(Math.max(s, 0.01)) * t.weight;
  }

  // 第 7 个维度：能量质量（空热量占比），权重随目标档位变化
  const qualityWeight = opts.qualityWeight ?? QUALITY_WEIGHT;
  const qualityScore = 1 - emptyShare;
  weightSum += qualityWeight;
  arithSum += qualityScore * qualityWeight;
  geoLogSum += Math.log(Math.max(qualityScore, 0.01)) * qualityWeight;

  const arithmetic = weightSum > 0 ? arithSum / weightSum : 0;
  const geometric = weightSum > 0 ? Math.exp(geoLogSum / weightSum) : 0;
  const score = aggregate === 'mean' ? arithmetic : (1 - gShare) * arithmetic + gShare * geometric;

  return {
    score,
    score100: Math.round(score * 1000) / 10,
    perNutrient,
    quality: { emptyShare, score: qualityScore, label: qualityLabel(qualityScore) },
  };
}

/* ------------------------------------------------------------------ *
 * 候选池
 * ------------------------------------------------------------------ */

export interface Candidate {
  product: CandidateProduct;
  facts: NutritionFacts;
  /** 这一样贡献的「空热量能量」= 能量 × 空热量倾向，用于增量更新能量质量 */
  emptyEnergy: number;
  /** 归一化名称，用于去重与排除已点 */
  normName: string;
  /** 该套餐里含有已经点过的组成项（只做提示，不做排除） */
  containsOrdered: string[];
  /** 需要向用户点明的补充说明（套餐拆解口径、含已点项） */
  kindNote?: string;
}

/**
 * 判断某个候选是否属于「已经点过」—— 对应约束 4：推荐结果要排除已点的菜。
 *
 * 判定口径：
 *   · 编码相同 → 排除
 *   · 归一化名称相同 → 排除（归一化已经把「麦乐鸡5块 / 5块麦乐鸡 / 麦乐鸡-5块」视为同一个）
 *   · 受控包含：「已点名称」与「候选名称」互相包含且长度相近 → 排除
 *     （长度约束是为了不把「可乐」误判成「可口可乐中杯」这种不同商品）
 */
function buildExclusion(ordered: ResolvedLine[], allowRepeat: boolean): (name: string, code?: string) => boolean {
  if (allowRepeat) return () => false;

  const codes = new Set<string>();
  const names: string[] = [];

  for (const l of ordered) {
    if (l.line.code) codes.add(l.line.code);
    if (l.matched?.code) codes.add(l.matched.code);
    const n = normalizeName(l.line.name);
    if (n) names.push(n);
    if (l.matched?.normName) names.push(l.matched.normName);
  }

  return (name: string, code?: string): boolean => {
    if (code && codes.has(code)) return true;
    const n = normalizeName(name);
    if (!n) return false;
    for (const prev of names) {
      if (prev === n) return true;
      // 受控包含：既要有一侧完整包含另一侧，长度也不能差太多
      if (prev.length >= 3 && n.includes(prev) && prev.length / n.length >= 0.55) return true;
      if (n.length >= 3 && prev.includes(n) && n.length / prev.length >= 0.55) return true;
    }
    return false;
  };
}

export interface BuildCandidatesResult {
  candidates: Candidate[];
  menuSize: number;
  excludedCount: number;
  droppedNoNutrition: number;
}

/**
 * 从菜单目录挑出可推荐的候选。
 *
 * 注意：营养解析已经在 menu.ts 里做完（单品对营养库、套餐按组成求和），
 * 这里只负责「排除已点的菜」和「过滤掉空营养的项」。
 */
export function buildCandidates(input: {
  products: CandidateProduct[];
  ordered: ResolvedLine[];
  allowRepeat?: boolean;
  /** 只保留能提供至少一项营养的候选 */
  minTotalNutrient?: number;
}): BuildCandidatesResult {
  const isExcluded = buildExclusion(input.ordered, input.allowRepeat ?? false);
  const floor = input.minTotalNutrient ?? 0;

  // 已点过的组成项名称（用于给套餐加「含已点」提示）
  const orderedNames = new Set<string>();
  for (const l of input.ordered) {
    const n = normalizeName(l.line.name);
    if (n) orderedNames.add(n);
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let excludedCount = 0;
  let droppedNoNutrition = 0;

  for (const p of input.products) {
    if (isExcluded(p.name, p.code)) {
      excludedCount++;
      continue;
    }

    const normName = normalizeName(p.name);
    const key = `${p.code}::${normName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sum = NUTRIENT_KEYS.reduce((acc, k) => acc + p.facts[k], 0);
    if (sum <= floor) {
      droppedNoNutrition++;
      continue;
    }

    const containsOrdered: string[] = [];
    for (const c of p.components) {
      const cn = normalizeName(c.name);
      if (cn && orderedNames.has(cn)) containsOrdered.push(c.name);
    }

    const notes: string[] = [];
    if (p.kind === 'combo' && p.components.length > 0) {
      notes.push(
        `营养按套餐默认组成累加（${p.components.map((c) => `${c.qty > 1 ? c.qty + '×' : ''}${c.name}`).join(' + ')}）`,
      );
    }
    if (containsOrdered.length > 0) {
      notes.push(`这个套餐里含你已点过的「${containsOrdered.join('、')}」，如果不想要可以单点`);
    }

    candidates.push({
      product: p,
      facts: p.facts,
      emptyEnergy: p.facts.energy * emptyCalorieTendency(p.facts),
      normName,
      containsOrdered,
      kindNote: notes.length > 0 ? notes.join('；') : undefined,
    });
  }

  return { candidates, menuSize: input.products.length, excludedCount, droppedNoNutrition };
}

/* ------------------------------------------------------------------ *
 * 残缺基线：只给分，不给建议
 * ------------------------------------------------------------------ */

/** 这顿的空热量能量（Σ 能量 × 空热量倾向） */
export function emptyEnergyOf(lines: ResolvedLine[]): number {
  return lines.reduce((acc, l) => acc + (l.matched ? l.facts.energy * emptyCalorieTendency(l.matched.facts) : 0), 0);
}

/**
 * 只算平衡分，不给任何加餐/减项建议。
 *
 * 为什么需要它：如果这一顿有相当一部分餐品在营养库里查不到（UNKNOWN），
 * 总量就是「残缺基线」——按 0 计入的那部分可能含大量能量。
 * 此时再按缺口感去推荐「再吃一个汉堡」，就是把「数据缺失」误当成「你没吃够」，
 * 属于典型的数据驱动型误导。宁可不出建议，也不出错的建议。
 */
export function baselineOnlyOutcome(input: {
  totals: NutritionFacts;
  lines: ResolvedLine[];
  profile: TargetProfile;
  qualityWeight?: number;
  scoreOptions?: ScoreOptions;
}): RecommendOutcome {
  const scoreOpts: ScoreOptions = { ...(input.scoreOptions ?? {}) };
  if (input.qualityWeight !== undefined) scoreOpts.qualityWeight = input.qualityWeight;

  const emptyEnergy = emptyEnergyOf(input.lines);
  const emptyShare = input.totals.energy > 0 ? emptyEnergy / input.totals.energy : 0;
  const baseScore = scoreMeal(input.totals, input.profile, { ...scoreOpts, emptyShare });

  return {
    baseScore,
    picked: [],
    finalScore: baseScore,
    trajectory: [baseScore.score],
    ranked: [],
    removals: [],
    stats: { menuSize: 0, candidateSize: 0, excludedCount: 0, droppedNoNutrition: 0 },
  };
}

/* ------------------------------------------------------------------ *
 * 推荐生成
 * ------------------------------------------------------------------ */

function makeRecommendation(
  cand: Candidate,
  before: NutritionFacts,
  after: NutritionFacts,
  profile: TargetProfile,
  beforeScore: MealScore,
  afterScore: MealScore,
  newCategory: boolean,
): Recommendation {
  const fixes: Recommendation['fixes'] = [];

  for (const key of NUTRIENT_KEYS) {
    const t = profile[key];
    const bd = Math.abs(before[key] - t.target);
    const ad = Math.abs(after[key] - t.target);
    if (ad < bd - 1e-9) {
      fixes.push({
        key,
        label: NUTRIENT_META[key].label,
        unit: NUTRIENT_META[key].unit,
        before: bd,
        after: ad,
        deltaValue: after[key] - before[key],
      });
    }
  }

  fixes.sort((a, b) => (b.before - b.after) / Math.max(b.before, 1e-6) - (a.before - a.after) / Math.max(a.before, 1e-6));

  const reasons: string[] = [];
  for (const f of fixes.slice(0, 3)) {
    const amount = Math.abs(f.deltaValue);
    const shown = f.unit === 'kcal' ? Math.round(amount) : Math.round(amount * 10) / 10;
    const remain = f.after < 0.5 ? '，补完基本就到量了' : `，补完还差 ${fmt(f.after, f.unit)}${f.unit}`;
    reasons.push(`${f.label} +${shown}${f.unit}（原本离目标差 ${fmt(f.before, f.unit)}${f.unit}${remain}）`);
  }
  if (fixes.length === 0) {
    reasons.push('对各项指标的贴近度都有微幅改善，属于「不添乱」的选择');
  }

  const delta100 = Math.round((afterScore.score - beforeScore.score) * 1000) / 10;
  reasons.push(`整体平衡分 ${beforeScore.score100} → ${afterScore.score100}（${delta100 >= 0 ? '+' : ''}${delta100}）`);

  // 会从「不足」变成「过量」的营养素，明确提示
  for (const key of NUTRIENT_KEYS) {
    if (before[key] < profile[key].target && after[key] > profile[key].target) {
      reasons.push(`注意：${NUTRIENT_META[key].label}会从不足变为超出目标 ${fmt(after[key] - profile[key].target, NUTRIENT_META[key].unit)}${NUTRIENT_META[key].unit}`);
    }
  }

  if (newCategory) reasons.push('能引入这顿饭目前还没有的品类，结构更丰富');

  if (cand.kindNote) reasons.push(cand.kindNote);

  // 能量质量（空热量占比）的变化，好要说，坏也要说
  const beforeEmpty = beforeScore.quality.emptyShare;
  const afterEmpty = afterScore.quality.emptyShare;
  if (afterEmpty < beforeEmpty - 0.005) {
    reasons.push(
      `能量质量提升：空热量占比 ${(beforeEmpty * 100).toFixed(0)}% → ${(afterEmpty * 100).toFixed(0)}%`,
    );
  } else if (afterEmpty > beforeEmpty + 0.005) {
    reasons.push(
      `代价：空热量占比从 ${(beforeEmpty * 100).toFixed(0)}% 升到 ${(afterEmpty * 100).toFixed(0)}%`,
    );
  }

  return {
    code: cand.product.code,
    name: cand.product.name,
    facts: cand.facts,
    delta: afterScore.score - beforeScore.score,
    scoreAfter: afterScore.score,
    fixes: fixes.slice(0, 3),
    reasons,
    price: { amount: null, currency: 'CNY', source: 'unavailable' },
    category: cand.product.category,
    kind: cand.product.kind,
    components: cand.product.components.length > 0 ? cand.product.components : undefined,
    newCategory,
  };
}

function fmt(v: number, unit: string): string {
  if (unit === 'kcal') return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

export interface RecommendInput {
  totals: NutritionFacts;
  lines: ResolvedLine[];
  /** 菜单目录里所有能算出营养的可下单商品 */
  products: CandidateProduct[];
  profile: TargetProfile;
  /** 最多推荐几样，默认 2 */
  maxAdd?: number;
  /** 收益低于此值就不推荐了，默认 0.004 */
  minGain?: number;
  /** ranked 榜单展示条数，默认 5 */
  topRanked?: number;
  /** 是否给「新品类」一点排序加成（只影响排序，不影响真实 delta） */
  diversity?: boolean;
  allowRepeat?: boolean;
  scoreOptions?: ScoreOptions;
  /** 能量质量维度权重，通常来自 resolveTargets 的结果 */
  qualityWeight?: number;
}

export function recommendAddOns(input: RecommendInput): RecommendOutcome {
  const maxAdd = input.maxAdd ?? 2;
  const minGain = input.minGain ?? 0.004;
  const topRanked = input.topRanked ?? 5;
  const diversity = input.diversity ?? true;
  const scoreOpts: ScoreOptions = { ...(input.scoreOptions ?? {}) };
  if (input.qualityWeight !== undefined) scoreOpts.qualityWeight = input.qualityWeight;

  const built = buildCandidates({
    products: input.products,
    ordered: input.lines,
    allowRepeat: input.allowRepeat,
  });

  /* --- 能量质量基线：Σ(能量 × 空热量倾向) --- */
  const baseEmptyEnergy = input.lines.reduce(
    (acc, l) => acc + (l.matched ? l.facts.energy * emptyCalorieTendency(l.matched.facts) : 0),
    0,
  );
  const emptyShareOf = (energy: number, emptyEnergy: number): number => (energy > 0 ? emptyEnergy / energy : 0);
  /** 给定「总量 + 空热量能量」求分 */
  const scoreOf = (totals: NutritionFacts, emptyEnergy: number): MealScore =>
    scoreMeal(totals, input.profile, { ...scoreOpts, emptyShare: emptyShareOf(totals.energy, emptyEnergy) });

  const baseScore = scoreOf(input.totals, baseEmptyEnergy);

  // 这顿饭目前已覆盖的品类（直接来自候选商品的 category 映射）
  const categoryByNorm = new Map<string, string>();
  for (const p of input.products) {
    if (p.category) categoryByNorm.set(normalizeName(p.name), p.category);
  }
  const existingCategories = new Set<string>();
  for (const l of input.lines) {
    if (!l.matched) continue;
    const cat = categoryByNorm.get(l.matched.normName);
    if (cat) existingCategories.add(cat);
  }
  const isNewCategory = (cand: Candidate): boolean =>
    !!cand.product.category && !existingCategories.has(cand.product.category);

  /* --- ranked：每一样单独加入基准餐的收益，降序 --- */
  const ranked: Recommendation[] = [];
  for (const cand of built.candidates) {
    const after = addFacts(input.totals, cand.facts);
    const afterScore = scoreOf(after, baseEmptyEnergy + cand.emptyEnergy);
    if (afterScore.score <= baseScore.score) continue;
    ranked.push(makeRecommendation(cand, input.totals, after, input.profile, baseScore, afterScore, isNewCategory(cand)));
  }
  ranked.sort((a, b) => b.delta - a.delta);

  /* --- 贪心：逐步挑当前收益最大的一样 --- */
  let current = { ...input.totals };
  let currentEmpty = baseEmptyEnergy;
  let currentScore = baseScore;
  const picked: Recommendation[] = [];
  const used = new Set<string>();
  const trajectory: number[] = [baseScore.score];

  for (let step = 0; step < maxAdd; step++) {
    let best: { cand: Candidate; after: NutritionFacts; empty: number; afterScore: MealScore; delta: number; rank: number } | null =
      null;

    for (const cand of built.candidates) {
      if (used.has(cand.normName)) continue;
      const after = addFacts(current, cand.facts);
      const nextEmpty = currentEmpty + cand.emptyEnergy;
      const afterScore = scoreOf(after, nextEmpty);
      const delta = afterScore.score - currentScore.score;
      if (delta <= 0) continue;

      // 多样性只作为排序加成，绝不修改真实收益
      const candIsNew = isNewCategory(cand);
      const rank = delta + (diversity && candIsNew ? delta * 0.08 : 0);

      if (!best || rank > best.rank) best = { cand, after, empty: nextEmpty, afterScore, delta, rank };
    }

    if (!best || best.delta < minGain) break;

    const rec = makeRecommendation(best.cand, current, best.after, input.profile, currentScore, best.afterScore, isNewCategory(best.cand));
    picked.push(rec);
    used.add(best.cand.normName);
    if (best.cand.product.category) existingCategories.add(best.cand.product.category);
    current = best.after;
    currentEmpty = best.empty;
    currentScore = best.afterScore;
    trajectory.push(currentScore.score);
  }

  /* --- 加不动了：给减项建议 --- */
  const removals: RemovalSuggestion[] = [];
  for (const line of input.lines) {
    if (!line.matched) continue;
    const qty = line.line.qty > 0 ? line.line.qty : 1;
    const minus = { ...input.totals };
    for (const k of NUTRIENT_KEYS) minus[k] = Math.max(0, minus[k] - line.matched.facts[k] * qty);
    const minusEmpty = Math.max(0, baseEmptyEnergy - line.facts.energy * emptyCalorieTendency(line.matched.facts));
    const s = scoreOf(minus, minusEmpty);
    const delta = s.score - baseScore.score;
    if (delta <= minGain / 2) continue;
    const helps: string[] = [];
    for (const k of NUTRIENT_KEYS) {
      const before = Math.abs(input.totals[k] - input.profile[k].target);
      const after = Math.abs(minus[k] - input.profile[k].target);
      if (after < before - 1e-9) helps.push(NUTRIENT_META[k].label);
    }
    if (minusEmpty / Math.max(minus.energy, 1e-6) < baseScore.quality.emptyShare - 0.005) helps.push('能量质量');
    removals.push({ name: line.line.name, qty, delta, helps });
  }
  removals.sort((a, b) => b.delta - a.delta);

  return {
    baseScore,
    picked,
    finalScore: currentScore,
    trajectory,
    ranked: ranked.slice(0, topRanked),
    removals: removals.slice(0, 3),
    stats: {
      menuSize: built.menuSize,
      candidateSize: built.candidates.length,
      excludedCount: built.excludedCount,
      droppedNoNutrition: built.droppedNoNutrition,
    },
  };
}
