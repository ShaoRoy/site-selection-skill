/**
 * survey-csv.mjs —— 调研表 CSV 的唯一解析实现（被 run-site.mjs 与 import-survey.mjs 共用）
 *
 * 为什么单独成文件：
 *   2026-11-08 之前有**两份**解析器——import-survey.mjs 的 parseCsv（干净、无千分位还原）
 *   与 run-site.mjs 的 readSurvey（带千分位启发式）。两份行为分叉，改一边忘另一边就漂移，
 *   实际上正是这个分叉让「来源列以数字开头 → value 被吞 → 财务分母错」的缺陷藏了下来。
 *   现在只保留这一份。
 *
 * 千分位还原的正确判据（踩过的坑）：
 *   不能只看「逗号后三位是数字」。`param,daily_revenue,12750,150 人 × 85 元,0.5` 里
 *   来源恰好以 `150` 开头，旧判据会把它当成 `150,000` 的续写，value 拼成
 *   "12750,150 人 × 85 元" → Number() = NaN → 参数静默丢弃 → 引擎回落业态默认值 →
 *   整份财务段分母错（租售比从 31.4% 变 50%）。
 *
 *   正确判据三层同时成立：
 *     a) headOk：当前格是 1–3 位且不以 0 开头，允许多段千分位（1,234,567）
 *     b) nextOk：紧跟的三位是纯数字
 *     c) tailOk：这三位之后**必须是分隔符 / 换行 / 文本末尾**（不能是空格、汉字、字母）
 */

export const REQUIRED_PARAMS = ['daily_revenue', 'gross_margin', 'monthly_rent', 'initial_investment']

export const HEADER_ALIAS = {
  类型: 'type', type: 'type',
  键: 'key', key: 'key', 字段: 'key', 参数: 'key',
  值: 'value', value: 'value',
  来源: 'source', source: 'source', 数据依据: 'source',
  置信度: 'confidence', confidence: 'confidence',
}

/** 判断此处逗号是不是千分位（而不是列分隔符） */
function isThousandsSep(src, i, cell) {
  const next3 = src.slice(i + 1, i + 4)
  const tail = src[i + 4] ?? ''
  const headOk = /^[1-9]\d{0,2}(,\d{3})*$/.test(cell.trim())
  const nextOk = /^\d{3}$/.test(next3)
  const tailOk = tail === ',' || tail === '\n' || tail === '\r' || tail === ''
  return headOk && nextOk && tailOk
}

/**
 * CSV 文本 → 二维数组
 * 支持：引号包裹、引号内双写转义、引号内换行、CRLF、BOM、千分位还原
 */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1 } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      if (isThousandsSep(src, i, field)) {
        field += ','            // 千分位：并进当前格
      } else {
        row.push(field); field = ''
      }
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''))
}

/** 数值清洗：去千分位与空白；空串返回 undefined（不能当 0） */
export function toNumber(raw) {
  const s = String(raw ?? '').replace(/[,，\s]/g, '')
  if (s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** 置信度：数字或 high/medium/low，缺省 0.5 */
function toConfidence(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === '') return 0.5
  if (['high', 'medium', 'low'].includes(s)) return s
  const n = Number(s)
  return Number.isFinite(n) ? n : 0.5
}

/**
 * 调研表文本 → { fields, params, meta, warnings }
 *
 * 契约与旧实现一致：
 *   meta  → 字符串
 *   field → { value: boolean|number|string, source, confidence }
 *   param → { value: number, source, confidence }，非数字或空值跳过（不写 0）
 */
export function parseSurveyText(text) {
  const rows = parseCsv(text)
  if (rows.length < 2) return null

  const head = rows[0].map((h) => String(h).trim())
  const idx = (name) => head.findIndex((h) => (HEADER_ALIAS[h] ?? h) === name)

  const fields = {}
  const params = {}
  const meta = {}
  const warnings = []

  for (const row of rows.slice(1)) {
    const get = (n) => (idx(n) >= 0 ? String(row[idx(n)] ?? '').trim() : '')
    const type = get('type').toLowerCase()
    const key = get('key')
    if (!key) continue

    const raw = get('value')
    const source = get('source') || '未标注来源'
    const confidence = toConfidence(get('confidence'))

    if (type === 'meta') {
      meta[key] = raw
      continue
    }
    if (type === 'field') {
      // 布尔 → boolean；纯数字 → number；其余留字符串
      const val = /^(true|false)$/i.test(raw)
        ? raw.toLowerCase() === 'true'
        : (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw)
      fields[key] = { value: val, source, confidence }
      continue
    }
    if (type === 'param') {
      const n = toNumber(raw)
      if (n !== undefined) params[key] = { value: n, source, confidence }
    }
  }

  // 缺必需财务参数时不能静默回落业态默认值——那会让「报告能生成但分母错」
  const missing = REQUIRED_PARAMS.filter((k) => !(k in params))
  if (missing.length > 0) {
    warnings.push(`缺必需财务参数：${missing.join(', ')}（会回落到业态默认值）`)
  }

  return { fields, params, meta, warnings }
}

/** 一次读文件：run-site.mjs 与 import-survey.mjs 的统一入口 */
export function parseSurveyFile(readFileSync, path) {
  const text = readFileSync(path, 'utf8')
  return parseSurveyText(text)
}
