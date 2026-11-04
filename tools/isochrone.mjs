/**
 * isochrone.mjs —— 本地路网等时圈客户端：Valhalla(8002) / OSRM(5000) 自动识别
 *
 * 自检：
 *   node .\tools\isochrone.mjs --check
 * 单点测试：
 *   node .\tools\isochrone.mjs --center=23.119825,113.333776 --mode=walk --minutes=12
 *
 * 说明：OSRM 没有 /isochrone，这里用 /table 矩阵 + 径向采样重建等时圈多边形。
 *   - Valhalla：原生 /isochrone，多边形精确
 *   - OSRM：24 个方向 × 6 圈采样，按到达时间插值出边界（够用，精度略粗）
 *
 * 注意：OSRM 的数据是**按某个 profile 切的**（car→driving / bike→cycling / foot→walking）。
 * 用 car 数据查 walk 等时圈没有意义——要步行圈，得另起一个 foot.lua 切片的实例。
 */

const VALHALLA_BASE = process.env.VALHALLA_URL ?? 'http://localhost:8002'
import { fileURLToPath } from 'node:url'
const OSRM_BASE = process.env.OSRM_URL ?? 'http://localhost:5000'
const OSRM_PROFILE = process.env.OSRM_PROFILE ?? 'driving'

const COSTING = { walk: 'pedestrian', bike: 'bicycle', car: 'auto' }
const SPEED_MPM = { walk: 80, bike: 250, car: 500 }

const withTimeout = (ms) => ({ signal: AbortSignal.timeout(ms) })

export async function valhallaAvailable(base = VALHALLA_BASE) {
  try {
    const res = await fetch(`${base}/status`, withTimeout(2500))
    return res.ok
  } catch {
    return false
  }
}

export async function osrmAvailable(base = OSRM_BASE, profile = OSRM_PROFILE) {
  try {
    const res = await fetch(`${base}/nearest/v1/${profile}/113.333776,23.119825?number=1`, withTimeout(4000))
    if (!res.ok) return false
    const json = await res.json()
    return json.code === 'Ok'
  } catch {
    return false
  }
}

/** 强制指定引擎：auto（默认，Valhalla 优先）/ valhalla / osrm */
const FORCE_ENGINE = (process.env.ISO_ENGINE ?? 'auto').toLowerCase()

/** 自动识别可用引擎；都不可用返回 null */
export async function detectEngine() {
  const wantValhalla = FORCE_ENGINE === 'auto' || FORCE_ENGINE === 'valhalla'
  const wantOsrm = FORCE_ENGINE === 'auto' || FORCE_ENGINE === 'osrm'
  if (wantValhalla && await valhallaAvailable()) {
    return { kind: 'valhalla', base: VALHALLA_BASE, label: '本地 Valhalla（原生多边形，多出行方式）' }
  }
  if (wantOsrm && await osrmAvailable()) {
    return { kind: 'osrm', base: OSRM_BASE, profile: OSRM_PROFILE, label: `本地 OSRM（${OSRM_PROFILE} 路网，径向采样）` }
  }
  return null
}

/** 点在多边形内（射线法），ring 为 [[lng,lat],...] */
export function pointInRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * 径向中值滤波：把"比邻域中位半径更凸出"的顶点向内压到中位值。
 * 能抹平窄刺（主干道走廊），但不改变整体形状；只会收不会放。
 * window=5 表示看左右各 2 个顶点。
 */
export function medianFilterRadial(ring, lat, lng, window = 5) {
  if (!ring || ring.length < 6 || window < 3) return ring
  const half = Math.floor(window / 2)
  const mLat = 111320
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180)
  const n = ring.length
  const radii = ring.map(([x, y]) => Math.hypot((x - lng) * mLng, (y - lat) * mLat))
  return ring.map(([x, y], i) => {
    const win = []
    for (let k = -half; k <= half; k += 1) win.push(radii[(i + k + n) % n])
    win.sort((a, b) => a - b)
    const med = win[half]
    if (radii[i] <= med + 1e-6) return [x, y]
    const scale = med / radii[i]
    return [Number((lng + (x - lng) * scale).toFixed(6)), Number((lat + (y - lat) * scale).toFixed(6))]
  })
}

