/**
 * guangzhou-probe.mjs —— 广州真实点位探查（双源 POI + 去重 + 空间分析）
 * 面向**中大型餐饮**（80–200㎡ 中型 / 1000–2000㎡ 大型）。
 *
 * 用法（在 scratch-plugin 目录下）：
 *   node .\tools\guangzhou-probe.mjs                                  # 默认：天河体育西路 / 中型餐饮
 *   node .\tools\guangzhou-probe.mjs "广州市天河区珠江新城" large       # 大型餐饮
 *   node .\tools\guangzhou-probe.mjs "广州市越秀区北京路" mid 1200 火锅  # 自定义：场景 半径 关键词
 *
 * 场景预设：
 *   mid   中型餐饮（80–200㎡）：关键词「餐厅」，半径 1000m，步行 10 分钟圈
 *   large 大型餐饮（1000–2000㎡）：关键词「酒楼」，半径 3000m，车行 15 分钟圈
 *   retail 便利店：关键词「便利店」，半径 800m，步行 10 分钟圈
 *
 * Key 读取顺序：环境变量 → %USERPROFILE%\.dsh\secrets\{amap,tencent}.key（不会打印到输出）
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectEngine, isochroneFrom, pointInRing } from './isochrone.mjs'
import { clampToRadius } from './isochrone.mjs'

// 注意：category_pattern 匹配的是**平台类目字段**（高德 type / 腾讯 category），不是店名。
// 品牌词（茶颜悦色/海底捞/广州酒家）必须放 keyword 检索，不能放白名单。
// 商圈口径（用户行业经验）：步行 10 分钟 ≈ 一个商圈的极限；车行 5 分钟同理；车行 10 分钟会跨 2–3 个商圈
/** 势力份额榜长度：报告里 W1–W10 + W11–W20 两段展示 */
const TOP_N = 20

const SCENES = {
  mid: { label: '中型餐饮（80–200㎡）', keyword: '餐厅', sweep: ['餐厅', '茶餐厅', '粤菜'], radius: 1000, pattern: '中餐厅|餐厅|快餐厅', exclude: '快餐|小吃|外卖', mode: 'walk', minutes: 10, rings: [{ label: '内圈·步行8分', mode: 'walk', minutes: 8, max_m: 800 }, { label: '外圈·车行5分', mode: 'car', minutes: 5, max_m: 1500 }] },
  large: { label: '大型餐饮（1000–2000㎡）', keyword: '酒楼', sweep: ['粤菜', '海鲜', '宴会', '酒楼', '火锅'], radius: 3000, pattern: '中餐厅|海鲜|粤菜|宴会|火锅', exclude: '快餐|小吃', mode: 'car', minutes: 5, rings: [{ label: '内圈·步行10分', mode: 'walk', minutes: 10, max_m: 1000 }, { label: '外圈·车行5分', mode: 'car', minutes: 5, max_m: 1500 }] },
  retail: { label: '便利店', keyword: '便利店', radius: 800, pattern: '便利店', exclude: '超市|百货|2元|折扣', mode: 'walk', minutes: 10, rings: [{ label: '内圈·步行5分', mode: 'walk', minutes: 5, max_m: 500 }, { label: '外圈·步行10分', mode: 'walk', minutes: 10, max_m: 1000 }] },
  tea: { label: '茶饮', keyword: '茶饮', radius: 800, pattern: '冷饮|甜品|咖啡|茶饮|饮品', exclude: '便利店|超市', mode: 'walk', minutes: 10, rings: [{ label: '内圈·步行5分', mode: 'walk', minutes: 5, max_m: 500 }, { label: '外圈·步行10分', mode: 'walk', minutes: 10, max_m: 1000 }] },
}

/** 商圈锁：等时圈与固定半径取交集，防止开到别的商圈去 */
const LOCK_RADIUS = Number(process.env.LOCK_RADIUS ?? 0)

/** 各出行方式速度（米/分）与绕行系数，与 geo_analyze 内部保持一致 */
const MODE_SPEED = { walk: 80, bike: 250, car: 500 }
const DETOUR = 1.35

/** 分段 key → 人话（yuecai_large → 粤菜·高端） */
const CUISINE_LABEL = { yuecai: '粤菜', chaoshan: '潮汕', other: '其他菜系', snack: '小吃' }
const SCALE_LABEL = { small: '小吃快餐', mid: '中端', large: '高端' }
// 优先用 profile 里给的 label；没有才按 key 拆分猜（xiaolongbao 这类自定义 key 拆不出来）
const segLabel = (key, label) => {
  if (label) return label
  const parts = String(key).split('_')
  const scale = parts.length > 1 ? parts[parts.length - 1] : ''
  const cuisine = parts.length > 1 ? parts.slice(0, -1).join('_') : parts[0]
  const c = CUISINE_LABEL[cuisine] ?? cuisine
  return SCALE_LABEL[scale] ? `${c}·${SCALE_LABEL[scale]}` : (CUISINE_LABEL[key] ?? key)
}

const secretDir = join(homedir(), '.dsh', 'secrets')

function readKey(file, envName) {
  const fromEnv = process.env[envName]
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const raw = readFileSync(join(secretDir, file), 'utf8')
    const line = raw.split(/\r?\n/).find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    return line ? line.trim() : undefined
  } catch {
    return undefined
  }
}

const AMAP = readKey('amap.key', 'AMAP_API_KEY')
const TENCENT = readKey('tencent.key', 'TENCENT_MAP_KEY')
if (!AMAP) { console.error('缺少高德 Key'); process.exit(1) }
if (!TENCENT) { console.error('缺少腾讯 Key'); process.exit(1) }

// 只取非 --flag 的位置参数，避免 --profile=xxx 被当成场景名
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const address = positional[0] ?? '广州市天河区体育西路'
// 双源开关：由 run-site.mjs 按「是否带租金」决定，默认关。
// 关掉时只跑高德，省腾讯 place/* 四个接口合计 800/日 的额度。
const DUAL_SOURCE = process.argv.includes('--dual-source')
console.log(DUAL_SOURCE
  ? '源模式：双源（高德 + 腾讯交叉校验）← 第 2 筛，已检出真实租金'
  : '源模式：单源（仅高德）← 第 1/1.5 筛，省腾讯 POI 额度')
