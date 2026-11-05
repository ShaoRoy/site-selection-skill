/**
 * test-parity.mjs —— TS / Python 双引擎跨链路契约测试
 *
 * 为什么要有这个文件：
 *   两套引擎（dsh/site-tools.ts 与 scripts/site_core.py）各自维护一份财务口径。
 *   v2.10.25 曾出现「TS 取基准档、Python 取保守档」的分裂，两边各自测试全绿，
 *   结论却差 1.56 倍。内部自测抓不到这类问题，只有跨引擎比对能抓。
 *
 * 做什么：
 *   同一组参数分别喂给两条链路，逐字段比对同名数值与枚举。
 *   任何口径漂移在这里第一次 npm test 就会红。
 *
 * 不需要比对的字段：纯展示/文案（rent_ratio_hint、formula_trace、assumption_ledger 等），
 *   单边存在不算失败。
 *
 * 用法：
 *   node tools/test-parity.mjs          # 详细输出
 *   npm test                            # 与冒烟测试串联
 *
 * 注意：TS 侧需要依赖（@deepseek-ai/dsh-tools）。在 dist/ 下跑需先安装依赖，
 *   否则会明确报错并给出修复命令，不会静默跳过。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ───────────────────────── 路径常量（集中，不散落） ─────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** TS 引擎入口：scratch-plugin 是 src/，dist 是 dsh/ */
const TS_CANDIDATES = [
  join(ROOT, 'src', 'site-tools.ts'),
  join(ROOT, 'dsh', 'site-tools.ts'),
]
/** Python 引擎 CLI：dist 下是 scripts/；scratch-plugin 无 scripts/，回退到 dist */
const PY_CANDIDATES = [
  join(ROOT, 'scripts', 'site_core.py'),
  resolve(ROOT, '..', 'dist', 'site-selection', 'scripts', 'site_core.py'),
]
const PY_CLI = PY_CANDIDATES.find((p) => existsSync(p))
if (!PY_CLI) {
  console.error(`❌ 找不到 Python 引擎：试过\n  ${PY_CANDIDATES.join('\n  ')}`)
  process.exit(1)
}

const TOL = 0.02

// ───────────────────────── 比对字段清单 ─────────────────────────
/** recommendation 里必须两边相等的字段 */
const REC_FIELDS = [
  'target_rent', 'ceiling_rent',
  'ceiling_rent_conservative', 'target_rent_conservative',
  'gap_to_target', 'gap_to_ceiling',
  'based_on_scenario', 'rent_ratio_verdict',
  'current_rent_ratio', 'rent_ratio_healthy_max', 'rent_ratio_warning_max',
  'anchor_unreachable',
]
/** per_scenario 每档里必须相等的数值字段 */
const SCEN_FIELDS = [
  'revenue', 'monthly_cash_flow', 'net_profit', 'breakeven_revenue_daily',
  'max_rent_breakeven', 'max_rent_target',
  'payback_static_months', 'accounting_payback_months', 'roi',
]
const SCENARIOS = ['base', 'pessimistic', 'optimistic']

// ───────────────────────── 测试用例 ─────────────────────────
/**
 * CASE-A：扬韬广场真实参数（工单 §2）
 *   base max_rent_breakeven=490000 / max_rent_target=365000
 *   不传 catchment（乘数 1），target=36
 */
const CASE_A = {
  name: 'CASE-A 扬韬广场',
  params: {
    daily_revenue: 100000, gross_margin: 0.58, monthly_rent: 290000,
    monthly_labor: 780000, monthly_other_fixed: 335000,
    initial_investment: 4500000, tax_rate: 0.045, amortization_months: 60,
  },
  format: 'large_yuecai',
  area: 1200,
  space: { avg_ticket: 180 },
  catchment: undefined,
  target: 36,
}

/**
 * CASE-B：selftest 内置参数（工单 §5）
 *   两侧都不传 target，走各自默认值（实测均为 large_yuecai 的 36）——
 *   若这里出现差异，先查默认值是否一致，不要放宽容差。
 */
const CASE_B = {
  name: 'CASE-B selftest 内置',
  params: {
    daily_revenue: 30000, gross_margin: 0.62, monthly_rent: 120000,
    monthly_labor: 150000, monthly_other_fixed: 40000, initial_investment: 3200000,
  },
  format: 'large_yuecai',
  area: 1200,
  space: { avg_ticket: 230 },
  catchment: 'L2',
  target: undefined,
}

// ───────────────────────── 断言收集 ─────────────────────────
const checks = []
const record = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail })
const near = (a, b, tol = TOL) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol

// ───────────────────────── TS 侧 ─────────────────────────
let tsTool = null

