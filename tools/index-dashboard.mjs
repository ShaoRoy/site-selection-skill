/**
 * index-dashboard.mjs —— 生成进度看板 out/index.md
 *
 * 设计目的：**防遗忘的唯一最小机制**。
 * 每次 run-site 跑完写一个 status.json，这个脚本把它们汇总成一页表。
 * 打开项目第一眼看这个文件，就知道哪些点位做过、做到哪一步、结论是什么。
 *
 * 用法（scratch-plugin 目录下）：
 *   node tools/index-dashboard.mjs
 *   node tools/index-dashboard.mjs --city 广州
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = new URL('../out/', import.meta.url)

const args = process.argv.slice(2)
const cityFilter = (() => {
  const i = args.findIndex((a) => a === '--city')
  return i >= 0 ? args[i + 1] : ''
})()

const STATUS_ORDER = ['未扫描', '已扫描', '已评估', '已现场', '候选池', '已否决', '已签约']
const STATUS_MARK = {
  未扫描: '⚪', 已扫描: '🟡', 已评估: '🟢', 已现场: '🔵',
  候选池: '📌', 已否决: '🔴', 已签约: '🟣',
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

// ── 收集 status.json
const rows = []
if (existsSync(OUT)) {
  for (const name of readdirSync(OUT)) {
    const dir = new URL(`${name}/`, OUT)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    const statusFile = new URL('status.json', dir)
    if (!existsSync(statusFile)) continue
    const s = readJson(statusFile)
    if (!s) continue
    if (cityFilter && s.city !== cityFilter) continue
    rows.push({ ...s, folder: name })
  }
}

rows.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))

// ── 读 registry 做覆盖摘要
const registry = readJson(new URL('grid/registry.json', OUT))
let coverage = ''
if (registry && registry.grids) {
  const grids = Object.values(registry.grids).filter((g) => !cityFilter || g.city === cityFilter)
  if (grids.length > 0) {
    const counts = {}
    for (const g of grids) counts[g.status] = (counts[g.status] ?? 0) + 1
    const touched = grids.length - (counts['未扫描'] ?? 0)
    coverage = [
      `**网格覆盖**：${grids.length} 个，已接触 ${touched}（${((touched / grids.length) * 100).toFixed(1)}%）`,
      ...(counts['未扫描'] ? [] : ['', '> ⚠️ registry 里没有「未扫描」网格，覆盖率会显示 100%。先铺底：`python tools/grid-registry.py --create --city <城市> --bbox lat1,lng1,lat2,lng2`']),
      '',
      '| 状态 | 数量 |',
      '| --- | --- |',
      ...STATUS_ORDER.filter((s) => counts[s]).map((s) => `| ${STATUS_MARK[s] ?? ''} ${s} | ${counts[s]} |`),
      '',
    ].join('\n')
  }
}

// ── 生成 markdown
const md = []
md.push('# 点位进度看板', '')
md.push(`> 自动生成于 ${new Date().toLocaleString('zh-CN')}｜数据源：各点位 \`status.json\``)
md.push('> **不要手改本文件**，跑 `node tools/index-dashboard.mjs` 重新生成。', '')

if (rows.length === 0) {
  md.push('_暂无点位记录。跑一次 `node tools/run-site.mjs --address=... --survey=...` 就会出现。_', '')
} else {
  md.push(`## 点位（${rows.length} 个${cityFilter ? `，城市：${cityFilter}` : ''}）`, '')
  md.push('| 状态 | 点位 | 城市 | 网格 | 更新 | 结论 | 报告 |')
  md.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const r of rows) {
    const mark = STATUS_MARK[r.status] ?? '⚪'
    // 路径含 ) 或反引号会截断 markdown 链接；encodeURI 后再放进括号
    const report = r.report ? `[报告](${encodeURI(r.report).replace(/\)/g, '%29')})` : '—'
    md.push(
      `| ${mark} ${r.status ?? '未知'} | ${r.address ?? r.store_id ?? r.folder} `
      + `| ${r.city ?? '—'} | ${r.grid_id ?? '—'} | ${r.updated_at ?? '—'} `
      + `| ${r.conclusion ?? '—'} | ${report} |`,
    )
  }
  md.push('')
}

if (coverage) {
  md.push('## 网格覆盖', '', coverage)
  md.push('> 查未做的网格：`python tools/grid-registry.py --city <城市> --status 未扫描`')
  md.push('> 看覆盖地图：`python tools/grid-registry.py --city <城市> --map`', '')
}

md.push('## 下一步该做什么', '')
const untouched = rows.filter((r) => r.status === '已扫描').length
const evaluated = rows.filter((r) => r.status === '已评估').length
const visited = rows.filter((r) => r.status === '已现场').length
if (rows.length === 0) {
  md.push('1. 先跑一个真实点位：`run-site --address=... --survey=...`')
} else {
  if (evaluated > 0) md.push(`1. **${evaluated} 个点位已评估但还没去现场** → 带上 \`survey/barriers/_template.csv\` 去跑动线阻断`)
  if (untouched > 0) md.push(`2. ${untouched} 个点位只扫描过、没做评估 → 挑分数高的跑 \`run-site\``)
  if (visited > 0) md.push(`3. ${visited} 个点位已现场 → 补齐财务参数，进财务锁盘`)
  if (evaluated === 0 && visited === 0) md.push('1. 挑一个点位跑完整评估，验证流程能走通')
}
md.push('')

const target = new URL('index.md', OUT)
// 干净检出（无 out/ 目录）时这里原本会 ENOENT —— 看板是首屏产物，不能因为目录没建就崩。
mkdirSync(OUT, { recursive: true })
writeFileSync(target, md.join('\n'), 'utf8')
console.log(`已生成 ${fileURLToPath(target)}（${rows.length} 个点位${coverage ? '，含网格覆盖' : ''}）`)
