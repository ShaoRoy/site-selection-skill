/**
 * check-text.mjs —— 发布文本控制字符检查
 *
 * 为什么需要它：CHANGELOG / README 里的行内代码如果被某些编辑器或脚本写入时
 * 误转义，会变成不可见控制字符（例如 `f 被解析为 U+000C、`t 变成 TAB），
 * 结果是「fin-v2」显示成「in-v2」，GitHub 渲染错乱且肉眼极难发现。
 *
 * 判定：
 *   · 致命（exit 1）：U+0000–U+0008 / U+000B / U+000C / U+000E–U+001F / U+007F，或孤立 CR（非 CRLF）。
 *   · 提示（不失败）：TAB 数量。缩进用 TAB 属合法，交由人工核对。
 *
 * 用法（源码包根目录）：
 *   node tools/check-text.mjs
 *   node tools/check-text.mjs --root=.        # 指定扫描根
 *
 * 纯 Node 内建模块，不联网、无第三方依赖。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, extname } from 'node:path'

const args = process.argv.slice(2)
const rootArg = (() => {
  const i = args.findIndex((a) => a.startsWith('--root='))
  return i >= 0 ? args[i].slice('--root='.length) : '.'
})()
const ROOT = resolve(rootArg)

const EXT = new Set(['.md', '.json', '.py', '.mjs', '.ts', '.yml', '.yaml'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'tiles', 'dist'])

// U+0000–0008 / 000B / 000C / 000E–001F / 007F
const FATAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

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
      walk(p, acc)
    } else if (e.isFile() && EXT.has(extname(e.name))) {
      acc.push(p)
    }
  }
  return acc
}

const files = walk(ROOT)
const fatalHits = []
const tabReport = []

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
}

console.log(`=== check-text：扫描 ${files.length} 个文本文件（root=${ROOT}）`)
if (tabReport.length) {
  console.log(`\nTAB 提示（不判失败，缩进可能合法；请人工确认正文标识符首字符处无 TAB）：`)
  for (const t of tabReport) console.log('  ' + t)
} else {
  console.log('\nTAB：0 处')
}

if (fatalHits.length) {
  console.log(`\n❌ 致命控制字符 ${fatalHits.length} 处：`)
  for (const h of fatalHits) console.log('  ' + h)
  console.log('\n修复提示：这类污染通常来自 `x 被当作转义序列（`a=BEL `f=FF `r=CR `t=TAB），')
  console.log('          按语义把控制字符换回「反引号 + 对应字母」，并补回丢失的右反引号。')
  process.exitCode = 1
} else {
  console.log('\n✅ 致命控制字符：0 处')
}
