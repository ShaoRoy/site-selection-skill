/**
 * isochrone.mjs —— 等时圈三级引擎：本地 Valhalla/OSRM → 云端腾讯/高德 → 直线估算
 *
 * 自检：
 *   node .\tools\isochrone.mjs --check
 * 单点测试：
 *   node .\tools\isochrone.mjs --center=23.119825,113.333776 --mode=walk --minutes=12
 *
 * 引擎优先级（ISO_ENGINE=auto 默认）：
 *   1) 本地 Valhalla(8002)：原生 /isochrone，真多边形
 *   2) 本地 OSRM(5000)：/table 径向采样近似（无原生 /isochrone）
 *   3) 云端腾讯 matrix / 高德 direction：真实路网，按 OD 对计费（ISO_CLOUD=off 可关）
 *   4) 直线估算圈：无任何引擎时回退，报告必须标【估算】
 *
 * 坐标系约定：
 *   本模块对外统一 **GCJ-02**（与高德 POI、底图、报告一致）。
 *   Valhalla / OSRM 的路网是 WGS84，进出时做转换；云端腾讯/高德本身就是 GCJ-02，不转。
 *   此前直接把 GCJ-02 传给本地引擎，圈心会偏 300~500m，属于已修正的缺陷。
 *
 * 注意：OSRM 的数据是**按某个 profile 切的**（foot→walking / bike→cycling）。
 * 本项目只跑步行圈（车行圈已废弃），OSRM 实例须用 foot.lua 切片；用 bike 数据查步行圈会口径不符。
 */

import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const VALHALLA_BASE = process.env.VALHALLA_URL ?? 'http://localhost:8002'
const OSRM_BASE = process.env.OSRM_URL ?? 'http://localhost:5000'
const OSRM_PROFILE = process.env.OSRM_PROFILE ?? 'walking'

const COSTING = { walk: 'pedestrian', bike: 'bicycle' }
const SPEED_MPM = { walk: 80, bike: 250 }

const withTimeout = (ms) => ({ signal: AbortSignal.timeout(ms) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 坐标转换：GCJ-02 ↔ WGS84（算法同 scripts/export-geojson.py）
const PI = Math.PI
const AXIS = 6378245.0
const EE = 0.00669342162296594323

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  return r
}

function transformLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  return r
}

/** WGS84 → GCJ-02，返回 [lat, lng] */
export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const rad = (lat / 180) * PI
  const magic = 1 - EE * Math.sin(rad) ** 2
  const sq = Math.sqrt(magic)
  dLat = (dLat * 180) / (((AXIS * (1 - EE)) / (magic * sq)) * PI)
  dLng = (dLng * 180) / ((AXIS / sq) * Math.cos(rad) * PI)
  return [lat + dLat, lng + dLng]
}

/** GCJ-02 → WGS84，迭代反解，精度 < 0.5m；返回 [lat, lng] */
export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng]
  let wLat = lat
  let wLng = lng
  for (let i = 0; i < 3; i += 1) {
    const [gLat, gLng] = wgs84ToGcj02(wLat, wLng)
    wLat -= gLat - lat
    wLng -= gLng - lng
  }
  return [wLat, wLng]
}

/** ring 顶点按 [lng, lat] 存；这里做整圈坐标转换 */
function transformRing(ring, fn) {
  return ring.map(([x, y]) => {
    const [nLat, nLng] = fn(y, x)
    return [Number(nLng.toFixed(6)), Number(nLat.toFixed(6))]
  })
}

// ── 引擎可用性
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

// ── 云端配置
const CLOUD_MODE = (process.env.ISO_CLOUD ?? 'auto').toLowerCase() // auto | off | tencent | amap
const CLOUD_ON = CLOUD_MODE !== 'off'
const CLOUD_PROVIDER = CLOUD_MODE === 'tencent' || CLOUD_MODE === 'amap'
  ? CLOUD_MODE
  : (process.env.ISO_CLOUD_PROVIDER ?? 'tencent').toLowerCase()