// 城市提示：从地址里认出城市就传，认不出则不限定（全国匹配），避免外地地址报 30001
const CITY_HINTS = ['北京', '上海', '广州', '深圳', '佛山', '东莞', '重庆', '成都', '杭州', '武汉',
  '苏州', '西安', '南京', '长沙', '天津', '青岛', '济南', '宁波', '郑州', '合肥', '昆明']
const cityHint = CITY_HINTS.find((c) => address.includes(c)) ?? ''
const sceneKey = (positional[1] ?? 'mid').toLowerCase()

// 业态档案优先：--profile=breakfast / tea / large-yuecai（见 profiles/ 目录，可自定义）
const profileArg = (process.argv.find((a) => a.startsWith('--profile=')) ?? '').slice('--profile='.length).trim()
let profile = null
if (profileArg !== '') {
  const file = new URL(`../profiles/${profileArg.replace(/\.json$/, '')}.json`, import.meta.url)
  profile = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`业态档案：${profile.name}`)
}

// 人工校正文件（由 review-segments.mjs --apply 生成）；有就用它覆盖自动分段
const overridesFile = new URL(`../profiles/${profileArg}.overrides.json`, import.meta.url)
let overrides = {}
if (profileArg !== '' && existsSync(overridesFile)) {
  overrides = JSON.parse(readFileSync(overridesFile, 'utf8'))
  console.log(`已加载人工校正：${Object.keys(overrides).length} 条`)
}

const scene = profile
  ? {
      label: profile.name,
      keyword: (profile.keywords ?? ['餐厅'])[0],
      sweep: profile.keywords ?? [],
      radius: Number(profile.scan_radius ?? 1000),
      pattern: profile.category_pattern,
      exclude: profile.exclude_pattern,
      exclude_category: profile.exclude_category_pattern,
      subtype: profile.subtype_pattern,
      mode: profile.rings?.[0]?.mode ?? 'walk',
      minutes: profile.rings?.[0]?.minutes ?? 10,
      rings: profile.rings ?? [],
    }
  : (SCENES[sceneKey] ?? SCENES.mid)
if (!profile) console.log('ℹ️ 未给 --profile=…，本次用示例预设（结论仅供参考；正式报告必须用业态档案）')

/** 交通阈值也来自业态档案：早餐/茶饮要更近，大型餐饮可放宽 */
const METRO_THRESHOLD = Number(profile?.transit?.metro_threshold_m ?? 800)
const PARKING_THRESHOLD = Number(profile?.transit?.parking_threshold_m ?? 300)
const requestedRadius = Number(positional[3] ?? scene.radius)
// 采集半径必须覆盖最大圈层，否则外圈会变成"全量"（半径大于采集范围时无过滤意义）
const maxRingRadius = Math.max(
  0,
  ...(scene.rings ?? []).map((ring) => Math.round(((MODE_SPEED[ring.mode] ?? 80) * ring.minutes) / DETOUR)),
)
const radius = Math.max(requestedRadius, maxRingRadius)
const keyword = positional[2] ?? scene.keyword
/** 细分品类（同类型=竞品，异类=协同）：--subtype=牛肉|牛杂；不传则用业态档案里的 */
const subtypeArg = (process.argv.find((a) => a.startsWith('--subtype=')) ?? '').slice('--subtype='.length).trim()
const subtype = subtypeArg !== '' ? subtypeArg : (profile?.subtype_pattern ?? '')
if (radius > requestedRadius) {
  console.log(`采集半径自动提升：${requestedRadius}m → ${radius}m（需覆盖最大圈层 ${maxRingRadius}m，否则外圈 = 全量）`)
}

console.log(`=== 场景 ===\n${scene.label}｜关键词「${keyword}」｜高德半径 ${radius}m｜${scene.mode} ${scene.minutes} 分钟圈`)
if (radius > 1000) {
  console.log(`⚠️ 腾讯 nearby 半径上限 1000m → 外圈（1000–${radius}m）只有高德数据，报告里必须注明覆盖差异`)
}

// ── 带本地缓存的请求器：同一 URL 只打一次接口，调试重跑零消耗
// 加 --fresh 强制回源（改了逻辑需要真数据时用）
let apiCalls = 0
let cacheHits = 0
const cacheEnabled = !process.argv.includes('--fresh')
const cacheDir = new URL('../.cache/', import.meta.url)

const getJson = async (url) => {
  const name = createHash('sha1').update(url).digest('hex').slice(0, 16) + '.json'
  const target = new URL(name, cacheDir)
  if (cacheEnabled) {
    try {
      const cached = JSON.parse(readFileSync(target, 'utf8'))
      cacheHits += 1
      return cached
    } catch {
      /* 未命中，继续回源 */
    }
  }
  apiCalls += 1
  const res = await fetch(url)
  const json = await res.json()
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(target, JSON.stringify(json), 'utf8')
  } catch {
    /* 缓存失败不影响主流程 */
  }
  return json
}

// ── 1. 定位中心点（GCJ-02）
// 优先 place/text（POI 搜索）：返回的是商铺/商场/写字楼的真实坐标。
// 回退 geocode/geo：它会把「XX地铁站」匹配到站点、「XX路口」匹配到道路中心，
// 坐标落在马路中间——2026-11-08 实测望京SOHO 的 geocode 结果偏了约 920 米。
const BAD_POI_TYPES = ['公交地铁站点', '地铁站', '道路', '村庄', '地名地址信息', '交通设施服务', '道路附属设施']
let center = null
let centerVia = ''
let centerName = ''

try {
  const ps = await getJson(
    `https://restapi.amap.com/v3/place/text?key=${AMAP}&keywords=${encodeURIComponent(address)}`
    + `&city=${encodeURIComponent(cityHint)}&offset=5&page=1&extensions=base`,
  )
  for (const p of (ps.pois ?? [])) {
    const t = String(p.type ?? '')
    if (BAD_POI_TYPES.some((b) => t.includes(b))) continue
    if (!p.location) continue
    const [lngS, latS] = String(p.location).split(',')
    center = { lat: Number(latS), lng: Number(lngS) }
    centerVia = `POI:${t.split(';').pop() || t}`
    centerName = p.name ?? ''
    break
  }
} catch { /* 落到下面的 geocode */ }

