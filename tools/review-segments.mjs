/**
 * review-segments.mjs —— 竞争分段的人工核对与回灌
 *
 * 用法：
 *   node .\tools\review-segments.mjs --in=out\xxx-review.csv
 *   node .\tools\review-segments.mjs --in=out\xxx-review.csv --apply --profile=large-yuecai
 *
 * 流程：
 *   1) probe 生成 *-review.csv（含"自动分段"列）
 *   2) 在 Excel 里填「人工校正」列（留空 = 保留自动结果）
 *   3) --apply 写入 profiles\<slug>.overrides.json
 *   4) 重跑 run-site，probe 会自动加载校正
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const args = new Map()
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw)
  if (m) args.set(m[1], m[2] ?? 'true')
}

const inFile = args.get('in')
if (!inFile) {
  console.error('用法：node .\\tools\\review-segments.mjs --in=out\\xxx-review.csv [--apply --profile=<slug>]')
  process.exit(1)
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1 } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''))
}

const rows = parseCsv(readFileSync(inFile, 'utf8'))
const header = rows[0]
const idx = (name) => header.indexOf(name)
if (idx('名称') < 0 || idx('自动分段') < 0) {
  console.error(`表头不对，需要「名称」「自动分段」列，当前：${header.join(' | ')}`)
  process.exit(1)
}

const items = rows.slice(1).map((r) => ({
  name: r[idx('名称')] ?? '',
  category: r[idx('类目')] ?? '',
  auto: r[idx('自动分段')] ?? '',
  manual: (idx('人工校正') >= 0 ? r[idx('人工校正')] ?? '' : '').trim(),
  cost: Number(idx('人均') >= 0 ? r[idx('人均')] : 0) || 0,
  rating: Number(idx('评分') >= 0 ? r[idx('评分')] : 0) || 0,
}))

// 汇总
const counts = new Map()
for (const it of items) {
  const seg = it.manual || it.auto
  counts.set(seg, (counts.get(seg) ?? 0) + 1)
}
console.log(`=== 核对：${inFile}（${items.length} 家）===`)
for (const [seg, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  const group = items.filter((it) => (it.manual || it.auto) === seg)
  const costs = group.map((g) => g.cost).filter((c) => c > 0)
  const avg = costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) : -1
  console.log(`  ${seg}：${n} 家${avg > 0 ? `（人均 ${avg} 元，有价率 ${Math.round((costs.length / n) * 100)}%）` : ''}`)
}

// 可疑项：靠名字判段但人均打脸
const suspects = items.filter((it) => {
  if (!it.cost) return false
  const seg = it.manual || it.auto
  if (/large/.test(seg) && it.cost < 60) return true
  if (/small/.test(seg) && it.cost >= 120) return true
  if (/粿条|牛肉饭|肠粉|粉面/.test(it.name) && /large/.test(seg)) return true
  if (/酒家|宴会|酒楼|公馆/.test(it.name) && /small/.test(seg)) return true
  return false
})
if (suspects.length > 0) {
  console.log(`\n⚠️ 可疑（${suspects.length} 家，建议人工确认后填「人工校正」）：`)
  for (const s of suspects.slice(0, 25)) {
    console.log(`  - ${s.name}｜自动=${s.auto}｜人均=${s.cost || '—'}｜${s.category}`)
  }
  if (suspects.length > 25) console.log(`  …… 还有 ${suspects.length - 25} 家，见 CSV`)
} else {
  console.log('\n✅ 没有发现明显矛盾项')
}

// 回灌
if (args.has('apply')) {
  const slug = args.get('profile')
  if (!slug) {
    console.error('--apply 需要 --profile=<slug>')
    process.exit(1)
  }
  const overrides = {}
  for (const it of items) {
    if (it.manual && it.manual !== it.auto) overrides[it.name] = it.manual
  }
  const target = new URL(`../profiles/${slug}.overrides.json`, import.meta.url)
  mkdirSync(new URL('../profiles/', import.meta.url), { recursive: true })
  writeFileSync(target, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8')
  console.log(`\n✅ 已写入人工校正 ${Object.keys(overrides).length} 条 → ${decodeURIComponent(target.pathname).replace(/^\/([A-Za-z]:)/, '$1')}`)
  console.log('重跑 run-site 即生效（probe 会自动加载 overrides）')
} else {
  console.log('\n下一步：在 CSV 的「人工校正」列填分段 key，然后 --apply --profile=<slug>')
}
