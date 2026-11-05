/**
 * test-finance.mjs —— financial_calc 的护栏测试
 *
 * 覆盖：三档测算 / 极限租金反推 / 建议锚点 / 租期现金流 / 空间容量 /
 *       内部比值校验 / 假设台账 / 双维敏感度 / 参数覆盖 / 确定性
 *
 * 用法（scratch-plugin 目录下）：
 *   node .\tools\test-finance.mjs
 *
 * 设计原则：全部用**可手算验证的固定参数**，断言写期望数值而不是"大于0"。
 * 这样任何一处公式改动都会被立刻抓住。
 */

const mod = await import(new URL('../src/site-tools.ts', import.meta.url).href)
const registered = []
mod.apply({ tools: { register: (d) => { registered.push(d); return () => {} } } })

const tool = registered.find((t) => t.name === 'financial_calc')
if (!tool) { console.error('FAIL：没找到 financial_calc'); process.exit(1) }

const checks = []
const check = (label, ok) => checks.push([label, Boolean(ok)])
const near = (a, b, tol = 0.02) => typeof a === 'number' && Math.abs(a - b) <= tol
const has = (arr, s) => Array.isArray(arr) && arr.some((x) => String(x).includes(s))

// ── 基准参数（可手算）：日营收 22000、毛利 62%、租 15 万、人力 7.2 万、其他 2.8 万、投入 380 万
const P = {
  daily_revenue: { value: 22000, source: '同商圈对标', confidence: 0.6 },
  gross_margin: { value: 0.62, source: '老板口述', confidence: 0.5 },
  monthly_rent: { value: 150000, source: '租赁意向书', confidence: 0.8 },
  monthly_labor: { value: 72000, source: '人效估算', confidence: 0.6 },
  monthly_other_fixed: { value: 28000, source: '物业费+水电', confidence: 0.7 },
  initial_investment: { value: 3800000, source: '工程报价', confidence: 0.4 },
}

const base = await tool.execute({
  store_id: 'T-001', format_code: 'large_yuecai', params: P, area_sqm: 1500,
  space: { avg_ticket: 252 },
})

// ── 1. 三档测算（fin-v3：税费 4.5% + 摊销 60 月已计入）
// 手算：营收 660000、税费 660000×4.5%=29700、摊销 3800000÷60=63333.33
//       现金净流 = 409200 − 29700 − 250000 = 129500
//       会计净利 = 129500 − 63333.33 = 66166.67
const b = base.per_scenario.base
check('月营业额 = 660000', near(b.revenue, 660000, 0.5))
check('月现金净流 = 129500（不含摊销）', near(b.monthly_cash_flow, 129500, 0.5))
check('月净利（会计）= 66166.67', near(b.net_profit, 66166.67, 0.5))
check('现金口径回本 = 29.3 月', near(b.payback_static_months, 29.3, 0.05))
check('会计口径回本 = 57.4 月', near(b.accounting_payback_months, 57.4, 0.05))
check('会计回本 > 现金回本（摊销拉长）', b.accounting_payback_months > b.payback_static_months)
check('保守档会计净利为负', base.per_scenario.pessimistic.net_profit < 0)
check('保守档现金净流仍为正', base.per_scenario.pessimistic.monthly_cash_flow > 0)

// ── 2. 极限租金（现金口径）：保本 = 409200 − 29700 − 100000 = 279500
check('极限租金·保本 = 279500', near(b.max_rent_breakeven, 279500, 0.5))
// 目标回本 36 月：(409200 − 29700 − 3800000/36) − 100000 = 173944.44
check('极限租金·36月回本 = 173944.44', near(b.max_rent_target, 173944.44, 0.5))

// 反算恒等式：把租金设为 max_rent_target，回本应精确回到 36 个月
const rev = await tool.execute({
  store_id: 'T-002', format_code: 'large_yuecai',
  params: { ...P, monthly_rent: { value: b.max_rent_target, source: '反算', confidence: 1 } },
  target_payback_months: 36,
})
check('反算：租金设为极限值后回本 = 36 月', near(rev.per_scenario.base.payback_static_months, 36, 0.15))