if (!center) {
  const geo = await getJson(
    `https://restapi.amap.com/v3/geocode/geo?key=${AMAP}&address=${encodeURIComponent(address)}&city=${encodeURIComponent(cityHint)}`,
  )
  if (geo.status !== '1' || !geo.geocodes?.length) {
    console.error('地理编码失败：', JSON.stringify(geo).slice(0, 200))
    process.exit(1)
  }
  const [lngStr, latStr] = String(geo.geocodes[0].location).split(',')
  center = { lat: Number(latStr), lng: Number(lngStr) }
  centerVia = `geocode:${geo.geocodes[0].level ?? ''}`
  centerName = geo.geocodes[0].formatted_address ?? ''
  console.warn(`⚠️ POI 搜索没命中商业载体，回退地理编码（匹配：${centerVia}）。`
    + '这类坐标可能落在路口/站点，内圈竞品数会失真——换更具体的点位名。')
}
console.log(`\n=== 0. 中心点 ===\n${address} → ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}（GCJ-02，匹配：${centerVia}）`)
if (centerName && centerName !== address) console.log(`命中载体：${centerName}`)

// ── 2. 高德周边（翻页取全；--sweep 时按多关键词扫描，绕过单次 200 条上限）
const AMAP_PAGE_SIZE = 25
const AMAP_MAX_PAGES = 8
const sweepMode = process.argv.includes('--sweep')
const sweepList = sweepMode && Array.isArray(scene.sweep) ? scene.sweep : [keyword]
let amapTotal = 0
let amapPois = []
for (const kw of sweepList) {
  let kwTotal = 0
  let kwGot = 0
  for (let page = 1; page <= AMAP_MAX_PAGES; page += 1) {
    const res = await getJson(
      `https://restapi.amap.com/v3/place/around?key=${AMAP}&location=${center.lng},${center.lat}`
      + `&keywords=${encodeURIComponent(kw)}&radius=${radius}&offset=${AMAP_PAGE_SIZE}&page=${page}&extensions=all`,
    )
    if (res.status !== '1') {
      if (page === 1) console.warn(`高德关键词「${kw}」失败：${res.info}（已跳过）`)
      break
    }
    const batch = res.pois ?? []
    kwTotal = Number(res.count ?? 0)
    for (const p of batch) {
      const [lng, lat] = String(p.location).split(',').map(Number)
      // extensions=all 会带人均消费与评分——用来做"规模"分层，比猜店名可靠
      const cost = Number(p.biz_ext?.cost)
      const rating = Number(p.biz_ext?.rating)
      amapPois.push({
        title: p.name,
        category: p.type,
        keytag: '',
        location: { lat, lng },
        _distance: p.distance,
        address: p.address,
        tel: '',
        source: 'amap',
        cost: Number.isFinite(cost) && cost > 0 ? cost : undefined,
        rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
      })
    }
    kwGot += batch.length
    if (batch.length < AMAP_PAGE_SIZE || kwGot >= kwTotal) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  amapTotal += kwTotal
  if (sweepList.length > 1) console.log(`  关键词「${kw}」：count=${kwTotal}，取回 ${kwGot} 条`)
}
// sweep 模式下 count 有重叠，覆盖率不适用，记 -1
const amapCoverage = sweepList.length > 1 ? -1 : (amapTotal === 0 ? 0 : Math.min(100, (amapPois.length / amapTotal) * 100))

// ── 3. 腾讯周边（半径压到 1000，翻页取全；配额/异常时降级为单源）
// --dual-source 未开时整段跳过：第 1/1.5 筛不花腾讯额度
const tRadius = Math.min(radius, 1000)
const TENCENT_PAGE_SIZE = 20
const TENCENT_MAX_PAGES = 10
let tTotal = 0
let tencentPois = []
let tencentOk = true
let tencentMessage = ''
for (let page = 1; DUAL_SOURCE && page <= TENCENT_MAX_PAGES; page += 1) {
  let res
  try {
    res = await getJson(
      `https://apis.map.qq.com/ws/place/v1/search?boundary=nearby(${center.lat},${center.lng},${tRadius})`
      + `&keyword=${encodeURIComponent(keyword)}&page_size=${TENCENT_PAGE_SIZE}&page_index=${page}&key=${TENCENT}`,
    )
  } catch (error) {
    tencentOk = false
    tencentMessage = error.message
    break
  }
  if (res.status !== 0) {
    tencentOk = false
    tencentMessage = res.message || '未知错误'
    if (page === 1) console.warn(`⚠️ 腾讯不可用（${tencentMessage}）→ 本次仅高德单源，报告必须注明「无双源交叉」`)
    break
  }
  const batch = res.data ?? []
  tTotal = Number(res.count ?? 0)
  for (const d of batch) {
    tencentPois.push({ title: d.title, category: d.category, keytag: d.keytag, location: d.location, _distance: d._distance, address: d.address, tel: d.tel, source: 'tencent' })
  }
  if (batch.length < TENCENT_PAGE_SIZE || tencentPois.length >= tTotal) break
  await new Promise((resolve) => setTimeout(resolve, 200))
}
const tencentCoverage = tTotal === 0 ? 0 : Math.min(100, (tencentPois.length / tTotal) * 100)

console.log(`\n=== 1. 原始 POI（已翻页${sweepList.length > 1 ? ' + 多关键词扫描' : ''}）===`)
if (sweepList.length > 1) {
  console.log(`高德：${sweepList.length} 个关键词，count 合计 ${amapTotal}（词间有重叠），去重前取回 ${amapPois.length} 条`)
} else {
  console.log(`高德 radius=${radius} → count=${amapTotal}，取回 ${amapPois.length} 条，覆盖率 ${amapCoverage.toFixed(1)}%`)
  if (amapCoverage < 95) console.warn(`⚠️ 高德覆盖率仅 ${amapCoverage.toFixed(1)}%：单次最多 200 条，加 --sweep 可按多关键词扫描补齐`)
}
console.log(DUAL_SOURCE
  ? `腾讯 radius=${tRadius} → count=${tTotal}，取回 ${tencentPois.length} 条，覆盖率 ${tencentCoverage.toFixed(1)}%${tencentOk ? '' : '（不可用）'}`
  : '腾讯：本轮跳过（单源模式，未检出真实租金）')

// ── 4. 去重清洗
// 采集层依赖 DSH 插件的计算模块。可能放在 src/（完整工作区）或 dsh/（分发包内），两处都认。
// 若都没有，先给能照做的提示，不要抛 MODULE_NOT_FOUND 堆栈。
const siteToolsCandidates = [
  new URL('../src/site-tools.ts', import.meta.url),
  new URL('../dsh/site-tools.ts', import.meta.url),
]
const siteToolsUrl = siteToolsCandidates.find((u) => existsSync(fileURLToPath(u)))
if (!siteToolsUrl) {
  console.error('\n❌ 本次运行缺少采集所需的计算模块：src/site-tools.ts 或 dsh/site-tools.ts')
  console.error('   当前目录既没有 src/（完整工作区）也没有 dsh/（分发包内的采集层）。')
  console.error('')
  console.error('   两条路：')
  console.error('   A. 已有 probe.json 时只渲染：')
  console.error('        node tools/report.mjs --in=<路径>/probe.json')
  console.error('   B. 用完整源码工作区（含 src/site-tools.ts）跑本脚本。')
  process.exit(2)
}
console.log(`采集计算层：${fileURLToPath(siteToolsUrl).replace(/.*[\\/]dist[\\/]/, 'dist/')}`)
const mod = await import(siteToolsUrl.href)
// 竞争分段：品类 × 规模（同段才是直接竞品）
const segs = subtypeArg !== ''
  ? [{ key: 'self', match: subtypeArg }]
  : (Array.isArray(profile?.segments) && profile.segments.length > 0
      ? profile.segments
      : (profile?.subtype_pattern ? [{ key: 'self', match: profile.subtype_pattern }] : []))
const selfSeg = subtypeArg !== '' ? 'self' : (profile?.self_segment ?? (segs.length === 1 ? segs[0].key : undefined))

const dedupe = mod.analyzePois([...amapPois, ...tencentPois], {
  sameNameMergeM: 50,
  crossSourceMergeM: 100,
  crossSourceSameSpotM: 30,
  nameSimilarity: 0.6,
  categoryPattern: new RegExp(scene.pattern),
  excludePattern: (process.env.EXCLUDE_NAME || scene.exclude) === undefined ? undefined : new RegExp(process.env.EXCLUDE_NAME || scene.exclude),
  excludeCategoryPattern: (() => {
    const src = process.env.EXCLUDE_CATEGORY || scene.exclude_category
    return src === undefined || src === '' ? undefined : new RegExp(src)
  })(),
  // label 一路带到 dedupe 结果里，报告层直接显示中文名，不再印技术 key
  segments: segs.map((s) => ({ key: s.key, ...(s.label ? { label: s.label } : {}), pattern: new RegExp(s.match) })),
  selfSegment: selfSeg,
  // 餐饮业态才启用「非堂食零售」过滤：便利店/超市业态里这些名字本身就是竞品
  diningOnly: /餐饮|餐厅|菜|火锅|酒楼|茶楼|小吃|快餐|烘焙|咖啡|茶饮/.test(scene.pattern ?? ''),
})

console.log(`\n=== 2. poi_dedupe（白名单 /${scene.pattern}/）===`)
console.log(`原始 ${dedupe.raw}｜有效 ${dedupe.effective}｜剔除 ${dedupe.dropped.length}｜合并 ${dedupe.merged.length}`)
// 应用人工校正，重算分段
const keptFinal = dedupe.kept.map((p) => ({ ...p, segment: overrides[p.name] ?? p.segment }))

// 人均硬分层：有价的按客单价重判规模段（覆盖店名猜测）
const costBands = Array.isArray(profile?.cost_bands) ? profile.cost_bands : []
let reassignedCount = 0
const keptSegmented = costBands.length === 0
  ? keptFinal
  : keptFinal.map((p) => {
      if (!(p.cost > 0)) return p
      // 段 key 形如 <cuisine>_<scale>，按人均换掉 scale 后缀（组合不存在也允许，报告会显示新 key）
      const base = p.segment.replace(/_(small|mid|large)$/, '')
      const band = costBands.find((b) => p.cost <= b.max_cost)?.key
      if (!band) return p
      const candidate = `${base}_${band}`
      if (candidate === p.segment) return p
      reassignedCount += 1
      return { ...p, segment: candidate }
    })
if (reassignedCount > 0) console.log(`人均硬分层：${reassignedCount} 家按客单价重判了规模段（覆盖店名猜测）`)

// 最终 POI 列表：分段以「人均重判后」为准，same_type 同步重算。
// 不这样做会出现——地图按店名猜测染色 26 个红点、正文按人均重判写 15 家，
// 同一份数据两套口径（审计报告 A 项）。
const selfSegFinal = dedupe.self_segment
const poisFinal = keptSegmented.map((p) => ({
  ...p,
  same_type: selfSegFinal === '' || selfSegFinal === undefined ? true : p.segment === selfSegFinal,
}))

const segMap = new Map()
for (const p of keptSegmented) segMap.set(p.segment, (segMap.get(p.segment) ?? 0) + 1)
const segmentsFinal = [...segMap.entries()]
  .map(([key, count]) => ({ key, count, is_self: key === dedupe.self_segment }))
  .sort((a, b) => b.count - a.count)
const sameCountFinal = dedupe.self_segment ? (segMap.get(dedupe.self_segment) ?? 0) : keptSegmented.length

if (segmentsFinal.length > 1 || dedupe.self_segment !== '') {
  console.log(`竞争分段（★=客户所在段）：${segmentsFinal.map((s) => `${segLabel(s.key, segs.find((x) => x.key === s.key)?.label)}${s.is_self ? '★' : ''} ${s.count}`).join('｜')}`)
  console.log(`直接竞品（同段）${sameCountFinal} 家｜异段 ${keptSegmented.length - sameCountFinal} 家（协同或弱竞争）`)
} else {
  console.log('未分竞争段（档案里配 segments + self_segment）：全部按同类计，竞品数会高估')
}

// 用高德人均消费做"规模"实证：同段 vs 异段的客单价分布
const segStats = segmentsFinal.map((s) => {
  const group = keptSegmented.filter((p) => p.segment === s.key)
  const costs = group.map((p) => p.cost).filter((c) => c > 0)
  const ratings = group.map((p) => p.rating).filter((r) => r > 0)
  return {
    key: s.key,
    ...(segs.find((x) => x.key === s.key)?.label
      ? { label: segs.find((x) => x.key === s.key).label }
      : {}),
    count: s.count,
    is_self: s.is_self,
    avg_cost: costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) : -1,
    cost_coverage: group.length > 0 ? Math.round((costs.length / group.length) * 100) : 0,
    avg_rating: ratings.length > 0 ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)) : -1,
  }
})
const withCost = segStats.filter((s) => s.avg_cost > 0)
if (withCost.length > 0) {
  console.log('客单价分布（高德 biz_ext.cost，实证规模差异）：')
  for (const s of withCost) {
    console.log(`  ${segLabel(s.key)}${s.is_self ? '★' : ''}：人均 ${s.avg_cost} 元｜评分 ${s.avg_rating}｜有价率 ${s.cost_coverage}%｜${s.count} 家`)
  }
} else {
  console.log('⚠️ 未取到人均消费（biz_ext.cost 为空）：规模分层只能回退到店名规则')
}
console.log(`最近竞品：${dedupe.nearest.name}（${dedupe.nearest.distance_m} 米）`)
if (dedupe.dropped.length) {
  console.log('剔除：')
  for (const d of dedupe.dropped.slice(0, 12)) console.log(`  - ${d.name}（${d.source}）：${d.reason}`)
}
if (dedupe.brand_groups.length) {
  console.log('品牌集中度：')
  for (const b of dedupe.brand_groups) console.log(`  - ${b.brand}：${b.count} 处，最近 ${b.nearest_m} 米`)
}

