/**
 * 输出渲染：终端彩色对齐表格 + Markdown 报告
 *
 * 中文/全角字符按 2 列宽计算，否则表格在终端里会歪。
 * 颜色只用于终端，Markdown 输出不含 ANSI 转义。
 */

import { NUTRIENT_KEYS, NUTRIENT_META, type DietReport, type NutrientKey, type NutrientScore } from './types.js';

/* ------------------------------------------------------------------ *
 * 显示宽度与对齐
 * ------------------------------------------------------------------ */

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const cur = displayWidth(s);
  const diff = width - cur;
  if (diff <= 0) return s;
  return align === 'right' ? ' '.repeat(diff) + s : s + ' '.repeat(diff);
}

function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/* ------------------------------------------------------------------ *
 * 颜色
 * ------------------------------------------------------------------ */

interface Palette {
  reset: string;
  bold: string;
  dim: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
  magenta: string;
  gray: string;
}

const PALETTE: Palette = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
  gray: '\u001b[90m',
};

function makePaint(enabled: boolean) {
  const p = enabled ? PALETTE : null;
  return {
    bold: (s: string) => (p ? `${p.bold}${s}${p.reset}` : s),
    dim: (s: string) => (p ? `${p.dim}${s}${p.reset}` : s),
    red: (s: string) => (p ? `${p.red}${s}${p.reset}` : s),
    green: (s: string) => (p ? `${p.green}${s}${p.reset}` : s),
    yellow: (s: string) => (p ? `${p.yellow}${s}${p.reset}` : s),
    blue: (s: string) => (p ? `${p.blue}${s}${p.reset}` : s),
    cyan: (s: string) => (p ? `${p.cyan}${s}${p.reset}` : s),
    magenta: (s: string) => (p ? `${p.magenta}${s}${p.reset}` : s),
    gray: (s: string) => (p ? `${p.gray}${s}${p.reset}` : s),
  };
}

type Paint = ReturnType<typeof makePaint>;

const BAND_LABEL: Record<NutrientScore['band'], string> = {
  'far-below': '明显不足',
  below: '偏少',
  'on-target': '达标',
  above: '偏多',
  'far-above': '明显超标',
  free: '充足',
};