// ── 3. 建议锚点：取基准档；保守档仅作压力下限（v2.10.8 改）
const rec = base.recommendation
// 口径变更（v2.10.17）：锚点与红线按**基准档**，最保守档另作压力下限并列。
// 理由：保守档是「营收↓15% 且 成本↑5%」双杀压力测试，拿它当谈判出价会让健康生意也报「需降 70%+」。
check('锚点取自基准档', rec.based_on_scenario === 'base')
check('锚点 = 基准档极限租金 ≈ 173944', near(rec.target_rent, 173944.44, 1))
check('压力下限 = 保守档极限租金 ≈ 106685', near(rec.target_rent_conservative, 106685.19, 1))
check('保本红线 = 基准档保本上限 ≈ 279500', near(rec.ceiling_rent, 279500, 1))
check('压力红线 = 保守档保本上限 ≈ 207214', near(rec.ceiling_rent_conservative, 207214.29, 1))
check('距锚点 = 150000 − 173944 ≈ -23944（有余量）', near(rec.gap_to_target, -23944.44, 1))
check('锚点可达（未标记不可达）', rec.anchor_unreachable === false)
check('租售比 = 22.7%', near(rec.current_rent_ratio, 0.2273, 0.001))
check('租售比判定为超红线', rec.rent_ratio_verdict === 'breach')

// ── 4. 租期现金流：默认 5 年、年递增 3%、第 5 年翻新
const L = base.lease_model
check('租期默认 5 年', L.term_years === 5)
check('年递增默认 3%', near(L.rent_escalation_pct, 0.03, 0.0001))
check('第 2 年租金 = 150000×1.03 = 154500', near(L.yearly[1].rent_monthly, 154500, 0.5))
check('第 5 年发生翻新', L.yearly[4].renovation > 0)
check('第 1–4 年无翻新', L.yearly.slice(0, 4).every((y) => y.renovation === 0))
check('租期内回本月份 > 0', L.payback_month > 0)
check('1500㎡ 用 5 年租期 → 触发租期过短警告', L.term_warning.includes('短于'))

// ── 5. 空间容量：厨房 35%、营业 975、座位 floor(975/2.8)=348
const S = base.space_model
check('厨房面积 = 525', near(S.kitchen_area_sqm, 525, 0.5))
check('营业面积 = 975', near(S.operating_area_sqm, 975, 0.5))
check('座位数 = 348', S.seats === 348)
check('座位为推算来源', S.seat_source === 'derived')
check('应有日营收 = 348×2.0×252 = 175392', near(S.implied_daily_revenue_normal, 175392, 1))
check('营收占比 ≈ 12.5%', near(S.revenue_vs_normal_ratio, 0.1254, 0.002))
check('输入自洽性 = revenue_too_low', S.input_consistency === 'revenue_too_low')
check('客单 252 与粤菜正餐区间匹配', S.ticket_matches_format === true)
check('保本翻台率 ≈ 0.17', near(S.breakeven_turnover_per_day, 0.165, 0.01))
check('目标翻台率 > 保本翻台率', S.target_turnover_per_day > S.breakeven_turnover_per_day)
check('盈亏平衡月 = 保本日 × 30', near(S.breakeven_revenue_monthly, b.breakeven_revenue_daily * 30, 1))

// ── 6. 内部比值校验：人力占比与单方造价都应偏低，且给出反推值
const byItem = (name) => base.ratio_checks.find((c) => c.item === name)
check('比值校验共 4 项', base.ratio_checks.length === 4)
check('人力占营收 ≈ 10.9% 且判偏低', byItem('人力占营收').status === 'low' && near(byItem('人力占营收').value, 10.9, 0.1))
check('人力偏低给出反推金额', byItem('人力占营收').note.includes('反推'))
check('单方造价 2533 判偏低', byItem('单方造价').status === 'low' && near(byItem('单方造价').value, 2533, 1))
check('毛利率 62% 判正常', byItem('毛利率').status === 'ok')
check('租售比 22.7% 已破警戒线 15%', byItem('租售比').status === 'breach' && near(byItem('租售比').value, 22.7, 0.2))

// ── 7. 假设台账：缺省项与口径都要摊出来
check('台账非空', base.assumption_ledger.length > 0)
check('台账含租期缺省项', base.assumption_ledger.some((r) => r.category === '租期系数'))
check('台账含空间系数', base.assumption_ledger.some((r) => r.category === '空间系数'))
check('台账含目标回本口径', base.assumption_ledger.some((r) => r.item === '目标回本周期'))

// ── 8. 敏感度：日营业额 ±20% 应翻转「租金偏高」的结论
const sensRevenue = base.sensitivity.find((s) => s.param === '日营业额')
check('敏感度含日营业额', Boolean(sensRevenue))
check('日营业额±20% 会翻转结论', sensRevenue.conclusion_flips === true)
const sensLabor = base.sensitivity.find((s) => s.param === '人力成本')
check('人力±20% 不翻转结论', sensLabor.conclusion_flips === false)
check('空间敏感度共 3 行', base.space_sensitivity.length === 3)
const seatRow = base.space_sensitivity.find((s) => s.param === '每座面积')
check('每座面积 −20% 座位增加', seatRow.seats_low > seatRow.seats_base)
check('每座面积 +20% 座位减少', seatRow.seats_high < seatRow.seats_base)

