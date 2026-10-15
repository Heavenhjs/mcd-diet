/**
 * 麦当劳 MCP Server 接入层
 *
 * 协议：MCP Streamable HTTP（JSON-RPC 2.0 over HTTPS）
 * 地址：https://mcp.mcd.cn
 * 鉴权：Authorization: Bearer <MCD_MCP_TOKEN>
 *
 * 这一层只负责「把 Tool 调通、把结果取回来」，不含任何业务判断。
 * 业务侧拿到的永远是 MCP 的原始返回，杜绝估算。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MCD_MCP_DEFAULT_URL = 'https://mcp.mcd.cn';
export const CLIENT_NAME = 'mcd-dev-diet';
/** 单一版本源：CLI 的 -v 与 MCP 握手的 clientInfo 都用它 */
export const CLIENT_VERSION = '0.2.0';

/** 本 Skill 用到的麦当劳 MCP Tool 名称 */
export const TOOLS = {
  listNutritionFoods: 'list-nutrition-foods',
  queryMeals: 'query-meals',
  queryMealDetail: 'query-meal-detail',
  calculatePrice: 'calculate-price',
  orderList: 'order-list',
  queryOrder: 'query-order',
  queryNearbyStores: 'query-nearby-stores',
  queryMyCoupons: 'query-my-coupons',
  nowTimeInfo: 'now-time-info',
} as const;

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 所有数据通道的统一接口，方便在「实时 MCP」与「离线 fixture」之间切换 */
export interface ToolGateway {
  readonly label: string;
  readonly isLive: boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<ToolSpec[]>;
}

/* ------------------------------------------------------------------ *
 * 通用工具函数
 * ------------------------------------------------------------------ */

const canon = (s: string): string => s.toLowerCase().replace(/[\s_\-./().]/g, '');

/**
 * 宽容取字段：先按规范化等值匹配，再退化为包含匹配。
 * 目的：MCP 返回的字段名（productName / product_name / 餐品名称）变化时不至于全线崩掉。
 */
export function pickField(obj: Record<string, unknown> | null | undefined, names: string[]): unknown {
  if (!obj) return undefined;
  const keys = Object.keys(obj);
  for (const want of names) {
    const w = canon(want);
    if (!w) continue;
    for (const k of keys) if (canon(k) === w) return obj[k];
  }
  for (const want of names) {
    const w = canon(want);
    if (w.length < 3) continue; // 太短的键名（如 na）会误伤 name，跳过包含匹配
    for (const k of keys) if (canon(k).includes(w)) return obj[k];
  }
  return undefined;
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

/**
 * 在任意深度的返回结构里捞出「对象数组」。
 * MCP 的列表类 Tool 常见包装有 data / result / list / items / records / dataList 等多种，
 * 与其硬编码路径，不如全部捞出来再按内容判断。
 */
export function collectArrays(payload: unknown, depth = 0): Record<string, unknown>[][] {
  const found: Record<string, unknown>[][] = [];
  if (depth > 6 || payload === null || typeof payload !== 'object') return found;

  if (Array.isArray(payload)) {
    const objs = payload.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length > 0 && objs.length >= payload.length * 0.6) found.push(objs);
    for (const el of payload) found.push(...collectArrays(el, depth + 1));
    return found;
  }

  for (const value of Object.values(payload as Record<string, unknown>)) {
    found.push(...collectArrays(value, depth + 1));
  }
  return found;
}

/** 找出「最像列表」的那一个数组：元素最多、且带名称字段 */
export function pickBestArray(payload: unknown, nameKeys: string[]): Record<string, unknown>[] {
  const arrays = collectArrays(payload);
  const scored = arrays
    .map((arr) => {
      const withName = arr.filter((o) => asString(pickField(o, nameKeys)) !== undefined).length;
      return { arr, withName };
    })
    .filter((x) => x.withName > 0)
    .sort((a, b) => b.withName - a.withName || b.arr.length - a.arr.length);
  return scored.length > 0 ? scored[0]!.arr : [];
}

/**
 * 收集所有「对象数组」（比 collectArrays 更激进，数组里只要有对象元素就算）。
 * 顺序数组的语义很不可控，所以这里全捞出来，交给调用方按内容判断。
 */
export function collectObjectArrays(payload: unknown, depth = 0): Record<string, unknown>[][] {
  const out: Record<string, unknown>[][] = [];
  const walk = (node: unknown, d: number): void => {
    if (d > 7 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objs = node.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length > 0) out.push(objs);
      for (const el of node) walk(el, d + 1);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, d + 1);
  };
  walk(payload, depth);
  return out;
}

/** 元素级「结构签名」：字段名排序拼接，用来判断两个数组装的是不是同一类东西 */
export function keySignature(obj: Record<string, unknown> | undefined): string {
  if (!obj) return '';
  return Object.keys(obj).sort().join('|');
}