// ── 4.5 交通可达（地铁站 + 停车）：大型餐饮的核心决策项，2 次额外调用（走缓存）
const transit = { metro: [], nearest_parking_m: -1, parking_near: 0, parking_in_1km: 0, metro_threshold_m: METRO_THRESHOLD, parking_threshold_m: PARKING_THRESHOLD, ok: false }
if (!process.argv.includes('--no-transit')) {
  console.log(`\n=== 2.5 交通可达（阈值：地铁 ${METRO_THRESHOLD}m / 停车场 ${PARKING_THRESHOLD}m）===`)
  try {
    const metroRes = await getJson(
      `https://restapi.amap.com/v3/place/around?key=${AMAP}&location=${center.lng},${center.lat}`
      + `&keywords=${encodeURIComponent('地铁站')}&radius=2000&offset=10&page=1&extensions=base`,
    )
    if (metroRes.status === '1') {
      transit.metro = (metroRes.pois ?? [])
        .map((p) => ({ name: p.name, distance_m: Number(p.distance) }))
        .filter((m) => Number.isFinite(m.distance_m))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, 5)
    }
    const parkRes = await getJson(
      `https://restapi.amap.com/v3/place/around?key=${AMAP}&location=${center.lng},${center.lat}`
      + `&keywords=${encodeURIComponent('停车场')}&radius=1000&offset=25&page=1&extensions=base`,
    )
    if (parkRes.status === '1') {
      const dists = (parkRes.pois ?? []).map((p) => Number(p.distance)).filter((d) => Number.isFinite(d)).sort((a, b) => a - b)
      transit.nearest_parking_m = dists.length > 0 ? dists[0] : -1
      transit.parking_near = dists.filter((d) => d <= PARKING_THRESHOLD).length
      transit.parking_in_1km = Number(parkRes.count ?? dists.length)
    }
    transit.ok = true
  } catch (error) {
    console.warn(`交通数据获取失败：${error.message}（报告须注明缺失）`)
  }
  const nearestMetro = transit.metro[0]
  const metroOk = nearestMetro ? nearestMetro.distance_m <= METRO_THRESHOLD : false
  const parkOk = transit.nearest_parking_m >= 0 && transit.nearest_parking_m <= PARKING_THRESHOLD
  console.log(`最近地铁：${nearestMetro ? `${nearestMetro.name} ${nearestMetro.distance_m} 米` : '未取到'}（${metroOk ? `✅ ${METRO_THRESHOLD}m 内` : `❌ 超 ${METRO_THRESHOLD}m`}）`)
  console.log(`最近停车场：${transit.nearest_parking_m >= 0 ? `${transit.nearest_parking_m} 米` : '未取到'}（${parkOk ? `✅ ${PARKING_THRESHOLD}m 内` : `❌ 超 ${PARKING_THRESHOLD}m`}）｜${PARKING_THRESHOLD}m 内 ${transit.parking_near} 个`)
}

