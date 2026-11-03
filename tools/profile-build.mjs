/**
 * profile-build.mjs —— 业态档案建档器（客户第一步）
 *
 * 交互建档：
 *   node .\tools\profile-build.mjs --ask
 * 命令行建档：
 *   node .\tools\profile-build.mjs --name="早餐·肠粉" --archetype=breakfast --subtype="肠粉|布拉肠" --area=40
 * 校验已有档案：
 *   node .\tools\profile-build.mjs --check=breakfast
 * 从现成档案复制一份新的（推荐，避免手写漏字段）：
 *   node .\tools\profile-build.mjs --scaffold=large-yuecai
 *
 * 产出：profiles\<slug>.json，并打印每条参数"为什么这么定"的建议。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

const PROFILES_URL = new URL('../profiles/', import.meta.url)
const toPath = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')

/** 业态起点库：只作为"建议默认值"，客户情况不同必须改 */
const ARCHETYPES = {
  breakfast: {
    label: '早餐（30–60㎡）',
    category_pattern: '早餐|包子|馒头|粥|豆浆|面点|油条',
    exclude_pattern: '便利店|超市|酒楼|宴会|火锅',
    rings: [
      { label: '内圈·步行3分', mode: 'walk', minutes: 3, max_m: 300 },
      { label: '外圈·步行8分', mode: 'walk', minutes: 8, max_m: 800 },
    ],
    scan_radius: 800,
    transit: { metro_threshold_m: 400, parking_threshold_m: 80 },
    why: '早餐是"路过型"消费，客人不会为吃早饭专门走路超过 8 分钟，停车位几乎无意义。',
  },
  tea: {
    label: '茶饮（20–60㎡）',
    category_pattern: '冷饮|甜品|咖啡|茶饮|饮品',
    exclude_pattern: '便利店|超市|酒楼',
    rings: [
      { label: '内圈·步行3分', mode: 'walk', minutes: 3, max_m: 300 },
      { label: '外圈·步行8分', mode: 'walk', minutes: 8, max_m: 800 },
    ],
    scan_radius: 800,
    transit: { metro_threshold_m: 500, parking_threshold_m: 100 },
    why: '茶饮靠"顺路 + 外卖"，步行 8 分钟内是核心；地铁口比停车位更重要。',
  },
  quick: {
    label: '快餐·简餐（60–150㎡）',
    category_pattern: '中餐厅|快餐厅|小吃',
    exclude_pattern: '酒楼|宴会|超市',
    rings: [
      { label: '内圈·步行5分', mode: 'walk', minutes: 5, max_m: 500 },
      { label: '外圈·步行12分', mode: 'walk', minutes: 12, max_m: 1200 },
    ],
    scan_radius: 1200,
    transit: { metro_threshold_m: 600, parking_threshold_m: 150 },
    why: '工作餐场景，客人能接受走 10 分钟左右；停车可有可无。',
  },
  dinner: {
    label: '中型正餐（80–200㎡）',
    category_pattern: '中餐厅|餐厅|快餐厅',
    exclude_pattern: '快餐|小吃|外卖',
    rings: [
      { label: '内圈·步行8分', mode: 'walk', minutes: 8, max_m: 800 },
      { label: '外圈·车行5分', mode: 'car', minutes: 5, max_m: 1500 },
    ],
    scan_radius: 1500,
    transit: { metro_threshold_m: 700, parking_threshold_m: 200 },
    why: '家庭/朋友聚餐，步行 8 分钟 + 短途打车都算合理；开始需要停车。',
  },
  large: {
    label: '大型正餐（1000–2000㎡）',
    category_pattern: '中餐厅|粤菜|海鲜|宴会|酒楼|火锅',
    exclude_pattern: '快餐|小吃',
    rings: [
      { label: '内圈·步行10分', mode: 'walk', minutes: 10, max_m: 1000 },
      { label: '外圈·车行5分', mode: 'car', minutes: 5, max_m: 1500 },
    ],
    scan_radius: 3000,
    transit: { metro_threshold_m: 800, parking_threshold_m: 300 },
    why: '宴请型消费，客人开车来、必须好停车；车行 5 分钟已是商圈极限，再远就是别的商圈。',
  },
  retail: {
    label: '便利店（40–120㎡）',
    category_pattern: '便利店',
    exclude_pattern: '超市|百货|2元|折扣',
    rings: [
      { label: '内圈·步行5分', mode: 'walk', minutes: 5, max_m: 500 },
      { label: '外圈·步行10分', mode: 'walk', minutes: 10, max_m: 1000 },
    ],
    scan_radius: 800,
    transit: { metro_threshold_m: 500, parking_threshold_m: 0 },
    why: '即时消费，步行 5 分钟是命门；停车基本不影响。',
  },
}