/**
 * 结构同构合并。
 *
 * 解决的真实问题：菜单返回可能是 categories[].meals[] 这种嵌套结构，
 * 每个分类一个 meals 数组 —— 只取「元素最多」的那个会漏掉其它分类。
 * 这里以参考数组首个元素的结构签名为准，把所有同构数组拼起来。
 */
export function mergeHomogeneousArrays(
  arrays: Record<string, unknown>[][],
  reference: Record<string, unknown>[],
): Record<string, unknown>[] {
  const ref = reference[0];
  if (!ref) return reference;
  const sig = keySignature(ref);
  const merged: Record<string, unknown>[] = [];
  for (const arr of arrays) {
    if (arr.length === 0) continue;
    // 允许轻微字段差异：对比集合重合度
    const overlap = overlapRatio(keySignature(arr[0]), sig);
    if (overlap < 0.6) continue;
    merged.push(...arr);
  }
  return merged.length > 0 ? merged : reference;
}

function overlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = new Set(a.split('|'));
  const B = new Set(b.split('|'));
  let inter = 0;
  for (const k of A) if (B.has(k)) inter++;
  return inter / Math.max(A.size, B.size);
}

/** 从 MCP tools/call 的返回里取出真正的业务负载 */
export function extractToolPayload(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;

  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;

  const content = r.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      const t = asString(p.text);
      if (t) texts.push(t);
    }
    if (texts.length === 1) return tryParseJson(texts[0]!);
    if (texts.length > 1) {
      const joined = texts.join('\n');
      const parsed = tryParseJson(joined);
      return parsed ?? joined;
    }
  }
  return r;
}

/**
 * 拆开麦当劳 MCP 的通用信封：{ success, code, message, datetime, traceId, data }
 * 返回 data 字段；若不是信封则原样返回。
 */
export function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>).data;
  }
  return payload;
}

/** 信封里的业务错误信息 */
export interface BusinessError {
  code: number | string;
  message: string;
  traceId?: string;
}

/** 读出业务错误；没有则返回 null */
export function readBusinessError(payload: unknown): BusinessError | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  // 只有明确 success === false 才算失败；success 字段缺失时按成功处理
  if (o.success !== false) return null;
  return {
    code: (o.code as number | string) ?? 'unknown',
    message: asString(o.message) ?? '未提供错误信息',
    traceId: asString(o.traceId),
  };
}

/**
 * 业务错误必须显式抛出。
 *
 * 为什么不能忽略：这些 Tool 的错误是「HTTP 200 + success:false」，
 * 数据字段直接缺失。若不当回事，下游会解析出空数组，然后一路安静地
 * 得出一份「0 营养」的报告 —— 比报错危险得多。
 */
export function assertBusinessOk(payload: unknown, toolName: string): void {
  const err = readBusinessError(payload);
  if (!err) return;
  throw new McpError(
    `Tool ${toolName} 返回业务失败 [${err.code}]：${err.message}`,
    undefined,
    BUSINESS_HINTS[String(err.code)],
  );
}

/** 几个高频业务错误码的处置建议（实测归纳） */
const BUSINESS_HINTS: Record<string, string | undefined> = {
  '60006': '该商品在当前门店不可售或已售罄，换一个 productCode 再试',
  '600050': '收藏门店为空：改用 --store <门店编码> 指定，或同时提供 --city 与 --keyword 搜索',
  '600058': '搜索门店时城市与关键词都必须提供（--city 上海 --keyword 人民广场）',
};