/**
 * 把等时圈沿径向裁到固定半径内 = 等时圈 ∩ 固定半径圆（商圈锁）。
 * 等时圈对中心是星形的，径向裁剪即为精确交集。
 */
export function clampToRadius(ring, lat, lng, maxMeters) {
  if (!ring || !Number.isFinite(maxMeters) || maxMeters <= 0) return ring
  const mLat = 111320
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180)
  return ring.map(([x, y]) => {
    const d = Math.hypot((x - lng) * mLng, (y - lat) * mLat)
    if (d <= maxMeters) return [x, y]
    const k = maxMeters / d
    return [
      Number((lng + (x - lng) * k).toFixed(6)),
      Number((lat + (y - lat) * k).toFixed(6)),
    ]
  })
}

/**
 * 削掉沿高速/主干道拉出的细长尖刺：把离中心超过 median×factor 的顶点向中心拉回。
 * facter=0 或 1 表示关闭。
 */
export function trimSpikes(ring, lat, lng, factor = 2.2) {
  if (!ring || ring.length < 4 || factor <= 1) return ring
  const mLat = 111320
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180)
  const dist = ring.map(([x, y]) => Math.hypot((x - lng) * mLng, (y - lat) * mLat))
  const sorted = [...dist].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const limit = median * factor
  return ring.map(([x, y], i) => {
    if (dist[i] <= limit) return [x, y]
    const k = limit / dist[i]
    return [
      Number((lng + (x - lng) * k).toFixed(6)),
      Number((lat + (y - lat) * k).toFixed(6)),
    ]
  })
}

async function valhallaIsochrone(base, lat, lng, costing, minutes, trimFactor = Number(process.env.ISO_TRIM ?? 1.6)) {
  const body = {
    locations: [{ lat, lon: lng }],
    costing,
    contours: [{ time: minutes }],
    polygons: true,
    // 大圈用更大的简化精度，避免顶点爆炸；denoise 抑制小碎块
    generalize: minutes >= 15 ? 60 : 25,
    denoise: 0.4,
  }
  try {
    const res = await fetch(`${base}/isochrone?json=${encodeURIComponent(JSON.stringify(body))}`, withTimeout(20000))
    if (!res.ok) return null
    const json = await res.json()
    const geom = json?.features?.[0]?.geometry
    // polygons:true → Polygon（外环 = coordinates[0]）；未设 → LineString（本身就是环）
    let ring = null
    if (geom?.type === 'Polygon') ring = geom.coordinates?.[0]
    else if (geom?.type === 'LineString') ring = geom.coordinates
    if (!Array.isArray(ring) || ring.length <= 2) return null
    const smoothed = medianFilterRadial(ring, lat, lng, Number(process.env.ISO_SMOOTH ?? 5))
    return trimSpikes(smoothed, lat, lng, trimFactor)
  } catch {
    return null
  }
}