// 需求侧指标统一由 demand-fetch.py 的 POI 代理提供
const population = { available: false, note: '已移除' }

// ── 5. 空间分析：多圈层（内圈看直接对手，外圈看辐射范围；纯本地零消耗）
let isochroneNotice = null
const useEngine = !process.argv.includes('--no-valhalla') && !process.argv.includes('--no-osrm')
const engine = useEngine ? await detectEngine() : null
if (engine) {
  console.log(`\n等时圈引擎：${engine.label}`)
} else {
  const why = useEngine
    ? 'Valhalla(8002) 与 OSRM(5000) 都不可达'
    : '命令带了 --no-valhalla/--no-osrm'
  console.warn(`\n⚠️ 等时圈引擎未启用：${why}`)
  console.warn('   本次等时圈为【直线估算】——遇江面、快速路、封闭小区会高估可达范围，圈内竞品数偏多。')
  console.warn('   首次启动：docker run -dt --name valhalla -p 8002:8002 -v F:/gis/valhalla:/custom_files ghcr.io/gis-ops/docker-valhalla/valhalla:latest')
  console.warn('   之后启动：docker start valhalla')
  console.warn('   不用时可以 docker stop valhalla 释放内存（约 1~2 GB），下次跑之前记得再 start。')
  isochroneNotice = {
    engine: 'straight',
    reason: why,
    fix: 'docker start valhalla',
    first_time: 'docker run -dt --name valhalla -p 8002:8002 -v F:/gis/valhalla:/custom_files ghcr.io/gis-ops/docker-valhalla/valhalla:latest',
    impact: '直线估算遇江面/快速路会高估可达范围，圈内竞品数偏多',
  }
}

