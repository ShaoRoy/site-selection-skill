/**
 * run-site.mjs —— 一条命令跑完完整选址分析（编排层）
 *
 * 用法：
 *   node .\tools\run-site.mjs --profile=large-yuecai --address="广州市天河区珠江新城"
 *   node .\tools\run-site.mjs --profile=large-yuecai --address="..." --survey=survey\GZ-001.csv
 *   node .\tools\run-site.mjs --profile=large-yuecai --batch="地址A;地址B;地址C"
 *
 * 链路：校验档案 → 采集/去重/分段/双圈/交通 → 否决判定 → 财务测算 → 地图 → 报告
 * 产出：out\<slug>\{probe.json, survey.json, segments-review.csv, map.html, report.html, report.md, compare.html}
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildReport } from './report.mjs'

const toPath = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
const toolPath = (name) => toPath(new URL(name, import.meta.url))
const OUT = new URL('../out/', import.meta.url)
// 输出文件名要清洗：地址里出现 / 或 .. 会写到目录外
const mySlug = (s) => String(s).replace(/^(广州|深圳|上海|佛山|重庆|成都|杭州|武汉|苏州|西安|南京|长沙|天津|青岛|宁波|东莞|郑州|合肥|昆明)(市)?/, '')
// ── 环境自检：采集链依赖 DSH 插件的计算模块与本目录的等时圈模块。
// 技能包里只有渲染器，缺这些依赖——先探一次，给能照做的提示，别抛堆栈。
{
  const selfDir = dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'))
  const missing = []
  if (!existsSync(join(selfDir, '..', 'src', 'site-tools.ts'))) missing.push('src/site-tools.ts（采集计算层）')
  if (!existsSync(join(selfDir, 'isochrone.mjs'))) missing.push('tools/isochrone.mjs（等时圈）')
  if (!existsSync(join(selfDir, 'guangzhou-probe.mjs'))) missing.push('tools/guangzhou-probe.mjs（采集入口）')
  if (missing.length > 0) {
    console.error('\n❌ 当前目录只能渲染报告，不能跑采集。缺少：')
    for (const m of missing) console.error(`   · ${m}`)
    console.error('')
    console.error('   技能包内请这样用（只渲染）：')
    console.error('     node tools/report.mjs --in=<路径>/probe.json')
    console.error('   需要采集时，在完整源码工作区（含 scratch-plugin/）运行本脚本。')
    process.exit(2)
  }
}

const PROFILES = new URL('../profiles/', import.meta.url)

// 业态码 → 基准库业态名（TS 的 benchmarkCheck 只认库内正式名）
const BENCH_FORMAT_MAP = {
  large_yuecai: '高端中餐酒楼',
  tea_house: '粤式茶楼早茶',
  mid_dining: '中式正餐(川湘粤家常)',
  fast_food: '中式快餐档口(黄焖鸡/沙县)',
  tea_drink: '新式茶饮(霸王茶姬/茶百道)',
  convenience: '早餐包子铺档口(15-30㎡)',
}

const args = new Map()
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw)
  if (m) args.set(m[1], m[2] ?? 'true')
}

const slug = args.get('profile')
const singleAddress = args.get('address')
const batch = args.get('batch')
if (!slug || (!singleAddress && !batch)) {
  console.error('用法：node .\\tools\\run-site.mjs --profile=<档案> --address="<地址>" [--survey=<csv>] [--sweep] [--no-map]')
  console.error('      node .\\tools\\run-site.mjs --profile=<档案> --batch="地址A;地址B"')
  console.error('可用档案：' + readdirSync(PROFILES).filter((f) => f.endsWith('.json') && !f.endsWith('.overrides.json')).map((f) => f.replace(/\.json$/, '')).join(' / '))
  process.exit(1)
}

// --profile 直接拼进 URL，必须挡掉 ../ 之类的输入
if (!/^[\w\u4e00-\u9fa5-]+$/.test(slug)) {
  console.error(`--profile 只能包含字母/数字/中文/下划线/连字符，收到：${slug}`)
  process.exit(1)
}
const profileFile = new URL(`${slug}.json`, PROFILES)
if (!existsSync(toPath(profileFile))) {
  console.error(`找不到业态档案：${toPath(profileFile)}（先跑 node .\\tools\\profile-build.mjs --ask）`)
  process.exit(1)
}
const profile = JSON.parse(readFileSync(profileFile, 'utf8'))

// 插件工具（确定性计算）：Node 24 可直接 import .ts
let tools = null
const loadTools = async () => {
  if (tools) return tools
  tools = await import(new URL('../src/site-tools.ts', import.meta.url).href)
  return tools
}

const run = (label, file, argv) => {
  console.log(`\n──────── ${label} ────────`)
  const res = spawnSync(process.execPath, [toolPath(file), ...argv], { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`❌ ${label} 失败（exit ${res.status}），流程中止`)
    process.exit(res.status ?? 1)
  }
}

/** 用系统默认程序打开文件（不阻塞流程） */
function openWithShell(path) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', path], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [path], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [path], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