/** OSRM：径向采样 + /table 批量求时，插值出边界多边形 */
async function osrmIsochrone(base, lat, lng, mode, minutes, profile = OSRM_PROFILE, trimFactor = Number(process.env.ISO_TRIM ?? 1.6)) {
  const limit = minutes * 60
  const estRadius = ((SPEED_MPM[mode] ?? SPEED_MPM.walk) * minutes) / 1.35
  const SECTORS = 24
  const RINGS = 6
  const mLat = 111320
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180)

  const samples = []
  for (let s = 0; s < SECTORS; s += 1) {
    const angle = (Math.PI * 2 * s) / SECTORS
    for (let r = 1; r <= RINGS; r += 1) {
      const dist = (estRadius * r) / RINGS
      samples.push({
        s,
        r,
        lng: lng + (Math.sin(angle) * dist) / mLng,
        lat: lat + (Math.cos(angle) * dist) / mLat,
        duration: null,
      })
    }
  }

  // OSRM 默认 max-table-size=100，按 99 个目标点分批
  const BATCH = 99
  for (let i = 0; i < samples.length; i += BATCH) {
    const slice = samples.slice(i, i + BATCH)
    const coords = [[lng, lat], ...slice.map((p) => [p.lng, p.lat])]
      .map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`)
      .join(';')
    const url = `${base}/table/v1/${profile}/${coords}?sources=0&annotations=duration`
    try {
      const res = await fetch(url, withTimeout(25000))
      if (!res.ok) return null
      const json = await res.json()
      if (json.code !== 'Ok' || !Array.isArray(json.durations?.[0])) return null
      const row = json.durations[0]
      for (let k = 0; k < slice.length; k += 1) {
        const raw = row[k + 1]
        slice[k].duration = typeof raw === 'number' ? raw : null
      }
    } catch {
      return null
    }
  }

  const ring = []
  for (let s = 0; s < SECTORS; s += 1) {
    const dir = samples.filter((p) => p.s === s)
    let reachable = 0
    for (const p of dir) {
      if (p.duration !== null && p.duration <= limit) reachable = p.r
    }
    let dist
    if (reachable === 0) {
      dist = (estRadius / RINGS) * 0.35
    } else if (reachable === RINGS) {
      dist = estRadius
    } else {
      const a = dir[reachable - 1]
      const b = dir[reachable]
      const da = a.duration ?? limit
      const db = b.duration ?? limit * 2
      const ratio = db > da ? Math.min(1, (limit - da) / (db - da)) : 0
      dist = (estRadius * reachable) / RINGS + ((estRadius / RINGS) * ratio)
    }
    const angle = (Math.PI * 2 * s) / SECTORS
    ring.push([
      Number((lng + (Math.sin(angle) * dist) / mLng).toFixed(6)),
      Number((lat + (Math.cos(angle) * dist) / mLat).toFixed(6)),
    ])
  }
  ring.push(ring[0])
  const smoothed = medianFilterRadial(ring, lat, lng, Number(process.env.ISO_SMOOTH ?? 5))
  return trimSpikes(smoothed, lat, lng, trimFactor)
}

/** 统一入口 */
export async function isochroneFrom(engine, lat, lng, mode, minutes, trimFactor) {
  if (!engine) return null
  if (engine.kind === 'valhalla') {
    return valhallaIsochrone(engine.base, lat, lng, COSTING[mode] ?? 'pedestrian', minutes, trimFactor)
  }
  return osrmIsochrone(engine.base, lat, lng, mode, minutes, engine.profile, trimFactor)
}

// ── CLI
// 注意：Windows 下 import.meta.url 是正斜杠、process.argv[1] 是反斜杠，
// 必须用 fileURLToPath 归一化，否则直接执行时会静默跳过（踩过这个坑）
const invokedDirectly = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const args = new Map()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (m) args.set(m[1], m[2] ?? 'true')
  }

  if (args.has('check') || !args.has('center')) {
    const v = await valhallaAvailable()
    const o = await osrmAvailable()
    console.log(`Valhalla ${VALHALLA_BASE} → ${v ? '在线 ✅' : '不可达'}`)
    console.log(`OSRM     ${OSRM_BASE}（profile=${OSRM_PROFILE}）→ ${o ? '在线 ✅' : '不可达'}`)
    const engine = await detectEngine()
    console.log(engine ? `\n将使用：${engine.label}` : '\n两个引擎都不可用 → 出图回退「直线估算圈」（标【估算】）')
    process.exit(engine ? 0 : 1)
  }

  const [lat, lng] = args.get('center').split(',').map(Number)
  const mode = args.get('mode') ?? 'walk'
  const minutes = Number(args.get('minutes') ?? 12)
  const engine = await detectEngine()
  if (!engine) {
    console.error('没有可用的等时圈引擎')
    process.exit(1)
  }
  const ring = await isochroneFrom(engine, lat, lng, mode, minutes)
  if (!ring) {
    console.error(`取等时圈失败（${engine.kind}）`)
    process.exit(1)
  }
  const lats = ring.map((p) => p[1])
  const lngs = ring.map((p) => p[0])
  console.log(`引擎：${engine.label}`)
  console.log(`等时圈（${mode} ${minutes} 分钟）：${ring.length} 个顶点`)
  console.log(`范围：lat ${Math.min(...lats).toFixed(5)}~${Math.max(...lats).toFixed(5)}, lng ${Math.min(...lngs).toFixed(5)}~${Math.max(...lngs).toFixed(5)}`)
  console.log(`中心在圈内：${pointInRing(lng, lat, ring) ? '是' : '否（异常）'}`)
}
