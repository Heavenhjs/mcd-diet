/**
 * mcd-dev-diet 全局类型定义
 *
 * 设计原则：
 *  - 所有营养/菜单/价格数据都来自麦当劳 MCP Server，本文件不内置任何餐品营养数值。
 *  - 对 MCP 返回结构保持「宽容解析」：字段名做模糊识别，避免服务端字段微调就把整个 Skill 打挂。
 */

/** 我们归一化后使用的六大营养素 */
export type NutrientKey = 'energy' | 'protein' | 'fat' | 'carb' | 'sodium' | 'calcium';

/** 归一化后的营养事实。单位见 NUTRIENT_META */
export interface NutritionFacts {
  energy: number; // kcal（若数据源为千焦，已在解析层换算）
  protein: number; // g
  fat: number; // g
  carb: number; // g
  sodium: number; // mg
  calcium: number; // mg
}

/** 营养素元信息：单位、中文名、是否为「越少越好」的限制型营养素 */
export interface NutrientMeta {
  key: NutrientKey;
  label: string;
  unit: string;
  /** 该营养素来自 MCP 数据时，原始单位可能是什么 */
  kind: 'macronutrient' | 'mineral';
}

export const NUTRIENT_META: Record<NutrientKey, NutrientMeta> = {
  energy: { key: 'energy', label: '能量', unit: 'kcal', kind: 'macronutrient' },
  protein: { key: 'protein', label: '蛋白质', unit: 'g', kind: 'macronutrient' },
  fat: { key: 'fat', label: '脂肪', unit: 'g', kind: 'macronutrient' },
  carb: { key: 'carb', label: '碳水化合物', unit: 'g', kind: 'macronutrient' },
  sodium: { key: 'sodium', label: '钠', unit: 'mg', kind: 'mineral' },
  calcium: { key: 'calcium', label: '钙', unit: 'mg', kind: 'mineral' },
};

export const NUTRIENT_KEYS: NutrientKey[] = ['energy', 'protein', 'fat', 'carb', 'sodium', 'calcium'];

export function emptyFacts(): NutritionFacts {
  return { energy: 0, protein: 0, fat: 0, carb: 0, sodium: 0, calcium: 0 };
}

export function addFacts(a: NutritionFacts, b: NutritionFacts): NutritionFacts {
  return {
    energy: a.energy + b.energy,
    protein: a.protein + b.protein,
    fat: a.fat + b.fat,
    carb: a.carb + b.carb,
    sodium: a.sodium + b.sodium,
    calcium: a.calcium + b.calcium,
  };
}

/* ------------------------------------------------------------------ *
 * MCP 数据模型
 * ------------------------------------------------------------------ */

/** 来自 list-nutrition-foods 的一条营养记录 */
export interface NutritionRecord {
  /** 餐品编码，可能为空（营养库不一定带编码） */
  code?: string;
  /** 餐品名称（原始） */
  name: string;
  /** 归一化名称，用于匹配 */
  normName: string;
  facts: NutritionFacts;
  /** 能量原始单位判定结果，用于报告「数据说明」 */
  energyUnit: 'kcal' | 'kJ-assumed' | 'kJ-explicit';
  /** 原始记录，便于调试 */
  raw: Record<string, unknown>;
}

/**
 * 来自 query-meals 的一条菜单记录。
 *
 * 实测：meals[] 元素只有 { code, tags }，**不含名称也不含价格**。
 * 名称必须另调 query-meal-detail 获取，因此 name 是可选的。
 */
export interface MenuRecord {
  code: string;
  /** query-meals 不返回名称，取到详情后才有 */
  name?: string;
  normName?: string;
  category?: string;
  tags: string[];
  raw: Record<string, unknown>;
}

/** query-meal-detail 的一个「选择组」里的一个可选项 */
export interface MealChoice {
  code?: string;
  name: string;
  /** 是否默认选中 */
  isDefault: boolean;
  /** 选中数量；实测 may be 0 表示未选中 */
  quantity: number;
  diffPrice?: string;
}

/** query-meal-detail 的一个「选择组」 */
export interface MealRound {
  id?: number;
  name: string;
  /** 该组的份数 —— 实测这是唯一可靠的倍率来源 */
  quantity: number;
  choices: MealChoice[];
}

/** query-meal-detail 的完整结果 */
export interface MealDetail {
  code: string;
  name: string;
  rounds: MealRound[];
  image?: string;
  supportModify?: boolean;
}