const rings = scene.rings ?? [{ label: `${scene.mode} ${scene.minutes}分`, mode: scene.mode, minutes: scene.minutes }]
const ringResults = []
console.log(`\n=== 3. geo_analyze（${rings.length} 个圈层，本地计算）===`)
for (const ring of rings) {
  const ringRadius = Math.round(((MODE_SPEED[ring.mode] ?? MODE_SPEED.walk) * ring.minutes) / DETOUR)
  const gridStep = ringRadius > 1500 ? Math.round(ringRadius / 40) : 100
  const result = mod.analyzeGeography(center.lat, center.lng, dedupe.kept, ring.mode, ring.minutes, gridStep)
  const inside = result.reachable.filter((r) => r.inside)

  // 有本地 Valhalla 就换成真路网等时圈多边形，并用"点在多边形内"重算圈内数量
  let iso = null
  let source = 'estimate'
  const PROFILE_FOR_MODE = { walk: 'walking', bike: 'cycling', car: 'driving' }
  if (engine && engine.kind === 'osrm' && engine.profile !== PROFILE_FOR_MODE[ring.mode]) {
    console.warn(`  ⚠️ OSRM 数据是 ${engine.profile}，与「${ring.mode}」不匹配 → 该圈回退直线估算（要步行圈需用 foot.lua 另起实例）`)
  } else if (engine) {
    // 尖刺处理：先径向中值滤波（默认窗口 5），再按 ISO_TRIM 削超长尾巴（默认关闭）
    const trimFactor = Number(process.env.ISO_TRIM ?? 0)
    iso = await isochroneFrom(engine, center.lat, center.lng, ring.mode, ring.minutes, trimFactor)
    if (iso) source = engine.kind
  }

  // 商圈锁：等时圈 ∩ 固定半径，防止把另一个商圈的竞品算进来
  const lockRadius = LOCK_RADIUS > 0 ? LOCK_RADIUS : Number(ring.max_m ?? 0)
  const mLatIso = 111320
  const mLngIso = 111320 * Math.cos((center.lat * Math.PI) / 180)
  if (iso && lockRadius > 0) {
    const farthest = Math.max(...iso.map(([x, y]) => Math.hypot((x - center.lng) * mLngIso, (y - center.lat) * mLatIso)))
    iso = clampToRadius(iso, center.lat, center.lng, lockRadius)
    if (farthest > lockRadius * 1.02) {
      console.log(`  🔒 商圈锁：等时圈最远 ${Math.round(farthest)}m → 截断到 ${lockRadius}m（超出部分属其他商圈，已剔除）`)
    }
  }

  // ── 等时圈可信度校验（2026-11-08 加）
  // Valhalla 若没装该城市的路网数据，会返回一个固定大小的「假等时圈」：
  // 实测北京两点位的步行 5 分 / 15 分 / 车行 10 分圈全是 186×142m，
  // 而广州花城汇同参数是 677m / 1910m —— 圈不随时长变大就说明数据缺失。
  // 这种圈会把所有竞品判成「圈外」，内圈数变成 0，报告结论整个失真。
  let isoTrusted = Boolean(iso)
  let isoRejectReason = ''
  if (iso) {
    const halfLat = (Math.max(...iso.map((p) => p[1])) - Math.min(...iso.map((p) => p[1]))) * mLatIso / 2
    const halfLng = (Math.max(...iso.map((p) => p[0])) - Math.min(...iso.map((p) => p[0]))) * mLngIso / 2
    const effRadius = Math.max(halfLat, halfLng)
    // 该时长下合理的等效半径下限：步速 80m/min、车速 400m/min，打 0.35 折已是极保守
    const speed = ring.mode === 'walk' ? 80 : ring.mode === 'bike' ? 200 : 400
    const floor = speed * ring.minutes * 0.35
    if (effRadius < floor) {
      isoTrusted = false
      isoRejectReason = `等时圈等效半径仅 ${Math.round(effRadius)}m，低于该时长合理下限 ${Math.round(floor)}m`
      console.warn(`  ⚠️ ${ring.label}：${isoRejectReason} → 路网数据可能没覆盖该城市，本圈退回直线圆估算`)
      console.warn('     （Valhalla 缺该城市 OSM 数据时会返回固定小多边形，圈内竞品会被误判为 0 家）')
      iso = null
    }
  }

  const insideCount = iso ? dedupe.kept.filter((p) => pointInRing(p.lng, p.lat, iso)).length : inside.length

  // 份额只在主圈（内圈）报；外圈范围过大（含江面/非商圈），报份额会误导 → 改报距离带
  const isPrimaryRing = ringResults.length === 0
  let top = []
  const distanceBands = []
  const mLatD = 111320
  const mLngD = 111320 * Math.cos((center.lat * Math.PI) / 180)
  const distOf = (p) => Math.round(Math.hypot((p.lng - center.lng) * mLngD, (p.lat - center.lat) * mLatD))
  const insidePois = dedupe.kept.filter((p) => (iso ? pointInRing(p.lng, p.lat, iso) : distOf(p) <= ringRadius))

  if (isPrimaryRing) {
    top = result.voronoi.slice(0, TOP_N)
    if (iso) {
      const step = gridStep
      const half = Math.ceil(ringRadius / step)
      const cells = new Map()
      let total = 0
      for (let gy = -half; gy <= half; gy += 1) {
        for (let gx = -half; gx <= half; gx += 1) {
          const lat = center.lat + (gy * step) / mLatD
          const lng = center.lng + (gx * step) / mLngD
          if (!pointInRing(lng, lat, iso)) continue
          let best
          let bestD = Infinity
          // 只在「圈内店」之间分配格子。用全部 kept 会让圈外店抢走圈边网格，
          // 造成地图上点在圈外、却算进「内圈势力份额」的怪象（2026-11-09 修）
          for (const poi of insidePois) {
            const dx = (poi.lng - lng) * mLngD
            const dy = (poi.lat - lat) * mLatD
            const d = dx * dx + dy * dy
            if (d < bestD) { bestD = d; best = poi.name }
          }
          if (!best) continue
          cells.set(best, (cells.get(best) ?? 0) + step * step)
          total += step * step
        }
      }
      top = [...cells.entries()]
        .map(([name, area]) => ({ name, area_sqm: Math.round(area), share_pct: total === 0 ? 0 : Number(((area / total) * 100).toFixed(1)) }))
        .sort((a, b) => b.area_sqm - a.area_sqm)
        .slice(0, TOP_N)
    }
  } else {
    // 距离带只报到 1km：再远的店对「走过去的客人」没意义，报了也是噪音（2026-11-09）
    const BAND_CAP = 1000
    const limit = Math.min(lockRadius > 0 ? lockRadius : ringRadius, BAND_CAP)
    const edges = [0, 300, 500, 800, 1000].filter((e) => e <= limit)
    if (edges[edges.length - 1] < limit) edges.push(Math.round(limit))
    for (let b = 0; b < edges.length - 1; b += 1) {
      const lo = edges[b]
      const hi = edges[b + 1]
      const label = `${lo < 1000 ? `${lo}m` : `${lo / 1000}km`}–${hi < 1000 ? `${hi}m` : `${hi / 1000}km`}`
      distanceBands.push({ label, count: insidePois.filter((p) => { const d = distOf(p); return d >= lo && d < hi }).length })
    }
  }

  ringResults.push({
    label: ring.label,
    radius: result.isochrone.straight_radius_m,
    area_km2: Number((result.coverage.total_area_sqm / 1000000).toFixed(2)),
    inside: insideCount,
    inside_circle: inside.length,
    source,
    iso,
    is_primary: isPrimaryRing,
    share_suppressed: !isPrimaryRing,
    top,
    distance_bands: distanceBands,
    // 与 dedupe.nearest 对齐：同一家店在「圈层」和「去重汇总」两处必须同一个距离值，
    // 否则报告取一个、明细取另一个，读者会看到 40m 与 41m 并存。
    nearest: (() => {
      const list = inside.slice(0, 3).map((r) => ({ name: r.name, distance_m: r.distance_m }))
      const dn = dedupe.nearest
      if (dn === undefined || dn === null) return list
      return list.map((x) => (x.name === dn.name ? { ...x, distance_m: dn.distance_m } : x))
    })(),
  })
  const bandText = distanceBands.map((b) => `${b.label} ${b.count} 家`).join('｜')
  const ringDesc = iso
    ? `${source} 路网等时圈（${iso.length} 顶点${lockRadius > 0 ? ` · 商圈锁 ${lockRadius}m` : ''}）`
    : (isoRejectReason
        ? `直线圆估算（等时圈不可信：${isoRejectReason}）`
        : `直线半径 ${result.isochrone.straight_radius_m} 米`)
  console.log(`\n[${ring.label}] ${ringDesc}｜范围 ${(result.coverage.total_area_sqm / 1000000).toFixed(2)} km²｜网格 ${gridStep}m`)
  if (result.isochrone.straight_radius_m >= radius * 0.95) {
    console.log(`  ⚠️ 圈层半径接近采集上限（${radius}m）→ 该圈内竞品可能不全，需扩大采集半径或拆扫描`)
  }
  console.log(`  圈内竞品 ${insideCount} 家${iso ? `（按路网多边形；按直线圆算是 ${inside.length} 家）` : ''}`)
  console.log(`  最近：${inside.slice(0, 3).map((r) => `${r.name}(${r.distance_m}m)`).join('、') || '无'}`)
  if (isPrimaryRing) {
    console.log(`  份额 Top3：${top.slice(0, 3).map((v) => `${v.name} ${v.share_pct}%`).join('｜') || '无'}`)
  } else {
    console.log(`  ⛔ 不报份额（范围过大含江面/非商圈）｜距离带：${bandText}`)
  }
}
const primary = ringResults[0]

