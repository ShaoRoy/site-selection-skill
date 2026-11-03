/**
 * tile-cache.mjs —— 预下载地图瓦片到本地（出图从此零调用、可离线）
 *
 * 用法：
 *   node tools/tile-cache.mjs --city=广州 --zoom=13-15
 *   node tools/tile-cache.mjs --center=23.119825,113.333776 --radius=6000 --zoom=13-15
 *   node tools/tile-cache.mjs --bbox=113.10,22.60,113.55,23.20 --zoom=13-15
 *   node tools/tile-cache.mjs --city=广州 --zoom=15 --concurrency=8
 *
 * 参数：
 *   --city=广州        内置城市 bbox（广州/深圳/上海/北京/杭州/成都/济南/青岛）
 *   --center=lat,lng   中心点（配合 --radius 自动算 bbox）
 *   --radius=6000      覆盖半径（米）
 *   --bbox=lng1,lat1,lng2,lat2
 *   --zoom=13-15       缩放级别，可单值 14 或区间 13-15
 *   --source=amap|osm  瓦片源，默认 amap（国内快）
 *   --concurrency=12   并发下载数（默认 12；别超过 20，会被限流）
 *
 * 落盘：out/tiles/{z}/{x}/{y}.png（已存在则跳过，可重复跑续传）
 * 体积参考（每张约 13 KB）：
 *   广州市 z13-15  ≈ 19,400 张 / 246 MB
 *   单点位 1.5km z13-15 ≈ 2.6 MB
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CITIES = {
  广州: [112.95, 22.51, 114.06, 23.95],
  深圳: [113.75, 22.40, 114.65, 22.90],
  上海: [120.85, 30.65, 122.00, 31.90],
  北京: [116.05, 39.55, 116.90, 40.25],
  杭州: [119.55, 29.85, 120.75, 30.55],
  成都: [103.60, 30.05, 104.90, 31.45],
  济南: [116.65, 36.35, 117.45, 37.00],
  青岛: [119.90, 35.85, 120.75, 36.55],
}

const TILE_URLS = {
  amap: (z, x, y) => `https://webrd0${((x + y) % 4) + 1}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`,
  osm: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
}

const args = new Map()
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(raw)
  if (m) args.set(m[1], m[2])
}

const source = (args.get('source') ?? 'amap').toLowerCase()
const tileUrl = TILE_URLS[source]
if (!tileUrl) {
  console.error(`未知瓦片源：${source}（用 amap 或 osm）`)
  process.exit(1)
}
const CONCURRENCY = Math.min(20, Math.max(1, Number(args.get('concurrency') ?? 12)))
const delayMs = Math.max(0, Number(args.get('delay') ?? 0))

const zoomParts = (args.get('zoom') ?? '13-15').split('-').map(Number)
const zoomFrom = Math.min(...zoomParts)
const zoomTo = Math.max(...zoomParts)
if (!Number.isFinite(zoomFrom) || !Number.isFinite(zoomTo)) {
  console.error('--zoom 格式错误，例：--zoom=13-15')
  process.exit(1)
}

let bbox
let label = ''
if (args.has('city')) {
  const name = args.get('city')
  const b = CITIES[name]
  if (!b) {
    console.error(`未知城市：${name}\n内置城市：${Object.keys(CITIES).join('、')}`)
    process.exit(1)
  }
  bbox = { lng1: b[0], lat1: b[1], lng2: b[2], lat2: b[3] }
  label = name
} else if (args.has('bbox')) {
  const nums = args.get('bbox').split(',').map(Number)
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    console.error('--bbox 格式：lng1,lat1,lng2,lat2')
    process.exit(1)
  }
  bbox = {
    lng1: Math.min(nums[0], nums[2]), lat1: Math.min(nums[1], nums[3]),
    lng2: Math.max(nums[0], nums[2]), lat2: Math.max(nums[1], nums[3]),
  }
  label = '自定义范围'
} else if (args.has('center')) {
  const [lat, lng] = args.get('center').split(',').map(Number)
  const radius = Number(args.get('radius') ?? 6000)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
    console.error('--center 格式：lat,lng（配合 --radius=米）')
    process.exit(1)
  }
  const dLat = radius / 111320
  const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180))
  bbox = { lng1: lng - dLng, lat1: lat - dLat, lng2: lng + dLng, lat2: lat + dLat }
  label = `中心 ${lat},${lng} 半径 ${radius}m`
} else {
  console.error(`需要 --city / --bbox / --center 之一\n内置城市：${Object.keys(CITIES).join('、')}`)
  process.exit(1)
}

const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z
const lat2tile = (lat, z) => {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
}

// 瓦片根目录可配置：仓库包内没有 out/ 结构，需要能指到任意位置
const tilesRoot = args.has('out')
  ? resolve(String(args.get('out')))
  : join(process.cwd(), 'out', 'tiles')

// 先统计总量
const plan = []
for (let z = zoomFrom; z <= zoomTo; z += 1) {
  const x0 = Math.floor(lon2tile(bbox.lng1, z))
  const x1 = Math.floor(lon2tile(bbox.lng2, z))
  const y0 = Math.floor(lat2tile(bbox.lat2, z))
  const y1 = Math.floor(lat2tile(bbox.lat1, z))
  plan.push({ z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) })
}
const total = plan.reduce((s, p) => s + p.count, 0)

console.log(`范围：${label}`)
console.log(`瓦片源：${source}｜zoom ${zoomFrom}–${zoomTo}｜并发 ${CONCURRENCY}`)
console.log(`预计 ${total.toLocaleString()} 张，约 ${(total * 13 / 1024).toFixed(0)} MB`)
console.log('已存在的会跳过，可随时中断后重跑续传\n')

let skipped = 0
let downloaded = 0
let failed = 0
let done = 0
const t0 = Date.now()

async function fetchOne(z, x, y) {
  const dir = join(tilesRoot, String(z), String(x))
  const file = join(dir, `${y}.png`)
  if (existsSync(file)) {
    skipped += 1
    done += 1
    return
  }
  try {
    const res = await fetch(tileUrl(z, x, y), { headers: { 'User-Agent': 'site-selection-local/1.0' } })
    if (!res.ok) {
      failed += 1
      done += 1
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, buf)
    downloaded += 1
  } catch {
    failed += 1
  }
  done += 1
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
}

for (const p of plan) {
  console.log(`zoom ${p.z}：${p.x1 - p.x0 + 1} × ${p.y1 - p.y0 + 1} = ${p.count.toLocaleString()} 张`)
  const queue = []
  for (let x = p.x0; x <= p.x1; x += 1) {
    for (let y = p.y0; y <= p.y1; y += 1) queue.push([p.z, x, y])
  }
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(([z, x, y]) => fetchOne(z, x, y)))
    if (done % 500 < CONCURRENCY || done === total) {
      const sec = (Date.now() - t0) / 1000
      const rate = (done / sec).toFixed(1)
      const eta = rate > 0 ? ((total - done) / rate / 60).toFixed(1) : '—'
      process.stdout.write(`\r  ${done.toLocaleString()}/${total.toLocaleString()} ｜下载 ${downloaded} ｜跳过 ${skipped} ｜失败 ${failed} ｜${rate}/s ｜剩余 ${eta} 分   `)
    }
  }
  console.log()
}

const sec = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n完成：共 ${total.toLocaleString()} 张｜新下载 ${downloaded}｜已存在跳过 ${skipped}｜失败 ${failed}｜耗时 ${sec}s`)
console.log(`落盘：${tilesRoot}`)
if (failed > 0) console.log('有失败瓦片，重跑本脚本会自动续传（已存在的会跳过）')