const slugify = (s) => s.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client'

/**
 * 脚手架：把一份现成档案复制成新档案，只留几处必改项。
 * 目的：手写 JSON 最容易漏 category_pattern / rings / segments 这些必填项，
 * 直接抄一份完整结构比对着字段表写可靠得多。
 */
function scaffold(from) {
  const listProfiles = () => {
    try {
      return readdirSync(toPath(PROFILES_URL)).filter((f) => f.endsWith('.json') && !f.includes('_template'))
    } catch {
      return []
    }
  }

  if (from === 'true' || from === '') {
    const list = listProfiles()
    console.log('从哪份档案复制？指定名称后重跑：')
    console.log('  node .\\tools\\profile-build.mjs --scaffold=<名称>')
    console.log('\n可选：')
    for (const f of list) console.log(`  ${f.replace(/\.json$/, '')}`)
    if (list.length === 0) console.log('  （profiles/ 里还没有档案）')
    return
  }

  const slug = slugify(from)
  const src = new URL(`${slug}.json`, PROFILES_URL)
  if (!existsSync(toPath(src))) {
    console.error(`找不到源档案：${toPath(src)}`)
    console.error(`可选：${listProfiles().map((f) => f.replace(/\.json$/, '')).join('、') || '（空）'}`)
    process.exit(1)
  }

  const base = JSON.parse(readFileSync(src, 'utf8'))
  const out = { ...base }
  // 必改项留下醒目占位，跑之前不改也能过校验，但报告里会显示出来
  out.name = `${base.name}（新建）`
  out.note = `由 ${slug}.json 复制而来；改完 name / category_pattern / rings / scan_radius 再用`
  out.scan_radius = base.scan_radius

  const to = new URL(`新建-${slug}.json`, PROFILES_URL)
  writeFileSync(to, `${JSON.stringify(out, null, 2)}\n`, 'utf8')

  console.log(`\n✅ 已生成脚手架：${toPath(to)}`)
  console.log('\n必改这四项：')
  console.log('  name             档案名称（会写进报告抬头）')
  console.log('  category_pattern 大类白名单（正例正则）')
  console.log('  rings            圈层（数组，至少一条，mode 只能 walk/bike/car）')
  console.log('  scan_radius      POI 采集半径（米）')
  console.log('\n然后是自带的其他字段：')
  for (const k of Object.keys(base)) {
    if (['name', 'note', 'category_pattern', 'rings', 'scan_radius'].includes(k)) continue
    const v = base[k]
    const brief = Array.isArray(v) ? `数组 ${v.length} 项` : typeof v === 'object' && v !== null ? '对象' : String(v)
    console.log(`  ${k.padEnd(24)} ${brief}`)
  }
  console.log(`\n改完校验：node .\\tools\\profile-build.mjs --check=新建-${slug}`)
}

function parseArgs() {
  const m = new Map()
  for (const raw of process.argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (match) m.set(match[1], match[2] ?? 'true')
  }
  return m
}