async function loadTsTool() {
  const entry = TS_CANDIDATES.find((p) => existsSync(p))
  if (!entry) {
    console.error(`❌ 找不到 TS 引擎：试过\n  ${TS_CANDIDATES.join('\n  ')}`)
    process.exit(1)
  }
  let mod
  try {
    mod = await import(new URL(`file://${entry.replace(/\\/g, '/')}`).href)
  } catch (err) {
    if (String(err?.message ?? err).includes('@deepseek-ai/dsh-tools')) {
      console.error(
        '❌ TS 引擎依赖缺失（@deepseek-ai/dsh-tools）。\n'
        + `   入口：${entry}\n`
        + '   修复：在本目录执行 pnpm install，或从 scratch-plugin 目录运行本测试。\n'
        + '   契约测试必须两边都真跑，不允许静默跳过。',
      )
      process.exit(1)
    }
    throw err
  }
  const registered = []
  mod.apply({ tools: { register: (d) => { registered.push(d); return () => {} } } })
  const tool = registered.find((t) => t.name === 'financial_calc')
  if (!tool) {
    console.error('❌ TS 引擎里没找到 financial_calc')
    process.exit(1)
  }
  return tool
}

/** TS 需要 {value, source, confidence} 包装；Python 是裸值 */
const wrap = (v) => ({ value: v, source: 'parity', confidence: 0.8 })

async function runTs(c) {
  const args = {
    store_id: `PARITY-${c.name}`,
    format_code: c.format,
    params: Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, wrap(v)])),
    area_sqm: c.area,
    space: c.space,
  }
  if (c.catchment !== undefined) args.catchment_level = c.catchment
  if (c.target !== undefined) args.target_payback_months = c.target
  return tsTool.execute(args)
}

// ───────────────────────── Python 侧 ─────────────────────────
function runPy(c) {
  const argv = [
    PY_CLI, 'finance',
    '--params', JSON.stringify(c.params),
    '--area', String(c.area),
    '--format', c.format,
    '--space', JSON.stringify(c.space),
  ]
  if (c.catchment !== undefined) argv.push('--catchment', c.catchment)
  if (c.target !== undefined) argv.push('--target', String(c.target))

  const r = spawnSync('python', argv, { encoding: 'utf8', cwd: ROOT })
  if (r.error) {
    console.error(`❌ Python 调用失败：${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`❌ Python 退出码 ${r.status}\n${r.stderr?.slice(0, 800)}`)
    process.exit(1)
  }
  try {
    return JSON.parse(r.stdout)
  } catch {
    console.error(`❌ Python 输出不是 JSON：\n${r.stdout?.slice(0, 500)}`)
    process.exit(1)
  }
}

// ───────────────────────── 比对 ─────────────────────────
function compare(c, ts, py) {
  const tsRec = ts.recommendation ?? {}
  const pyRec = py.recommendation ?? {}

  for (const f of REC_FIELDS) {
    const a = tsRec[f]
    const b = pyRec[f]
    if (typeof a === 'number' || typeof b === 'number') {
      record(`${c.name} · recommendation.${f}`, near(a, b), { ts: a, py: b })
    } else {
      record(`${c.name} · recommendation.${f}`, a === b, { ts: a, py: b })
    }
  }

  for (const s of SCENARIOS) {
    const a = ts.per_scenario?.[s] ?? {}
    const b = py.per_scenario?.[s] ?? {}
    if (!a || !b || Object.keys(a).length === 0 || Object.keys(b).length === 0) {
      record(`${c.name} · per_scenario.${s} 存在`, false, { ts: !!a, py: !!b })
      continue
    }
    for (const f of SCEN_FIELDS) {
      record(`${c.name} · per_scenario.${s}.${f}`, near(a[f], b[f]), { ts: a[f], py: b[f] })
    }
  }
}

// ───────────────────────── 主流程 ─────────────────────────
tsTool = await loadTsTool()

for (const c of [CASE_A, CASE_B]) {
  const ts = await runTs(c)
  const py = runPy(c)
  compare(c, ts, py)
}

const failed = checks.filter((x) => !x.ok)
if (failed.length === 0) {
  console.log(`parity: ${checks.length}/${checks.length} PASS（TS ↔ Python 口径一致）`)
  process.exit(0)
}

console.error(`parity: ${checks.length - failed.length}/${checks.length} PASS —— ${failed.length} 项不符\n`)
console.error('字段'.padEnd(58) + 'TS'.padStart(16) + 'PY'.padStart(16))
console.error('-'.repeat(90))
for (const f of failed) {
  const ts = f.detail?.ts
  const py = f.detail?.py
  const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '—'))
  console.error(f.label.padEnd(58) + fmt(ts).padStart(16) + fmt(py).padStart(16))
}
console.error(
  '\n口径分裂意味着两条链路对同一组参数给出不同结论。'
  + '\n先确认哪边是对的（看 CHANGELOG 与 references/02-formulas.md），再统一实现——不要靠放大容差让它变绿。',
)
process.exit(1)
