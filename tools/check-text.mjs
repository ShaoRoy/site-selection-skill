/**
 * check-text.mjs —— 发布文本守卫（控制字符 + README 格式）
 *
 * 为什么需要它：发布物反复出现过三类「肉眼难发现、渲染后很难看」的问题——
 *   1. 行内代码被误转义成控制字符（`` `f ``→U+000C、`` `t ``→TAB、`` `a ``→BEL、`` `r ``→孤立CR），
 *      于是「fin-v2」显示成「in-v2」；
 *   2. 徽章被换行拆成两行，或同一份许可挂了两个徽章（其中一个 lightgrey 像失效）；
 *   3. 表格中间被塞进物理换行、标题层级跳级。
 * 这些问题不该由用户发现，必须在 npm test 第一段就被拦下。
 *
 * 判定：
 *   · 致命（exit 1）：控制字符 / 孤立 CR / 徽章被拆行 / 徽章数不符 / 非 https 链接 /
 *                     表格行 `|` 数不一致 / 标题跳级。
 *   · 提示（不失败）：TAB 数量（缩进可能合法）。
 *
 * 用法（源码包根目录）：
 *   node tools/check-text.mjs
 *   node tools/check-text.mjs --root=..\..            # 扫发布目录
 *
 * 纯 Node 内建模块，不联网、无第三方依赖。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, extname, basename } from 'node:path'

const args = process.argv.slice(2)
const rootArg = (() => {
  const i = args.findIndex((a) => a.startsWith('--root='))
  return i >= 0 ? args[i].slice('--root='.length) : '.'
})()
const ROOT = resolve(rootArg)

const EXT = new Set(['.md', '.json', '.py', '.mjs', '.ts', '.yml', '.yaml'])
// 精确跳过：目录名匹配这些才不进；dist 不再整目录跳过（发布看板与 _src 也要扫）
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'tiles'])
const SKIP_DIR_PATTERNS = [/^release$/, /^_backup-/, /^_archive-/]

// U+0000–0008 / 000B / 000C / 000E–001F / 007F
const FATAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const BADGE_HOST = 'img.shields.io'
const EXPECTED_BADGES = 14

/**
 * 已知历史存档豁免（docs/ 下实测存在的 6 处表格列数不齐）。
 * 这些文件按约定不改写（历史存档），但**除这 6 处之外** docs/ 的结构问题一律致命。
 * key 格式：归一化为 / 分隔的路径 + @L行号。
 */
const DOCS_WHITELIST = new Set([
  'docs/SKILL-FULL.md@L33',
  'docs/未处理事项.md@L12',
  'docs/未处理事项.md@L13',
  'docs/未处理事项.md@L23',
  'docs/未处理事项.md@L33',
  'docs/未处理事项.md@L55',
])

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (SKIP_DIR_PATTERNS.some((re) => re.test(e.name))) continue
      walk(p, acc)
    } else if (e.isFile()) {
      const ext = extname(e.name)
      // _src 下的解包目录没有扩展名，但其中的文件有；zip 与二进制一律跳过
      if (ext === '.zip') continue
      if (EXT.has(ext)) acc.push(p)
    }
  }
  return acc
}

const files = walk(ROOT)
const fatalHits = []
const warnHits = []
const tabReport = []
const badgeReports = []

/** 徽章守卫：只针对含 shields.io 徽章的 README（主文档），子目录 README 不涉及 */
function checkBadges(rel, raw) {
  if (basename(rel) !== 'README.md') return
  if (!raw.includes(BADGE_HOST)) return

  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => l.includes(BADGE_HOST))
  if (idx < 0) return
  const line = lines[idx]

  const badgeCount = (line.match(/<img\b/g) || []).length
  badgeReports.push(`${rel} @L${idx + 1} 徽章 ${badgeCount} 个`)

  if (badgeCount !== EXPECTED_BADGES) {
    fatalHits.push(`${rel} @L${idx + 1} 徽章数 ${badgeCount}，期望 ${EXPECTED_BADGES}`)
  }
  // 徽章块必须在同一物理行：首行之后紧跟的行若还含徽章标签，说明被拆行了
  const next = lines[idx + 1] || ''
  if (next.includes('<img') || next.includes(BADGE_HOST)) {
    fatalHits.push(`${rel} @L${idx + 2} 徽章被换行拆成多行（应压在同一行 <p> 内）`)
  }
  // href 必须绝对 https
  for (const m of line.matchAll(/<a\s+href="([^"]*)"/g)) {
    const href = m[1]
    if (!/^https:\/\//.test(href)) {
      fatalHits.push(`${rel} @L${idx + 1} 徽章链接非绝对 https：${href}`)
    }
    if (href.includes('vercel.app')) {
      fatalHits.push(`${rel} @L${idx + 1} 徽章链接指向已下线的 vercel.app：${href}`)
    }
  }
}

