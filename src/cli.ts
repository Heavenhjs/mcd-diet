#!/usr/bin/env node
/**
 * 【核心文件 3 / 3】CLI 入口
 *
 * 流程：
 *   1. 解析参数 / 读环境变量
 *   2. 建立 MCP 数据通道（必须有 Token，除非显式 --demo）
 *   3. 解析订单（文件 / 手输 / 历史订单），并从历史订单里推导门店
 *   4. 构建候选目录（营养库 + 门店菜单 + 每个餐品的详情，带磁盘缓存）
 *   5. 营养累加 → 软评分 → 贪心推荐 → 补价格
 *   6. 打印终端表格，并写出 Markdown 报告
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CLIENT_VERSION, createGateway, McpError, TOOLS, unwrapData, type ToolGateway } from './mcp.js';
import { accumulate } from './nutrition.js';
import { extractOrders, parseInlineItems, parseOrderFile, extractOrderLines, pickLatestOrder } from './order.js';
import { fetchCatalog, fetchNutritionOnly, searchStores, type Catalog } from './menu.js';
import { attachPrices, loadBaseline, summarizeSchema, type PriceUnit } from './price.js';
import { baselineOnlyOutcome, recommendAddOns } from './recommend.js';
import { renderMarkdown, renderTerminal } from './report.js';
import { parseGoal, parseMeal, parseOverrideKey, resolveTargets } from './targets.js';
import type { DietReport, NutrientKey, OrderLine } from './types.js';

const VERSION = CLIENT_VERSION;
/** 对外 JSON 的输出格式版本号（消费方据此做兼容判断） */
export const REPORT_SCHEMA = 'mcd-dev-diet/report@1';
// 注意：必须用 fileURLToPath —— URL.pathname 在含中文/空格的路径下会被百分号编码
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 项目根目录（server.ts 等外部入口需要用它定位 fixtures / data） */
export const PROJECT_ROOT = PKG_ROOT;

/* ------------------------------------------------------------------ *
 * .env 极简加载（不引入依赖）
 * ------------------------------------------------------------------ */

