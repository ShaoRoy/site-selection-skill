/**
 * test-isochrone.mjs —— 等时圈模块单测（不联网、不消耗配额）
 *
 * 覆盖：
 *   1) GCJ-02 ↔ WGS84 往返精度与中国境内偏移量级
 *   2) 境外坐标不转换
 *   3) 径向插值：全可达 / 全不可达 / 半可达 三种边界
 *   4) 环闭合与顶点数
 *   5) 点在多边形内
 *
 * 运行：node tools/test-isochrone.mjs
 */

import {
  gcj02ToWgs84,
  wgs84ToGcj02,
  pointInRing,
  interpolateRing,
} from './isochrone.mjs'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`)
  }
}

const distM = (lat1, lng1, lat2, lng2) => {
  const mLat = 111320
  const mLng = 111320 * Math.cos((lat1 * Math.PI) / 180)
  return Math.hypot((lat2 - lat1) * mLat, (lng2 - lng1) * mLng)
}

console.log('== 1. 坐标往返 ==')
for (const [lat, lng, name] of [[23.1198, 113.3338, '广州'], [39.9962, 116.481, '北京'], [31.2304, 121.4737, '上海']]) {
  const [wLat, wLng] = gcj02ToWgs84(lat, lng)
  const [gLat, gLng] = wgs84ToGcj02(wLat, wLng)
  const err = distM(lat, lng, gLat, gLng)
  check(`${name}往返误差 < 0.5m`, err < 0.5, `${err.toFixed(2)}m`)
  const shift = distM(lat, lng, wLat, wLng)
  check(`${name} GCJ→WGS 偏移 300~800m`, shift > 300 && shift < 800, `${shift.toFixed(0)}m`)
}

console.log('== 2. 境外不转换 ==')
{
  const [lat, lng] = [35.6812, 139.7671] // 东京
  const [wLat, wLng] = gcj02ToWgs84(lat, lng)
  check('境外坐标原样返回', wLat === lat && wLng === lng)
  const [gLat, gLng] = wgs84ToGcj02(lat, lng)
  check('境外 WGS→GCJ 原样返回', gLat === lat && gLng === lng)
}

console.log('== 3. 径向插值 ==')
const LAT = 23.1198
const LNG = 113.3338
const SECTORS = 24
const RINGS = 4
const EST = 600
const LIMIT = 600 // 秒

function makeSamples(fill) {
  const mLat = 111320
  const mLng = 111320 * Math.cos((LAT * Math.PI) / 180)
  const out = []
  for (let s = 0; s < SECTORS; s += 1) {
    const angle = (Math.PI * 2 * s) / SECTORS
    for (let r = 1; r <= RINGS; r += 1) {
      const dist = (EST * r) / RINGS
      out.push({
        s,
        r,
        lng: LNG + (Math.sin(angle) * dist) / mLng,
        lat: LAT + (Math.cos(angle) * dist) / mLat,
        duration: fill(r, s),
      })
    }
  }
  return out
}

const maxRadius = (ring) => Math.max(...ring.map(([x, y]) => distM(LAT, LNG, y, x)))

{
  const ring = interpolateRing(makeSamples(() => 100), LAT, LNG, EST, SECTORS, RINGS, LIMIT, 0)
  check('全可达：顶点数 = 扇区数 + 1', ring.length === SECTORS + 1, String(ring.length))
  const first = ring[0]
  const last = ring[ring.length - 1]
  check('环闭合', first[0] === last[0] && first[1] === last[1])
  const r = maxRadius(ring)
  check('全可达：半径 ≈ 估算半径', Math.abs(r - EST) < 5, `${r.toFixed(1)}m`)
}

{
  const ring = interpolateRing(makeSamples(() => LIMIT * 3), LAT, LNG, EST, SECTORS, RINGS, LIMIT, 0)
  const r = maxRadius(ring)
  check('全不可达：半径收缩到 0.35×内环', Math.abs(r - (EST / RINGS) * 0.35) < 5, `${r.toFixed(1)}m`)
}

{
  // 每个方向：前 2 环可达，后 2 环不可达
  const ring = interpolateRing(
    makeSamples((r) => (r <= 2 ? 100 : LIMIT * 3)),
    LAT, LNG, EST, SECTORS, RINGS, LIMIT, 0,
  )
  const r = maxRadius(ring)
  check('半可达：半径落在内环与外环之间', r > EST * 0.4 && r < EST * 0.8, `${r.toFixed(1)}m`)
}

{
  // 单方向异常：0 号扇区全不可达，其余全可达 → 0 号方向应显著收缩
  const ring = interpolateRing(
    makeSamples((r, s) => (s === 0 ? LIMIT * 3 : 100)),
    LAT, LNG, EST, SECTORS, RINGS, LIMIT, 0,
  )
  const d0 = distM(LAT, LNG, ring[0][1], ring[0][0])
  const d1 = distM(LAT, LNG, ring[1][1], ring[1][0])
  check('单方向不可达：该方向收缩', d0 < d1 * 0.6, `${d0.toFixed(0)}m vs ${d1.toFixed(0)}m`)
}

console.log('== 4. 点在多边形内 ==')
{
  const ring = interpolateRing(makeSamples(() => 100), LAT, LNG, EST, SECTORS, RINGS, LIMIT, 0)
  check('中心点在圈内', pointInRing(LNG, LAT, ring))
  check('远处点（3km）在圈外', !pointInRing(LNG + 0.03, LAT, ring))
}

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail > 0) process.exit(1)
