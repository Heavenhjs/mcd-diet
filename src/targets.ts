/**
 * 目标标准：三档预设 + 单项覆盖
 *
 * 基准口径：《中国居民膳食指南（2022）》+《中国居民膳食营养素参考摄入量》成人（轻体力活动）
 *   日参考量：能量 2000 kcal｜蛋白质 60 g｜脂肪 ≈25% 供能｜碳水 ≈55% 供能｜钠 <2000 mg｜钙 800 mg
 * 单餐 = 日参考量 ÷ 3，再按目标档位（减脂/维持/增肌）与餐次做系数调整。
 *
 * 注意：这里的数值是「目标标准」，不是「餐品营养数据」。
 *      餐品营养数据一律来自 MCP 的 list-nutrition-foods，本文件不内置任何餐品营养值。
 */

import { NUTRIENT_KEYS, type GoalName, type MealName, type NutrientKey, type NutrientTarget, type TargetProfile } from './types.js';

export interface GoalPreset {
  goal: GoalName;
  label: string;
  /** 各营养素相对「维持」基准的调整系数 */
  factor: Record<NutrientKey, number>;
  /**
   * 「能量质量（空热量占比）」这一维度在总分里的权重。
   *
   * 为什么不固定：空热量对不同目标的危害程度本来就不一样。
   * 减脂期热量预算紧，空热量几乎纯属浪费，权重要给高；
   * 增肌期本来就需要高能量密度，空热量的边际伤害小得多。
   */
  qualityWeight: number;
  /** 一句话说明 */
  blurb: string;
}

/** 单餐基准（日参考量 ÷ 3，成人轻体力活动，男女中值口径） */
export const MEAL_BASELINE: Record<NutrientKey, number> = {
  energy: 2000 / 3, // ≈ 667 kcal
  protein: 60 / 3, // 20 g
  fat: ((2000 * 0.25) / 9) / 3, // ≈ 18.5 g
  carb: ((2000 * 0.55) / 4) / 3, // ≈ 91.7 g
  sodium: 2000 / 3, // ≈ 667 mg
  calcium: 800 / 3, // ≈ 267 mg
};

export const GOAL_PRESETS: Record<GoalName, GoalPreset> = {
  'fat-loss': {
    goal: 'fat-loss',
    label: '减脂',
    factor: { energy: 0.82, protein: 1.4, fat: 0.75, carb: 0.7, sodium: 0.9, calcium: 1.0 },
    qualityWeight: 2.2,
    blurb: '控总能量、压脂肪与碳水，同时把蛋白质拉高以保住瘦体重',
  },
  maintain: {
    goal: 'maintain',
    label: '维持',
    factor: { energy: 1.0, protein: 1.0, fat: 1.0, carb: 1.0, sodium: 1.0, calcium: 1.0 },
    qualityWeight: 1.6,
    blurb: '按膳食指南单餐推荐量走，均衡为主',
  },
  muscle: {
    goal: 'muscle',
    label: '增肌',
    factor: { energy: 1.25, protein: 1.9, fat: 1.15, carb: 1.25, sodium: 1.15, calcium: 1.1 },
    qualityWeight: 1.0,
    blurb: '拉高总能量与蛋白质，碳水同步上以保证训练供能',
  },
};

export interface MealPreset {
  meal: MealName;
  label: string;
  /** 餐次能量占比系数（相对单餐基准） */
  scale: number;
}

export const MEAL_PRESETS: Record<MealName, MealPreset> = {
  breakfast: { meal: 'breakfast', label: '早餐', scale: 0.8 },
  lunch: { meal: 'lunch', label: '午餐', scale: 1.0 },
  dinner: { meal: 'dinner', label: '晚餐', scale: 0.9 },
  snack: { meal: 'snack', label: '加餐/夜宵', scale: 0.45 },
};

/**
 * 容差（half = 「得分衰减到 0.5 时离目标的距离」占目标值的比例）
 *  - halfLow  : Infinity 表示低于目标不扣分（如钠、钙）
 *  - halfHigh : Infinity 表示高于目标不扣分（如钙）
 * 这是软评分的唯一形状来源，全程没有硬阈值。
 */
const TOLERANCE: Record<NutrientKey, { halfLow: number; halfHigh: number; weight: number }> = {
  energy: { halfLow: 0.3, halfHigh: 0.2, weight: 1.0 },
  // 蛋白质上侧容差给得宽：多吃蛋白本身无碍，但过量同样意味着多余热量，所以仍会缓慢扣分
  protein: { halfLow: 0.35, halfHigh: 0.5, weight: 1.5 },
  fat: { halfLow: 0.55, halfHigh: 0.25, weight: 1.0 },
  carb: { halfLow: 0.4, halfHigh: 0.3, weight: 0.8 },
  sodium: { halfLow: Infinity, halfHigh: 0.35, weight: 1.2 },
  calcium: { halfLow: 0.6, halfHigh: Infinity, weight: 0.5 },
};

