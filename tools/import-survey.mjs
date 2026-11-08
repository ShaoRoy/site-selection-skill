/**
 * import-survey.mjs —— 调研表 → 工具入参（CSV 原生支持；XLSX 需 `pnpm add -d xlsx`）
 *
 * 用法：
 *   node .\tools\import-survey.mjs 调研表.csv
 *   node .\tools\import-survey.mjs 调研表.xlsx
 *
 * 表格格式（第一行表头，四列，逗号分隔；Excel 另存为 CSV 即可）：
 *   type,key,value,source,confidence
 *   meta,store_id,GZ-TEA-001,,
 *   meta,format_code,tea,,
 *   field,exhaust,false,现场照片,0.9
 *   field,power_kw,30,电表读数,0.9
 *   param,monthly_rent,45000,租赁合同,0.95
 *   param,gross_margin,0.62,老板口述,0.6
 *
 * type 取值：meta（元信息）/ field（否决字段）/ param（财务参数）
 * 中文表头也认：类型 / 键 / 值 / 来源 / 置信度
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { parseCsv, toNumber, HEADER_ALIAS, REQUIRED_PARAMS } from './survey-csv.mjs'



function coerceValue(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true'
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

function coerceConfidence(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return 0.5
  if (['high', 'medium', 'low'].includes(text)) return text
  const n = Number(text)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

async function loadRows(file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.csv' || ext === '.txt') {
    return parseCsv(readFileSync(file, 'utf8'))
  }
  if (ext === '.xlsx' || ext === '.xls') {
    let xlsx
    try {
      xlsx = await import('xlsx')
    } catch {
      throw new Error('读 xlsx 需要依赖：在 scratch-plugin 目录执行 `pnpm add -d xlsx`，或在 Excel 里「另存为 CSV」')
    }
    const book = xlsx.read(readFileSync(file))
    const sheet = book.Sheets[book.SheetNames[0]]
    const json = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false })
    return json.map((row) => row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))))
  }
  throw new Error(`不支持的文件类型：${ext}（用 .csv / .xlsx）`)
}

const file = process.argv[2]
if (!file) {
  console.error('用法：node .\\tools\\import-survey.mjs 调研表.csv')
  process.exit(1)
}

const rows = await loadRows(file)
if (rows.length < 2) throw new Error('表格至少要有表头 + 一行数据')

const header = rows[0].map((h) => HEADER_ALIAS[String(h).trim()] ?? String(h).trim())
const need = ['type', 'key', 'value']
for (const col of need) {
  if (!header.includes(col)) throw new Error(`缺少必需列「${col}」，当前表头：${rows[0].join(' | ')}`)
}

const meta = {}
const fields = {}
const params = {}
const warnings = []

for (const row of rows.slice(1)) {
  const get = (name) => {
    const idx = header.indexOf(name)
    return idx === -1 ? '' : String(row[idx] ?? '').trim()
  }
  const type = get('type').toLowerCase()
  const key = get('key')
  if (!key) continue
  const value = get('value')
  const source = get('source') || '未标注来源'
  const confidence = coerceConfidence(get('confidence'))

  if (type === 'meta') {
    meta[key] = value
    continue
  }
  if (type === 'field') {
    fields[key] = { value: coerceValue(value), source, confidence }
    continue
  }
  if (type === 'param') {
    const numeric = toNumber(value)
    if (numeric === undefined) {
      warnings.push(`参数 ${key} 的值「${value}」不是数字，已跳过`)
      continue
    }
    params[key] = { value: numeric, source, confidence }
    continue
  }
  warnings.push(`未知 type「${type}」（应为 meta / field / param），键 ${key} 已跳过`)
}

if (!meta.store_id) warnings.push('缺少 meta.store_id')
if (!meta.format_code) warnings.push('缺少 meta.format_code')
for (const key of REQUIRED_PARAMS) {
  if (!(key in params)) warnings.push(`财务参数缺少 ${key}（无法做完整回本测算）`)
}

const lowConfidence = [...Object.entries({ ...fields, ...params })]
  .filter(([, v]) => (typeof v.confidence === 'number' ? v.confidence < 0.5 : v.confidence === 'low'))
  .map(([k]) => k)

console.log(`=== 导入结果：${file} ===`)
console.log(`元信息 ${Object.keys(meta).length} 项｜调研字段 ${Object.keys(fields).length} 项｜财务参数 ${Object.keys(params).length} 项`)
if (lowConfidence.length > 0) console.log(`低置信项（报告须标【预估】）：${lowConfidence.join('、')}`)
if (warnings.length > 0) {
  console.log('\n⚠️ 警告：')
  for (const w of warnings) console.log(`  - ${w}`)
}

console.log('\n--- ① veto_check 入参 ---')
console.log(JSON.stringify({
  store_id: meta.store_id ?? 'S-0001',
  format_code: meta.format_code ?? 'convenience_store',
  fields,
}, null, 2))

console.log('\n--- ② financial_calc 入参 ---')
console.log(JSON.stringify({
  store_id: meta.store_id ?? 'S-0001',
  format_code: meta.format_code ?? 'convenience_store',
  params,
}, null, 2))

console.log('\n下一步：把两段 JSON 分别喂给 veto_check / financial_calc；字段口径见 SKILL.md 0.6.2 与 0.9')