/** Markdown 结构守卫：表格同块内 `|` 数一致、标题不跳级
 *
 * 分级：
 *   · README.md 与 references/*.md → 致命（发布门面与随包分发的生效文档，必须干净）
 *   · docs/*.md → 默认同样致命；仅 DOCS_WHITELIST 里那 6 处已知历史存档降为警告
 *     （白名单按「文件+行号」硬锁定，改动被锁文件的前置行会让白名单失配而变红，这是有意设计）
 */
function checkMarkdown(rel, raw) {
  const lines = raw.split('\n')
  const relKey = rel.replace(/\\/g, '/')
  const report = (msg, lineNo) => {
    const key = `${relKey}@L${lineNo}`
    if (DOCS_WHITELIST.has(key)) warnHits.push(msg)
    else fatalHits.push(msg)
  }

  // —— 表格完整性（竖线计数先剥掉行内代码，避免 `a|b` 这类内容误判）
  const countPipes = (l) => (l.replace(/`[^`]*`/g, '').match(/\|/g) || []).length
  let blockStart = -1
  let blockPipeCount = -1
  for (let i = 0; i <= lines.length; i += 1) {
    const l = lines[i] === undefined ? '' : lines[i]
    const isRow = /^\s*\|/.test(l)
    if (isRow) {
      const pipes = countPipes(l)
      if (blockStart < 0) {
        blockStart = i + 1
        blockPipeCount = pipes
      } else if (pipes !== blockPipeCount) {
        report(`${rel} @L${i + 1} 表格行竖线数 ${pipes}，表头为 ${blockPipeCount}（表格被改坏或断行）`, i + 1)
      }
    } else {
      blockStart = -1
      blockPipeCount = -1
    }
  }

  // —— 标题层级（跳过代码块内）
  let inFence = false
  let prevLevel = 0
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (/^\s*```/.test(l)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+\S/.test(l)
    if (m) {
      const level = l.match(/^(#{1,6})/)[1].length
      if (prevLevel > 0 && level > prevLevel + 1) {
        report(`${rel} @L${i + 1} 标题跳级 H${prevLevel} → H${level}`, i + 1)
      }
      prevLevel = level
    }
  }
}

for (const f of files) {
  let raw
  try {
    raw = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const rel = relative(ROOT, f) || f

  for (const m of raw.matchAll(FATAL)) {
    const off = m.index
    const ctx = raw.slice(Math.max(0, off - 20), off + 20).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    fatalHits.push(`${rel} @${off} U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}  …${ctx}…`)
  }
  for (const m of raw.matchAll(/\r(?!\n)/g)) {
    const off = m.index
    const ctx = raw.slice(Math.max(0, off - 20), off + 20).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    fatalHits.push(`${rel} @${off} lone CR  …${ctx}…`)
  }
  const tabs = (raw.match(/\t/g) || []).length
  if (tabs > 0) tabReport.push(`${rel}: TAB × ${tabs}`)

  if (extname(f) === '.md') {
    checkBadges(rel, raw)
    checkMarkdown(rel, raw)
  }
}

console.log(`=== check-text：扫描 ${files.length} 个文本文件（root=${ROOT}）`)

if (badgeReports.length) {
  console.log('\nREADME 徽章守卫：')
  for (const b of badgeReports) console.log('  ' + b)
} else {
  console.log('\nREADME 徽章守卫：本次扫描范围内无主 README（跳过）')
}

if (tabReport.length) {
  console.log('\nTAB 提示（不判失败，缩进可能合法；请人工确认正文标识符首字符处无 TAB）：')
  for (const t of tabReport) console.log('  ' + t)
} else {
  console.log('\nTAB：0 处')
}

if (warnHits.length) {
  console.log(`\n⚠️ 已知历史存档豁免 ${warnHits.length}/${DOCS_WHITELIST.size} 处（docs/ 下仅这 ${DOCS_WHITELIST.size} 处放行，其余一律致命）：`)
  for (const w of warnHits) console.log('  ' + w)
}

if (fatalHits.length) {
  console.log(`\n❌ 违规 ${fatalHits.length} 处：`)
  for (const h of fatalHits) console.log('  ' + h)
  console.log('\n修复提示：控制字符通常来自 `` `x `` 被当作转义序列（`a=BEL `f=FF `r=CR `t=TAB），')
  console.log('          按语义换回「反引号 + 对应字母」并补回右反引号；')
  console.log('          徽章必须压在同一行 <p> 内、链接用绝对 https、主 README 固定 14 个徽章。')
  process.exitCode = 1
} else {
  console.log('\n✅ 控制字符 0 处；README 徽章与 Markdown 结构合规')
}