/** 在产物目录写一个双击即开的 open.cmd */
function writeOpenScript(dir) {
  const body = [
    '@echo off',
    'start "" "%~dp0report.html"',
    'if exist "%~dp0map.html" start "" "%~dp0map.html"',
    'if exist "%~dp0compare.html" start "" "%~dp0compare.html"',
    '',
  ].join('\r\n')
  writeFileSync(toPath(new URL('open.cmd', dir)), body, 'utf8')
}

/** 极简 CSV → {fields, params, meta}（与 import-survey.mjs 同契约） */
function readSurvey(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    const cells = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]
      if (quoted) {
        if (c === '"') { if (line[i + 1] === '"') { cell += '"'; i += 1 } else quoted = false } else cell += c
      } else if (c === '"') quoted = true
      else if (c === ',') {
        // Excel 复制出来的 150,000 会被切成 value=150 / source=000。
        // 判据：当前格是纯数字、下一格是三位数字 → 这是千分位，不是分隔符。
        const next3 = line.slice(i + 1, i + 4)
        if (/^\d+$/.test(cell.trim()) && /^\d{3}$/.test(next3) && !/^\d$/.test(line[i + 4] ?? '')) {
          cell += ','
        } else {
          cells.push(cell); cell = ''
        }
      } else cell += c
    }
    cells.push(cell)
    return cells
  })
  if (rows.length < 2) return null
  const head = rows[0].map((h) => h.trim())
  const alias = { 类型: 'type', type: 'type', 键: 'key', key: 'key', 值: 'value', value: 'value', 来源: 'source', source: 'source', 置信度: 'confidence', confidence: 'confidence' }
  const idx = (name) => head.findIndex((h) => (alias[h] ?? h) === name)
  const fields = {}
  const params = {}
  const meta = {}
  for (const row of rows.slice(1)) {
    const get = (n) => (idx(n) >= 0 ? String(row[idx(n)] ?? '').trim() : '')
    const type = get('type').toLowerCase()
    const key = get('key')
    if (!key) continue
    const raw = get('value')
    const source = get('source') || '未标注来源'
    const confRaw = get('confidence').toLowerCase()
    const confidence = confRaw === '' ? 0.5 : (['high', 'medium', 'low'].includes(confRaw) ? confRaw : Number(confRaw))
    if (type === 'meta') { meta[key] = raw; continue }
    if (type === 'field') {
      const val = /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw)
      fields[key] = { value: val, source, confidence }
      continue
    }
    if (type === 'param') {
      // 空单元格不能当 0：Number('') === 0 且 isFinite(0) === true，
      // 会把「留空」静默变成「营业额 0」，整份报告变全亏。
      const cleaned = raw.replace(/[,，\s]/g, '')
      if (cleaned === '') continue
      const n = Number(cleaned)
      if (Number.isFinite(n)) params[key] = { value: n, source, confidence }
    }
  }
  return { fields, params, meta }
}