export async function loadDotEnv(dir: string): Promise<void> {
  for (const name of ['.env.local', '.env']) {
    try {
      const text = await readFile(path.join(dir, name), 'utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      /* 没有 .env 也正常 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

export interface CliArgs {
  command: 'diet' | 'probe' | 'help' | 'version';
  order?: string;
  items?: string;
  fromHistory?: number;
  goal: string;
  meal: string;
  overrides: Partial<Record<NutrientKey, number>>;
  storeCode?: string;
  storeName?: string;
  /** 1=到店（含得来速），2=外送（含团餐） */
  orderType: number;
  /** 1=到店自提，2=麦乐送，5=得来速，6=团餐 */
  beType: number;
  /** 外送/团餐场景必填（orderType=2） */
  beCode?: string;
  city?: string;
  keyword?: string;
  top: number;
  maxAdd: number;
  allowRepeat: boolean;
  /** 匹配覆盖率低于此值就不出加餐建议（残缺基线上给建议会误导） */
  minCoverage: number;
  price: boolean;
  priceUnit: PriceUnit;
  color: boolean;
  json: boolean;
  out?: string;
  writeOut: boolean;
  energyUnit: 'kj' | 'kcal';
  cacheDir: string;
  noCache: boolean;
  refreshCache: boolean;
  demo: boolean;
  verbose: boolean;
}

export interface ParseOutcome {
  args: CliArgs;
  errors: string[];
}

const HELP = `
mcd-dev-diet v${VERSION} —— 麦当劳膳食盘点与加餐推荐

用法：
  mcd-dev-diet --order <订单.json> [选项]
  mcd-dev-diet --items "巨无霸x1,中薯条x1,无糖冰美式" [选项]
  mcd-dev-diet --from-history [选项]
  mcd-dev-diet probe            打印关键 MCP Tool 的实际入参 schema

输入（三选一）：
  --order <path>        订单 JSON 文件（直接吃 MCP query-order / order-list 的返回）
  --items "<text>"      手输餐品，用逗号分隔；数量写 x2 或空格加数字
  --from-history [n]    从麦当劳 MCP 拉最近的历史订单（默认最近 1 单）

目标标准：
  --goal <档位>         减脂 / 维持 / 增肌（也接受 fat-loss / maintain / muscle），默认维持
  --meal <餐次>         早餐 / 午餐 / 晚餐 / 加餐（也接受 breakfast/lunch/dinner/snack），默认午餐
  --set <键=值>         覆盖单项营养目标，可重复。键支持 kcal/能量、protein/蛋白质、fat/脂肪、
                        carb/碳水、sodium/钠、calcium/钙
                        例：--set kcal=500 --set protein=35

价格：
  --no-price            跳过价格查询（默认会实时优先、失败降级本地均价）
  --store <code>       门店编码（不填则从历史订单里自动识别，实测订单自带 storeCode）
  --store-name <name>  门店名称（仅用于展示）
  --city <name>        配合 --keyword：按城市 + 关键词搜一家最近的门店（无历史订单时用）
  --keyword <text>     配合 --city 使用，两者必须同时提供
  --order-type <t>     1/pickup（到店，默认）| 2/delivery（外送）
  --be-type <n>        1=到店自提，2=麦乐送，5=得来速，6=团餐；默认 1
  --be-code <code>     外送/团餐(orderType=2)必填；到店场景**不能传**（传了 MCP 会报错）
  --price-unit <u>     金额单位口径：auto（整数按分、小数按元）| fen | yuan，默认 auto

推荐：
  --max-add <n>         最多推荐几样，默认 2
  --top <n>             候选榜单条数，默认 5
  --allow-repeat        允许推荐已点过的餐品（默认排除，对应约束 4）
  --min-coverage <r>    匹配覆盖率低于该值就不出加餐建议，默认 0.5
                        （未匹配部分可能含大量能量，残缺基线上给建议会误导）

菜单缓存：
  --no-cache            本次不使用缓存（仍会写入）
  --refresh             忽略已有缓存，强制重抓
  --cache-dir <path>    缓存目录，默认 out/cache

输出：
  --out <path>          Markdown 报告路径，默认 out/diet-report.md
  --no-out              不写 Markdown 文件
  --json                额外输出结构化 JSON 到 stdout
  --no-color            关闭 ANSI 颜色
  --energy-unit <u>     营养数据未标单位时的能量口径：kj | kcal，默认 kj

其他：
  --demo                使用随包附带的实测结构快照（非 MCP 实时，报告中会强制标注）
  --verbose             打印 MCP 交互细节与目录抓取进度
  -h, --help            显示帮助
  -v, --version         显示版本

环境变量：
  MCD_MCP_TOKEN         必填。麦当劳 MCP Token（https://open.mcd.cn/mcp）
  MCD_MCP_URL           可选，默认 https://mcp.mcd.cn
  MCD_STORE_CODE        可选，默认门店编码
  MCD_BE_CODE           可选，外送/团餐的 beCode

示例：
  # 分析刚吃的那顿（门店自动从历史订单识别）
  mcd-dev-diet --from-history --goal 减脂

  # 手输
  mcd-dev-diet --items "巨无霸x1,中薯条x1" --goal 减脂 --store 1410005

  # 吃订单 JSON
  mcd-dev-diet --order my-order.json --goal maintain --meal 午餐 --out report.md

  # 没有历史订单、只记得附近地标时，按城市 + 关键词搜门店
  mcd-dev-diet --items "巨无霸x1,中薯条x1" --city 福州 --keyword 五四路

  # 没有 Token 时先看效果
  npm run demo
`;

export function parseArgs(argv: string[]): ParseOutcome {
  const args: CliArgs = {
    command: 'diet',
    goal: 'maintain',
    meal: 'lunch',
    overrides: {},
    orderType: 1,
    beType: 1,
    top: 5,
    maxAdd: 2,
    allowRepeat: false,
    minCoverage: 0.5,
    price: true,
    priceUnit: 'auto',
    color: true,
    json: false,
    writeOut: true,
    energyUnit: 'kj',
    cacheDir: path.join(PKG_ROOT, 'out', 'cache'),
    noCache: false,
    refreshCache: false,
    demo: false,
    verbose: false,
    storeCode: process.env.MCD_STORE_CODE,
    beCode: process.env.MCD_BE_CODE,
  };
  const errors: string[] = [];

  const need = (i: number, flag: string): string | null => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      errors.push(`${flag} 缺少取值`);
      return null;
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case 'probe':
        args.command = 'probe';
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        break;
      case '-v':
      case '--version':
        args.command = 'version';
        break;
      case '--order': {
        const v = need(i, a);
        if (v) {
          args.order = v;
          i++;
        }
        break;
      }
      case '--items': {
        const v = need(i, a);
        if (v) {
          args.items = v;
          i++;
        }
        break;
      }
      case '--from-history': {
        const next = argv[i + 1];
        if (next && /^\d+$/.test(next)) {
          args.fromHistory = Number(next);
          i++;
        } else {
          args.fromHistory = 1;
        }
        break;
      }
      case '--goal': {
        const v = need(i, a);
        if (v) {
          args.goal = v;
          i++;
        }
        break;
      }
      case '--meal': {
        const v = need(i, a);
        if (v) {
          args.meal = v;
          i++;
        }
        break;
      }
      case '--set': {
        const v = need(i, a);
        if (v) {
          const eq = v.indexOf('=');
          if (eq === -1) errors.push(`--set 需要写成 键=值，例如 --set kcal=500（收到 ${v}）`);
          else {
            const key = parseOverrideKey(v.slice(0, eq));
            const value = Number(v.slice(eq + 1));
            if (!key) errors.push(`--set 不认识的营养项目标：${v.slice(0, eq)}`);
            else if (!Number.isFinite(value) || value <= 0) errors.push(`--set ${key} 的取值必须是正数`);
            else args.overrides[key] = value;
          }
          i++;
        }
        break;
      }
      case '--store': {
        const v = need(i, a);
        if (v) {
          args.storeCode = v;
          i++;
        }
        break;
      }
      case '--store-name': {
        const v = need(i, a);
        if (v) {
          args.storeName = v;
          i++;
        }
        break;
      }
      // 注意：这里刻意**不支持** --address。
      // 实测 calculate-price 的外送场景是用 storeCode + beCode 定位的，不接自由文本地址，
      // 与其收下一个用不上的参数让用户以为生效了，不如落到「未知参数」分支报出来。
      case '--be-code': {
        const v = need(i, a);
        if (v) {
          args.beCode = v;
          i++;
        }
        break;
      }
      case '--be-type': {
        const v = need(i, a);
        if (v) {
          const n = Number(v);
          if (![1, 2, 5, 6].includes(n)) errors.push('--be-type 只能是 1(到店自提) / 2(麦乐送) / 5(得来速) / 6(团餐)');
          else args.beType = n;
          i++;
        }
        break;
      }
      case '--city': {
        const v = need(i, a);
        if (v) {
          args.city = v;
          i++;
        }
        break;
      }
      case '--keyword': {
        const v = need(i, a);
        if (v) {
          args.keyword = v;
          i++;
        }
        break;
      }
      case '--order-type': {
        const v = need(i, a);
        if (v) {
          // 同时接受实测的整数口径与旧的中文/英文别名
          const lower = v.toLowerCase();
          if (lower === 'delivery' || lower === '2' || lower === '外送' || lower === '麦乐送') args.orderType = 2;
          else if (lower === 'pickup' || lower === '1' || lower === '到店' || lower === '到店自取') args.orderType = 1;
          else errors.push('--order-type 只能是 1/pickup(到店) 或 2/delivery(外送)');
          i++;
        }
        break;
      }
      case '--price-unit': {
        const v = need(i, a);
        if (v) {
          if (!['auto', 'fen', 'yuan'].includes(v)) errors.push('--price-unit 只能是 auto / fen / yuan');
          else args.priceUnit = v as PriceUnit;
          i++;
        }
        break;
      }
      case '--cache-dir': {
        const v = need(i, a);
        if (v) {
          args.cacheDir = v;
          i++;
        }
        break;
      }
      case '--no-cache':
        args.noCache = true;
        break;
      case '--refresh':
        args.refreshCache = true;
        break;
      case '--top': {
        const v = need(i, a);
        if (v) {
          args.top = Math.max(1, Number(v) || 5);
          i++;
        }
        break;
      }
      case '--max-add': {
        const v = need(i, a);
        if (v) {
          args.maxAdd = Math.max(0, Number(v) || 0);
          i++;
        }
        break;
      }
      case '--min-coverage': {
        const v = need(i, a);
        if (v) {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 1) errors.push('--min-coverage 需要 0~1 之间的小数，例如 0.6');
          else args.minCoverage = n;
          i++;
        }
        break;
      }
      case '--out': {
        const v = need(i, a);
        if (v) {
          args.out = v;
          i++;
        }
        break;
      }
      case '--energy-unit': {
        const v = need(i, a);
        if (v) {
          if (v !== 'kj' && v !== 'kcal') errors.push('--energy-unit 只能是 kj 或 kcal');
          else args.energyUnit = v;
          i++;
        }
        break;
      }
      case '--allow-repeat':
        args.allowRepeat = true;
        break;
      case '--no-price':
        args.price = false;
        break;
      case '--no-color':
        args.color = false;
        break;
      case '--no-out':
        args.writeOut = false;
        break;
      case '--json':
        args.json = true;
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        if (a.startsWith('--')) errors.push(`未知参数：${a}`);
        break;
    }
  }

  const inputs = [args.order, args.items, args.fromHistory !== undefined ? 'history' : undefined].filter(Boolean);
  if (args.command === 'diet' && inputs.length === 0) {
    errors.push('必须提供输入：--order <文件> 或 --items "<文本>" 或 --from-history');
  }
  if (inputs.length > 1) {
    errors.push('--order / --items / --from-history 只能用一个');
  }
  if ((args.city && !args.keyword) || (!args.city && args.keyword)) {
    errors.push('--city 与 --keyword 必须同时提供（MCP query-nearby-stores 要求两者都在）');
  }

  return { args, errors };
}

/* ------------------------------------------------------------------ *
 * 订单来源
 * ------------------------------------------------------------------ */

interface ResolvedOrder {
  lines: OrderLine[];
  provenance: string;
  /** 从历史订单里读到的门店信息，可用于自动补全 storeCode */
  store?: { storeCode?: string; storeName?: string; beType?: string | number; orderType?: string | number; beCode?: string; orderId?: string };
}

async function resolveOrder(args: CliArgs, gateway: ToolGateway): Promise<ResolvedOrder> {
  if (args.order) {
    const lines = await parseOrderFile(args.order);
    return { lines, provenance: `订单来源：本地文件 ${args.order}（${lines.length} 种餐品）` };
  }
  if (args.items) {
    const lines = parseInlineItems(args.items);
    return { lines, provenance: `订单来源：命令行手输（${lines.length} 种餐品）` };
  }

  // 历史订单：order-list 拿列表 → 取最近一单 → 必要时用 query-order 补详情
  const wanted = args.fromHistory ?? 1;
  const listPayload = await gateway.callTool(TOOLS.orderList, {});
  const orders = extractOrders(listPayload);
  if (orders.length === 0) {
    throw new Error(
      'MCP order-list 没有返回任何历史订单。可以改用 --order <文件> 或 --items "<文本>" 指定这一顿。',
    );
  }
  if (wanted > 1) {
    console.error(`提示：--from-history 当前只处理最近 1 单（本次请求 ${wanted} 单），其余订单可用 --order 逐个分析。`);
  }

  const latest = pickLatestOrder(listPayload)!;
  let payload: unknown = listPayload;

  // order-list 的明细里套餐组成键名是 name/quantity；query-order 带更多字段，优先用它
  if (latest.orderId) {
    try {
      payload = await gateway.callTool(TOOLS.queryOrder, { orderId: latest.orderId });
    } catch (err) {
      if (args.verbose) console.error(`[order] query-order 失败，回退用 order-list 的明细：${(err as Error).message}`);
      payload = listPayload;
    }
  }

  let lines = extractOrderLines(payload);
  if (lines.length === 0) lines = extractOrderLines(listPayload);
  if (lines.length === 0) {
    throw new Error('没能从历史订单里解析出餐品明细，可改用 --order <文件> 或 --items "<文本>"');
  }

  // 门店信息要合并两个来源：实测 query-order **不返回 storeCode**，只有 storeName；
  // storeCode / beType / beCode 只在 order-list 里。少合并一处就会丢掉门店，进而查不到在售菜单。
  const detail = pickLatestOrder(payload);
  const merged = {
    orderId: detail?.orderId ?? latest.orderId,
    storeCode: latest.storeCode ?? detail?.storeCode,
    storeName: detail?.storeName ?? latest.storeName,
    beType: latest.beType ?? detail?.beType,
    orderType: latest.orderType ?? detail?.orderType,
    beCode: latest.beCode || detail?.beCode,
  };

  return {
    lines,
    store: merged,
    provenance: `订单来源：MCP ${TOOLS.orderList}${
      merged.orderId && payload !== listPayload ? ` + ${TOOLS.queryOrder}` : ''
    }（最近 1 单，orderId ${merged.orderId ?? '未知'}，${lines.length} 种餐品）`,
  };
}

/* ------------------------------------------------------------------ *
 * 门店解析
 * ------------------------------------------------------------------ */

interface StoreResolution {
  storeCode?: string;
  storeName?: string;
  orderType: number;
  beType: number;
  beCode?: string;
  note: string;
}

/**
 * 决定用哪家门店。
 *
 * 优先级：--store / MCD_STORE_CODE → 本次订单里的 storeCode → --city + --keyword 搜索 → 历史订单里的 storeCode → 放弃。
 * 从历史订单推导是刻意的：order-list 每条订单都带 storeCode/storeName，
 * 而 query-meals / calculate-price 又都必须有门店码，
 * 于是「分析我刚吃的那顿」这件事不该再要求用户手敲一遍门店编码。
 * --city + --keyword 排在历史订单之前，是因为用户既然显式说了自己在哪，就不该被一单旧订单的门店覆盖掉。
 */
async function resolveStore(args: CliArgs, order: ResolvedOrder, gateway: ToolGateway): Promise<StoreResolution> {
  if (args.storeCode) {
    return {
      storeCode: args.storeCode,
      storeName: args.storeName,
      orderType: args.orderType,
      beType: args.beType,
      beCode: args.beCode,
      note: `门店：使用命令行/环境变量指定的 ${args.storeCode}${args.storeName ? `（${args.storeName}）` : ''}`,
    };
  }

  const fromOrder = (s: { storeCode?: string; storeName?: string; beType?: string | number; orderType?: string | number; beCode?: string }, how: string): StoreResolution => {
    // 订单自带的 beType/orderType 优先，因为那才是这顿实际的下单方式
    const ob = Number(s.beType);
    const ot = Number(s.orderType);
    const beType = [1, 2, 5, 6].includes(ob) ? ob : args.beType;
    const orderType = [1, 2].includes(ot) ? ot : args.orderType;
    return {
      storeCode: s.storeCode,
      storeName: s.storeName ?? args.storeName,
      orderType,
      beType,
      beCode: s.beCode ?? args.beCode,
      note: `门店：${how} ${s.storeCode}${s.storeName ? `（${s.storeName}）` : ''}，下单方式 orderType=${orderType} beType=${beType}`,
    };
  };

  if (order.store?.storeCode) return fromOrder(order.store, '从本次订单识别');

  // 用户显式给了位置：用 query-nearby-stores 搜一家最近的。
  // （没有历史订单、也不记得门店编码的场景 —— 这正是这两个参数的用途。
  //   注意 searchType=2 是按位置搜索，searchType=1 是搜「我的收藏门店」，
  //   纯新用户收藏为空会报 600050，所以这里必须用 2。）
  if (args.city && args.keyword) {
    try {
      const stores = await searchStores(gateway, {
        city: args.city,
        keyword: args.keyword,
        beType: args.beType,
      });
      const picked = stores[0];
      if (picked) {
        if (stores.length > 1) {
          console.error(
            `[store] “${args.city} + ${args.keyword}”命中 ${stores.length} 家门店，取服务端返回的第一家（实测按距离升序） ` +
              `${picked.storeCode}${picked.storeName ? `（${picked.storeName}）` : ''}` +
              `${picked.distance != null ? `，${picked.distance}m` : ''}；换一家请用 --store <编码>`,
          );
        }
        return fromOrder(
          { storeCode: picked.storeCode, storeName: picked.storeName },
          `按「${args.city} + ${args.keyword}」搜到的第一家门店`,
        );
      }
      console.error(`[store] “${args.city} + ${args.keyword}”没有搜到门店，改用其它方式识别门店`);
    } catch (err) {
      console.error(`[store] query-nearby-stores 失败（${(err as Error).message}），改用其它方式识别门店`);
    }
  }

  // 手输 / 自定义 JSON 的场景没有订单门店信息：顺手查一下历史订单。
  // 演示模式同样走这里（fixture 里有订单快照），否则 --demo --items 会因为没门店而给不出建议。
  try {
    const listPayload = await gateway.callTool(TOOLS.orderList, {});
    const latest = pickLatestOrder(listPayload);
    if (latest?.storeCode) {
      return fromOrder(latest, '从历史订单自动识别');
    }
  } catch (err) {
    if (args.verbose) console.error(`[store] 查历史订单取门店失败：${(err as Error).message}`);
  }

  return {
    storeCode: undefined,
    storeName: args.storeName,
    orderType: args.orderType,
    beType: args.beType,
    beCode: args.beCode,
    note: args.city && args.keyword
      ? `门店：按「${args.city} + ${args.keyword}」未搜到可用门店，且历史订单里也没有门店信息，无法取门店菜单与实时价`
      : '门店：未指定 --store，且历史订单里也没有门店信息，无法取门店菜单与实时价',
  };
}

/* ------------------------------------------------------------------ *
 * probe
 * ------------------------------------------------------------------ */

async function runProbe(gateway: ToolGateway): Promise<void> {
  console.log(`数据通道：${gateway.label}\n`);
  const specs = await gateway.listTools();
  console.log(`该 MCP Server 共暴露 ${specs.length} 个 Tool：`);
  for (const s of specs) console.log(`  · ${s.name}`);
  console.log('');

  const interesting = [
    TOOLS.listNutritionFoods,
    TOOLS.queryMeals,
    TOOLS.queryMealDetail,
    TOOLS.calculatePrice,
    TOOLS.orderList,
    TOOLS.queryOrder,
    TOOLS.queryNearbyStores,
    TOOLS.nowTimeInfo,
  ];
  console.log('以下是本 Skill 实际调用的 Tool 及其入参 schema：\n');
  for (const name of interesting) {
    const spec = specs.find((s) => s.name === name);
    console.log(`▸ ${name}`);
    if (spec?.description) console.log(`  说明：${spec.description.split('\n')[0]}`);
    console.log(summarizeSchema(spec));
    console.log('');
  }
  console.log('提示：以上 schema 是运行时从 MCP tools/list 实时读到的，不是写死在代码里的。');
  console.log('      若麦当劳侧调整了字段，本 Skill 的解析层做了宽容处理；');
  console.log('      但仍建议接入新 Token / 新门店后先跑一次 probe 核对，再跑 diet。');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 【分析核心】跑完整条流水线，产出一份报告对象（不输出任何东西）。
 *
 * 之所以把它和「输出」拆开：Web 界面（src/server.ts）要复用同一条流水线。
 * 拆开之后 CLI 与 Web 走的是**同一份代码**，94 项自检保护的也就是这一份，
 * 不会出现「网页上算的」和「终端里算的」对不上的情况。
 */
export async function analyzeDiet(args: CliArgs): Promise<DietReport> {
  const fixturesDir = path.join(PKG_ROOT, 'fixtures');
  const baselineFile = await loadBaseline(path.join(PKG_ROOT, 'data', 'price-baseline.json'));

  const gateway = createGateway({
    demo: args.demo,
    token: process.env.MCD_MCP_TOKEN,
    url: process.env.MCD_MCP_URL,
    fixturesDir,
    verbose: args.verbose,
  });

  const provenance: string[] = [];
  const assumptions: string[] = [];

  if (!gateway.isLive) {
    assumptions.push(
      '当前运行在 --demo 演示模式，营养/菜单/价格数据来自随包附带的实测结构快照，不是 MCP 实时数据，仅用于在没有 Token 时验证流程。',
    );
  }

  /* --- 1. 订单（先做，因为历史订单里带门店信息） --- */
  const order = await resolveOrder(args, gateway);
  provenance.push(order.provenance);

  /* --- 2. 门店 --- */
  const store = await resolveStore(args, order, gateway);
  assumptions.push(store.note);

  /* --- 3. 候选目录：营养库 + 门店菜单 + 每个餐品详情 --- */
  // 演示模式默认安静，实时模式把抓取进度打出来（124 个餐品详情要跑十几秒，没进度会以为卡死）
  const catalogLog = (m: string): void => {
    if (gateway.isLive || args.verbose) console.error(`[catalog] ${m}`);
  };

  let catalog: Catalog;
  if (!store.storeCode) {
    // 没有门店就没法查「当前在售」，退化为「只盘点不建议」
    catalog = await fetchNutritionOnly(gateway);
    assumptions.push('没有可用门店编码，已跳过门店菜单抓取：本次只做营养盘点，不出加餐推荐。');
  } else {
    catalog = await fetchCatalog(gateway, {
      storeCode: store.storeCode,
      orderType: store.orderType,
      beType: store.beType,
      beCode: store.beCode,
      cacheDir: args.cacheDir,
      noCache: args.noCache,
      refresh: args.refreshCache,
      verbose: args.verbose,
      onProgress: catalogLog,
    });
  }

  const index = catalog.index;
  const products = catalog.products;
  provenance.push(...catalog.provenance);

  provenance.push(
    `营养库解析：${index.records.length} 条有效记录${
      index.declaredRows ? `（声明 ${index.declaredRows} 行，重复名已去重）` : ''
    }，数据形态 ${index.format === 'packed-table' ? '紧凑表格文本' : 'JSON 对象'}。`,
  );

  if (products.length > 0) {
    provenance.push(
      `候选池：门店在售 ${catalog.stats.menuCodes} 个餐品码 → 详情成功 ${catalog.stats.detailOk} 个 → ` +
        `可算出营养的 ${catalog.stats.poolSize} 个（单品 ${catalog.stats.singles} + 套餐拆解 ${catalog.stats.combos}），` +
        `其余 ${catalog.stats.excluded.length} 个因「营养库无对应」或「组成项缺数据」被排除。`,
    );
  }

  /* --- 4. 累加 --- */
  const acc = accumulate(order.lines, index, {
    menuByCode: catalog.byCode,
    menuByName: catalog.byName,
  });
  assumptions.push(...acc.assumptions);

  /* --- 5. 目标 --- */
  const targets = resolveTargets({
    goal: parseGoal(args.goal),
    meal: parseMeal(args.meal),
    overrides: args.overrides,
  });
  assumptions.push(...targets.notes);

  /* --- 6. 推荐 --- */
  const recommendationsUsable = acc.coverage >= args.minCoverage;
  const outcome = recommendationsUsable
    ? recommendAddOns({
        totals: acc.totals,
        lines: acc.lines,
        products,
        profile: targets.profile,
        maxAdd: args.maxAdd,
        topRanked: args.top,
        allowRepeat: args.allowRepeat,
        qualityWeight: targets.qualityWeight,
      })
    : baselineOnlyOutcome({
        totals: acc.totals,
        lines: acc.lines,
        profile: targets.profile,
        qualityWeight: targets.qualityWeight,
      });

  if (!recommendationsUsable) {
    const unknownNames = acc.unknown.map((u) => u.name).join('、');
    assumptions.push(
      `本次不出加餐建议：已有 ${acc.unknown.length} 项（${unknownNames}）在 MCP 营养库中查不到，` +
        `匹配覆盖率仅 ${(acc.coverage * 100).toFixed(0)}%，低于阈值 ${(args.minCoverage * 100).toFixed(0)}%。` +
        `未匹配的部分可能含大量能量与脂肪，按 0 计的总量是「残缺基线」，` +
        `在此之上推荐「再吃点啥」会把数据缺失误判成你没吃够。` +
        `营养盘点（上表）只覆盖已匹配到的部分，同样不代表这一顿的真实摄入。`,
    );
    if (catalog.stats.excluded.length > 0) {
      assumptions.push(
        `补充：这些餐品查不到营养的原因是麦当劳营养库只收录「常见餐品」，` +
          `而门店在售包含了季节/限定商品（本店在售里有 ${catalog.stats.excluded.length} 个餐品拿不到营养数据）。` +
          `若想要建议，可以改用 --items 手输你确定的单品，或用 --min-coverage 调低阈值。`,
      );
    }
  } else if (acc.coverage < 1) {
    assumptions.push(
      `提示：匹配覆盖率 ${(acc.coverage * 100).toFixed(0)}%，仍有 ${acc.unknown.length} 项未匹配。` +
        `下面按已匹配部分计算，真实摄入会高于表中数值，建议方向仍然有效但强度会被高估。`,
    );
  }

  if (products.length === 0 && recommendationsUsable) {
    assumptions.push('候选池为空，无法给出加餐推荐；营养盘点部分仍然有效。');
  }

  /* --- 7. 价格 --- */
  if (args.price) {
    if (args.demo || !store.storeCode) {
      assumptions.push(
        args.demo
          ? '价格：演示模式下不调 MCP 询价，直接使用本地参考均价。'
          : '价格：没有可用门店编码，calculate-price 缺少门店信息，因此降级为本地参考均价。',
      );
    }
    const priceResult = await attachPrices({
      recs: [...outcome.picked, ...outcome.ranked.filter((r) => !outcome.picked.some((p) => p.code === r.code))],
      ctx: {
        gateway,
        storeCode: store.storeCode,
        storeName: store.storeName,
        orderType: store.orderType,
        beType: store.beType,
        beCode: store.beCode,
        unit: args.priceUnit,
        verbose: args.verbose,
      },
      baseline: baselineFile,
      maxLive: args.demo ? 0 : 8,
    });

    provenance.push(
      `MCP ${TOOLS.calculatePrice}：实时报价 ${priceResult.live} 条，降级本地参考均价 ${priceResult.baseline} 条` +
        `${priceResult.unavailable > 0 ? `，不可得 ${priceResult.unavailable} 条` : ''}。${priceResult.note}`,
    );
  } else {
    assumptions.push('价格：已按 --no-price 关闭价格查询。');
  }

  /* --- 8. 组装报告 --- */
  const now = new Date();
  const report: DietReport = {
    context: {
      source: gateway.isLive ? 'mcp' : 'demo',
      storeCode: store.storeCode,
      storeName: store.storeName,
      orderType: String(store.orderType),
      goal: targets.goal,
      meal: targets.meal,
      overrides: targets.overrides,
      generatedAt: now.toISOString().replace('T', ' ').slice(0, 19),
    },
    lines: acc.lines,
    totals: acc.totals,
    score: outcome.baseScore,
    finalScore: outcome.finalScore,
    outcome,
    unknown: acc.unknown,
    coverage: acc.coverage,
    catalog: catalog?.stats,
    suppressed: recommendationsUsable
      ? undefined
      : {
          reason:
            `匹配覆盖率只有 ${(acc.coverage * 100).toFixed(0)}%（${acc.lines.length} 种里 ${acc.unknown.length} 种查不到营养数据），` +
            `低于阈值 ${(args.minCoverage * 100).toFixed(0)}%。未匹配部分可能含大量能量，按 0 计的总量属于「残缺基线」，` +
            `在此之上推荐加餐会把数据缺失误当成你没吃够 —— 因此本次刻意不出建议。`,
        },
    assumptions,
    provenance,
  };

  return report;
}

/**
 * 把报告摊平成稳定的对外 JSON 结构。
 *
 * 单独抽出来是为了让 Web 界面用**完全相同**的字段口径（`schema` 版本号也一并复用）。
 */
export function toJsonPayload(report: DietReport): Record<string, unknown> {
  const { outcome } = report;
  return {
    schema: REPORT_SCHEMA,
    context: report.context,
    totals: report.totals,
    coverage: report.coverage,
    score: { score: report.score.score, score100: report.score.score100, perNutrient: report.score.perNutrient },
    finalScore: { score: report.finalScore.score, score100: report.finalScore.score100 },
    items: report.lines.map((l) => ({
      name: l.line.name,
      qty: l.line.qty,
      matchType: l.matchType,
      confidence: l.confidence,
      matchedName: l.matched?.name ?? null,
      components: l.line.components ?? null,
      facts: l.facts,
    })),
    unknown: report.unknown.map((u) => ({ name: u.name, qty: u.qty })),
    recommendations: outcome.picked.map((r) => ({
      name: r.name,
      code: r.code,
      kind: r.kind,
      components: r.components ?? null,
      delta: r.delta,
      scoreAfter: r.scoreAfter,
      price: r.price,
      fixes: r.fixes.map((f) => ({ key: f.key, label: f.label, deltaValue: f.deltaValue, before: f.before, after: f.after })),
      reasons: r.reasons,
    })),
    ranked: outcome.ranked.map((r) => ({ name: r.name, code: r.code, kind: r.kind, delta: r.delta, price: r.price, fixes: r.fixes.map((f) => f.label) })),
    removals: outcome.removals,
    stats: outcome.stats,
    suppressed: report.suppressed ?? null,
    catalog: report.catalog
      ? {
          nutritionRows: report.catalog.nutritionRows,
          menuCodes: report.catalog.menuCodes,
          poolSize: report.catalog.poolSize,
          singles: report.catalog.singles,
          combos: report.catalog.combos,
          excludedCount: report.catalog.excluded.length,
          fromCache: report.catalog.fromCache,
          fetchedAt: report.catalog.fetchedAt,
        }
      : null,
    assumptions: report.assumptions,
    provenance: report.provenance,
  };
}

/** 渲染并输出报告：终端表格 → Markdown 文件 → JSON。 */
export async function runDiet(args: CliArgs): Promise<number> {
  const report = await analyzeDiet(args);

  /* --- 9. 输出 --- */
  const colorEnabled = args.color && process.stdout.isTTY !== false && !process.env.NO_COLOR;
  const terminal = renderTerminal(report, { color: colorEnabled });
  console.log(terminal);

  if (args.writeOut) {
    const outPath = path.resolve(args.out ?? path.join('out', 'diet-report.md'));
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, renderMarkdown(report), 'utf8');
    console.log(colorEnabled ? `\u001b[32mMarkdown 报告已写入：${outPath}\u001b[0m\n` : `Markdown 报告已写入：${outPath}\n`);
  }

  if (args.json) {
    console.log(JSON.stringify(toJsonPayload(report), null, 2));
  }

  return 0;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  await loadDotEnv(PKG_ROOT);
  await loadDotEnv(process.cwd());

  const { args, errors } = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (args.command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (errors.length > 0) {
    console.error('\n参数有问题：');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('\n用 --help 看完整用法。');
    return 2;
  }

  try {
    if (args.command === 'probe') {
      const gateway = createGateway({
        demo: false,
        token: process.env.MCD_MCP_TOKEN,
        url: process.env.MCD_MCP_URL,
        fixturesDir: path.join(PKG_ROOT, 'fixtures'),
        verbose: args.verbose,
      });
      await runProbe(gateway);
      return 0;
    }
    return await runDiet(args);
  } catch (err) {
    if (err instanceof McpError) {
      console.error(`\nMCP 接入失败：${err.message}`);
      if (err.hint) console.error(`处理建议：${err.hint}`);
      return 1;
    }
    console.error(`\n执行失败：${(err as Error).message}`);
    if (args.verbose && (err as Error).stack) console.error((err as Error).stack);
    return 1;
  }
}

/**
 * 只有「被当作程序直接启动」时才跑 main()。
 *
 * 这一层守卫是必需的：src/server.ts 要 import 本模块复用 analyzeDiet()，
 * 若无条件调用 main()，import 的那一刻就会把 CLI 跑起来。
 */
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('未预料的错误：', err);
      process.exitCode = 1;
    });
}