// ── 9. 参数覆盖：normal_turnover 改 2.5 应生效且被审计
const ov = await tool.execute({
  store_id: 'T-003', format_code: 'large_yuecai', params: P, area_sqm: 1500,
  space: { avg_ticket: 252 },
  overrides: { normal_turnover: 2.5, param_version: 'TEST-OV-1' },
})
check('覆盖生效：常规翻台 = 2.5', near(ov.space_model.normal_turnover_per_day, 2.5, 0.001))
check('覆盖后应有日营收 = 219240', near(ov.space_model.implied_daily_revenue_normal, 219240, 1))
check('覆盖键被审计记录', has(ov.param_overrides_applied, 'normal_turnover'))
check('覆盖版本号透传', ov.param_version_source === 'TEST-OV-1')

// ── 10. 业态标签校验：茶楼标签配 252 客单应报不符
const wrong = await tool.execute({
  store_id: 'T-004', format_code: 'tea_house', params: P, area_sqm: 1500,
  space: { avg_ticket: 252 },
})
check('茶楼标签 + 252 客单 → 标注不符', wrong.space_model.ticket_matches_format === false)
check('不符说明提及茶楼与正餐差别', wrong.space_model.ticket_note.includes('茶楼'))

// ── 11. 边界：不给面积 → 空间模型不可用，但盈亏平衡仍要出
const noArea = await tool.execute({ store_id: 'T-005', format_code: 'large_yuecai', params: P })
check('无面积时空间模型不可用', noArea.space_model.available === false)
check('无面积时仍给出盈亏平衡月额', noArea.space_model.breakeven_revenue_monthly > 0)
check('无面积时翻台率记 -1', noArea.space_model.turnover_per_day === -1)

// ── 12. 锚点不可达：人力抬到 30 万，零租金也达不到目标回本
const doomed = await tool.execute({
  store_id: 'T-006', format_code: 'large_yuecai',
  params: { ...P, monthly_labor: { value: 300000, source: '压力测试', confidence: 1 } },
})
check('人力 30 万时锚点被标记不可达', doomed.recommendation.anchor_unreachable === true)

// ── 13. 确定性：同样输入两次，结果必须逐字节一致
const again = await tool.execute({
  store_id: 'T-001', format_code: 'large_yuecai', params: P, area_sqm: 1500,
  space: { avg_ticket: 252 },
})
check('同输入两次结果一致', JSON.stringify(base) === JSON.stringify(again))

// ── 14. 点位截流力（第一轴：场地）与竞争压力（第二轴：竞品）并存
const L3 = await tool.execute({ store_id: 'T-L3', format_code: 'large_yuecai', params: P, catchment_level: 'L3' })
check('L3 乘数 = 1.00（行业基准）', near(L3.catchment_multiplier, 1.0, 0.001))
check('L3 不改变营业额', near(L3.per_scenario.base.revenue, 660000, 0.5))

const L1 = await tool.execute({ store_id: 'T-L1', format_code: 'large_yuecai', params: P, catchment_level: 'L1' })
check('L1 乘数 = 1.30（顶级截流）', near(L1.catchment_multiplier, 1.3, 0.001))
check('L1 营业额 = 660000×1.3 = 858000', near(L1.per_scenario.base.revenue, 858000, 1))
check('L1 回本快于基准', L1.per_scenario.base.payback_static_months < base.per_scenario.base.payback_static_months)
check('L1 口径台账多一行「客流乘数」', L1.formula_trace[0]?.metric === '客流乘数')

const L4 = await tool.execute({ store_id: 'T-L4', format_code: 'large_yuecai', params: P, catchment_level: 'L4' })
check('L4 乘数 = 0.65（弱截流）', near(L4.catchment_multiplier, 0.65, 0.001))
check('L4 营业额 = 429000', near(L4.per_scenario.base.revenue, 429000, 1))

let rejected = false
try {
  await tool.execute({ store_id: 'T-LX', format_code: 'large_yuecai', params: P, catchment_level: 'L9' })
} catch {
  rejected = true
}
check('非法等级在入口被拒（枚举校验）', rejected)
check('未传等级时 catchment_code 为空', base.catchment_code === '')

