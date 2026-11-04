/**
 * test-grid.mjs —— 网格编号 / registry / 看板 的护栏
 *
 * 用法（scratch-plugin 目录下）：node .\tools\test-grid.mjs
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
const selfTest = spawnSync('python', [p(new URL('grid-registry.py', TOOLS)), '--self-test'], { encoding: 'utf8' })
check('registry --self-test 通过', selfTest.status === 0)
check('registry 自测 12 条全过', /12\/12 通过/.test(selfTest.stdout ?? ''))

// ── B. 编号公式：JS 与 Python 必须一致（防止两处实现漂移）
const jsGridId = (lat, lng) => `G${Math.floor((lat + 90) / 0.005)}_${Math.floor((lng + 180) / 0.005)}`
const pyOut = spawnSync('python', [p(new URL('grid-registry.py', TOOLS)), '--id-of', '23.119825,113.333776'], { encoding: 'utf8' })
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
  check('看板含点位表头', md.includes('| 状态 | 点位 |'))
  check('看板含下一步建议', md.includes('下一步该做什么'))
}

// ── E. 候选表（若跑过 grid-scan）
const cand = new URL('grid/candidates-广州-天河.csv', OUT)
if (existsSync(cand)) {
  const csv = readFileSync(cand, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  const head = csv[0].split(',')
  check('候选表含评分列', ['rank', 'grade', 'total', 'demand', 'pressure', 'reason'].every((k) => head.includes(k)))
  check('候选表至少 10 行', csv.filter((l) => l.trim() !== '').length > 10)
  check('候选表分数在本批内归一（存在 100）', csv.slice(1).some((l) => l.includes(',100.0,') || l.includes(',100,')))
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
