/**
 * test-grid.mjs —— 网格编号 / registry / 看板 的护栏
 *
 * 用法（源码包根目录下）：node tools/test-grid.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOOLS = new URL('./', import.meta.url)
const OUT = new URL('../out/', import.meta.url)
const p = (u) => fileURLToPath(u)

const checks = []
const check = (label, ok) => checks.push([label, Boolean(ok)])

// ── A. Python registry 自测
const selfTest = spawnSync('python', [p(new URL('../scripts/grid-registry.py', TOOLS)), '--self-test'], { encoding: 'utf8' })
check('registry --self-test 通过', selfTest.status === 0)
check('registry 自测 12 条全过', /12\/12 通过/.test(selfTest.stdout ?? ''))

// ── B. 编号公式：JS 与 Python 必须一致（防止两处实现漂移）
const jsGridId = (lat, lng) => `G${Math.floor((lat + 90) / 0.005)}_${Math.floor((lng + 180) / 0.005)}`
const pyOut = spawnSync('python', [p(new URL('../scripts/grid-registry.py', TOOLS)), '--id-of', '23.119825,113.333776'], { encoding: 'utf8' })
check('编号公式 JS 与 Python 一致', (pyOut.stdout ?? '').trim() === jsGridId(23.119825, 113.333776))
check('编号形如 G<lat>_<lng>', /^G\d+_\d+$/.test(jsGridId(23.119825, 113.333776)))

// ── C. registry 文件结构与状态机
const regPath = new URL('grid/registry.json', OUT)
if (existsSync(regPath)) {
  const reg = JSON.parse(readFileSync(regPath, 'utf8').replace(/^\uFEFF/, ''))
  const grids = Object.values(reg.grids ?? {})
  check('registry 有网格记录', grids.length > 0)
  check('每条记录有 grid_id/status/history', grids.every((g) => g.grid_id && g.status && Array.isArray(g.history)))
  check('状态取值合法', grids.every((g) => ['未扫描', '已扫描', '已评估', '已现场', '候选池', '已否决', '已签约'].includes(g.status)))
  check('已接触网格有 history', grids.filter((g) => g.status !== '未扫描').every((g) => g.history.length > 0))
} else {
  check('registry 文件存在', false)
}

// ── D. 看板生成
const dash = spawnSync(process.execPath, [p(new URL('index-dashboard.mjs', TOOLS))], { encoding: 'utf8' })
check('看板脚本执行成功', dash.status === 0)
const indexPath = new URL('index.md', OUT)
check('out/index.md 已生成', existsSync(indexPath))
if (existsSync(indexPath)) {
  const md = readFileSync(indexPath, 'utf8')
  check('看板含标题', md.includes('# 点位进度看板'))
  // 看板在「有点位记录」与「空态」两种状态下都应成立：
  // 断言不能依赖本机是否跑过 run-site，否则干净检出必然 FAIL。
  check('看板含点位表头或空态提示',
    md.includes('| 状态 | 点位 |') || md.includes('暂无点位记录'))
  check('看板含下一步建议', md.includes('下一步该做什么'))
}

// ── E. 候选表（若跑过 grid-scan）
// 口径 v2.10.34（grid-v1）起：列名从 total/demand/pressure 改为
// rank_score/demand_rel/pressure_rel，并新增 d_abs/p_abs 与公式版本列。
// 旧断言「本批内归一（存在 100）」会锁死旧行为，已按新口径改写。
const cand = new URL('grid/candidates-广州-天河.csv', OUT)
if (existsSync(cand)) {
  const raw = readFileSync(cand, 'utf8').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = lines[0].split(',')
  const need = ['rank', 'grade', 'rank_score', 'demand_rel', 'pressure_rel', 'd_abs', 'p_abs', 'score_formula_version', 'reason']
  const missing = need.filter((k) => !head.includes(k))
  check(`候选表含新口径列（缺：${missing.join('/') || '无'}）`, missing.length === 0)
  check('候选表不再输出旧列 total/demand/pressure', !head.includes('total') && !head.includes('demand') && !head.includes('pressure'))
  check('候选表至少 1 行数据', lines.length - 1 >= 1)

  const idx = (k) => head.indexOf(k)
  const rows = lines.slice(1).map((l) => l.split(','))
  const nums = (k) => rows.map((r) => Number(r[idx(k)]))

  const relInRange = [nums('demand_rel'), nums('pressure_rel')]
    .every((arr) => arr.every((v) => Number.isFinite(v) && v >= -1e-6 && v <= 100 + 1e-6))
  check('相对口径落在 0~100 区间', relInRange)

  const dMax = Math.max(...nums('demand_rel'))
  const pMax = Math.max(...nums('pressure_rel'))
  const allSameD = new Set(nums('d_abs')).size === 1
  const allSameP = new Set(nums('p_abs')).size === 1
  check('本批相对分在最高项上归一为 100（除非该项全场同值）',
    (allSameD || Math.abs(dMax - 100) < 1e-4) && (allSameP || Math.abs(pMax - 100) < 1e-4))

  // 零竞争不再被罚：p_abs 全 0 的候选，pressure_rel 必须为 0
  const zeroCompOk = rows.every((r) => Number(r[idx('p_abs')]) > 0 || Number(r[idx('pressure_rel')]) === 0)
  check('零竞争候选 pressure_rel = 0（不误罚）', zeroCompOk)

  // rank_score = demand_rel − pressure_rel × k，逐行复算
  const kUsed = rows.length
    ? Number((Number(rows[0][idx('demand_rel')]) - Number(rows[0][idx('rank_score')])) / (Number(rows[0][idx('pressure_rel')]) || 1))
    : NaN
  const rankOk = rows.every((r, i) => {
    const d = Number(r[idx('demand_rel')])
    const p = Number(r[idx('pressure_rel')])
    const rs = Number(r[idx('rank_score')])
    // 用首行反推的 k 复算；pressure_rel 为 0 时无法反推，改用 0.8 兜底比对
    const k = Number.isFinite(kUsed) && Math.abs(kUsed - 0.8) < 1e-3 ? kUsed : 0.8
    return Math.abs(d - p * k - rs) < 1e-2 || i === 0
  })
  check('rank_score = demand_rel − pressure_rel × k（逐行复算）', rankOk)

  check('公式版本标记为 grid-v1',
    rows.every((r) => r[idx('score_formula_version')] === 'grid-v1'))
} else {
  check('候选表存在（先跑一次 grid-scan --rescore）', false)
}

// ── F. sidecar：分数必须可纸上复算
const sidecar = new URL('grid/candidates-广州-天河.score.json', OUT)
if (existsSync(sidecar)) {
  const sc = JSON.parse(readFileSync(sidecar, 'utf8').replace(/^\uFEFF/, ''))
  check('sidecar 含公式版本 grid-v1', sc.score_formula_version === 'grid-v1')
  check('sidecar 含参数结构版本 2', sc.params_schema_version === 2)
  check('sidecar 记录参数来源', Boolean(sc.param_sources?.radius_m && sc.param_sources?.k && sc.param_sources?.weights))
  check('sidecar 记录归一化基准', Boolean(sc.normalization?.d_abs && sc.normalization?.p_abs))
  check('sidecar 标注 PROXY 代理口径', typeof sc.provenance === 'string' && /PROXY|代理/.test(sc.provenance))

  const w = sc.weights ?? {}
  const wSum = Object.values(w).reduce((a, b) => a + b, 0)
  check('sidecar 权重四项之和为 1', Math.abs(wSum - 1) < 1e-6)

  let recalcOk = true
  let contribOk = true
  for (const c of sc.candidates ?? []) {
    const dAbs = Object.entries(w).reduce((a, [key, wv]) => a + (c.density?.[key] ?? NaN) * wv, 0)
    if (!(Math.abs(dAbs - c.d_abs) < 1e-4)) recalcOk = false
    const contribSum = Object.values(c.contrib ?? {}).reduce((a, b) => a + b, 0)
    if (!(Math.abs(contribSum - c.d_abs) < 1e-4)) contribOk = false
  }
  check('逐项 density×weight 复算还原 d_abs', recalcOk)
  check('逐项 contrib 求和还原 d_abs', contribOk)

  const nd = sc.normalization?.d_abs ?? {}
  const np = sc.normalization?.p_abs ?? {}
  const rel = (v, lo, hi) => (hi - lo < 1e-9 ? 0 : ((v - lo) / (hi - lo)) * 100)
  const scoreOk = (sc.candidates ?? []).every((c) => {
    const dr = rel(c.d_abs, nd.min, nd.max)
    const pr = rel(c.p_abs, np.min, np.max)
    const rs = dr - pr * sc.k
    return Math.abs(dr - c.demand_rel) < 1e-2
      && Math.abs(pr - c.pressure_rel) < 1e-2
      && Math.abs(rs - c.rank_score) < 1e-2
  })
  check('按 sidecar 基准可纸上复算还原 rank_score', scoreOk)
} else {
  check('sidecar 存在（先跑一次 grid-scan --rescore）', false)
}

// ── 汇总
console.log('\n--- 断言 ---')
let pass = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${checks.length} 通过`)
if (pass !== checks.length) process.exitCode = 1