// ── 5.5 数据质量审计：区分「当地真的没有」与「接口没返回数据」
// 高德/腾讯在 Key 失效、配额耗尽、坐标错误时都可能返回 status 正常但 count=0，
// 静默出 0 会让报告得出「这里没有竞品」的错误结论——必须显式标记。
const dq = (() => {
  const amapZero = !(amapTotal > 0)
  const tencentZero = !(tTotal > 0)
  const amapFetchedZero = !(amapPois.length > 0)
  const tencentFetchedZero = !(tencentPois.length > 0)
  const warnings = []

  // 单源模式：腾讯本轮根本没跑，不参与判定，也不该报「腾讯返回 0」
  if (!DUAL_SOURCE) {
    if (amapZero || amapFetchedZero) warnings.push('高德 count 或取回条数为 0：查配额 / Key 权限 / 坐标')
    if (amapCoverage >= 0 && amapCoverage < 50) warnings.push(`高德覆盖率仅 ${amapCoverage.toFixed(1)}%，漏采严重`)
    return {
      verdict: warnings.length > 0 ? 'partial' : 'ok',
      source_mode: 'single',
      amap: { count: amapTotal, fetched: amapPois.length, coverage: Number(amapCoverage.toFixed(1)) },
      tencent: null,
      warnings,
      note: '本次为单源（仅高德）。腾讯交叉校验只在检出真实租金后启用（第 2 筛）；'
        + '报告不得声称「双源交叉验证」。',
    }
  }

  if (!tencentOk) warnings.push('腾讯接口不可用（已降级为单源）')
  if (amapZero || amapFetchedZero) warnings.push('高德 count 或取回条数为 0：查配额 / Key 权限 / 坐标')
  if (tencentOk && (tencentZero || tencentFetchedZero)) warnings.push('腾讯返回 0：查配额 / Key 权限')
  if (amapCoverage >= 0 && amapCoverage < 50) warnings.push(`高德覆盖率仅 ${amapCoverage.toFixed(1)}%，漏采严重`)

  const bothEmpty = (amapZero || amapFetchedZero) && (!tencentOk || tencentZero || tencentFetchedZero)
  let verdict = 'ok'
  if (bothEmpty) verdict = 'suspicious'
  else if (warnings.length > 0) verdict = 'partial'

  return {
    verdict,
    source_mode: tencentOk ? 'dual' : 'single',
    amap: { count: amapTotal, fetched: amapPois.length, coverage: Number(amapCoverage.toFixed(1)) },
    tencent: { count: tTotal, fetched: tencentPois.length, coverage: Number(tencentCoverage.toFixed(1)), ok: tencentOk },
    warnings,
    note: verdict === 'ok'
      ? '两源均有返回'
      : bothEmpty
        ? '两源均为空：极可能是接口没给数据（配额/权限/坐标），不是当地没有竞品'
        : '部分源为空或覆盖率偏低，结论需打折',
  }
})()

