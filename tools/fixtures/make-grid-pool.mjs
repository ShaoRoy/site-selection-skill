/**
 * fixtures/make-grid-pool.mjs —— TEST-ONLY 网格测试夹具
 *
 * 作用：在一份干净的检出里，生成 `out/grid/` 下的两份夹具，
 * 让 `grid-scan --rescore` 与 `test-grid.mjs` 能离线跑通（0 次接口调用）。
 *
 * 生成物：
 *   out/grid/_pool-广州-天河.json   采集快照（6 锚点 / 底图 POI / 竞品）
 *   out/grid/registry.json          网格注册表（6 条「未扫描」记录）
 *
 * 关键约束：
 *   · 锚点间距 > 2.5km，POI 撒在各自锚点 500m 圆周上 →
 *     「任意锚点在 1000m 内的计数 == 设计值」可被独立复算，脚本末尾自校验，不符即 exit 1。
 *   · 纯 Node 内建模块，不联网、不需要 Key、不引入第三方依赖。
 *   · 仅在 03 源码包内分发（01 技能包不含 tools/）。
 *
 * 用法（源码包根目录）：
 *   node tools/fixtures/make-grid-pool.mjs
 *   python scripts/grid-scan.py --city 广州 --district 天河 --rescore
 *   node tools/test-grid.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = new URL('../../out/grid/', import.meta.url)
const M_PER_DEG_LAT = 111320.0
const GRID_SIZE_DEG = 0.005
const FIXTURE_RADIUS_M = 1000

// 名称, kind, lat, lng, 住宅, 办公, 咖啡, 银行, 竞品（1km 内设计计数）
const ANCHORS = [
  ['体育西路(B合成)', 'metro', 23.1330, 113.3200, 120, 200, 40, 25, 90],
  ['岗顶(B合成)', 'metro', 23.1400, 113.3450, 150, 40, 15, 12, 20],
  ['棠下(B合成)', 'metro', 23.1650, 113.3650, 80, 60, 10, 8, 45],
  ['龙洞(B合成)', 'metro', 23.1900, 113.4000, 100, 90, 22, 18, 60],
  ['车陂(B合成)', 'mall', 23.1250, 113.4000, 20, 5, 0, 2, 0],
  ['东圃(B合成)', 'mall', 23.1000, 113.4200, 10, 0, 0, 1, 0],
]

const haversine = (a1, o1, a2, o2) => {
  const R = 6371000.0
  const p1 = (a1 * Math.PI) / 180
  const p2 = (a2 * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((o2 - o1) * Math.PI) / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const ring = (prefix, n, lat, lng, radius = 500.0) => {
  const out = []
  const perLng = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
  for (let i = 0; i < n; i += 1) {
    const ang = (2 * Math.PI * i) / n
    out.push({
      name: `${prefix}${String(i).padStart(3, '0')}`,
      lat: Number((lat + (radius * Math.sin(ang)) / M_PER_DEG_LAT).toFixed(6)),
      lng: Number((lng + (radius * Math.cos(ang)) / perLng).toFixed(6)),
    })
  }
  return out
}

const anchors = []
const pool = { residential: [], office: [], coffee: [], bank: [] }
const competitors = []

for (const [name, kind, lat, lng, res, off, cof, ban, comp] of ANCHORS) {
  anchors.push({ name, kind, lat, lng })
  pool.residential.push(...ring('r', res, lat, lng))
  pool.office.push(...ring('o', off, lat, lng))
  pool.coffee.push(...ring('c', cof, lat, lng))
  pool.bank.push(...ring('b', ban, lat, lng))
  competitors.push(...ring('k', comp, lat, lng))
}

// ── 自校验：每个锚点 1km 内计数必须等于设计值
const near = (rows, a) => rows.filter((p) => haversine(a.lat, a.lng, p.lat, p.lng) <= FIXTURE_RADIUS_M).length
const bad = []
for (let i = 0; i < ANCHORS.length; i += 1) {
  const [, , , , res, off, cof, ban, comp] = ANCHORS[i]
  const a = anchors[i]
  const got = [near(pool.residential, a), near(pool.office, a), near(pool.coffee, a), near(pool.bank, a), near(competitors, a)]
  const want = [res, off, cof, ban, comp]
  if (got.join() !== want.join()) bad.push(`${a.name}: 设计 ${want.join('/')} 实测 ${got.join('/')}`)
}
if (bad.length) {
  console.error('❌ 夹具自校验失败（锚点间距不足，POI 互相污染）：')
  for (const b of bad) console.error('   ' + b)
  process.exitCode = 1
  throw new Error('fixture self-check failed')
}

const gridId = (lat, lng) => `G${Math.floor((lat + 90) / GRID_SIZE_DEG)}_${Math.floor((lng + 180) / GRID_SIZE_DEG)}`

const registry = { version: 1, updated_at: new Date().toISOString().slice(0, 16).replace('T', ' '), grids: {} }
for (const a of anchors) {
  const gid = gridId(a.lat, a.lng)
  registry.grids[gid] = {
    grid_id: gid,
    city: '广州',
    district: '天河',
    center: { lat: a.lat, lng: a.lng },
    size_deg: GRID_SIZE_DEG,
    geohash: '',
    status: '未扫描',
    score: 0,
    store_id: '',
    report: '',
    note: 'TEST-ONLY 夹具',
    history: [],
  }
}

mkdirSync(OUT, { recursive: true })
const poolPath = new URL('_pool-广州-天河.json', OUT)
const regPath = new URL('registry.json', OUT)

writeFileSync(poolPath, JSON.stringify({
  city: '广州',
  district: '天河',
  anchors,
  pool,
  competitors,
  comp_keywords: ['粤菜', '茶楼', '烧腊'],
  _synthetic: 'TEST-ONLY 夹具，由 tools/fixtures/make-grid-pool.mjs 生成；非真实采集数据。',
}, null, 1), 'utf8')

writeFileSync(regPath, JSON.stringify(registry, null, 1), 'utf8')

const total = Object.values(pool).reduce((a, v) => a + v.length, 0)
console.log(`夹具已生成：${fileURLToPath(poolPath)}`)
console.log(`夹具已生成：${fileURLToPath(regPath)}`)
console.log(`锚点 ${anchors.length}｜底图 POI ${total}｜竞品 ${competitors.length}｜自校验通过（1km 内计数 == 设计值）`)
