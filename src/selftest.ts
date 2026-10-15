/**
 * 自检脚本：npm run selftest
 *
 * 这里固化的都是「改一处就悄悄崩」的行为，尤其是与线上实测契约相关的部分：
 *   - 紧凑表格文本（list-nutrition-foods 的 data 不是 JSON 数组）能否解析出来
 *   - 名称归一化：麦乐鸡5块 / 5块麦乐鸡 / 麦乐鸡-5块 是同一个；5块 ≠ 4块
 *   - 包含匹配的唯一性守卫：只有「可乐」时必须拒绝，不能替用户猜尺寸
 *   - 套餐拆解：倍率取 round.quantity；isDefault=1 但 quantity=0 的项不能算进去
 *   - 拆解不完整（组成项缺营养数据）时整单排除，绝不部分估算
 *   - 两个订单接口的套餐组成键名差异（name/quantity vs itemName/itemQuantity）
 *   - calculate-price 的金额单位是「分」
 *   - 软评分的数学性质（无硬阈值）
 *   - 推荐结果排除已点菜品
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FixtureGateway, TOOLS } from './mcp.js';
import { looksLikePackedTable, parsePackedTable } from './packed.js';
import { accumulate, buildNutritionIndex, factsFromComponents, matchNutrition, normalizeName } from './nutrition.js';
import { componentsOf, fetchCatalog, parseMealDetail, searchStores } from './menu.js';
import { extractOrderLines, parseInlineItems, pickLatestOrder } from './order.js';
import { toYuan } from './price.js';
import { emptyCalorieTendency, recommendAddOns, scoreMeal, softScore } from './recommend.js';
import { resolveTargets } from './targets.js';
import { emptyFacts, type NutritionFacts, type OrderLine } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures');

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function facts(partial: Partial<NutritionFacts>): NutritionFacts {
  return { ...emptyFacts(), ...partial };
}

async function main(): Promise<void> {
  const gw = new FixtureGateway(FIXTURES);

  console.log('\n一、紧凑表格文本解析（list-nutrition-foods 的真实返回形态）');
  {
    const raw = JSON.parse(await readFile(path.join(FIXTURES, 'demo-nutrition.json'), 'utf8'));
    ok('能识别紧凑表格（表头 [N]{列名}: 形态）', looksLikePackedTable(raw.data));

    const table = parsePackedTable(raw.data);
    ok('声明行数与实际行数一致', table.declaredRows === table.rows.length, `${table.declaredRows} vs ${table.rows.length}`);
    ok('解析出 160 行', table.rows.length === 160, `实际 ${table.rows.length}`);
    ok('列名与线上一致', table.columns.join(',') === 'productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium', table.columns.join(','));
    ok('null 被解析为 null（不是字符串 "null"）', table.rows[0]!.nutritionDescription === null);
    ok('数字被解析为 number', typeof table.rows[0]!.energyKcal === 'number');
    ok('姓名列是字符串', typeof table.rows[0]!.productName === 'string');

    // 名称自带逗号时不能串列
    const tricky = parsePackedTable('[1]{productName,energyKcal,protein}:\n  薯条, 大,300,4');
    ok('名称含逗号时不串列', tricky.rows[0]!.productName === '薯条, 大' && tricky.rows[0]!.energyKcal === 300, JSON.stringify(tricky.rows[0]));

    // 列数不足的行跳过，而不是错位填充
    const short = parsePackedTable('[2]{productName,energyKcal,protein}:\n  只有两列,100\n  完整行,200,5');
    ok('列数不足的行被跳过（不错位填充）', short.rows.length === 1 && short.rows[0]!.protein === 5, JSON.stringify(short.rows));

    // 表头不合法必须抛错，而不是静默返回空数组
    let threw = false;
    try {
      parsePackedTable('这不是紧凑表格');
    } catch {
      threw = true;
    }
    ok('格式不认识时抛错而非静默返回空', threw);
  }

  console.log('\n二、名称归一化（同一商品的变体必须收敛）');
  {
    const k = normalizeName;
    ok('麦乐鸡5块 == 5块麦乐鸡', k('麦乐鸡5块') === k('5块麦乐鸡'), `${k('麦乐鸡5块')} vs ${k('5块麦乐鸡')}`);
    ok('麦乐鸡-5块 == 麦乐鸡5块', k('麦乐鸡-5块') === k('麦乐鸡5块'));
    ok('麦辣鸡翅2块 == 麦辣鸡翅-2块', k('麦辣鸡翅2块') === k('麦辣鸡翅-2块'));
    ok('麦乐鸡5块 ≠ 麦乐鸡4块（数量必须保留）', k('麦乐鸡5块') !== k('麦乐鸡4块'));
    ok('中薯条 ≠ 大薯条', k('中薯条') !== k('大薯条'));
    ok('小杯玉米杯 ≠ 大杯玉米杯', k('小杯玉米杯') !== k('大杯玉米杯'));
    ok('雪碧（小杯）== 雪碧小杯', k('雪碧（小杯）') === k('雪碧小杯'));
    ok('纯牛奶(盒装) == 纯牛奶（盒装）', k('纯牛奶(盒装)') === k('纯牛奶（盒装）'));
    ok('全角半角归一', k('可口可乐（中杯）') === k('可口可乐(中杯)'));
  }

  console.log('\n三、营养匹配（宽容但绝不猜）');
  {
    const raw = JSON.parse(await readFile(path.join(FIXTURES, 'demo-nutrition.json'), 'utf8'));
    const table = parsePackedTable(raw.data);
    const records = table.rows
      .map((r) => ({
        name: String(r.productName),
        normName: normalizeName(String(r.productName)),
        facts: facts({
          energy: Number(r.energyKcal ?? 0),
          protein: Number(r.protein ?? 0),
          fat: Number(r.fat ?? 0),
          carb: Number(r.carbohydrate ?? 0),
          sodium: Number(r.sodium ?? 0),
          calcium: Number(r.calcium ?? 0),
        }),
        energyUnit: 'kcal' as const,
        raw: r,
      }));
    const idx = buildNutritionIndex(records, { format: 'packed-table', declaredRows: table.declaredRows });

    ok('精确命中：巨无霸', matchNutrition('巨无霸', idx).matchType === 'exact');
    ok('包含命中：纯牛奶(盒装) → 纯牛奶（盒装）', matchNutrition('纯牛奶(盒装)', idx).matched?.name === '纯牛奶（盒装）');
    ok('包含命中：鱼排堡 → 儿童鱼排堡', matchNutrition('鱼排堡', idx).matched?.name === '儿童鱼排堡');

    // 唯一性守卫：只有「可乐」时，营养库里有 可乐中杯/大杯/小杯 + 无糖系列，必须拒绝
    ok('歧义时拒绝（裸「可乐」不猜尺寸）', matchNutrition('可乐', idx).matchType === 'none', JSON.stringify(matchNutrition('可乐', idx)));

    // 套餐名禁止走宽松匹配，否则「巨无霸三件套」会被算成「巨无霸」
    ok('套餐名拒绝宽松匹配（巨无霸三件套 ≠ 巨无霸）', matchNutrition('巨无霸三件套', idx).matched?.name !== '巨无霸');
    ok('完全不认识的餐品返回未匹配', matchNutrition('神秘限定汉堡', idx).matchType === 'none');
  }

  console.log('\n四、套餐拆解（倍率与完整性）');
  {
    const detailFile = JSON.parse(await readFile(path.join(FIXTURES, 'demo-meal-detail.json'), 'utf8'));
    const detail = parseMealDetail({ success: true, data: detailFile['9900005321'] })!;
    ok('解析出餐品详情', detail.code === '9900005321' && detail.rounds.length > 0);

    const { components, incomplete } = componentsOf(detail);
    ok('完全可拆解（无缺默认项的 round）', !incomplete);
    const cola = components.find((c) => c.name === '可乐中杯');
    ok('倍率取 round.quantity：可乐中杯 = 2 份', cola?.qty === 2, JSON.stringify(components));
    const wings = components.find((c) => c.name === '薄皮焦香V翅');
    ok('倍率取 round.quantity：薄皮焦香V翅 = 2 份', wings?.qty === 2);

    // isDefault=1 但 quantity=0 的未选中项不能算进去（实测 鱼牛汉堡四件套 有这种项）
    const withUnselected = parseMealDetail({
      success: true,
      data: {
        code: 'X',
        name: '测试套餐',
        rounds: [
          {
            id: 1,
            name: '选择汉堡',
            quantity: 1,
            choices: [
              { code: 'a', name: '巨无霸', isDefault: 1, quantity: 1 },
              { code: 'b', name: '培根蔬萃双层牛堡', isDefault: 1, quantity: 0 },
            ],
          },
        ],
      },
    })!;
    const c2 = componentsOf(withUnselected).components;
    ok('isDefault=1 但 quantity=0 的项不计入', c2.length === 1 && c2[0]!.name === '巨无霸', JSON.stringify(c2));

    // 有 round 缺默认项 → 组成不确定，必须标记 incomplete
    const partial = parseMealDetail({
      success: true,
      data: {
        code: 'Y',
        name: '测试套餐2',
        rounds: [
          { id: 1, name: '主食', quantity: 1, choices: [{ code: 'a', name: '巨无霸', isDefault: 1, quantity: 1 }] },
          { id: 2, name: '饮料', quantity: 1, choices: [{ code: 'b', name: '可乐中杯', isDefault: 0, quantity: 0 }] },
        ],
      },
    })!;
    ok('有 round 缺默认项时标记 incomplete', componentsOf(partial).incomplete);
  }

  console.log('\n五、目录构建（走真实结构 fixture）');
  const catalog = await fetchCatalog(gw, {
    storeCode: '1410005',
    orderType: 1,
    beType: 1,
    cacheDir: path.join(ROOT, 'out', 'cache-selftest'),
    noCache: true,
  });
  {
    ok('营养库声明 160 行', catalog.index.declaredRows === 160, String(catalog.index.declaredRows));
    // 实测线上确实有 2 行完全相同的重复记录（小杯玉米杯、纯牛奶（盒装）），去重后 158 条
    ok('去重后 158 条唯一营养记录', catalog.index.records.length === 158, `实际 ${catalog.index.records.length}`);
    ok('数据形态识别为紧凑表格', catalog.index.format === 'packed-table');
    ok('菜单解析出 15 个餐品码', catalog.stats.menuCodes === 15, `实际 ${catalog.stats.menuCodes}`);

    // 15 个码里，13 个能算出营养；2 个应被排除
    ok('候选池 = 13 个（15 个码里 2 个拿不到营养）', catalog.stats.poolSize === 13, `实际 ${catalog.stats.poolSize}`);
    const excludedNames = catalog.stats.excluded.map((e) => e.name);
    ok('排除「鸡薯双全盒」（组成项缺营养数据）', excludedNames.some((n) => n.includes('鸡薯双全盒')), excludedNames.join('、'));
    ok('排除「泷愿成真麦旋风」（营养库无对应）', excludedNames.some((n) => n.includes('泷愿成真麦旋风')), excludedNames.join('、'));
    ok('每个排除项都带原因', catalog.stats.excluded.every((e) => !!e.reason));

    // 去重只允许丢掉「完全相同的行」，不能因为同名就把数值不同的记录吞掉
    {
      const raw = JSON.parse(await readFile(path.join(FIXTURES, 'demo-nutrition.json'), 'utf8'));
      const rows = parsePackedTable(raw.data).rows;
      const byName = new Map<string, Set<string>>();
      for (const r of rows) {
        const key = String(r.productName);
        if (!byName.has(key)) byName.set(key, new Set());
        byName.get(key)!.add(JSON.stringify({ ...r, productName: undefined }));
      }
      const conflicting = [...byName.entries()].filter(([, set]) => set.size > 1);
      ok('线上重复行数值完全一致（去重不会丢信息）', conflicting.length === 0, conflicting.map(([n]) => n).join('、'));
      ok('去重损耗 = 160 - 158 = 2 行', rows.length - catalog.index.records.length === 2);
    }

    const single = catalog.byCode.get('1100')!;
    ok('巨无霸识别为单品', single.kind === 'single' && single.facts.energy === 513);

    const combo = catalog.byCode.get('9900004064')!;
    ok('精选单人餐三件套识别为套餐', combo.kind === 'combo');
    ok('套餐营养 = 组成求和 = 827 kcal', near(combo.facts.energy, 827), String(combo.facts.energy));
    ok(
      '套餐组成含 3 项且倍率正确',
      combo.components.length === 3 && combo.components.every((c) => c.qty === 1),
      JSON.stringify(combo.components),
    );

    const wings = catalog.byCode.get('9900006332')!;
    ok('薄皮V翅双拼十翅 = 3×麦辣鸡翅-2块 + 2×薄皮焦香V翅 = 1056 kcal', near(wings.facts.energy, 1056), String(wings.facts.energy));

    // 关键：套餐营养不能等于同名单品营养
    ok('套餐不会退化成同名单品（巨无霸三件套若存在，其营养 ≠ 巨无霸）', !catalog.products.some((p) => p.name.includes('巨无霸三件套') && near(p.facts.energy, 513)));
  }

  console.log('\n六、订单解析（两个接口的键名差异）');
  {
    const listRaw = JSON.parse(await readFile(path.join(FIXTURES, 'demo-order-list.json'), 'utf8'));
    const latest = pickLatestOrder(listRaw);
    ok('order-list 取出最近一单（按 createTime）', latest?.orderId === 'DEMO-ORDER-0003', latest?.orderId);
    ok('从订单里读出门店码', latest?.storeCode === '1410005');

    const linesFromList = extractOrderLines(listRaw);
    ok('order-list 明细解析出 1 项（最新单）', linesFromList.length === 1, JSON.stringify(linesFromList.map((l) => l.name)));
    ok(
      'order-list 的套餐组成（name/quantity 键名）被识别',
      linesFromList[0]!.components?.length === 3,
      JSON.stringify(linesFromList[0]!.components),
    );

    const detailRaw = JSON.parse(await readFile(path.join(FIXTURES, 'demo-order-detail.json'), 'utf8'));
    const linesFromDetail = extractOrderLines(detailRaw);
    ok('query-order（itemName/itemQuantity 键名）也能解析', linesFromDetail.length === 1, JSON.stringify(linesFromDetail.map((l) => l.name)));
    ok(
      'query-order 的套餐组成被识别为 3 个组成项',
      linesFromDetail[0]!.components?.length === 3,
      JSON.stringify(linesFromDetail[0]!.components),
    );
    ok(
      '组成项数量正确',
      linesFromDetail[0]!.components!.every((c) => c.qty === 1),
      JSON.stringify(linesFromDetail[0]!.components),
    );
  }

  console.log('\n七、手输数量解析');
  {
    const a = parseInlineItems('麦乐鸡5块x2');
    ok('"麦乐鸡5块x2" → 名称含 5块、数量 2', a[0]!.name === '麦乐鸡5块' && a[0]!.qty === 2, JSON.stringify(a));
    const b = parseInlineItems('麦乐鸡5块');
    ok('"麦乐鸡5块" → 数量 1（不被吃掉数字）', b[0]!.name === '麦乐鸡5块' && b[0]!.qty === 1, JSON.stringify(b));
    const c = parseInlineItems('巨无霸 2');
    ok('"巨无霸 2" → 数量 2', c[0]!.name === '巨无霸' && c[0]!.qty === 2, JSON.stringify(c));
    const d = parseInlineItems('巨无霸×1,中薯条x1, 锡兰红茶');
    ok('多品 + 混合分隔符合并正确', d.length === 3, JSON.stringify(d));
  }

  console.log('\n八、价格单位（实测为「分」）');
  {
    ok('整数按分：1590 → ¥15.90', near(toYuan(1590), 15.9, 1e-9));
    ok('整数按分：12990 → ¥129.90', near(toYuan(12990), 129.9, 1e-9));
    ok('小数按元：9.9 → ¥9.90（query-order 的口径）', near(toYuan(9.9), 9.9, 1e-9));
    ok('--price-unit fen 强制按分', near(toYuan(1590, 'fen'), 15.9, 1e-9));
    ok('--price-unit yuan 强制按元', near(toYuan(1590, 'yuan'), 1590, 1e-9));
  }

  console.log('\n九、软评分性质（无硬阈值）');
  {
    const halfLow = 10;
    const halfHigh = 5;
    ok('目标点取 1', near(softScore(100, 100, halfLow, halfHigh), 1));
    ok('偏离越远分数越低（低侧）', softScore(90, 100, halfLow, halfHigh) > softScore(80, 100, halfLow, halfHigh));
    ok('偏离越远分数越低（高侧）', softScore(110, 100, halfLow, halfHigh) > softScore(120, 100, halfLow, halfHigh));
    ok('halfHigh=Infinity 时超目标不扣分（钠/脂肪超标不罚的反面）', near(softScore(999, 100, halfLow, Infinity), 1));
    ok('halfLow=Infinity 时低于目标不扣分（钠低于目标不罚）', near(softScore(1, 100, Infinity, halfHigh), 1));
    ok('低侧偏离等于容差时取 0.5', near(softScore(90, 100, halfLow, halfHigh), 0.5));
    ok('高侧偏离等于容差时取 0.5', near(softScore(105, 100, halfLow, halfHigh), 0.5));
    ok('分数恒在 (0,1]', softScore(1e6, 100, halfLow, halfHigh) > 0 && softScore(1e6, 100, halfLow, halfHigh) <= 1);

    const maxJumpAt = (step: number): number => {
      let m = 0;
      let prev = softScore(0, 100, halfLow, halfHigh);
      for (let x = step; x <= 200; x += step) {
        const cur = softScore(x, 100, halfLow, halfHigh);
        m = Math.max(m, Math.abs(cur - prev));
        prev = cur;
      }
      return m;
    };
    const j1 = maxJumpAt(0.1);
    const j2 = maxJumpAt(0.05);
    ok('无硬阈值跳变（连续可导）', j1 < 0.02 && j2 < j1 * 0.6, `j(0.1)=${j1.toFixed(5)} j(0.05)=${j2.toFixed(5)}`);
  }

  console.log('\n十、空热量倾向排序');
  {
    const milk = emptyCalorieTendency(facts({ energy: 129, protein: 7, calcium: 231 }));
    const corn = emptyCalorieTendency(facts({ energy: 53, protein: 2, calcium: 6 }));
    const cola = emptyCalorieTendency(facts({ energy: 147, protein: 0, calcium: 10 }));
    const water = emptyCalorieTendency(facts({ energy: 0 }));
    ok('纯牛奶 < 玉米杯 < 含糖可乐', milk < corn && corn < cola, `${milk.toFixed(3)} / ${corn.toFixed(3)} / ${cola.toFixed(3)}`);
    ok('零能量（水/无糖茶）不判为空热量', near(water, 0));
  }

  console.log('\n十一、推荐逻辑（排除已点 + 套餐不误算）');
  {
    const targets = resolveTargets({ goal: 'fat-loss', meal: 'lunch', overrides: {} });

    // 场景：点了巨无霸 + 中薯条
    const ordered: OrderLine[] = [
      { name: '巨无霸', normName: normalizeName('巨无霸'), code: '1100', qty: 1 },
      { name: '中薯条', normName: normalizeName('中薯条'), code: '4810', qty: 1 },
    ];
    const acc = accumulate(ordered, catalog.index, { menuByCode: catalog.byCode, menuByName: catalog.byName });
    ok('累加结果 = 巨无霸 513 + 中薯条 289 = 802 kcal', near(acc.totals.energy, 802), String(acc.totals.energy));
    ok('匹配覆盖率 100%', near(acc.coverage, 1));

    const out = recommendAddOns({
      totals: acc.totals,
      lines: acc.lines,
      products: catalog.products,
      profile: targets.profile,
      maxAdd: 2,
      qualityWeight: targets.qualityWeight,
    });

    const pickedNames = out.picked.map((p) => p.name);
    ok('推荐结果排除已点的巨无霸', !pickedNames.includes('巨无霸'), JSON.stringify(pickedNames));
    ok('推荐结果排除已点的中薯条', !pickedNames.includes('中薯条'), JSON.stringify(pickedNames));
    ok('ranked 里也不含已点项', !out.ranked.some((r) => r.name === '巨无霸' || r.name === '中薯条'));
    ok('排除计数 > 0', out.stats.excludedCount > 0, String(out.stats.excludedCount));

    // allow-repeat 应能放开排除
    const out2 = recommendAddOns({
      totals: acc.totals,
      lines: acc.lines,
      products: catalog.products,
      profile: targets.profile,
      maxAdd: 2,
      allowRepeat: true,
      qualityWeight: targets.qualityWeight,
    });
    ok('--allow-repeat 放开排除（排除计数归零）', out2.stats.excludedCount === 0, String(out2.stats.excludedCount));
    ok('放开后候选池更大', out2.stats.candidateSize > out.stats.candidateSize, `${out.stats.candidateSize} → ${out2.stats.candidateSize}`);

    ok('推荐项的 delta 都是正的', out.picked.every((r) => r.delta > 0));
    ok('最终分不低于初始分', out.finalScore.score >= out.baseScore.score - 1e-9);

    // 套餐拆解的营养来自组成项之和，不是把套餐名匹配到某个单品
    const comboPick = [...out.picked, ...out.ranked].find((r) => r.kind === 'combo');
    if (comboPick) {
      ok('套餐推荐附带组成明细（可核对口径）', (comboPick.components?.length ?? 0) > 0);
      const summed = factsFromComponents(comboPick.components!, catalog.index);
      ok('套餐推荐的营养 = 其组成项求和', summed.ok && near(summed.facts.energy, comboPick.facts.energy, 1e-6), `${summed.facts.energy} vs ${comboPick.facts.energy}`);
    } else {
      ok('套餐推荐附带组成明细（本轮无套餐候选，跳过）', true);
    }
  }

  console.log('\n十二、评分聚合');
  {
    const targets = resolveTargets({ goal: 'maintain', meal: 'lunch', overrides: {} });
    const onTarget = scoreMeal(
      {
        energy: targets.profile.energy.target,
        protein: targets.profile.protein.target,
        fat: targets.profile.fat.target,
        carb: targets.profile.carb.target,
        sodium: targets.profile.sodium.target,
        calcium: targets.profile.calcium.target,
      },
      targets.profile,
      { emptyShare: 0 },
    );
    ok('各项刚好等于目标时接近满分', onTarget.score > 0.98, onTarget.score.toFixed(4));
    ok('score100 在 0~100 之间', onTarget.score100 > 0 && onTarget.score100 <= 100);
  }

  console.log('\n十三、门店搜索（query-nearby-stores）');
  {
    const stores = await searchStores(gw, { city: '福州', keyword: '五四路' });
    ok('解析出门店数组', stores.length > 1, String(stores.length));
    ok('每条都带 storeCode（后续 query-meals / calculate-price 都要用）', stores.every((s) => !!s.storeCode));
    ok('取服务端返回的第一家', stores[0]?.storeCode === '1410005', String(stores[0]?.storeCode));
    ok('带上门店名与距离', !!stores[0]?.storeName && typeof stores[0]?.distance === 'number');
    // 实测：searchType 必须用 2（1 是搜「我的收藏门店」，新用户收藏为空会报 600050）
    const reqArgs = gw.lastArgs(TOOLS.queryNearbyStores);
    ok('searchType 固定用 2', reqArgs?.searchType === 2, JSON.stringify(reqArgs));
    ok('beType 只传 schema 允许的 1 或 5', [1, 5].includes(Number(reqArgs?.beType)), String(reqArgs?.beType));
    ok('city / keyword 都带上了', reqArgs?.city === '福州' && reqArgs?.keyword === '五四路');
  }

  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项断言。\n`);
  } else {
    console.log(`${passed} 项通过，${failures.length} 项失败：`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log('');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('自检脚本自身出错：', err);
  process.exitCode = 1;
});