if (dq.verdict !== 'ok') {
  console.log(`\n${dq.verdict === 'suspicious' ? '⛔' : '⚠️'} 数据质量：${dq.verdict}`)
  for (const w of dq.warnings) console.log(`   - ${w}`)
  console.log(`   ${dq.note}`)
}

// ── 6. 落盘机器可读结果（供 render-map.mjs 出图，免二次调用）
const slug = address.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
const outDir = new URL('../out/', import.meta.url)
mkdirSync(outDir, { recursive: true })
const dumpFile = new URL(`${slug}-${sceneKey}.json`, outDir)
writeFileSync(
  dumpFile,
  JSON.stringify(
    {
      scene: profile ? profileArg : sceneKey,
      address,
      center,
      scan_radius: radius,
      isochrone_notice: isochroneNotice,
      coverage: { amap: Number(amapCoverage.toFixed(1)), tencent: Number(tencentCoverage.toFixed(1)), tencent_ok: tencentOk, source_mode: DUAL_SOURCE ? 'dual' : 'single' },
      dedupe: {
        raw: dedupe.raw,
        effective: dedupe.effective,
        same_type_count: sameCountFinal,
        other_type_count: keptSegmented.length - sameCountFinal,
        self_segment: dedupe.self_segment,
        segments: segStats,
        dropped: dedupe.dropped.length,
        merged: dedupe.merged.length,
        nearest: dedupe.nearest,
        brands: dedupe.brand_groups,
      },
      transit,
      population,
      data_quality: dq,
      rings: ringResults,
      pois: poisFinal,
    },
    null,
    2,
  ),
  'utf8',
)
console.log(`\n[结果已落盘] ${decodeURIComponent(dumpFile.pathname)}`)
// 人工核对清单：改「人工校正」列后跑 review-segments.mjs --apply 回灌
const reviewFile = new URL(`${slug}-review.csv`, outDir)
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
const reviewLines = ['名称,类目,自动分段,人工校正,人均,评分']
for (const p of poisFinal) {
  reviewLines.push([
    csvCell(p.name),
    csvCell(p.category),
    csvCell(p.segment),
    csvCell(overrides[p.name] ?? ''),
    p.cost > 0 ? p.cost : '',
    p.rating > 0 ? p.rating : '',
  ].join(','))
}
// Excel 在中文 Windows 默认按 GBK 打开无 BOM 的 CSV = 全乱码
// 加 UTF-8 BOM 后双击即可正常显示
writeFileSync(reviewFile, '\ufeff' + `${reviewLines.join('\n')}\n`, 'utf8')
console.log(`[人工核对清单] ${decodeURIComponent(reviewFile.pathname)}（${poisFinal.length} 行）`)
console.log('核对：node .\\tools\\review-segments.mjs --in=' + decodeURIComponent(reviewFile.pathname).replace(/^\/([A-Za-z]:)/, '$1'))
console.log('出图：node .\\tools\\render-map.mjs （自动取最新的 out/*.json）')

console.log(`\n=== 4. API 消耗 ===`)
console.log(`接口调用 ${apiCalls} 次｜缓存命中 ${cacheHits} 次${cacheEnabled ? '' : '（--fresh：已强制回源）'}`)
// 把真实调用数并进统一账本，否则 quota.json 只反映 demand-fetch 的消耗，
// 看不出 run-site 花了多少（2026-11-08 加）
if (apiCalls > 0) {
  try {
    const qf = new URL('../survey/demand/.quota.json', import.meta.url)
    const today = new Date().toISOString().slice(0, 10)
    let q = { date: today, calls: 0 }
    try { q = JSON.parse(readFileSync(qf, 'utf8')) } catch { /* 首次 */ }
    if (q.date !== today) q = { date: today, calls: 0 }
    q.calls += apiCalls
    writeFileSync(qf, JSON.stringify(q), 'utf8')
    console.log(`账本已记：今日累计 ${q.calls} 次`)
  } catch { /* 记账失败不影响主流程 */ }
}
console.log('零消耗（纯本地）：poi_dedupe / geo_analyze / crs_guard')

console.log('\n=== 5. 报告可用字段 ===')
console.log(JSON.stringify({
  scene: sceneKey,
  center,
  amap_count: amapTotal,
  amap_fetched: amapPois.length,
  amap_coverage_pct: Number(amapCoverage.toFixed(1)),
  tencent_count: tTotal,
  tencent_fetched: tencentPois.length,
  tencent_coverage_pct: Number(tencentCoverage.toFixed(1)),
  tencent_ok: tencentOk,
  source_mode: DUAL_SOURCE ? 'dual' : 'single',
  raw: dedupe.raw,
  effective: dedupe.effective,
  dropped: dedupe.dropped.length,
  merged: dedupe.merged.length,
  brands: dedupe.brand_groups.map((b) => `${b.brand}x${b.count}`),
  nearest: `${dedupe.nearest.name}@${dedupe.nearest.distance_m}m`,
  rings: ringResults.map((r) => ({
    label: r.label,
    radius_m: r.radius,
    area_km2: r.area_km2,
    inside: r.inside,
    nearest: r.nearest,
    share_top: r.top.map((v) => `${v.name}=${v.share_pct}%`),
  })),
  primary_ring: primary.label,
  isochrone_radius: primary.radius,
  inside_count: primary.inside,
  share_top: primary.top.map((v) => `${v.name}=${v.share_pct}%`),
}, null, 2))