function bandColor(paint: Paint, band: NutrientScore['band']): (s: string) => string {
  switch (band) {
    case 'far-below':
    case 'far-above':
      return paint.red;
    case 'below':
    case 'above':
      return paint.yellow;
    default:
      return paint.green;
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const over = ratio > 1 ? '>' : '';
  return `${'█'.repeat(Math.max(0, filled - over.length))}${over}${'░'.repeat(Math.max(0, width - filled))}`;
}

function num(v: number, unit: string): string {
  if (unit === 'kcal') return String(Math.round(v));
  const abs = Math.abs(v);
  if (abs >= 100) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toFixed(abs < 10 ? 1 : 1);
}

function signed(v: number, unit: string): string {
  const s = num(v, unit);
  return v >= 0 ? `+${s}` : s;
}

function goalLabel(goal: string): string {
  return goal === 'fat-loss' ? '减脂' : goal === 'muscle' ? '增肌' : '维持';
}

function mealLabel(meal: string): string {
  return meal === 'breakfast' ? '早餐' : meal === 'dinner' ? '晚餐' : meal === 'snack' ? '加餐/夜宵' : '午餐';
}

/** 简易表格：cols = [{header, width, align}] */
function table(
  paint: Paint,
  cols: Array<{ header: string; width: number; align?: 'left' | 'right' }>,
  rows: Array<{ cells: string[]; color?: (s: string, i: number) => string }>,
): string[] {
  const out: string[] = [];
  const sep = cols.map((c) => '─'.repeat(c.width)).join('  ');

  out.push(cols.map((c) => paint.dim(pad(c.header, c.width, c.align))).join('  '));
  out.push(paint.dim(sep));

  for (const row of rows) {
    const cells = row.cells.map((cell, i) => {
      const col = cols[i]!;
      const text = pad(truncate(cell, col.width), col.width, col.align);
      return row.color ? row.color(text, i) : text;
    });
    out.push(cells.join('  '));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 终端渲染
 * ------------------------------------------------------------------ */

export interface RenderOptions {
  color?: boolean;
}

export function renderTerminal(report: DietReport, opts: RenderOptions = {}): string {
  const paint = makePaint(opts.color ?? false);
  const L: string[] = [];
  const { context, outcome, score, finalScore, totals } = report;

  const rule = paint.dim('─'.repeat(74));

  L.push('');
  L.push(`${paint.bold('麦当劳膳食盘点')}  ${paint.gray('mcd-dev-diet')}`);
  L.push(
    paint.gray(
      `目标：${goalLabel(context.goal)} ｜ 餐次：${mealLabel(context.meal)} ｜ 数据来源：${
        context.source === 'mcp' ? '麦当劳 MCP Server（实时）' : '随包实测结构快照（演示，非实时）'
      }`,
    ),
  );
  if (context.storeCode) {
    L.push(paint.gray(`门店：${context.storeName ? `${context.storeName}（` : ''}${context.storeCode}${context.storeName ? '）' : ''}`));
  }
  L.push(rule);

  /* --- 1. 这顿吃了什么 --- */
  L.push('');
  L.push(paint.bold('一、这顿吃了什么'));
  L.push('');

  const itemCols = [
    { header: '餐品', width: 22 },
    { header: '份', width: 3, align: 'right' as const },
    { header: '能量', width: 7, align: 'right' as const },
    { header: '蛋白', width: 7, align: 'right' as const },
    { header: '脂肪', width: 7, align: 'right' as const },
    { header: '碳水', width: 7, align: 'right' as const },
    { header: '钠', width: 7, align: 'right' as const },
    { header: '钙', width: 6, align: 'right' as const },
    { header: '匹配', width: 8 },
  ];

  const itemRows = report.lines.map((l) => {
    const m = l.matched;
    const cells = [
      l.line.name,
      String(l.line.qty),
      m ? num(l.facts.energy, 'kcal') : '—',
      m ? num(l.facts.protein, 'g') : '—',
      m ? num(l.facts.fat, 'g') : '—',
      m ? num(l.facts.carb, 'g') : '—',
      m ? num(l.facts.sodium, 'mg') : '—',
      m ? num(l.facts.calcium, 'mg') : '—',
      matchLabel(l.matchType),
    ];
    return {
      cells,
      color: (s: string, i: number) => {
        if (!m) return i === 8 ? paint.red(s) : paint.gray(s);
        if (i === 8) return paint.green(s);
        return s;
      },
    };
  });

  L.push(...table(paint, itemCols, itemRows));

  // 套餐拆解：把组成摊开，让用户能自己核对口径
  const combos = report.lines.filter((l) => l.matchType === 'combo' && (l.line.components?.length ?? 0) > 0);
  if (combos.length > 0) {
    L.push('');
    L.push(paint.gray('  套餐按默认组成累加（倍率取套餐分组份数）：'));
    for (const c of combos) {
      L.push(
        paint.gray(`    · ${c.line.name} = ${componentText(c.line.components)}`),
      );
    }
  }

  if (report.unknown.length > 0) {
    L.push('');
    L.push(
      paint.red(
        `  未匹配 ${report.unknown.length} 项：${report.unknown.map((u) => `${u.name}x${u.qty}`).join('、')}（未计入总量，本工具不做营养估算）`,
      ),
    );
  }
  L.push('');
  L.push(
    paint.gray(
      `  匹配覆盖率 ${(report.coverage * 100).toFixed(0)}%　｜　共 ${report.lines.length} 种 ${report.lines.reduce(
        (a, l) => a + l.line.qty,
        0,
      )} 份`,
    ),
  );

  /* --- 2. 营养盘点 --- */
  L.push('');
  L.push(paint.bold('二、营养盘点（对比目标）'));
  L.push('');

  const nutCols = [
    { header: '营养素', width: 12 },
    { header: '摄入', width: 10, align: 'right' as const },
    { header: '目标', width: 10, align: 'right' as const },
    { header: '达成', width: 7, align: 'right' as const },
    { header: '进度', width: 14 },
    { header: '软评分', width: 7, align: 'right' as const },
    { header: '状态', width: 10 },
  ];

  const nutRows = NUTRIENT_KEYS.map((key) => {
    const n = score.perNutrient[key];
    const cells = [
      `${n.label}`,
      `${num(n.value, n.unit)} ${n.unit}`,
      `${num(n.target, n.unit)} ${n.unit}`,
      `${(n.ratio * 100).toFixed(0)}%`,
      bar(n.ratio, 14),
      n.score.toFixed(2),
      BAND_LABEL[n.band],
    ];
    return {
      cells,
      color: (s: string, i: number) => {
        if (i === 0) return paint.bold(s);
        if (i === 4) return bandColor(paint, n.band)(s);
        if (i === 5) return n.score >= 0.85 ? paint.green(s) : n.score >= 0.5 ? paint.yellow(s) : paint.red(s);
        if (i === 6) return bandColor(paint, n.band)(s);
        return s;
      },
    };
  });

  L.push(...table(paint, nutCols, nutRows));

  // 第 7 个维度：能量质量（空热量占比）
  const q = score.quality;
  const qColor = q.score >= 0.85 ? paint.green : q.score >= 0.7 ? paint.cyan : q.score >= 0.5 ? paint.yellow : paint.red;
  L.push('');
  L.push(
    `  ${pad(paint.bold('能量质量'), 12)}空热量占比 ${pad(`${(q.emptyShare * 100).toFixed(0)}%`, 5, 'right')}  ${qColor(
      bar(q.score, 14),
    )}  ${qColor(`软评分 ${q.score.toFixed(2)}（${q.label}）`)}`,
  );
  L.push(
    paint.gray(
      '  「空热量」= 每 100 kcal 里蛋白质与钙的密度都偏低的能量（如含糖饮料）。它不算营养缺口，但会让这顿的「热量质量」变差。',
    ),
  );

  /* --- 3. 平衡分 --- */
  L.push('');
  L.push(paint.bold('三、这顿的平衡分'));
  L.push('');

  const scoreBar = bar(score.score, 30);
  const scoreColor = score.score >= 0.85 ? paint.green : score.score >= 0.6 ? paint.yellow : paint.red;
  L.push(`  ${scoreColor(paint.bold(`${score.score100.toFixed(1)} / 100`))}   ${scoreColor(scoreBar)}`);
  L.push(
    paint.gray(
      '  软评分口径：单营养素得分 = 1/(1+(偏离/容差)²)，越接近目标越高；总分 = 加权算术均值与几何均值的混合（几何占比 40%，放大短板）。参与维度：6 个营养素 + 1 个能量质量。',
    ),
  );

  /* --- 4. 还能加点啥 --- */
  L.push('');
  L.push(paint.bold('四、还能加点啥让这顿更平衡'));
  L.push('');

  if (report.suppressed) {
    L.push(paint.yellow('  本次刻意不出加餐建议。'));
    L.push('');
    L.push(`  ${paint.yellow('原因')}：${report.suppressed.reason}`);
    L.push('');
    L.push(
      paint.gray(
        '  本工具的前提是「所有营养数值都来自 MCP，不做估算」；既然这一顿有一部分查不到，' +
          '那么在残缺基线上算出的缺口就不可信，宁可不给建议。',
      ),
    );
  } else if (outcome.picked.length === 0) {
    if (outcome.removals.length > 0) {
      L.push(paint.yellow('  这顿已经在目标之上，再加任何一样都会拉低平衡分。建议从「减项」入手：'));
      L.push('');
      for (const r of outcome.removals) {
        L.push(
          `  ${paint.yellow('减')} ${paint.bold(r.name)}${r.qty > 1 ? ` x${r.qty}` : ''}　平衡分 ${signed(
            Math.round(r.delta * 1000) / 10,
            '',
          )} 分　${paint.gray(`主要改善：${r.helps.join('、') || '—'}`)}`,
        );
      }
    } else {
      L.push(paint.green('  这顿已经很接近目标了，没有值得再加的东西 —— 保持现状就是最优解。'));
    }
  } else {
    let step = 1;
    for (const rec of outcome.picked) {
      const priceText =
        rec.price.amount === null
          ? paint.gray('价格未知')
          : `${paint.cyan(`¥${rec.price.amount.toFixed(2)}`)}${paint.gray(
              rec.price.source === 'mcp-live' ? '（MCP 实时价）' : '（本地参价）',
            )}`;

      L.push(
        `  ${paint.green(`+${step}`)} ${paint.bold(rec.name)}${
          rec.kind === 'combo' ? paint.gray('（套餐）') : ''
        }  ${priceText}  ${paint.green(
          `平衡分 +${(Math.round(rec.delta * 1000) / 10).toFixed(1)}`,
        )}${rec.category ? paint.gray(`　[${rec.category}]`) : ''}`,
      );
      if (rec.kind === 'combo' && rec.components?.length) {
        L.push(`      ${paint.gray(`按默认组成拆解：${componentText(rec.components)}`)}`);
      }
      for (const reason of rec.reasons) {
        L.push(`      ${paint.gray('·')} ${reason}`);
      }
      L.push('');
      step++;
    }
    L.push(
      `  ${paint.bold('加上之后：')} ${score.score100.toFixed(1)} → ${paint.green(
        finalScore.score100.toFixed(1),
      )} ${paint.gray('分')}`,
    );
  }

  /* --- 5. 其他候选 --- */
  const pickedCodes = new Set(outcome.picked.map((p) => p.code));
  const others = outcome.ranked.filter((r) => !pickedCodes.has(r.code));
  if (others.length > 0) {
    L.push('');
    L.push(paint.bold('五、其他可考虑的候选'));
    L.push('');
    const candCols = [
      { header: '候选', width: 22 },
      { header: '平衡分增益', width: 11, align: 'right' as const },
      { header: '价格', width: 12, align: 'right' as const },
      { header: '主要补什么', width: 30 },
    ];
    const candRows = others.map((r) => ({
      cells: [
        r.kind === 'combo' ? `${r.name}（套餐）` : r.name,
        `+${(Math.round(r.delta * 1000) / 10).toFixed(1)}`,
        r.price.amount === null ? '—' : `¥${r.price.amount.toFixed(2)}`,
        r.fixes.map((f) => f.label).join('、') || '—',
      ],
      color: (s: string, i: number) => (i === 1 ? paint.green(s) : i === 3 ? paint.gray(s) : s),
    }));
    L.push(...table(paint, candCols, candRows));
    L.push('');
  }

  /* --- 5b. 候选池构成 --- */
  if (report.catalog) {
    const c = report.catalog;
    L.push('');
    L.push(
      paint.gray(
        `  候选池：营养库 ${c.nutritionRows} 条 ｜ 门店在售 ${c.menuCodes} 个餐品码 ｜ 取到详情 ${c.detailOk} 个 → ` +
          `可算营养 ${c.poolSize} 个（单品 ${c.singles} + 套餐拆解 ${c.combos}）｜ 排除已点 ${outcome.stats.excludedCount} 个 ｜ ` +
          `本轮实际候选 ${outcome.stats.candidateSize} 个`,
      ),
    );
    if (c.fromCache) L.push(paint.gray(`  菜单数据来自缓存（抓取于 ${c.fetchedAt}），加 --refresh 可强制重抓。`));
    if (c.excluded.length > 0) {
      L.push('');
      L.push(paint.gray(`  以下 ${c.excluded.length} 个在售餐品因拿不到营养数据被排除（不做估算）：`));
      for (const e of c.excluded.slice(0, 12)) {
        L.push(paint.gray(`    · ${e.name}：${e.reason}`));
      }
      if (c.excluded.length > 12) L.push(paint.gray(`    · …另有 ${c.excluded.length - 12} 个，见 --json 输出的 catalog 段`));
    }
  }

  /* --- 6. 数据说明 --- */
  L.push('');
  L.push(rule);
  L.push(paint.bold('数据说明'));
  L.push('');
  for (const a of report.assumptions) L.push(`  - ${a}`);
  for (const p of report.provenance) L.push(`  - ${p}`);
  if (report.assumptions.length === 0 && report.provenance.length === 0) L.push('  - 无');
  L.push('');
  L.push(paint.gray(`  生成时间：${context.generatedAt}`));
  L.push(
    paint.gray('  本工具输出仅供参考，不构成医疗或营养建议；餐品信息与价格以麦当劳官方渠道实时结果为准。'),
  );
  L.push('');

  return L.join('\n');
}

function matchLabel(t: string): string {
  switch (t) {
    case 'menu':
      return '目录';
    case 'combo':
      return '套餐拆解';
    case 'exact':
      return '精确';
    case 'contains':
      return '包含';
    case 'fuzzy':
      return '模糊';
    default:
      return '未匹配';
  }
}

/** 套餐组成的一行说明 */
function componentText(components: Array<{ name: string; qty: number }> | undefined): string {
  if (!components || components.length === 0) return '';
  return components.map((c) => `${c.qty > 1 ? `${c.qty}×` : ''}${c.name}`).join(' + ');
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染
 * ------------------------------------------------------------------ */

function mdTable(headers: string[], rows: string[][]): string {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

export function renderMarkdown(report: DietReport): string {
  const { context, outcome, score, finalScore } = report;
  const L: string[] = [];

  L.push('# 麦当劳膳食盘点报告');
  L.push('');
  L.push(
    `> 目标：**${goalLabel(context.goal)}**　｜　餐次：**${mealLabel(context.meal)}**　｜　数据来源：**${
      context.source === 'mcp' ? '麦当劳 MCP Server（实时）' : '随包实测结构快照（演示，非 MCP 实时）'
    }**`,
  );
  if (context.storeCode) {
    L.push(`> 门店：**${context.storeName ? `${context.storeName}（` : ''}${context.storeCode}${context.storeName ? '）' : ''}**`);
  }
  L.push('');

  /* 一 */
  L.push('## 一、这顿吃了什么');
  L.push('');
  L.push(
    mdTable(
      ['餐品', '份数', '能量 (kcal)', '蛋白质 (g)', '脂肪 (g)', '碳水 (g)', '钠 (mg)', '钙 (mg)', '匹配方式'],
      report.lines.map((l) => [
        l.line.name,
        String(l.line.qty),
        l.matched ? num(l.facts.energy, 'kcal') : '—',
        l.matched ? num(l.facts.protein, 'g') : '—',
        l.matched ? num(l.facts.fat, 'g') : '—',
        l.matched ? num(l.facts.carb, 'g') : '—',
        l.matched ? num(l.facts.sodium, 'mg') : '—',
        l.matched ? num(l.facts.calcium, 'mg') : '—',
        l.matched ? matchLabel(l.matchType) : '**未匹配**',
      ]),
    ),
  );
  L.push('');
  L.push(
    mdTable(
      ['营养素', '摄入', '目标', '达成率', '软评分', '状态'],
      [
        ...NUTRIENT_KEYS.map((k) => {
          const n = score.perNutrient[k];
          return [
            n.label,
            `${num(n.value, n.unit)} ${n.unit}`,
            `${num(n.target, n.unit)} ${n.unit}`,
            `${(n.ratio * 100).toFixed(0)}%`,
            n.score.toFixed(2),
            BAND_LABEL[n.band],
          ];
        }),
        [
          '能量质量（空热量占比）',
          `${(score.quality.emptyShare * 100).toFixed(0)}%`,
          '越低越好',
          '—',
          score.quality.score.toFixed(2),
          score.quality.label,
        ],
      ],
    ),
  );
  L.push('');
  L.push(
    '> 「空热量」指每 100 kcal 中蛋白质与钙密度都偏低的能量（典型如含糖饮料）。它不影响营养缺口，但会拉低这顿的热量质量。',
  );
  L.push('');
  if (report.unknown.length > 0) {
    L.push(
      `> ⚠️ 未匹配 MCP 营养库的餐品：**${report.unknown.map((u) => u.name).join('、')}**，已按 0 计入并单独列出。`,
    );
    L.push('> 本工具不接受估算，因此不会用同类餐品或均值替代。');
    L.push('');
  }
  L.push(`匹配覆盖率：**${(report.coverage * 100).toFixed(0)}%**`);
  L.push('');

  // 套餐拆解口径
  const combos = report.lines.filter((l) => l.matchType === 'combo' && (l.line.components?.length ?? 0) > 0);
  if (combos.length > 0) {
    L.push('**套餐拆解口径**（倍率取套餐分组份数，组成项均来自 MCP 营养库）：');
    L.push('');
    for (const c of combos) L.push(`- ${c.line.name} = ${componentText(c.line.components)}`);
    L.push('');
  }

  /* 二 */
  L.push('## 二、这顿的平衡分');
  L.push('');
  L.push(`**${score.score100.toFixed(1)} / 100**`);
  L.push('');
  L.push('软评分口径：单营养素得分 `1/(1+(偏离/容差)²)`，越接近目标越高，无硬阈值；');
  L.push('总分 = 加权算术均值与加权几何均值的混合（几何占比 40%），让单项短板被放大。');
  L.push('参与维度 = 6 个营养素 + 1 个能量质量（空热量占比），共 7 个。');
  L.push('');

  /* 三 */
  L.push('## 三、还能加点啥让这顿更平衡');
  L.push('');
  if (report.suppressed) {
    L.push('> ⚠️ **本次刻意不出加餐建议。**');
    L.push('>');
    L.push(`> 原因：${report.suppressed.reason}`);
    L.push('>');
    L.push(
      '> 本工具的前提是「所有营养数值都来自 MCP，不做估算」；既然这一顿有一部分查不到，那么在残缺基线上算出的缺口就不可信，宁可不给建议。',
    );
    L.push('');
  } else if (outcome.picked.length === 0) {
    if (outcome.removals.length > 0) {
      L.push('这顿各项已普遍超过目标，再加入任何单品都会拉低平衡分。建议改为「减项」：');
      L.push('');
      L.push(
        mdTable(
          ['建议去掉', '份数', '平衡分变化', '主要改善'],
          outcome.removals.map((r) => [
            r.name,
            String(r.qty),
            `+${(Math.round(r.delta * 1000) / 10).toFixed(1)}`,
            r.helps.join('、') || '—',
          ]),
        ),
      );
      L.push('');
    } else {
      L.push('这顿已经很接近目标，没有值得再加的单品。');
      L.push('');
    }
  } else {
    let step = 1;
    for (const rec of outcome.picked) {
      const priceText =
        rec.price.amount === null
          ? '价格未知'
          : `¥${rec.price.amount.toFixed(2)}（${rec.price.source === 'mcp-live' ? 'MCP 实时价' : '本地参考均价'}）`;
      L.push(`### ${step}. ${rec.name}${rec.kind === 'combo' ? '（套餐）' : ''}　${priceText}　平衡分 +${(Math.round(rec.delta * 1000) / 10).toFixed(1)}`);
      L.push('');
      if (rec.kind === 'combo' && rec.components?.length) {
        L.push(`按默认组成拆解：${componentText(rec.components)}`);
        L.push('');
      }
      for (const reason of rec.reasons) L.push(`- ${reason}`);
      L.push('');
      step++;
    }
    L.push(`加上之后的总分：**${score.score100.toFixed(1)} → ${finalScore.score100.toFixed(1)}**`);
    L.push('');
  }

  /* 四 */
  const pickedCodes = new Set(outcome.picked.map((p) => p.code));
  const others = outcome.ranked.filter((r) => !pickedCodes.has(r.code));
  if (others.length > 0) {
    L.push('## 四、其他可考虑的候选');
    L.push('');
    L.push(
      mdTable(
        ['候选', '类型', '平衡分增益', '价格', '主要补什么'],
        others.map((r) => [
          r.name,
          r.kind === 'combo' ? '套餐' : '单品',
          `+${(Math.round(r.delta * 1000) / 10).toFixed(1)}`,
          r.price.amount === null ? '—' : `¥${r.price.amount.toFixed(2)}`,
          r.fixes.map((f) => `${f.label} +${num(f.deltaValue, f.unit)}${f.unit}`).join('、') || '—',
        ]),
      ),
    );
    L.push('');
  }

  /* 五 */
  L.push('## 五、数据说明');
  L.push('');
  for (const a of report.assumptions) L.push(`- ${a}`);
  for (const p of report.provenance) L.push(`- ${p}`);
  if (report.catalog) {
    const c = report.catalog;
    L.push(
      `- 候选池：营养库 ${c.nutritionRows} 条 → 门店在售 ${c.menuCodes} 个餐品码 → 取到详情 ${c.detailOk} 个 → ` +
        `可算营养 ${c.poolSize} 个（单品 ${c.singles} + 套餐拆解 ${c.combos}）→ 排除已点 ${outcome.stats.excludedCount} 个 → 本轮候选 ${outcome.stats.candidateSize} 个`,
    );
    if (c.fromCache) L.push(`- 菜单数据来自缓存（抓取于 ${c.fetchedAt}），加 \`--refresh\` 可强制重抓。`);
    if (c.excluded.length > 0) {
      L.push('');
      L.push(`**以下 ${c.excluded.length} 个在售餐品因拿不到营养数据被排除**（本工具不做估算）：`);
      L.push('');
      L.push(
        mdTable(
          ['餐品', '排除原因'],
          c.excluded.map((e) => [e.name, e.reason]),
        ),
      );
      L.push('');
    }
  }
  L.push(`- 生成时间：${context.generatedAt}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(
    '本工具输出仅供参考，不构成医疗或营养建议；餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。',
  );
  L.push('');
  L.push('_本作品为麦当劳程序员节创意开发大赛参赛作品，非麦当劳官方产品。_');
  L.push('');

  return L.join('\n');
}