/** 套餐拆解出的一项组成 */
export interface Component {
  name: string;
  /** 数量 = round.quantity（实测，非 choice.quantity） */
  qty: number;
  code?: string;
}

/** 订单里的一项（已归一化） */
export interface OrderLine {
  name: string;
  normName: string;
  code?: string;
  qty: number;
  /** 若该项本身是套餐，订单里会直接带出组成明细 */
  components?: Component[];
  /** 原始记录 */
  raw?: Record<string, unknown>;
}

/** 匹配方式，决定我们对这条数据的信任程度（越靠前越可信） */
export type MatchType =
  | 'menu' // 命中菜单目录（编码或目录内名称），营养最有保障
  | 'combo' // 套餐按组成项求和
  | 'exact' // 归一化名称精确命中营养库
  | 'contains' // 包含匹配（营养库条目名更长，且唯一）
  | 'fuzzy' // 字符二元组相似度
  | 'none';

/** 订单项解析后的结果 */
export interface ResolvedLine {
  line: OrderLine;
  matched: NutritionRecord | null;
  matchType: MatchType;
  /** 模糊匹配的相似度，0~1 */
  confidence: number;
  /** 这一行的营养贡献（未匹配则为全 0） */
  facts: NutritionFacts;
}

/* ------------------------------------------------------------------ *
 * 候选商品目录
 * ------------------------------------------------------------------ */

/**
 * 候选商品：当前门店可下单、且能从 MCP 数据算出营养的商品。
 *
 * 只有两类能进池，别的宁可不要：
 *   single —— 单品，营养直接来自 list-nutrition-foods 的对应行
 *   combo  —— 套餐，营养 = Σ(round.quantity × 组成项营养)，组成项全部来自营养库
 * 任何需要「猜」的都不进池，而是记进 CatalogStats.excluded 并在报告里列出来。
 */
export interface CandidateProduct {
  code: string;
  name: string;
  category?: string;
  tags: string[];
  kind: 'single' | 'combo';
  facts: NutritionFacts;
  components: Component[];
  /** 匹配方式与置信度，决定报告里展示的可信等级 */
  match: { type: MatchType; confidence: number; sourceName?: string };
}

/** 目录构建过程的统计。全部要在报告里露出来，不允许静默丢数据。 */
export interface CatalogStats {
  nutritionRows: number;
  nutritionDeclaredRows: number;
  menuCodes: number;
  detailOk: number;
  detailFailed: number;
  poolSize: number;
  singles: number;
  combos: number;
  /** 被排除的菜单商品及原因 */
  excluded: Array<{ code: string; name: string; reason: string }>;
  /** 数据是否来自缓存 */
  fromCache: boolean;
  fetchedAt: string;
}

/* ------------------------------------------------------------------ *
 * 目标 / 评分
 * ------------------------------------------------------------------ */

export type GoalName = 'fat-loss' | 'maintain' | 'muscle';
export type MealName = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** 单餐目标：每个营养素一个目标值 + 双侧容差（half 为「得分衰减到 0.5 的距离」） */
export interface NutrientTarget {
  target: number;
  /** 低于目标时的容差；Infinity 表示「低于目标不罚分」 */
  halfLow: number;
  /** 高于目标时的容差；Infinity 表示「高于目标不罚分」 */
  halfHigh: number;
  /** 该营养素在总分里的权重 */
  weight: number;
}

export type TargetProfile = Record<NutrientKey, NutrientTarget>;

export interface NutrientScore {
  key: NutrientKey;
  label: string;
  unit: string;
  value: number;
  target: number;
  /** 软评分 0~1，越接近目标越高 */
  score: number;
  /** value / target，仅用于展示，不参与评分 */
  ratio: number;
  /** 相对目标的缺口（正=还差，负=已超） */
  gap: number;
  /** 展示用状态标签，由 gap 相对容差推导，仅供参考 */
  band: 'far-below' | 'below' | 'on-target' | 'above' | 'far-above' | 'free';
}

export interface MealScore {
  /** 加权平均后的 0~1 总分 */
  score: number;
  /** 0~100 的展示分 */
  score100: number;
  perNutrient: Record<NutrientKey, NutrientScore>;
  /** 能量质量：空热量占比及其软评分 */
  quality: EnergyQualityScore;
}