async function runOne(address, surveyPath) {
  const probeArgs = [address, `--profile=${slug}`]
  if (args.has('sweep')) probeArgs.push('--sweep')
  run(`② 采集与分析（${address}）`, 'guangzhou-probe.mjs', probeArgs)

  const jsons = readdirSync(OUT)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: statSync(new URL(f, OUT)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (jsons.length === 0) {
    console.error('❌ 没找到 probe 输出')
    process.exit(1)
  }
  const latest = jsons[0].f
  // 输出目录必须带点位标识，否则同一业态换个地址就会覆盖上一份报告
  const addrSlug = String(address)
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '')
    .replace(/^(广州|深圳|上海|佛山|重庆|成都|杭州|武汉|苏州|西安|南京|长沙|天津|青岛|宁波|东莞|郑州|合肥|昆明)(市)?/, '')
    .replace(/^(天河区|海珠区|荔湾区|越秀区|白云区|番禺区|黄埔区|南沙区|花都区|增城区|从化区)/, '')
    .slice(0, 14) || 'point'
  const dir = new URL(`${slug}-${addrSlug}/`, OUT)
  mkdirSync(dir, { recursive: true })
  const probeCopy = new URL('probe.json', dir)
  copyFileSync(toPath(new URL(latest, OUT)), toPath(probeCopy))
  const reviewSrc = new URL(latest.replace(/\.json$/, '-review.csv'), OUT)
  if (existsSync(toPath(reviewSrc))) copyFileSync(toPath(reviewSrc), toPath(new URL('segments-review.csv', dir)))
  console.log(`\n📁 归档：${toPath(dir)}`)

  const data = JSON.parse(readFileSync(toPath(probeCopy), 'utf8'))

  // 需求侧代理：即使没有调研表也要加载——按地址在 survey/demand/ 里找匹配的那份
  // 找不到就**当场自动采一次**（高德免费额度 5000 次/日，单点约 21 次），
  // 不再把「POI 代理未计算」留给用户自己补
  try {
    const _demandDirPre = new URL('../survey/demand/', import.meta.url)
    const _normPre = (v) => String(v).replace(/[（(].*?[)）]/g, '').replace(/\s/g, '')
    const _mine = _normPre(address)
    const _hasDemand = (() => {
      try {
        if (!existsSync(toPath(_demandDirPre))) return false
        return readdirSync(toPath(_demandDirPre))
          .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
          .some((f) => {
            try {
              const j = JSON.parse(readFileSync(toPath(new URL(f, _demandDirPre)), 'utf8').replace(/^\uFEFF/, ''))
              const a = _normPre(j.address ?? '')
              return a !== '' && (a.includes(_mine) || _mine.includes(a) || mySlug(a) === mySlug(_mine))
            } catch { return false }
          })
      } catch { return false }
    })()
    if (!_hasDemand && !args.has('no-demand')) {
      console.log('\n需求侧代理：本地无缓存 → 自动采集（约 21 次高德调用）')
      try {
        const outName = `${mySlug(address) || 'site'}.json`
        const outPath = toPath(new URL(outName, _demandDirPre))
        mkdirSync(toPath(_demandDirPre), { recursive: true })
        const r = spawnSync('python', ['tools/demand-fetch.py', address, '--radius', '3000', '--out', `survey/demand/${outName}`], {
          cwd: toPath(new URL('..', import.meta.url)), encoding: 'utf8', shell: true,
        })
        const tail = String(r.stdout ?? '').trim().split('\n').slice(-6).join('\n')
        if (existsSync(outPath)) console.log(`需求侧代理：采集完成 → ${outName}`)
        else console.warn(`⚠️ 需求侧采集未产出文件：${tail}`)
      } catch (error) {
        console.warn(`⚠️ 需求侧自动采集失败：${error.message}（可加 --no-demand 跳过）`)
      }
    }
  } catch { /* 后续统一按无数据处理 */ }
  try {
    const demandDir = new URL('../survey/demand/', import.meta.url)
    if (existsSync(toPath(demandDir))) {
      const norm = (s) => String(s).replace(/[（(].*?[)）]/g, '').replace(/\s/g, '')
      const mine = norm(address)
      const hit = readdirSync(toPath(demandDir))
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map((f) => ({ f, j: JSON.parse(readFileSync(toPath(new URL(f, demandDir)), 'utf8').replace(/^\uFEFF/, '')) }))
        .find(({ j }) => {
          const a = norm(j.address ?? '')
          return a !== '' && (a.includes(mine) || mine.includes(a) || mySlug(a) === mySlug(mine))
        })
      if (hit) {
        data.demand = hit.j
        console.log(`需求侧代理：已匹配 ${hit.f}（需求强度 ${hit.j.demand_score?.score ?? '—'}）`)
      }
    }
  } catch (error) {
    console.warn(`⚠️ 需求侧数据加载失败：${error.message}`)
  }

  // 人口核对：WorldPop 栅格 × POI 代理双源对照（可选，缺环时跳过但必须留痕）
  try {
    const CITY_CODE = {
      北京: 'bj', 上海: 'sh', 广州: 'gz', 深圳: 'sz', 佛山: 'fs', 东莞: 'dg',
      重庆: 'cq', 成都: 'cd', 杭州: 'hz', 武汉: 'wh', 苏州: 'su', 西安: 'xa',
      南京: 'nj', 长沙: 'cs', 天津: 'tj', 青岛: 'qd', 济南: 'jn', 宁波: 'nb',
      郑州: 'zz', 合肥: 'hf', 昆明: 'km',
    }
    const hitCity = Object.keys(CITY_CODE).find((c) => String(address).includes(c))
    const tifDir = toPath(new URL('../../data/worldpop/', import.meta.url))
    const tif = hitCity ? `${tifDir}${CITY_CODE[hitCity]}_pop_2020_100m.tif` : null
    const qgisPy = 'D:\\QGIS 3.44.8\\bin\\python-qgis-ltr.bat'
    const sampler = toPath(new URL('./worldpop-sample.py', import.meta.url))
    const skip = (reason, fix) => {
      data.population_skip = { reason, fix }
      console.warn(`⚠️ 人口核对未执行：${reason}`)
      console.warn(`   补齐：${fix}`)
    }

    if (!hitCity) {
      skip(
        '地址里没有识别到已支持的城市名',
        '在 tools/run-site.mjs 的 CITY_CODE 里加城市映射，并用 scripts/worldpop-clip.py --bbox 裁出该城市栅格',
      )
    } else if (!existsSync(tif)) {
      skip(
        `${hitCity} 的人口栅格还没裁`,
        `scripts/worldpop-clip.py --src <WorldPop全国tif> --city ${hitCity}`,
      )
    } else if (!existsSync(qgisPy)) {
      skip(
        '没检测到 QGIS（读取栅格需要它的 GDAL）',
        '装 QGIS 后把 run-site.mjs 里的 qgisPy 指向 python-qgis-ltr.bat；不装则本次不含人口核对',
      )
    } else {
      const intensity = data.demand?.demand_score?.score
      const _c = data.center ?? {}
      const _lat = Number(_c.lat ?? 0)
      const _lng = Number(_c.lng ?? 0)
      const args = [`"${sampler}"`, '--tif', `"${tif}"`, '--center', `${_lat},${_lng}`]
      if (typeof intensity === 'number') args.push('--proxy-intensity', String(intensity))
      const r = spawnSync(`"${qgisPy}"`, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, shell: true })
      if (r.status === 0 && r.stdout) {
        const i = r.stdout.indexOf('{')
        data.population = JSON.parse(r.stdout.slice(i))
        const c = data.population.cross_check
        console.log(`人口核对：1km 密度 ${data.population.rings?.['1000']?.density_per_km2 ?? '—'} 人/km²` +
          (c ? `｜判定 ${c.verdict}` : ''))
      } else {
        const err = String(r.stderr || r.error?.message || '').slice(0, 200)
        skip('采样进程报错', `检查 QGIS Python 与栅格路径；错误信息：${err}`)
      }
    }
  } catch (error) {
    data.population_skip = { reason: '人口核对抛异常', fix: String(error.message) }
    console.warn(`⚠️ 人口核对未执行：${error.message}`)
  }

  // 否决判定 + 财务测算（需要调研表）
  if (surveyPath && existsSync(surveyPath)) {
    const survey = readSurvey(surveyPath)
    if (survey) {
      const storeId = survey.meta.store_id ?? 'S-0001'
      const formatCode = survey.meta.format_code ?? profile.archetype ?? 'store'
      // 点位截流力是场地属性，不依赖财务参数也要能进报告
      const rawLv = survey.meta.catchment_level ?? survey.fields?.catchment_level?.value
      const lv = typeof rawLv === 'string' ? rawLv.trim().toUpperCase() : ''
      if (['L1', 'L2', 'L3', 'L4', 'L5'].includes(lv)) {
        data.catchment = { code: lv, source: '现场判定' }
        console.log(`点位截流力：${lv}（现场判定）`)
      }
      // 需求侧代理指标已在前面按地址自动匹配，这里不再重复加载（避免覆盖与重复日志）
      const mod = await loadTools()
      console.log('\n──────── ③ 否决判定 + 财务测算 ────────')
      try {
        if (Object.keys(survey.fields).length > 0) {
          // veto 规则读 fields，但租金常录在 params（财务口径）—— 用 params 兜底，
          // 否则会误报「缺失 rent」，而报告里租金明明已经给了
          const fieldsForVeto = { ...survey.fields }
          if (fieldsForVeto.rent === undefined) {
            const rentM = Number(survey.params?.monthly_rent?.value)
            const revM = Number(survey.params?.daily_revenue?.value) * 30
            if (Number.isFinite(rentM) && Number.isFinite(revM) && revM > 0) {
              // fields 的值必须是 {value, source, confidence}，不能塞裸数字
              fieldsForVeto.rent = {
                value: rentM / revM,
                source: '由 params 月租金 ÷（日营业额×30）推算',
                confidence: 0.6,
              }
            }
          }
          data.veto = await mod.vetoCheckTool.execute({
            store_id: storeId,
            format_code: formatCode,
            fields: fieldsForVeto,
            ...(Array.isArray(profile.veto_rules) ? { rules: profile.veto_rules } : {}),
          })
          console.log(
            `硬伤 ${data.veto.hard_reasons.length} 项（提醒，不中断）`
            + `｜重大风险 ${data.veto.major_risks.length} 项`
            + `｜待核实字段 ${data.veto.missing_fields.length} 项`,
          )
        }
        // 动线阻断实测（walk-matrix.py 生成或现场口述后整理）
        const barrierFile = new URL(`../survey/barriers/${storeId}.csv`, import.meta.url)
        if (existsSync(toPath(barrierFile))) {
          try {
            const raw = readFileSync(toPath(barrierFile), 'utf8').replace(/^\uFEFF/, '')
            const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
            const head = lines[0].split(',').map((h) => h.trim())
            data.barriers = lines.slice(1).map((line) => {
              // 目标名里可能带逗号（如「A,B出口」），用引号包裹时简单处理
              const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').trim()).slice(0, head.length) ?? []
              const row = {}
              head.forEach((k, i) => { row[k] = cells[i] ?? '' })
              return row
            })
            const blocked = data.barriers.filter((b) => (b.barrier_type ?? '') !== '')
            console.log(`动线阻断：实测 ${data.barriers.length} 条，其中 ${blocked.length} 条有阻断`)
          } catch (error) {
            console.warn(`⚠️ 动线阻断数据解析失败：${error.message}（已忽略）`)
          }
        }
        if (Object.keys(survey.params).length > 0) {
          // 单店级参数：按候选顺序找，第一个存在的即用。
          //  ① 包内布局  <pkg>/tools/  →  ../params/
          //  ② dev 布局  scratch-plugin/tools/  →  ../../.dsh/skills/site-report/params/
          //  ③ 同目录    tools/ 旁的 params/
          const paramCandidates = [
            new URL(`../params/${storeId}.json`, import.meta.url),
            new URL(`../../.dsh/skills/site-report/params/${storeId}.json`, import.meta.url),
            new URL(`../.dsh/skills/site-report/params/${storeId}.json`, import.meta.url),
          ]
          let overrides
          const hitParam = paramCandidates.find((u) => existsSync(toPath(u)))
          if (hitParam) {
            try {
              overrides = JSON.parse(readFileSync(toPath(hitParam), 'utf8'))
              console.log(`单店参数：已载入 ${toPath(hitParam).split(/[\\/]params[\\/]/).pop()}（${Object.keys(overrides).length} 个键）`)
            } catch (error) {
              console.warn(`⚠️ 单店参数解析失败：${error.message}（已忽略）`)
            }
          } else if (storeId !== '') {
            console.log(`单店参数：未找到 params/${storeId}.json（按业态默认值测算，这不是错误）`)
          }
          // 面积、客单、租期：从调研表字段里取，缺省就不传（财务会自己披露缺省项）
          const numField = (key) => {
            const raw = survey.fields?.[key]?.value ?? survey.params?.[key]?.value
            const n = Number(raw)
            return Number.isFinite(n) && n > 0 ? n : undefined
          }
          const areaVal = numField('area_sqm')
          const ticketVal = numField('avg_ticket')
          const termVal = numField('term_years')
          data.finance = await mod.financialCalcTool.execute({
            store_id: storeId,
            format_code: formatCode,
            params: survey.params,
            ...(overrides ? { overrides } : {}),
            ...(areaVal !== undefined ? { area_sqm: areaVal } : {}),
            // seats 必须能显式锁定：换业态档案时每座面积系数会变，座位数跟着变，
            // 就会污染「只改业态」的对照测试。调研表给了 seats 就以它为准。
            ...((() => {
              const seatsVal = numField('seats')
              const spaceRaw = {
                ...(ticketVal !== undefined ? { avg_ticket: ticketVal } : {}),
                ...(seatsVal !== undefined ? { seats: seatsVal } : {}),
              }
              return Object.keys(spaceRaw).length > 0 ? { space: spaceRaw } : {}
            })()),
            ...(termVal !== undefined ? { lease: { term_years: termVal } } : {}),
            // 目标回本周期按业态默认（粤菜 36 / 茶楼 27）；
            // 做「只换业态」的对照测试时，用调研表显式锁定它，避免业态差异混进锚点
            ...(() => {
              const tp = numField('target_payback_months')
              return tp !== undefined ? { target_payback_months: tp } : {}
            })(),
            // 点位截流力：现场判定后填在调研表里（L1–L5），决定客流乘数
            ...(() => {
              const raw = survey.meta.catchment_level ?? survey.fields?.catchment_level?.value
              const lv = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
              return ['L1', 'L2', 'L3', 'L4', 'L5'].includes(lv) ? { catchment_level: lv } : {}
            })(),
          })
          const base = data.finance?.per_scenario?.base
          console.log(
            `基准情景：现金净流 ${base?.monthly_cash_flow ?? '—'} 元｜会计净利 ${base?.net_profit ?? '—'} 元`
            + `｜回本 现金 ${base?.payback_static_months > 0 ? `${base.payback_static_months} 月` : '无法回本'}`
            + ` / 会计 ${base?.accounting_payback_months > 0 ? `${base.accounting_payback_months} 月` : '无法回本'}`
            + `｜年ROI ${base ? (base.roi * 100).toFixed(1) : '—'}%`,
          )

          // 行业基准对标：城市 + 业态能从地址/档案里认出来就跑
          const KNOWN_CITIES = ['上海', '广州', '深圳', '佛山', '重庆', '成都', '杭州', '武汉', '苏州', '西安', '南京', '长沙', '天津', '青岛', '宁波', '东莞', '郑州', '合肥', '昆明']
          const city = survey.meta.city ?? KNOWN_CITIES.find((c) => String(data.address ?? '').includes(c)) ?? ''
          const formatLabel = survey.meta.format_name ?? profile.name ?? formatCode
          if (city !== '' && base) {
            try {
              const pv = (k) => Number(survey.params?.[k]?.value ?? NaN)
              data.benchmark = await mod.benchmarkCheckTool.execute({
                city,
                format: BENCH_FORMAT_MAP[formatCode] ?? formatCode,
                ...(Number.isFinite(pv('initial_investment')) ? { initial_investment_wan: pv('initial_investment') / 10000 } : {}),
                ...(Number.isFinite(pv('monthly_rent')) ? { monthly_rent_wan: pv('monthly_rent') / 10000 } : {}),
                ...(Number.isFinite(pv('daily_revenue')) ? { daily_revenue_wan: (pv('daily_revenue') * 30) / 10000 } : {}),
                ...(Number.isFinite(Number(survey.fields?.area_sqm?.value)) ? { area_sqm: Number(survey.fields.area_sqm.value) } : {}),
                ...(Number.isFinite(Number(survey.space?.avg_ticket)) ? { avg_ticket: Number(survey.space.avg_ticket) } : {}),
                ...(base.accounting_payback_months > 0 ? { accounting_payback_months: base.accounting_payback_months } : {}),
                ...(base.revenue > 0 ? { net_margin: base.net_profit / base.revenue } : {}),
              })
              console.log(`行业基准：${data.benchmark.matched ? `${data.benchmark.matched_format}｜${data.benchmark.note}` : data.benchmark.note}`)
            } catch (error) {
              console.warn(`⚠️ 行业基准对标失败：${error.message}`)
            }
          }
        }
        writeFileSync(toPath(new URL('survey.json', dir)), JSON.stringify({ ...survey, veto: data.veto ?? null, finance: data.finance ?? null }, null, 2), 'utf8')
      } catch (error) {
        console.warn(`⚠️ 否决/财务计算失败：${error.message}`)
      }
    }
  } else if (surveyPath) {
    console.warn(`⚠️ 调研表不存在：${surveyPath}（本报告不含否决与财务段）`)
  }

  if (!args.has('no-map')) {
    run('④ 生成交互地图', 'render-map.mjs', [toPath(probeCopy), '--show-outer'])
    const mapFile = new URL('probe-map.html', dir)
    if (existsSync(toPath(mapFile))) {
      renameSync(toPath(mapFile), toPath(new URL('map.html', dir)))
      data._hasMap = true
    } else {
      console.warn('⚠️ 未找到地图输出')
      data._hasMap = false
    }
    // 静态地图：瓦片 base64 内嵌，打印 / 存 PDF 时保留
    try {
      const svgPath = toPath(new URL('map-static.svg', dir))
      run('④b 生成静态地图', 'render-static-map.mjs',
        [`--probe=${toPath(probeCopy)}`, '--zoom=auto', `--out=${svgPath}`])
      if (existsSync(svgPath)) {
        const svg = readFileSync(svgPath, 'utf8').replace(/^\uFEFF/, '')
        const tiles = (svg.match(/data:image\/png;base64/g) ?? []).length
        if (tiles === 0) {
          // 没有瓦片就别塞空图，改提示怎么补
          const c = data.center ?? {}
          data._mapTilesMissing = {
            reason: '本地瓦片缓存里没有该点位的底图',
            fix: `node tools/tile-cache.mjs --center=${Number(c.lat ?? 0)},${Number(c.lng ?? 0)} --radius=2000 --zoom=13-17`,
          }
          console.warn('⚠️ 静态地图未内嵌：瓦片缺失')
          console.warn(`   补齐：${data._mapTilesMissing.fix}`)
        } else {
          data._staticMapSvg = svg
          console.log(`静态地图：已内嵌 ${Math.round(svg.length / 1024)} KB（${tiles} 张瓦片）`)
        }
      }
    } catch (error) {
      console.warn(`⚠️ 静态地图未生成（不影响主流程）：${error.message}`)
    }
  } else {
    data._hasMap = false
  }

  console.log('\n──────── ⑤ 生成报告 ────────')
  const { markdown, html } = buildReport(data, profile)
  writeFileSync(toPath(new URL('report.md', dir)), markdown, 'utf8')
  writeFileSync(toPath(new URL('report.html', dir)), html, 'utf8')
  writeFileSync(toPath(probeCopy), JSON.stringify(data, null, 2), 'utf8')
  writeOpenScript(dir)

  // ── 留痕：status.json + registry + index.md
  // 目的：跑过就留下痕迹，下次不用重跑，也不会忘记哪个点位做到哪一步
  try {
    const center = data.center ?? {}
    const folderName = decodeURIComponent(dir.pathname).split('/').filter(Boolean).pop() ?? ''
    const cityHit = ['上海', '广州', '深圳', '佛山', '重庆', '成都', '杭州', '武汉', '苏州', '西安',
      '南京', '长沙', '天津', '青岛', '宁波', '东莞', '郑州', '合肥', '昆明']
      .find((c) => String(address).includes(c)) ?? ''
    const status = {
      schema: 1,
      store_id: data.store_id ?? folderName,
      address,
      city: cityHit,
      district: '',
      center: { lat: Number(center.lat ?? 0), lng: Number(center.lng ?? 0) },
      // 与 grid-registry.py 保持同一公式（0.005° 网格）
      grid_id: center.lat !== undefined
        ? `G${Math.floor((Number(center.lat) + 90) / 0.005)}_${Math.floor((Number(center.lng) + 180) / 0.005)}`
        : '',
      status: Array.isArray(data.barriers) && data.barriers.length > 0 ? '已现场' : '已评估',
      updated_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      report: `out/${folderName}/report.md`,
      conclusion: conclusionLine(data),
    }
    const statusPath = toPath(new URL('status.json', dir))
    writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8')

    // 回写 registry（Python 单写者，避免并发冲突）
    const reg = spawnSync('python', [toolPath('grid-registry.py'), '--status-file', statusPath], {
      encoding: 'utf8', timeout: 30000,
    })
    if (reg.status === 0) console.log(`留痕：${(reg.stdout ?? '').trim()}`)
    else if (reg.status !== null) console.warn(`⚠️ registry 回写失败：${(reg.stderr ?? '').trim()}`)

    // 刷新看板
    const dash = spawnSync(process.execPath, [toolPath('index-dashboard.mjs')], { encoding: 'utf8', timeout: 30000 })
    if (dash.status === 0) console.log(`留痕：${(dash.stdout ?? '').trim()}`)

    // 历史留存：每次重跑都存一份快照，永不覆盖历史（只保留最近 20 份）
    try {
      const histRoot = new URL('history/', dir)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      const snap = new URL(`${stamp}/`, histRoot)
      mkdirSync(snap, { recursive: true })
      for (const f of ['report.md', 'report.html', 'probe.json', 'survey.json', 'status.json']) {
        const src = new URL(f, dir)
        if (existsSync(src)) copyFileSync(toPath(src), toPath(new URL(f, snap)))
      }
      const olds = readdirSync(toPath(histRoot), { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name).sort()
      for (const name of olds.slice(0, Math.max(0, olds.length - 20))) {
        rmSync(toPath(new URL(`${name}/`, histRoot)), { recursive: true, force: true })
      }
      console.log(`历史留存：history/${stamp}/（共 ${Math.min(olds.length, 20)} 份快照）`)
    } catch (error) {
      console.warn(`⚠️ 历史留存失败（不影响报告）：${error.message}`)
    }
  } catch (error) {
    console.warn(`⚠️ 留痕失败（不影响报告）：${error.message}`)
  }

  return {
    address,
    json: data,
    dir,
  }
}