/** 判断是否「业务失败但可容忍」的调用（例如询价时个别商品售罄） */
export function isBusinessFailure(payload: unknown, code?: string | number): boolean {
  const err = readBusinessError(payload);
  if (!err) return false;
  return code === undefined || String(err.code) === String(code);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];

  // 有些 Server 会把 JSON 包在 ```json 代码块里
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  for (const c of candidates) {
    if (!c) continue;
    if (!/^[[{]/.test(c)) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return undefined;
}

/** 解析 SSE 响应体，取出所有 data: 之后的 JSON 消息 */
export function parseSseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  let dataBuf: string[] = [];
  const flush = (): void => {
    if (dataBuf.length === 0) return;
    const joined = dataBuf.join('\n');
    dataBuf = [];
    const parsed = tryParseJson(joined);
    if (parsed !== undefined) out.push(parsed);
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // 注释/心跳
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataBuf.push(value);
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * 实时 MCP 网关
 * ------------------------------------------------------------------ */

export interface McpOptions {
  url?: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** 每次请求之间的最小间隔，默认 50ms，远离 600 次/分钟限流 */
  minIntervalMs?: number;
  verbose?: boolean;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class HttpMcpGateway implements ToolGateway {
  readonly label = '麦当劳 MCP Server（实时）';
  readonly isLive = true;

  private sessionId?: string;
  private protocolVersion?: string;
  private nextId = 1;
  private initialized = false;
  private initPromise?: Promise<void>;
  private toolCache?: ToolSpec[];
  private lastCallAt = 0;

  constructor(private readonly opts: McpOptions) {}

  /* -------------------- 底层 JSON-RPC -------------------- */

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.opts.token}`,
      'User-Agent': `${CLIENT_NAME}/${CLIENT_VERSION}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  private async throttle(): Promise<void> {
    const min = this.opts.minIntervalMs ?? 50;
    const wait = this.lastCallAt + min - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  /** 发一条 JSON-RPC 消息。notification=true 时不带 id、不等返回 */
  private async rpc(method: string, params: unknown, notification = false): Promise<unknown> {
    const url = this.opts.url ?? MCD_MCP_DEFAULT_URL;
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const maxRetries = this.opts.maxRetries ?? 3;

    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    if (!notification) body.id = this.nextId++;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.throttle();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        // 记录会话 id
        const sid = res.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;

        if (res.status === 401) {
          throw new McpError(
            'MCP Token 无效、已过期或未提供（401）',
            401,
            '检查环境变量 MCD_MCP_TOKEN，或在 https://open.mcd.cn/mcp 控制台重新申请 Token',
          );
        }

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? '1');
          const waitMs = Math.max(500, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
          lastError = new McpError('触发 MCP 限流（429），已自动退避重试', 429);
          if (attempt < maxRetries) {
            if (this.opts.verbose) console.error(`[mcp] 429 限流，等待 ${waitMs}ms 后重试（第 ${attempt + 1} 次）`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw lastError;
        }

        if (res.status === 202 || res.status === 204) return null; // 通知类请求

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new McpError(`MCP 请求失败：HTTP ${res.status} ${res.statusText} ${text.slice(0, 300)}`, res.status);
        }

        const contentType = res.headers.get('content-type') ?? '';
        const raw = await res.text();
        if (!raw.trim()) return null;

        let message: any;
        if (contentType.includes('text/event-stream') || /(^|\n)data:/.test(raw)) {
          const messages = parseSseMessages(raw);
          message = messages.find((m: any) => m && typeof m === 'object' && (m as any).id === body.id) ?? messages[0];
        } else {
          message = tryParseJson(raw) ?? undefined;
        }

        if (!message) {
          throw new McpError(`MCP 返回无法解析：${raw.slice(0, 300)}`);
        }
        if ((message as any).error) {
          const err = (message as any).error;
          throw new McpError(`MCP 报错 [${err.code ?? '-'}] ${err.message ?? JSON.stringify(err)}`);
        }
        return (message as any).result;
      } catch (err) {
        lastError = err;
        if (err instanceof McpError && (err.status === 401 || err.status === 429)) throw err;
        const retriable = attempt < maxRetries;
        if (!retriable) break;
        const backoff = 400 * Math.pow(2, attempt);
        if (this.opts.verbose) {
          console.error(`[mcp] 请求异常（${(err as Error).message}），${backoff}ms 后重试`);
        }
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    if (lastError instanceof McpError) throw lastError;
    throw new McpError(`MCP 调用失败：${(lastError as Error)?.message ?? String(lastError)}`);
  }

  /* -------------------- 握手 -------------------- */

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const result = (await this.rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      })) as Record<string, unknown> | null;

      const negotiated = asString(result?.protocolVersion);
      if (negotiated) this.protocolVersion = negotiated;

      await this.rpc('notifications/initialized', undefined, true);
      this.initialized = true;
      if (this.opts.verbose) {
        console.error(`[mcp] 已连接 ${this.opts.url ?? MCD_MCP_DEFAULT_URL}，协议版本 ${negotiated ?? '未声明'}`);
      }
    })();

    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = undefined;
      throw err;
    }
  }

  /* -------------------- 对外接口 -------------------- */

  async listTools(): Promise<ToolSpec[]> {
    if (this.toolCache) return this.toolCache;
    await this.ensureInitialized();
    const result = (await this.rpc('tools/list', {})) as { tools?: unknown } | null;
    const raw = Array.isArray(result?.tools) ? (result!.tools as unknown[]) : [];
    const specs: ToolSpec[] = raw
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        name: asString(t.name) ?? '(unknown)',
        description: asString(t.description),
        inputSchema: (t.inputSchema ?? t.input_schema) as Record<string, unknown> | undefined,
      }));
    this.toolCache = specs;
    return specs;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = await this.rpc('tools/call', { name, arguments: args });
    const envelope = result as Record<string, unknown> | null;
    if (envelope?.isError === true) {
      const payload = extractToolPayload(envelope);
      throw new McpError(
        `Tool ${name} 返回错误：${typeof payload === 'string' ? payload : JSON.stringify(payload).slice(0, 400)}`,
      );
    }
    return extractToolPayload(envelope);
  }
}