const CLOUD_SECTORS = 24
const CLOUD_RINGS = Math.max(2, Math.min(8, Number(process.env.ISO_CLOUD_RINGS ?? 4)))
const CLOUD_MAX_PAIRS = Math.max(CLOUD_SECTORS, Number(process.env.ISO_CLOUD_MAX_PAIRS ?? 400))
const CLOUD_DAILY_MAX = Math.max(100, Number(process.env.ISO_CLOUD_DAILY_MAX ?? 4000))
const TENCENT_BATCH = Math.max(1, Math.min(200, Number(process.env.ISO_CLOUD_BATCH ?? 5)))
const CLOUD_INTERVAL_MS = Math.max(0, Number(process.env.ISO_CLOUD_INTERVAL_MS ?? 1200))

function readKey(provider) {
  const envName = provider === 'tencent' ? 'TENCENT_MAP_KEY' : 'AMAP_API_KEY'
  if (process.env[envName]) return process.env[envName].trim()
  const p = join(homedir(), '.dsh', 'secrets', provider === 'tencent' ? 'tencent.key' : 'amap.key')
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

function quotaFile(provider) {
  const day = new Date().toISOString().slice(0, 10)
  return join(fileURLToPath(new URL('../.cache/', import.meta.url)), `iso-cloud-quota-${provider}-${day}.json`)
}

export function readCloudQuota(provider = CLOUD_PROVIDER) {
  try {
    const q = JSON.parse(readFileSync(quotaFile(provider), 'utf8'))
    return { pairs: Number(q.pairs) || 0, updated: q.updated ?? null }
  } catch {
    return { pairs: 0, updated: null }
  }
}

function addCloudQuota(provider, pairs) {
  const q = readCloudQuota(provider)
  const next = { pairs: q.pairs + pairs, updated: new Date().toISOString() }
  try {
    const file = quotaFile(provider)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    /* 记账失败不阻断采集，但不能静默——下一行会打印 */
    console.warn(`  ⚠️ 云端配额记账写入失败（${provider}），本次消耗 ${pairs} 对未落盘`)
  }
  return next.pairs
}

/** 云端是否可用；不可用时给出可读原因，供报告标注 */
export function cloudStatus(provider = CLOUD_PROVIDER) {
  if (!CLOUD_ON) return { ok: false, reason: 'ISO_CLOUD=off（已显式关闭云端降级）' }
  if (!readKey(provider)) {
    const envName = provider === 'tencent' ? 'TENCENT_MAP_KEY' : 'AMAP_API_KEY'
    return { ok: false, reason: `未配置 ${envName}` }
  }
  const used = readCloudQuota(provider).pairs
  if (used >= CLOUD_DAILY_MAX) {
    return { ok: false, reason: `当日云端配额已用 ${used}/${CLOUD_DAILY_MAX} 对` }
  }
  return { ok: true, provider, used, dailyMax: CLOUD_DAILY_MAX }
}

/** 强制指定引擎：auto（默认，本地优先）/ valhalla / osrm / cloud */
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
  const wantCloud = FORCE_ENGINE === 'auto' || FORCE_ENGINE === 'cloud'
  if (wantCloud) {
    const st = cloudStatus()
    if (st.ok) {
      const name = st.provider === 'tencent' ? '腾讯 matrix' : '高德 direction'
      return {
        kind: 'cloud',
        provider: st.provider,
        label: `云端 ${name}（真实路网，按 OD 对计费）`,
        calls: 0,
        usedBefore: st.used,
        dailyMax: st.dailyMax,
      }
    }
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
 * factor=0 或 1 表示关闭。
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

/**
 * 从径向采样插值出边界环（OSRM 与云端共用）。
 * samples 每项含 { s, r, duration }，duration 单位为秒；limit 也是秒。
 */
export function interpolateRing(samples, lat, lng, estRadius, sectors, rings, limit, trimFactor) {
  const mLat = 111320
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180)
  const ring = []
  for (let s = 0; s < sectors; s += 1) {
    const dir = samples.filter((p) => p.s === s)
    let reachable = 0
    for (const p of dir) {
      if (p.duration !== null && p.duration <= limit) reachable = p.r
    }
    let dist
    if (reachable === 0) {
      dist = (estRadius / rings) * 0.35
    } else if (reachable === rings) {
      dist = estRadius
    } else {
      const a = dir[reachable - 1]
      const b = dir[reachable]
      const da = a.duration ?? limit
      const db = b.duration ?? limit * 2
      const ratio = db > da ? Math.min(1, (limit - da) / (db - da)) : 0
      dist = (estRadius * reachable) / rings + ((estRadius / rings) * ratio)
    }
    const angle = (Math.PI * 2 * s) / sectors
    ring.push([
      Number((lng + (Math.sin(angle) * dist) / mLng).toFixed(6)),
      Number((lat + (Math.cos(angle) * dist) / mLat).toFixed(6)),
    ])
  }
  ring.push(ring[0])
  const smoothed = medianFilterRadial(ring, lat, lng, Number(process.env.ISO_SMOOTH ?? 5))
  return trimSpikes(smoothed, lat, lng, trimFactor)
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

  const samples = []
  for (let s = 0; s < SECTORS; s += 1) {
    const angle = (Math.PI * 2 * s) / SECTORS
    for (let r = 1; r <= RINGS; r += 1) {
      const dist = (estRadius * r) / RINGS
      samples.push({
        s,
        r,
        lng: lng + (Math.sin(angle) * dist) / (111320 * Math.cos((lat * Math.PI) / 180)),
        lat: lat + (Math.cos(angle) * dist) / 111320,
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

  return interpolateRing(samples, lat, lng, estRadius, SECTORS, RINGS, limit, trimFactor)
}

// ── 云端：腾讯 matrix（5 对/批）/ 高德 direction（1 对/次）
const CLOUD_MODE_PARAM = { walk: 'walking', bike: 'bicycling' }

async function tencentMatrix(key, originLat, originLng, points, mode) {
  const modeParam = CLOUD_MODE_PARAM[mode] ?? 'walking'
  const from = `${originLat},${originLng}`
  const to = points.map((p) => `${p.lat},${p.lng}`).join(';')
  const url = `https://apis.map.qq.com/ws/distance/v1/matrix?mode=${modeParam}`
    + `&from=${from}&to=${encodeURIComponent(to)}&key=${key}`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, withTimeout(15000))
      if (!res.ok) return false
      const json = await res.json()
      // status=120：QPS 超限（腾讯按 OD 对数计），退避一次
      if (json.status === 120 && attempt === 0) {
        await sleep(2200)
        continue
      }
      if (json.status !== 0) {
        console.warn(`  ⚠️ 腾讯矩阵返回 status=${json.status}（${json.message ?? '未知'}）`)
        return false
      }
      const els = json?.result?.rows?.[0]?.elements ?? []
      for (let k = 0; k < points.length; k += 1) {
        const dur = Number(els[k]?.duration) // 单位：秒
        points[k].duration = Number.isFinite(dur) && dur > 0 ? dur : null
      }
      return true
    } catch {
      return false
    }
  }
  return false
}

async function amapDirection(key, originLat, originLng, point, mode) {
  if (mode === 'bike') return false // 高德 v3 无骑行路径规划
  const path = 'walking'
  const url = `https://restapi.amap.com/v3/direction/${path}`
    + `?origin=${originLng},${originLat}&destination=${point.lng},${point.lat}&key=${key}`
  try {
    const res = await fetch(url, withTimeout(12000))
    if (!res.ok) return false
    const json = await res.json()
    if (json.status !== '1') {
      console.warn(`  ⚠️ 高德路径规划返回 status=${json.status}（${json.info ?? '未知'}）`)
      return false
    }
    const dur = Number(json?.route?.paths?.[0]?.duration) // 单位：秒
    point.duration = Number.isFinite(dur) && dur > 0 ? dur : null
    return true
  } catch {
    return false
  }
}

/**
 * 云端等时圈：24 方向 × N 环径向采样，按真实路径耗时插值出边界。
 * 计费口径：腾讯 matrix 按 OD 对数，高德 direction 按 1 对/次；两者都写入当日配额账本。
 */
export async function cloudIsochrone(engine, lat, lng, mode, minutes, trimFactor = 0) {
  const provider = engine.provider ?? CLOUD_PROVIDER
  const st = cloudStatus(provider)
  if (!st.ok) return null

  const key = readKey(provider)
  if (!key) return null

  const limit = minutes * 60
  const estRadius = ((SPEED_MPM[mode] ?? SPEED_MPM.walk) * minutes) / 1.35
  const SECTORS = CLOUD_SECTORS
  const RINGS = CLOUD_RINGS
  const total = SECTORS * RINGS
  if (total > CLOUD_MAX_PAIRS) return null
  if (st.used + total > st.dailyMax) {
    console.warn(`  ⚠️ 云端当日配额不足：已用 ${st.used}，本圈需 ${total}，上限 ${st.dailyMax}`)
    return null
  }

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

  let spent = 0
  if (provider === 'tencent') {
    for (let i = 0; i < samples.length; i += TENCENT_BATCH) {
      const slice = samples.slice(i, i + TENCENT_BATCH)
      const ok = await tencentMatrix(key, lat, lng, slice, mode)
      spent += slice.length
      addCloudQuota(provider, slice.length)
      engine.calls = (engine.calls ?? 0) + slice.length
      if (!ok) return null
      if (i + TENCENT_BATCH < samples.length) await sleep(CLOUD_INTERVAL_MS)
    }
  } else {
    for (const p of samples) {
      const ok = await amapDirection(key, lat, lng, p, mode)
      spent += 1
      addCloudQuota(provider, 1)
      engine.calls = (engine.calls ?? 0) + 1
      if (!ok) return null
      await sleep(600)
    }
  }

  const ring = interpolateRing(samples, lat, lng, estRadius, SECTORS, RINGS, limit, trimFactor)
  return ring
}

/** 统一入口：对外坐标一律 GCJ-02 */
export async function isochroneFrom(engine, lat, lng, mode, minutes, trimFactor) {
  if (!engine) return null
  if (engine.kind === 'valhalla') {
    const [wLat, wLng] = gcj02ToWgs84(lat, lng)
    const ring = await valhallaIsochrone(engine.base, wLat, wLng, COSTING[mode] ?? 'pedestrian', minutes, trimFactor)
    return ring ? transformRing(ring, wgs84ToGcj02) : null
  }
  if (engine.kind === 'osrm') {
    const [wLat, wLng] = gcj02ToWgs84(lat, lng)
    const ring = await osrmIsochrone(engine.base, wLat, wLng, mode, minutes, engine.profile, trimFactor)
    return ring ? transformRing(ring, wgs84ToGcj02) : null
  }
  if (engine.kind === 'cloud') {
    return cloudIsochrone(engine, lat, lng, mode, minutes, trimFactor)
  }
  return null
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
    const c = cloudStatus()
    console.log(`Valhalla ${VALHALLA_BASE} → ${v ? '在线 ✅' : '不可达'}`)
    console.log(`OSRM     ${OSRM_BASE}（profile=${OSRM_PROFILE}）→ ${o ? '在线 ✅' : '不可达'}`)
    console.log(`云端     ${CLOUD_PROVIDER} → ${c.ok ? `可用（今日已用 ${c.used}/${c.dailyMax} 对）` : `不可用：${c.reason}`}`)
    const engine = await detectEngine()
    console.log(engine ? `\n将使用：${engine.label}` : '\n三级引擎都不可用 → 出图回退「直线估算圈」（标【估算】）')
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
  if (engine.kind === 'cloud') console.log(`云端消耗：${engine.calls ?? 0} 对（今日累计 ${readCloudQuota(engine.provider).pairs} 对）`)
  console.log(`等时圈（${mode} ${minutes} 分钟）：${ring.length} 个顶点`)
  console.log(`范围：lat ${Math.min(...lats).toFixed(5)}~${Math.max(...lats).toFixed(5)}, lng ${Math.min(...lngs).toFixed(5)}~${Math.max(...lngs).toFixed(5)}`)
  console.log(`中心在圈内：${pointInRing(lng, lat, ring) ? '是' : '否（异常）'}`)
}