/** 从报告数据里抽一行结论，供看板显示。 */
function conclusionLine(data) {
  const parts = []
  const rent = data.finance?.recommendation
  if (rent) {
    parts.push(`锚点 ${Math.round(rent.target_rent).toLocaleString('zh-CN')} 元/月`)
    const gap = Math.round(rent.gap_to_target)
    if (gap > 0) parts.push(`距租金需降 ${gap.toLocaleString('zh-CN')}`)
    if (rent.rent_ratio_verdict === 'breach') parts.push('租售比超红线')
  }
  const comp = data.rings?.[0]
  if (data.finance?.space_model?.input_consistency === 'revenue_too_low') parts.push('面积与营收不匹配')
  if (comp?.share_suppressed === false && comp?.top?.[0]) parts.push(`Top1 ${comp.top[0].share_pct}%`)
  if (Array.isArray(data.barriers) && data.barriers.length > 0) {
    const blocked = data.barriers.filter((b) => (b.barrier_type ?? '') !== '').length
    if (blocked > 0) parts.push(`现场阻断 ${blocked} 处`)
  }
  return parts.join('｜') || '—'
}

// ── 主流程
run('① 校验业态档案', 'profile-build.mjs', [`--check=${slug}`])

if (batch) {
  const addresses = batch.split(';').map((s) => s.trim()).filter(Boolean)
  if (addresses.length < 2) {
    console.error('--batch 至少给 2 个地址，用分号分隔')
    process.exit(1)
  }
  const results = []
  for (const [i, addr] of addresses.entries()) {
    console.log(`\n════════ 方案 ${i + 1}/${addresses.length}：${addr} ════════`)
    results.push(await runOne(addr, args.get('survey')))
  }
  const { buildCompare } = await import('./report.mjs')
  const { markdown, html } = buildCompare(results, profile)
  const dir = new URL(`${slug}/`, OUT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(toPath(new URL('compare.md', dir)), markdown, 'utf8')
  writeFileSync(toPath(new URL('compare.html', dir)), html, 'utf8')
  console.log(`\n✅ 多方案对比：${toPath(new URL('compare.html', dir))}`)
  if (!args.has('no-open')) openWithShell(toPath(new URL('compare.html', dir)))
} else {
  const one = await runOne(singleAddress, args.get('survey'))
  console.log(`\n✅ 完成：${profile.name} ｜ ${one.address}`)
  console.log(`   报告：${toPath(new URL('report.html', one.dir))}`)
  console.log(`   数据：${toPath(new URL('probe.json', one.dir))}`)
  if (!args.has('no-map')) console.log(`   地图：${toPath(new URL('map.html', one.dir))}`)
  console.log(`   一键打开：${toPath(new URL('open.cmd', one.dir))}（双击即可）`)
  if (!args.has('no-open')) openWithShell(toPath(new URL('report.html', one.dir)))
  console.log('\n复核提示：报告里每个数字都能在 probe.json / survey.json 找到出处。')
}
