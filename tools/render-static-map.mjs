/**
 * render-static-map.mjs —— 生成可嵌入报告的静态地图（SVG，瓦片 base64 内嵌）
 *
 * 为什么需要：map.html 是独立交互页，打印成 PDF 时地图不会进来。
 * 这个脚本把瓦片直接内联进 SVG，嵌进 report.html 后打印/PDF 都能保留地图。
 *
 * 用法：
 *   node tools/render-static-map.mjs --probe out/<点位>/probe.json --zoom 15 --out out/<点位>/map-static.svg
 *
 * 参数：
 *   --probe   probe.json 路径
 *   --out     输出 SVG 路径（默认与 probe 同目录 map-static.svg）
 *   --zoom    缩放级（默认 15；报告用 15 覆盖约 1.1km × 0.8km）
 *   --w/--h   视口像素（默认 1000 × 720）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = (k, d = null) => {
  const hit = args.find((a) => a === `--${k}` || a.startsWith(`--${k}=`))
  if (!hit) return d
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : args[args.indexOf(hit) + 1]
}

const probePath = arg('probe')
if (!probePath) {
  console.error('需要 --probe=<probe.json>')
  process.exit(1)
}
const VW = Number(arg('w', '1000'))
const VH = Number(arg('h', '720'))
const outPath = arg('out', join(dirname(resolve(probePath)), 'map-static.svg'))
// 默认放在 probe.json 同级目录的 ../tiles；也可用 --tiles 显式指定
const tileDir = arg('tiles') !== undefined
  ? resolve(String(arg('tiles')))
  : resolve(join(dirname(resolve(probePath)), '..', 'tiles'))

const probe = JSON.parse(readFileSync(probePath, 'utf8').replace(/^\uFEFF/, ''))
const center = probe.center ?? { lat: 0, lng: 0 }
const TILE = 256

// ── 缩放级：--zoom 显式指定，否则按最大圈层自动适配视口
const zoomArg = arg('zoom', 'auto')
let ZOOM
if (zoomArg === 'auto') {
  // 取所有圈层多边形的最大外包（单位：米），留 8% 边距
  let maxM = 0
  const autoRings = (() => {
    const all = probe.rings ?? []
    if (arg('rings', 'inner') === 'all') return all
    const p = all.findIndex((x) => x.is_primary === true)
    return p >= 0 ? [all[p]] : all.slice(0, 1)
  })()
  for (const r of autoRings) {
    const poly = r.iso
    if (!Array.isArray(poly) || poly.length < 3) {
      const rad = Number(r.radius ?? 0)
      if (rad > maxM) maxM = rad
      continue
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const pt of poly) {
      const lng = Array.isArray(pt) ? pt[0] : pt.lng
      const lat = Array.isArray(pt) ? pt[1] : pt.lat
      const mx = (lng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180)
      const my = (lat - center.lat) * 110574
      if (mx < minX) minX = mx
      if (mx > maxX) maxX = mx
      if (my < minY) minY = my
      if (my > maxY) maxY = my
    }
    // 以中心为原点取对称半径，保证点位在正中
    const need = 2 * Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY))
    if (need > maxM) maxM = need
  }
  // 需要覆盖 ±maxM/2 的半径 → 视口较短边要装下整条直径
  const span = Math.max(maxM * 1.08, 400)
  const mppMax = span / Math.min(VW, VH)   // 每像素最多覆盖多少米
  // mpp(z) = 40075016.686 * cos(lat) / (256 * 2^z)
  const z = Math.log2((40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (TILE * mppMax))
  ZOOM = Math.max(11, Math.min(17, Math.floor(z)))
  const mppPicked = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (TILE * 2 ** ZOOM)
  console.log(`自动缩放：最大圈层跨度 ${(span / 1000).toFixed(2)} km → zoom ${ZOOM}` +
    `（视口约 ${(mppPicked * VW / 1000).toFixed(2)} × ${(mppPicked * VH / 1000).toFixed(2)} km）`)
} else {
  ZOOM = Number(zoomArg)
}


const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z * TILE
const latToY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z * TILE
}

const cx = lonToX(center.lng, ZOOM)
const cy = latToY(center.lat, ZOOM)
const left = cx - VW / 2
const top = cy - VH / 2

const x0 = Math.floor(left / TILE)
const x1 = Math.floor((left + VW) / TILE)
const y0 = Math.floor(top / TILE)
const y1 = Math.floor((top + VH) / TILE)

let hit = 0
let miss = 0
const imgTags = []
for (let tx = x0; tx <= x1; tx += 1) {
  for (let ty = y0; ty <= y1; ty += 1) {
    const p = join(tileDir, String(ZOOM), String(tx), `${ty}.png`)
    if (!existsSync(p)) {
      miss += 1
      continue
    }
    const b64 = readFileSync(p).toString('base64')
    const sx = tx * TILE - left
    const sy = ty * TILE - top
    imgTags.push(
      `<image x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${TILE}" height="${TILE}" ` +
        `preserveAspectRatio="none" href="data:image/png;base64,${b64}"/>`,
    )
    hit += 1
  }
}

// 坐标 → 屏幕
const px = (lng) => lonToX(lng, ZOOM) - left
const py = (lat) => latToY(lat, ZOOM) - top

// 圈层多边形
const ringColors = ['#e65100', '#1565c0', '#6a1b9a']
const ringTags = []
// 只画主圈（步行圈）：外圈车行范围太大，画面过花
const ringsToDraw = (() => {
  const all = probe.rings ?? []
  if (arg('rings', 'inner') === 'all') return all
  const primary = all.findIndex((r) => r.is_primary === true)
  return primary >= 0 ? [all[primary]] : all.slice(0, 1)
})()
ringsToDraw.forEach((r, i) => {
  const poly = r.iso
  if (!Array.isArray(poly) || poly.length < 3) return
  const pts = poly
    .map((pt) => {
      const lng = Array.isArray(pt) ? pt[0] : pt.lng
      const lat = Array.isArray(pt) ? pt[1] : pt.lat
      return `${px(lng).toFixed(1)},${py(lat).toFixed(1)}`
    })
    .join(' ')
  const color = ringColors[i % ringColors.length]
  ringTags.push(
    `<polygon points="${pts}" fill="${color}" fill-opacity="0.08" stroke="${color}" ` +
      `stroke-width="${i === 0 ? 2.2 : 1.6}" ${i > 0 ? 'stroke-dasharray="7 5"' : ''}/>`,
  )
})

// POI 点：同段竞品红色，其余灰色
const poiTags = []
const escAttr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
;(probe.pois ?? []).forEach((p) => {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return
  const x = px(p.lng)
  const y = py(p.lat)
  if (x < -10 || x > VW + 10 || y < -10 || y > VH + 10) return
  const same = p.same_type === true
  poiTags.push(
    `<circle class="poi" data-name="${escAttr(p.name)}" ` +
      `cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${same ? 3.6 : 2.4}" ` +
      `fill="${same ? '#d40000' : '#607d8b'}" fill-opacity="${same ? 0.85 : 0.5}"` +
      ` stroke="#fff" stroke-width="${same ? 0.8 : 0.4}"/>`,
  )
})

// 候选点位
const cand = `<g><circle cx="${VW / 2}" cy="${VH / 2}" r="9" fill="#d40000" stroke="#fff" stroke-width="2.5"/>` +
  `<circle cx="${VW / 2}" cy="${VH / 2}" r="20" fill="none" stroke="#d40000" stroke-width="1.5" stroke-opacity="0.55"/></g>`

// 比例尺（zoom 15，赤道 256*2^15 像素覆盖 40075016 米）
const mpp = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / (TILE * 2 ** ZOOM)
const barM = 200
const barPx = barM / mpp
const scaleBar = `<g transform="translate(16,${VH - 30})">
  <rect x="0" y="0" width="${barPx.toFixed(1)}" height="6" fill="#212121" fill-opacity="0.8"/>
  <rect x="0" y="0" width="${(barPx / 2).toFixed(1)}" height="6" fill="#fff"/>
  <text x="0" y="-6" font-size="11" fill="#212121" font-family="sans-serif">${barM} m</text></g>`

// 图例
const legend = `<g transform="translate(16,20)" font-family="sans-serif" font-size="12">
  <rect x="-6" y="-14" width="196" height="${22 + ringsToDraw.length * 18}" fill="#fff" fill-opacity="0.88" stroke="#ddd" rx="4"/>
  <circle cx="4" cy="2" r="5" fill="#d40000" stroke="#fff" stroke-width="1.5"/><text x="16" y="6" fill="#212121">候选点位</text>
  ${ringsToDraw
    .map((r, i) => {
      const c = ringColors[i % ringColors.length]
      return `<line x1="-2" y1="${22 + i * 18}" x2="12" y2="${22 + i * 18}" stroke="${c}" stroke-width="2.5"/><text x="18" y="${26 + i * 18}" fill="#212121">${String(r.label ?? '').replace(/[<>&]/g, '')}（${r.inside ?? 0} 家）</text>`
    })
    .join('')}
  <circle cx="4" cy="${28 + ringsToDraw.length * 18}" r="4" fill="#d40000" fill-opacity="0.85"/><text x="16" y="${32 + ringsToDraw.length * 18}" fill="#212121">同段直接竞品</text>
  <circle cx="4" cy="${46 + ringsToDraw.length * 18}" r="3" fill="#607d8b" fill-opacity="0.5"/><text x="16" y="${50 + ringsToDraw.length * 18}" fill="#212121">其他竞品 / 周边</text>
</g>`

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${VH}" viewBox="0 0 ${VW} ${VH}" ` +
  `font-family="sans-serif" style="background:#eef2f5">` +
  `<rect width="${VW}" height="${VH}" fill="#eef2f5"/>` +
  imgTags.join('') +
  ringTags.join('') +
  poiTags.join('') +
  cand +
  legend +
  scaleBar +
  `<text x="${VW - 12}" y="${VH - 12}" font-size="10" fill="#555" text-anchor="end">` +
  `GCJ-02｜zoom ${ZOOM}｜底图 © 高德｜圈层${ringsToDraw[0]?.source === 'valhalla' ? '本地 Valhalla 路网' : '直线估算【估算】'}</text>` +
  `</svg>`

writeFileSync(outPath, svg, 'utf8')
const kb = (Buffer.byteLength(svg) / 1024).toFixed(0)
console.log(`静态地图：${outPath}`)
console.log(`  视口 ${VW}×${VH}｜zoom ${ZOOM}｜瓦片 ${hit} 张命中 / ${miss} 张缺失（共 ${hit + miss}）`)
console.log(`  圈层 ${ringTags.length} 个｜POI ${poiTags.length} 个｜文件 ${kb} KB`)
if (miss > 0) {
  console.log(`  ⚠️ 有 ${miss} 张瓦片缺失，先跑：node tools/tile-cache.mjs --center=${center.lat},${center.lng} --radius=1500 --zoom=${ZOOM}`)
}
