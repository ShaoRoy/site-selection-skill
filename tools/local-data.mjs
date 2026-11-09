/**
 * 本地数据位读取与校验（L2）。
 *
 * 数据源：data/local/<城市>.json，由用户按官方公开数据自行维护。
 * 优先级：A 本地实测/官方 > B 内置行业基准 > C 模型估算 > D 占位。
 * 本模块只负责 A 级的读取、校验与查询，不回写 data/cities.json 的缩放基数。
 *
 *   node tools/local-data.mjs --check        # CI 结构校验（0 次联网）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const LOCAL_DIR = resolve(HERE, '..', 'data', 'local')

const REQUIRED = ['city', 'scope', 'metric', 'value', 'unit', 'source',
  'published_at', 'collected_at', 'confidence']

export const GRADE = Object.freeze({ LOCAL: 'A', BENCH: 'B', ESTIMATE: 'C', PLACEHOLDER: 'D' })

/** 读一个城市的 JSON，返回 { city, records, errors }。示例记录（example:true）会被剔除。 */
export function readCity(file) {
  const errors = []
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return { city: '', records: [], errors: [`JSON 解析失败：${e.message}`] }
  }
  const list = Array.isArray(doc.records) ? doc.records : []
  const records = []
  list.forEach((r, i) => {
    if (r.example === true) return
    for (const k of REQUIRED) {
      if (r[k] === undefined || r[k] === null || r[k] === '') {
        errors.push(`records[${i}] 缺字段 ${k}`)
      }
    }
    if (r.value !== undefined && (typeof r.value !== 'number' || !Number.isFinite(r.value))) {
      errors.push(`records[${i}].value 必须是纯数字`)
    }
    if (r.confidence !== undefined && (r.confidence < 0 || r.confidence > 1)) {
      errors.push(`records[${i}].confidence 必须在 0–1`)
    }
    records.push(r)
  })
  return { city: doc.city ?? '', records, errors }
}

/** 读整个本地数据位；_template.json 只作模板，不参与计算。 */
export function loadLocalData(dir = LOCAL_DIR) {
  if (!existsSync(dir)) return { records: [], errors: [], files: [] }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_template.json')
  const records = []
  const errors = []
  for (const f of files) {
    const r = readCity(join(dir, f))
    for (const e of r.errors) errors.push(`${f}: ${e}`)
    records.push(...r.records)
  }
  return { records, errors, files }
}

/** 查一条 A 级数据；scope 优先精确匹配，再退回「全市」。返回 null 表示未命中。 */
export function resolveLocal(records, city, metric, scope = '全市') {
  const pool = records.filter((r) => r.city === city && r.metric === metric)
  if (pool.length === 0) return null
  return pool.find((r) => r.scope === scope) ?? pool.find((r) => r.scope === '全市') ?? null
}

/** 报告里用的来源标注文本。 */
export function sourceLabel(rec) {
  if (!rec) return ''
  return `本地数据位 · 来源 ${rec.source} · 发布于 ${rec.published_at}（可能滞后）`
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const { records, errors, files } = loadLocalData()
  const skipped = records.length === 0
  console.log(`本地数据位：${files.length} 个城市文件，${records.length} 条有效记录`)
  for (const e of errors) console.error(`  ❌ ${e}`)
  if (skipped) console.log('  ℹ️  当前只有示例数据（example:true），不参与计算——这是允许的')
  if (process.argv.includes('--check')) {
    if (errors.length > 0) process.exit(1)
    console.log('  ✅ 结构校验通过')
  }
}