function validate(profile, sourceName) {
  const errors = []
  const warns = []
  if (!profile.name) {
    errors.push('缺少 name（档案名称）—— 参考 profiles/large-yuecai.json 的 "name" 字段')
  }

  // category_pattern 缺失降级为「警告」而非「错误」：
  // SKILL-FULL.md 0.6.2 明确要求「不确定类目长什么样时，先留空跑一次，
  // 从 kept/dropped 里读出平台真实类目串，再定正则」。
  // 若这里当错误处理，那条官方做法根本走不通。
  if (!profile.category_pattern) {
    warns.push(
      '未设 category_pattern（大类白名单）：本次不做类目过滤，effective 会虚高。'
      + '跑完后从 kept / dropped 里读出平台真实类目串，再定这条正则（见 SKILL-FULL.md 0.6.2）',
    )
  }
  if (!profile.subtype_pattern && !(Array.isArray(profile.segments) && profile.segments.length > 0)) {
    warns.push('缺少 segments（竞争分段）：竞品与协同无法区分，竞品数会高估——参考 profiles/large-yuecai.json 的 "segments"')
  }
  if (Array.isArray(profile.segments) && profile.segments.length > 0 && !profile.self_segment) {
    warns.push('缺少 self_segment：无法确定"客户所在段"，直接竞品数会算成 0——填 segments 里属于客户的那个 key')
  }
  if (Array.isArray(profile.segments)) {
    for (const [i, seg] of profile.segments.entries()) {
      if (!seg.key) errors.push(`segments[${i}] 缺少 key`)
      if (!seg.match) errors.push(`segments[${i}] 缺少 match`)
      else { try { new RegExp(seg.match) } catch { errors.push(`segments[${i}].match 不是合法正则：${seg.match}`) } }
    }
  }
  if (!Array.isArray(profile.rings) || profile.rings.length === 0) {
    errors.push(
      '缺少 rings（圈层）—— 至少一条，形如 '
      + '{"label":"内圈·步行10分","mode":"walk","minutes":10,"max_m":1000}；'
      + 'mode 只能 walk/bike/car。可参考 profiles/large-yuecai.json',
    )
  }
  for (const key of ['category_pattern', 'exclude_pattern', 'subtype_pattern']) {
    const v = profile[key]
    if (typeof v === 'string' && v !== '') {
      try { new RegExp(v) } catch { errors.push(`${key} 不是合法正则：${v}`) }
    }
  }
  for (const [i, ring] of (profile.rings ?? []).entries()) {
    if (!['walk', 'bike', 'car'].includes(ring.mode)) errors.push(`rings[${i}].mode 必须是 walk/bike/car`)
    if (!(ring.minutes > 0)) errors.push(`rings[${i}].minutes 必须 > 0`)
    if (!(ring.max_m > 0)) warns.push(`rings[${i}].max_m 缺失：不会做商圈锁，等时圈可能跨商圈`)
  }
  if (!(profile.scan_radius > 0)) warns.push('scan_radius 缺失，默认按最大圈层半径采集')
  if (!profile.hardware || profile.hardware.area_sqm === undefined) {
    warns.push('缺少 hardware.area_sqm：无法判断消防流程复杂度（≥300㎡ 触发二次消防备案）')
  }
  if (!profile.hardware || profile.hardware.needs_exhaust === undefined) {
    warns.push('缺少 hardware.needs_exhaust：无法判断排烟是否为硬性前置条件')
  }
  if (!profile.transit || !(profile.transit.metro_threshold_m >= 0)) warns.push('transit.metro_threshold_m 缺失，默认 800m')
  if (!Array.isArray(profile.keywords) || profile.keywords.length === 0) warns.push('keywords 为空：只能单关键词检索，覆盖率可能不足')

  console.log(`\n=== 校验：${sourceName} ===`)
  if (errors.length === 0 && warns.length === 0) console.log('✅ 通过，可以直接用于分析')
  for (const e of errors) console.log(`❌ ${e}`)
  for (const w of warns) console.log(`⚠️ ${w}`)
  if (errors.length > 0) {
    console.log('\n修法（三选一）：')
    console.log('  1. 从现成档案复制：node .\\tools\\profile-build.mjs --scaffold=large-yuecai')
    console.log('  2. 命令行建档：      node .\\tools\\profile-build.mjs --name="..." --archetype=large-dining')
    console.log('  3. 照文档逐个字段填： docs\\SKILL-FULL.md 第 0.13 节「业态档案」')
  }
  return errors.length === 0
}

/**
 * 硬件条件问卷（工程侧）。
 * 目的：把「这个铺能不能做」的排除项在**建档阶段**就问清，避免跑到现场才发现电力不够。
 * 注意：这里问的是**客户的经营需求**，不是某个具体铺位的实测值；
 *      实测值走调研表（survey.csv）喂给 veto_check。
 */
const HARDWARE_QUESTIONS = [
  { key: 'area_sqm', ask: '⑥ 目标面积㎡（≥300㎡ 通常需二次消防备案；≥1000㎡ 多需消防设计审查）' },
  { key: 'needs_exhaust', ask: '⑦ 是否需要排烟（y/n）' },
  { key: 'power_kw', ask: '⑧ 需要电力多少 kW（按有管道燃气估算；无燃气会额外 +100kW）' },
  { key: 'needs_gas', ask: '⑨ 是否需要天然气（y/n）' },
  { key: 'needs_drainage', ask: '⑩ 是否需要排污 / 隔油池（y/n）' },
  { key: 'ceiling_m', ask: '⑪ 层高要求 m（扣天花板后净高，可空）' },
  { key: 'other', ask: '⑫ 其他硬性条件（门宽 / 承重 / 外立面 / 停车，可空）' },
]

/** y/yes/1/是/需要 → true；n/no/0/否/不需要 → false；空 → undefined（视为未问）。 */
const toBool = (raw) => {
  const t = String(raw ?? '').trim().toLowerCase()
  if (['', 'skip', '-'].includes(t)) return undefined
  if (['y', 'yes', '1', '是', '需要', 'true'].includes(t)) return true
  if (['n', 'no', '0', '否', '不需要', 'false'].includes(t)) return false
  return undefined
}