/**
 * 能量质量（空热量占比）
 *
 * 为什么需要它：只看「能量/蛋白/脂肪/碳水/钠/钙」的距离，会得出「含糖可乐最能补碳水缺口」
 * 这种数学正确但营养学错误的结论。这里补上「这一口能量有没有带上蛋白质和钙」这一维度。
 *
 * 定义（全部为连续函数，无阈值）：
 *   对单个餐品，先算每 100 kcal 的蛋白质密度与钙密度，
 *   密度得分 pd = d / (d + REF)，值域 (0,1)；
 *   空热量倾向 e = (1 - pd_protein) × (1 - cd_calcium)，值域 [0,1)。
 *   一顿的 emptyShare = Σ(能量ᵢ × eᵢ) / Σ能量ᵢ，即「空热量」贡献的能量份额。
 *   质量得分 = 1 - emptyShare。
 */
export interface EnergyQualityScore {
  /** 空热量能量占比 0~1 */
  emptyShare: number;
  /** 软评分 = 1 - emptyShare */
  score: number;
  label: string;
}

/* ------------------------------------------------------------------ *
 * 推荐
 * ------------------------------------------------------------------ */

export interface PriceInfo {
  amount: number | null;
  currency: 'CNY';
  source: 'mcp-live' | 'mcp-bundle' | 'baseline' | 'unavailable';
  note?: string;
}

export interface Recommendation {
  code: string;
  name: string;
  facts: NutritionFacts;
  /** 加上这一样之后的总分提升 */
  delta: number;
  /** 加上之后的总分 */
  scoreAfter: number;
  /** 这一样主要补上了什么 */
  fixes: Array<{
    key: NutrientKey;
    label: string;
    unit: string;
    /** 加之前离目标的距离 */
    before: number;
    /** 加之后离目标的距离 */
    after: number;
    /** 这一项带来的营养素变化量 */
    deltaValue: number;
  }>;
  /** 人话理由 */
  reasons: string[];
  price: PriceInfo;
  category?: string;
  /** 单品还是套餐（套餐的营养是拆解求和得到的） */
  kind?: 'single' | 'combo';
  /** 套餐的组成明细，用于在报告里展示拆解口径 */
  components?: Component[];
  /** 是否是新增品类（用于多样性提示） */
  newCategory: boolean;
}

/** 减项建议：吃多了的时候告诉你去掉哪样最划算 */
export interface RemovalSuggestion {
  name: string;
  qty: number;
  /** 去掉后总分提升 */
  delta: number;
  /** 去掉后刚好回到目标附近的营养素 */
  helps: string[];
}

export interface RecommendOutcome {
  baseScore: MealScore;
  /** 贪心搜索出来的、可加的组合（按加入顺序） */
  picked: Recommendation[];
  /** 加入组合后的总分 */
  finalScore: MealScore;
  /** 每一步之后的分数轨迹，[base, step1, step2, ...] */
  trajectory: number[];
  /** 所有候选按 「单独加入的收益」降序排的前若干名（含未被选中的） */
  ranked: Recommendation[];
  /** 加不动了的时候给出的减项建议 */
  removals: RemovalSuggestion[];
  /** 候选池规模、被排除的餐品等统计 */
  stats: {
    menuSize: number;
    candidateSize: number;
    excludedCount: number;
    /** 候选里因为没有营养数据而被丢弃的数量 */
    droppedNoNutrition: number;
  };
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

export interface OrderContext {
  /** 数据来源：实时 MCP / 演示 fixture */
  source: 'mcp' | 'demo';
  storeCode?: string;
  storeName?: string;
  orderType?: string;
  goal: GoalName;
  meal: MealName;
  /** 覆盖过的单项目标，用于在报告里标注 */
  overrides: Partial<Record<NutrientKey, number>>;
  generatedAt: string;
}

export interface DietReport {
  context: OrderContext;
  lines: ResolvedLine[];
  /** 总计（只含匹配成功的项） */
  totals: NutritionFacts;
  score: MealScore;
  finalScore: MealScore;
  outcome: RecommendOutcome;
  /** 未匹配上的原始订单项 */
  unknown: OrderLine[];
  /** 覆盖率：匹配上的份数 / 总份数 */
  coverage: number;
  /** 候选目录的抓取统计（含被排除的餐品与原因） */
  catalog?: CatalogStats;
  /** 若因覆盖度过低而刻意不出建议，这里说明原因 */
  suppressed?: { reason: string };
  /** 数据来源与假设，全部要打印出来，不做静默处理 */
  assumptions: string[];
  /** 原始数据出处（调了哪些 Tool） */
  provenance: string[];
}