/* ------------------------------------------------------------------ *
 * 离线 fixture 网关（仅用于无 Token 时自测 / 演示，报告中会强制标注）
 * ------------------------------------------------------------------ */

export class FixtureGateway implements ToolGateway {
  readonly label = '本地 fixture（实测结构快照，非实时 MCP）';
  readonly isLive = false;

  private readonly map: Record<string, string> = {
    [TOOLS.listNutritionFoods]: 'demo-nutrition.json',
    [TOOLS.queryMeals]: 'demo-menu.json',
    [TOOLS.queryMealDetail]: 'demo-meal-detail.json',
    [TOOLS.calculatePrice]: 'demo-price.json',
    [TOOLS.queryOrder]: 'demo-order-detail.json',
    [TOOLS.orderList]: 'demo-order-list.json',
    [TOOLS.queryNearbyStores]: 'demo-stores.json',
  };

  /** 演示模式下对 query-meal-detail 的响应：按 code 从快照里取 */
  private detailCache?: Record<string, { code: string; name: string; rounds: unknown[] }>;

  /** 最近一次调用的入参（自检用：可以断言「到底传了什么」而不只是「返回了什么」） */
  private readonly lastArgsByName = new Map<string, Record<string, unknown>>();

  constructor(private readonly dir: string) {}

  /** 取某个 Tool 最近一次的入参 */
  lastArgs(name: string): Record<string, unknown> | undefined {
    return this.lastArgsByName.get(name);
  }

  async listTools(): Promise<ToolSpec[]> {
    return [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.lastArgsByName.set(name, args);
    if (name === TOOLS.nowTimeInfo) {
      const now = new Date();
      return {
        success: true,
        code: 200,
        data: {
          timestamp: now.getTime(),
          formatted: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:00`,
        },
      };
    }

    // query-meal-detail 在演示模式下从快照里按 code 查
    if (name === TOOLS.queryMealDetail) {
      if (!this.detailCache) {
        const text = await readFile(path.join(this.dir, 'demo-meal-detail.json'), 'utf8');
        this.detailCache = JSON.parse(text) as Record<string, { code: string; name: string; rounds: unknown[] }>;
      }
      const code = asString(args.code) ?? '';
      const hit = this.detailCache[code];
      if (!hit) {
        return {
          success: false,
          code: 60006,
          message: `演示快照中没有 code=${code} 的餐品详情（快照只覆盖少量餐品）`,
        };
      }
      return { success: true, code: 200, message: '请求成功', data: hit };
    }

    const file = this.map[name];
    if (!file) {
      if (name === TOOLS.orderList) return { success: true, code: 200, data: { list: [] } };
      throw new McpError(`演示模式未提供 ${name} 的 fixture`);
    }

    // query-order 必须按 orderId 对上，避免演示时把 A 单的商品配到 B 单的门店上
    if (name === TOOLS.queryOrder) {
      const text0 = await readFile(path.join(this.dir, file), 'utf8');
      const detail = JSON.parse(text0) as { data?: { orderId?: string } };
      const want = asString(args.orderId);
      if (want && detail.data?.orderId && want !== detail.data.orderId) {
        return {
          success: false,
          code: 600001,
          message: `演示快照里没有 orderId=${want} 的详情（快照只有 ${detail.data.orderId}）`,
        };
      }
      return detail;
    }

    const target = typeof args.__fixture === 'string' ? args.__fixture : file;
    const text = await readFile(path.join(this.dir, target), 'utf8');
    return JSON.parse(text);
  }
}

export function createGateway(opts: {
  demo: boolean;
  token?: string;
  url?: string;
  fixturesDir: string;
  verbose?: boolean;
}): ToolGateway {
  if (opts.demo) return new FixtureGateway(opts.fixturesDir);
  if (!opts.token) {
    throw new McpError(
      '缺少 MCD_MCP_TOKEN。本 Skill 的全部营养/菜单/价格数据都来自麦当劳 MCP Server，不接受估算，因此必须有 Token。',
      undefined,
      '申请：https://open.mcd.cn/mcp → 登录 → 控制台 → 激活 → 复制 Token；然后 export MCD_MCP_TOKEN=xxx。' +
        '（只想先看效果可以加 --demo，用随包的实测结构快照跑通流程，报告里会标注非实时）',
    );
  }
  return new HttpMcpGateway({ token: opts.token, url: opts.url, verbose: opts.verbose });
}
