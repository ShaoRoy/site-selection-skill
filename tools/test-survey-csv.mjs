/**
 * test-survey-csv.mjs —— 调研表 CSV 解析护栏
 *
 * 背景（2026-11-08 修的真实缺陷）：
 *   run-site.mjs 的 readSurvey 为避免「Excel 复制的 150,000 被切成 150 + 000」加了
 *   千分位启发式，但旧判据只看「逗号后三位是数字」，于是
 *
 *       param,daily_revenue,12750,150 人 × 85 元,0.5
 *
 *   里 value 后面的来源恰好以 `150` 开头 → 被当成千分位续写 →
 *   value 变成 "12750,150 人 × 85 元" → Number() = NaN → 该参数被静默丢弃 →
 *   引擎回落到业态默认 daily_revenue=8000 → 整份财务段分母错（租售比从 31.4% 变 50%）。
 *
 * 本测试锁死两件事：
 *   1. 来源列以数字开头时不得吞值（回归用例）
 *   2. 真千分位（含多段）仍要正确还原
 *
 * 用法：node tools/test-survey-csv.mjs
 */

import { parseCsv, toNumber } from './survey-csv.mjs'

/** 单行 → 字段数组（走真实现，不是复制品） */
const parseLine = (line) => parseCsv(line)[0] ?? []

const CASES = [
  // ── 回归：来源以数字开头，绝不能吞值 ────────────────────────────
  {
    name: '来源以三位数开头（本次 bug 原样）',
    line: 'param,daily_revenue,12750,150 人 × 85 元,0.5',
    expect: ['param', 'daily_revenue', '12750', '150 人 × 85 元', '0.5'],
  },
  {
    name: '来源以年份开头',
    line: 'param,daily_revenue,8000,2024 年实测,0.5',
    expect: ['param', 'daily_revenue', '8000', '2024 年实测', '0.5'],
  },
  {
    name: '来源以三位数结尾（无后续列）',
    line: 'field,exhaust,true,现场踏勘 150',
    expect: ['field', 'exhaust', 'true', '现场踏勘 150'],
  },
  // ── 真千分位必须还原 ──────────────────────────────────────────
  {
    name: '单段千分位',
    line: 'param,initial_investment,150,000,工程报价,0.4',
    expect: ['param', 'initial_investment', '150,000', '工程报价', '0.4'],
  },
  {
    name: '多段千分位',
    line: 'param,monthly_labor,1,234,567,人效,0.6',
    expect: ['param', 'monthly_labor', '1,234,567', '人效', '0.6'],
  },
  {
    name: '引号内千分位',
    line: 'param,monthly_rent,"150,000",租赁意向书,0.8',
    expect: ['param', 'monthly_rent', '150,000', '租赁意向书', '0.8'],
  },
  // ── 常规行不受影响 ────────────────────────────────────────────
  {
    name: '普通小数',
    line: 'field,rent,0.31,租赁意向书,0.6',
    expect: ['field', 'rent', '0.31', '租赁意向书', '0.6'],
  },
  {
    name: '空尾列',
    line: 'meta,store_id,GZ-001,,',
    expect: ['meta', 'store_id', 'GZ-001', '', ''],
  },
  {
    name: '四位数字（非千分位写法）',
    line: 'param,seat_count,1200,设计图纸,0.7',
    expect: ['param', 'seat_count', '1200', '设计图纸', '0.7'],
  },
]


let pass = 0
let fail = 0
console.log('=== 调研表 CSV 解析护栏 ===\n')

for (const c of CASES) {
  const got = parseLine(c.line)
  const same = got.length === c.expect.length && got.every((v, i) => v === c.expect[i])
  if (same) {
    pass += 1
    console.log(`  PASS  ${c.name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${c.name}`)
    console.log(`        输入 ${c.line}`)
    console.log(`        期望 ${JSON.stringify(c.expect)}`)
    console.log(`        实际 ${JSON.stringify(got)}`)
  }
}

// ── 额外护栏：value 必须能转成有限数字（本次 bug 的直接受害项）──
console.log('\n=== value 数值化护栏 ===\n')
const NUM_CASES = [
  ['param,daily_revenue,12750,150 人 × 85 元,0.5', 12750],
  ['param,initial_investment,150,000,工程报价,0.4', 150000],
  ['param,monthly_labor,1,234,567,人效,0.6', 1234567],
]
for (const [line, want] of NUM_CASES) {
  const got = Number(String(parseLine(line)[2]).replace(/,/g, ''))
  if (got === want) {
    pass += 1
    console.log(`  PASS  ${line.slice(0, 46)} → ${got}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${line}  期望 ${want}，实际 ${got}`)
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