// ── 座位翻台五档基准（15 个细分业态）
// 用户验收点：同一个翻台原值，不同业态，判定必须不同
const TQ = {
  daily_revenue: { value: 278 * 1.499 * 120, source: 't', confidence: 0.9 },
  gross_margin: { value: 0.58, source: 't', confidence: 0.9 },
  monthly_rent: { value: 180000, source: 't', confidence: 0.9 },
  monthly_labor: { value: 380000, source: 't', confidence: 0.9 },
  monthly_other_fixed: { value: 197000, source: 't', confidence: 0.9 },
  initial_investment: { value: 3400000, source: 't', confidence: 0.9 },
}
// 1.499 次/日 × 278 座 × 120 元 × 30 天 ≈ 1,499,000/月
const turnCase = async (code, dailyRevenue) => tool.execute({
  store_id: 'T-TQ', format_code: code, params: { ...TQ, daily_revenue: { value: dailyRevenue, source: 't', confidence: 0.9 } },
  area_sqm: 1200, space: { avg_ticket: 120, seats: 278 },
})

// 验收点 ①：粤式大酒楼 1.499 → 红；且展示必须 3 位（不能显示 1.50）
const q1 = (await turnCase('large_yuecai', 278 * 1.499 * 120)).space_model
check('翻台 1.499 × 粤式大酒楼 → red', q1.turnover_risk === 'red')
check('翻台展示保留 3 位（1.499，不是 1.50）', q1.turnover_per_day === 1.499)
check('红档说明含未舍入值 1.499', q1.turnover_risk_note.includes('1.499'))
check('大酒楼告警线 1.5', q1.turnover_band?.alert_below === 1.5)
check('大酒楼绿区 1.8–2.2', q1.turnover_band?.normal_low === 1.8 && q1.turnover_band?.normal_high === 2.2)
check('大酒楼物理上限 2.6', q1.turnover_band?.max_real === 2.6)
check('大酒楼客单区间取自基准表 150–400', q1.typical_ticket_min === 150 && q1.typical_ticket_max === 400)

// 验收点 ②：粤式全天茶楼 1.499 → 黄，无红色
const q2 = (await turnCase('tea_house', 278 * 1.499 * 120)).space_model
check('翻台 1.499 × 24h 纯茶市 → yellow', q2.turnover_risk === 'yellow')
check('茶楼告警线 1.3（非 1.5）', q2.turnover_band?.alert_below === 1.3)
check('同一翻台值，两业态判定不同', q1.turnover_risk !== q2.turnover_risk)

// 全天茶楼（非 24h）：告警线 1.4
const q3 = (await turnCase('yumcha_day', 278 * 1.499 * 120)).space_model
check('全天茶楼告警线 1.4', q3.turnover_band?.alert_below === 1.4)
check('全天茶楼 1.499 → yellow', q3.turnover_risk === 'yellow')

// 五档边界：绿区 / 高于常态 / 超物理上限
const q4 = (await turnCase('large_yuecai', 278 * 2.0 * 120)).space_model
check('翻台 2.0 → green', q4.turnover_risk === 'green')
const q5 = (await turnCase('large_yuecai', 278 * 2.4 * 120)).space_model
check('翻台 2.4（绿上限 2.2 之上）→ high', q5.turnover_risk === 'high')
const q6 = (await turnCase('large_yuecai', 278 * 2.8 * 120)).space_model
check('翻台 2.8（超物理上限 2.6）→ impossible', q6.turnover_risk === 'impossible')

// 客单配对校验：同一业态，客单跑出区间要告警
const q7 = (await turnCase('large_yuecai', 278 * 2.0 * 120)).space_model
check('大酒楼客单 120 低于 150 → 判不符', q7.ticket_matches_format === false)
const q8 = (await tool.execute({
  store_id: 'T-TQ8', format_code: 'tea_house', params: TQ, area_sqm: 1200,
  space: { avg_ticket: 100, seats: 278 },
})).space_model
check('茶楼客单 100 落在 60–120 → 相符', q8.ticket_matches_format === true)

// 未配置业态：返回 unknown，不臆造
const q9 = (await tool.execute({
  store_id: 'T-TQ9', format_code: 'convenience_store', params: TQ, area_sqm: 200,
  space: { avg_ticket: 20, seats: 10 },
})).space_model
check('未配置业态翻台判为 unknown', q9.turnover_risk === 'unknown')
check('未配置业态不输出 turnover_band', q9.turnover_band === undefined)

// ── 汇总
console.log('\n--- 断言 ---')
let pass = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${checks.length} 通过`)
if (pass !== checks.length) process.exitCode = 1