/** --set 支持的中文/英文别名 */
const OVERRIDE_ALIASES: Record<string, NutrientKey> = {
  energy: 'energy',
  kcal: 'energy',
  能量: 'energy',
  热量: 'energy',
  卡路里: 'energy',
  protein: 'protein',
  蛋白质: 'protein',
  蛋白: 'protein',
  fat: 'fat',
  脂肪: 'fat',
  carb: 'carb',
  carbs: 'carb',
  carbohydrate: 'carb',
  碳水: 'carb',
  碳水化合物: 'carb',
  sodium: 'sodium',
  na: 'sodium',
  钠: 'sodium',
  calcium: 'calcium',
  ca: 'calcium',
  钙: 'calcium',
};

export function parseOverrideKey(raw: string): NutrientKey | null {
  return OVERRIDE_ALIASES[raw.trim().toLowerCase()] ?? OVERRIDE_ALIASES[raw.trim()] ?? null;
}

const GOAL_ALIASES: Record<string, GoalName> = {
  'fat-loss': 'fat-loss',
  fatloss: 'fat-loss',
  cut: 'fat-loss',
  lose: 'fat-loss',
  减脂: 'fat-loss',
  减重: 'fat-loss',
  减肥: 'fat-loss',
  maintain: 'maintain',
  keep: 'maintain',
  维持: 'maintain',
  均衡: 'maintain',
  muscle: 'muscle',
  bulk: 'muscle',
  gain: 'muscle',
  增肌: 'muscle',
  增重: 'muscle',
};

export function parseGoal(raw: string | undefined): GoalName {
  if (!raw) return 'maintain';
  const key = raw.trim().toLowerCase();
  return GOAL_ALIASES[key] ?? GOAL_ALIASES[raw.trim()] ?? 'maintain';
}

const MEAL_ALIASES: Record<string, MealName> = {
  breakfast: 'breakfast',
  早餐: 'breakfast',
  早: 'breakfast',
  lunch: 'lunch',
  午餐: 'lunch',
  午饭: 'lunch',
  中餐: 'lunch',
  dinner: 'dinner',
  晚餐: 'dinner',
  晚饭: 'dinner',
  snack: 'snack',
  加餐: 'snack',
  夜宵: 'snack',
  宵夜: 'snack',
};

export function parseMeal(raw: string | undefined): MealName {
  if (!raw) return 'lunch';
  const key = raw.trim().toLowerCase();
  return MEAL_ALIASES[key] ?? MEAL_ALIASES[raw.trim()] ?? 'lunch';
}

export interface ResolvedTargets {
  profile: TargetProfile;
  goal: GoalName;
  meal: MealName;
  /** 能量质量维度的权重（随目标档位变化） */
  qualityWeight: number;
  /** 报告里要打印的口径说明 */
  notes: string[];
  overrides: Partial<Record<NutrientKey, number>>;
}

/**
 * 生成最终目标：基准 → 目标档位系数 → 餐次系数 → 单项覆盖
 */
export function resolveTargets(input: {
  goal: GoalName;
  meal: MealName;
  overrides?: Partial<Record<NutrientKey, number>>;
}): ResolvedTargets {
  const goalPreset = GOAL_PRESETS[input.goal];
  const mealPreset = MEAL_PRESETS[input.meal];
  const overrides = input.overrides ?? {};

  const profile = {} as TargetProfile;
  for (const key of NUTRIENT_KEYS) {
    const base = MEAL_BASELINE[key] * goalPreset.factor[key] * mealPreset.scale;
    const target = overrides[key] !== undefined ? overrides[key]! : round(base, key === 'energy' ? 0 : 1);
    const tol = TOLERANCE[key];
    profile[key] = {
      target,
      halfLow: tol.halfLow === Infinity ? Infinity : tol.halfLow * target,
      halfHigh: tol.halfHigh === Infinity ? Infinity : tol.halfHigh * target,
      weight: tol.weight,
    };
  }

  const notes: string[] = [];
  notes.push(
    `目标基准：《中国居民膳食指南（2022）》成人轻体力活动日参考量 ÷ 3 得到单餐基准，再按「${goalPreset.label}」档位（${goalPreset.blurb}）与「${mealPreset.label}」餐次系数 ${mealPreset.scale} 调整。`,
  );
  notes.push('钠采用单侧口径（低于目标不扣分，超过才衰减）；钙同理（高于目标不扣分）。');
  notes.push(
    `能量质量（空热量占比）维度的权重为 ${goalPreset.qualityWeight}：${goalPreset.label}档位下对「营养密度」的重视程度。`,
  );
  if (Object.keys(overrides).length > 0) {
    const parts = Object.entries(overrides).map(([k, v]) => `${k}=${v}`);
    notes.push(`已按命令行覆盖单项目标：${parts.join('、')}。`);
  }
  notes.push('以上为「目标标准」，非餐品数据；餐品营养数据全部来自 MCP list-nutrition-foods。');

  return {
    profile,
    goal: input.goal,
    meal: input.meal,
    qualityWeight: goalPreset.qualityWeight,
    notes,
    overrides,
  };
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
