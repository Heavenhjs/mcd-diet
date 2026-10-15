/**
 * 麦当劳 MCP 的「紧凑表格」文本格式解析
 *
 * 背景（实测）：list-nutrition-foods 返回的 data 字段不是 JSON 对象，而是一段字符串：
 *
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *     猪柳蛋麦满分,null,1618,387,23,21,25,846,243
 *
 *   · [N]        —— 数据行数
 *   · {a,b,c}    —— 列名
 *   · 缩进的行   —— 逗号分隔的取值，null 表示空
 *
 * 这是 MCP 为节省 token 采用的打包形式。若按普通 JSON 结构遍历去解析，会一行都拿不到，
 * 而「营养库为空」不会报错、只会静默产出 0 营养的结论 —— 属于最危险的那类 bug。
 * 因此这里独立成模块，并对格式做严格校验，解析不出就明确抛错而不是返回空数组。
 */

/** 表头匹配：[160]{col1,col2,...}: */
const HEADER_RE = /^\s*\[(\d+)\]\s*\{(.+?)\}\s*:\s*$/;

export interface PackedTable {
  /** 声明行数与实际行数（不一致时在报告里说明） */
  declaredRows: number;
  /** 列名，顺序与数据行一致 */
  columns: string[];
  /** 每行一个对象 */
  rows: Array<Record<string, string | number | null>>;
}

/** 看起来是不是紧凑表格（用于在多种包装里识别） */
export function looksLikePackedTable(value: unknown): boolean {
  return typeof value === 'string' && HEADER_RE.test(value.split(/\r?\n/, 1)[0] ?? '');
}

/** 单元格取值：null/空 → null；纯数字 → number；其余 → 原字符串 */
function parseCell(raw: string): string | number | null {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === 'NULL' || v === 'None' || v === '-') return null;
  // 只把「完整数字」当数字，避免把「5块」这种带单位的串误转
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * 解析紧凑表格。
 *
 * 名称列可能自带逗号（如「薯条, 大」），因此不能简单按逗号切分到底：
 * 表头已经告诉我们有几列，于是从右侧按列数切、把多出来的部分并回第一列。
 */
export function parsePackedTable(text: string): PackedTable {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    throw new Error('紧凑表格解析失败：内容为空');
  }

  const m = HEADER_RE.exec(lines[0]!);
  if (!m) {
    throw new Error(`紧凑表格解析失败：表头不符合 [N]{列名}: 格式 —— ${JSON.stringify(lines[0]!.slice(0, 120))}`);
  }

  const declaredRows = Number(m[1]);
  const columns = m[2]!
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (columns.length === 0) {
    throw new Error('紧凑表格解析失败：未解析出任何列名');
  }

  const rows: PackedTable['rows'] = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(',');
    if (parts.length < columns.length) {
      // 列数不足的行无法定位各列，跳过而非错位填充（错位会把钠读成钙）
      continue;
    }
    const overflow = parts.length - columns.length;
    const cells = overflow > 0 ? [parts.slice(0, overflow + 1).join(','), ...parts.slice(overflow + 1)] : parts;

    const obj: Record<string, string | number | null> = {};
    columns.forEach((c, i) => {
      obj[c] = parseCell(cells[i] ?? '');
    });
    rows.push(obj);
  }

  return { declaredRows, columns, rows };
}

/** 递归找出负载里所有「看起来像紧凑表格」的字符串 */
export function findPackedTables(payload: unknown, depth = 0): string[] {
  if (depth > 6 || payload === null || typeof payload !== 'object') return [];
  const out: string[] = [];
  const visit = (node: unknown, d: number): void => {
    if (d > 6) return;
    if (typeof node === 'string') {
      if (looksLikePackedTable(node)) out.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, d + 1);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) visit(v, d + 1);
  };
  visit(payload, depth);
  return out;
}

/**
 * 取出负载中的紧凑表格文本。
 * 兼容三种形态：负载本身就是表格字符串 / 包在 data 字段里 / 藏在更深的包装里。
 */
export function extractPackedTableText(payload: unknown): string | null {
  if (typeof payload === 'string') return looksLikePackedTable(payload) ? payload : null;
  if (payload === null || typeof payload !== 'object') return null;

  // 优先看常见的 data / result / content 字段，避免深层误抓
  const o = payload as Record<string, unknown>;
  for (const key of ['data', 'result', 'text', 'content']) {
    const v = o[key];
    if (typeof v === 'string' && looksLikePackedTable(v)) return v;
  }

  const found = findPackedTables(payload);
  return found.length > 0 ? found[0]! : null;
}