/** 无管道燃气时，厨房全电带来的额外功率需求（经验值，可在档案里改）。 */
const POWER_EXTRA_WITHOUT_GAS = 100

/** 面积触发的消防门槛（经验阈值，非法规原文；用于提醒而非判定）。 */
const FIRE_AREAS = { secondary_approval: 300, design_review: 1000 }

function buildHardware(raw) {
  const area = Number(raw.area_sqm) || undefined
  const power = Number(raw.power_kw) || undefined
  const gas = toBool(raw.needs_gas)
  const exhausted = toBool(raw.needs_exhaust)
  const drainage = toBool(raw.needs_drainage)
  const ceiling = Number(raw.ceiling_m) || undefined
  const other = (raw.other ?? '').trim()

  return {
    area_sqm: area,
    needs_exhaust: exhausted,
    power_kw: power,
    needs_gas: gas,
    needs_drainage: drainage,
    ceiling_m: ceiling,
    other: other === '' ? undefined : other,
    derived: {
      // 若目标铺位没有管道燃气，电力需求要按全电重新估
      power_kw_if_no_gas: power === undefined ? undefined : power + POWER_EXTRA_WITHOUT_GAS,
      // 面积决定消防流程的复杂度：这是「要跑几道手续」，不是「能不能开」
      needs_secondary_fire_approval: area === undefined ? undefined : area >= FIRE_AREAS.secondary_approval,
      needs_fire_design_review: area === undefined ? undefined : area >= FIRE_AREAS.design_review,
    },
  }
}

/** 生成现场核查清单：把硬件需求翻译成开发要带去现场逐条确认的字段。 */
function hardwareChecklist(hardware) {
  if (hardware === undefined) return []
  const d = hardware.derived ?? {}
  const items = []
  items.push(`面积：目标 ${hardware.area_sqm ?? '未填'}㎡｜实测需 ≥ 该值`
    + (d.needs_fire_design_review ? '（触发消防设计审查）' : d.needs_secondary_fire_approval ? '（触发二次消防备案）' : ''))
  if (hardware.needs_exhaust) items.push('排烟：确认能否接市政管网 / 是否需独立烟道（费用归属可谈）')
  if (hardware.power_kw !== undefined) {
    items.push(`电力：基准 ${hardware.power_kw}kW；若该铺无管道燃气则需 ${d.power_kw_if_no_gas}kW（厨房全电）`)
  }
  if (hardware.needs_gas) items.push('燃气：确认是否有管道燃气及容量（无则按全电重新核电力）')
  if (hardware.needs_drainage) items.push('排污：确认是否有隔油池 / 排污管网条件')
  if (hardware.ceiling_m !== undefined) items.push(`层高：扣天花板后净高需 ≥ ${hardware.ceiling_m}m`)
  if (hardware.other) items.push(`其他：${hardware.other}`)
  items.push('场地用途：产权证/租赁合同的用途栏是否为商业（注册与办证由承租方自行处理，不在本清单）')
  items.push('环评类别：确认该项目属「报告表」还是「登记表」（取决于规模与位置，问当地生态环境局，影响开业周期）')
  if (hardware.area_sqm !== undefined && hardware.area_sqm >= 300) {
    items.push('消防：面积≥300㎡ 通常需消防设计备案与竣工验收，确认疏散宽度与防火分区')
  }
  items.push('面积与布局：后厨占比、生熟分区、更衣间、库房能否满足餐饮布局')
  items.push('居民投诉风险：是否住宅楼底层 / 紧邻住宅（油烟、噪音）；向物业问历史投诉')
  items.push('产权：确认是否存在转租、抵押、纠纷')
  return items
}

async function main() {
  const args = parseArgs()

  // 脚手架模式：从现成档案复制一份，避免手写漏字段
  if (args.has('scaffold')) {
    scaffold(args.get('scaffold'))
    return
  }

  // 校验模式
  if (args.has('check')) {
    const name = args.get('check')
    const file = new URL(`${slugify(name)}.json`, PROFILES_URL)
    if (!existsSync(toPath(file))) {
      console.error(`找不到档案：${toPath(file)}`)
      process.exit(1)
    }
    const ok = validate(JSON.parse(readFileSync(file, 'utf8')), name)
    process.exit(ok ? 0 : 1)
  }

  // 交互建档
  let input = {
    name: args.get('name'),
    archetype: args.get('archetype'),
    subtype: args.get('subtype'),
    keywords: args.get('keywords'),
    area: args.get('area'),
    // 硬件条件也可用参数直传：--exhaust=y --power=150 --gas=y --drainage=y --ceiling=3.5
    hardware: {
      area_sqm: args.get('area'),
      needs_exhaust: args.get('exhaust'),
      power_kw: args.get('power'),
      needs_gas: args.get('gas'),
      needs_drainage: args.get('drainage'),
      ceiling_m: args.get('ceiling'),
      other: args.get('other'),
    },
  }
  if (args.has('ask')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('建档问卷（回车跳过）\n')
    console.log('—— 经营参数 ——')
    input.archetype = input.archetype ?? await rl.question(`① 业态（${Object.keys(ARCHETYPES).join(' / ')}）：`)
    input.name = input.name ?? await rl.question('② 客户/项目名（例：早餐·肠粉）：')
    input.subtype = input.subtype ?? await rl.question('③ 细分品类正则（例：肠粉|布拉肠）——同类才是竞品：')
    input.keywords = input.keywords ?? await rl.question('④ 检索词，逗号分隔（例：肠粉,早餐）：')
    input.area = input.area ?? await rl.question('⑤ 门店面积㎡：')
    input.hardware.area_sqm = input.area

    console.log('\n—— 工程硬件（决定这个铺「能不能做」，建档时一次问清）——')
    for (const q of HARDWARE_QUESTIONS) {
      const current = input.hardware[q.key]
      if (current !== undefined && current !== '') continue
      input.hardware[q.key] = await rl.question(`${q.ask}：`)
    }
    await rl.close()
  }

  const archetypeKey = (input.archetype ?? 'dinner').trim()
  const base = ARCHETYPES[archetypeKey]
  if (!base) {
    console.error(`未知业态：${archetypeKey}（可选：${Object.keys(ARCHETYPES).join(' / ')}）`)
    process.exit(1)
  }

  const name = (input.name ?? base.label).trim()
  const subtype = (input.subtype ?? '').trim()
  const keywords = (input.keywords ?? subtype.replace(/[|\\]/g, ',')).split(/[,，]/).map((s) => s.trim()).filter(Boolean)

  const profile = {
    name,
    archetype: archetypeKey,
    area_sqm: Number(input.area ?? 0) || undefined,
    // 平台通用类目词必须包含「餐饮」：高德对很多餐厅只给"餐饮服务;餐饮相关场所"，
    // 白名单缺「餐饮」会把真实竞品误剔（实测踩过）
    category_pattern: archetypeKey === 'retail'
      ? base.category_pattern
      : (base.category_pattern.includes('餐饮') ? base.category_pattern : `${base.category_pattern}|餐饮`),
    exclude_pattern: base.exclude_pattern,
    subtype_pattern: subtype,
    keywords: keywords.length > 0 ? keywords : [name],
    scan_radius: base.scan_radius,
    rings: base.rings,
    transit: base.transit,
    hardware: buildHardware(input.hardware),
  }
  delete profile.area_sqm

  const slug = slugify(name)
  mkdirSync(PROFILES_URL, { recursive: true })
  const file = new URL(`${slug}.json`, PROFILES_URL)
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')

  console.log(`\n✅ 已建档：${toPath(file)}`)
  console.log('\n=== 参数建议（讲给客户听）===')
  console.log(`业态起点：${base.label}`)
  console.log(`圈层：${base.rings.map((r) => `${r.label}（${r.mode} ${r.minutes} 分，锁定 ${r.max_m}m）`).join(' ＋ ')}`)
  console.log(`  理由：${base.why}`)
  console.log(`采集半径：${base.scan_radius}m（覆盖外圈 + 余量）`)
  console.log(`阈值：地铁 ${base.transit.metro_threshold_m}m / 停车 ${base.transit.parking_threshold_m}m`)
  const checklist = hardwareChecklist(profile.hardware)
  if (checklist.length > 0) {
    console.log('\n=== 现场核查清单（建完档就带着这张单子去）===')
    for (const item of checklist) console.log(`☐ ${item}`)
    console.log('→ 核实结果填进调研表（survey.csv）的 fields，字段代号：exhaust / power_kw / area_sqm / frontage_m / ceiling_m / gas_m3h / water_supply / fire_egress_m')
  } else {
    console.log('\n⚠️ 未填任何工程硬件需求：现场会缺一张核查清单，建议补 --ask 重跑')
  }
  if (subtype === '') console.log('⚠️ 未填细分品类：报告里的"竞品数"会等于全部同类目，必须补 subtype_pattern')
  console.log(`\n下一步：node .\\tools\\guangzhou-probe.mjs "<地址>" --profile=${slug}`)
  validate(profile, slug)
}

await main()
