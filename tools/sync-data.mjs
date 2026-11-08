#!/usr/bin/env node
/**
 * sync-data.mjs —— 数据资产一键同步（本地改完数据，跑这一条就够）
 *
 * 背景：项目里的「数据资产」有 4 个落点，改一处不够，容易漏：
 *
 *   ① 工作副本      dist/site-selection/data/*.json          ← 你改这里（Python 侧立即生效）
 *   ② 01 打包源树   upload/_src/01-skill/site-report/data/   ← 进 01 zip
 *   ③ 03 打包源树   upload/_src/03-source/data/              ← 进 03 zip
 *   ④ TS 侧常量     dsh/benchmark-data.ts                    ← benchmark_check 工具读这个
 *      ④' 已挂载副本 profiles/desktop/plugins/site-tools/benchmark-data.ts（改完要重启 DSH）
 *
 * 用法：
 *   node tools/sync-data.mjs            # 从工作副本单向推到其余 3 处
 *   node tools/sync-data.mjs --check    # 只比对，不改
 *   node tools/sync-data.mjs --from-json # 由 data/benchmarks.json 重新生成 dsh/benchmark-data.ts
 *
 * 注意：--from-json 会重写 benchmark-data.ts 的 BENCH_ROWS / BENCH_CITIES / BENCH_CATEGORIES，
 *       BENCH_FORMATS 与 CITY_BASELINES 里的中文名需要人工维护，脚本只保证不丢行。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = resolve(HERE, '..')                       // dist/site-selection
const UP = resolve(W, '..', 'upload')               // dist/upload
const S1 = join(UP, '_src', '01-skill', 'site-report')
const S3 = join(UP, '_src', '03-source')
const PLUGIN = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'plugins', 'site-tools')

const args = new Set(process.argv.slice(2))
const CHECK = args.has('--check')
const FROM_JSON = args.has('--from-json')

/** 需要同步的数据文件：源 → 目标列表 */
const TARGETS = []
for (const f of ['benchmarks.json', 'cities.json', 'formats.json']) {
  const src = join(W, 'data', f)
  TARGETS.push({
    name: `data/${f}`,
    src,
    dests: [join(S1, 'data', f), join(S3, 'data', f)],
  })
}
// TS 侧：工作副本 → 03 源树 → 已挂载的插件目录
TARGETS.push({
  name: 'dsh/benchmark-data.ts',
  src: join(W, 'dsh', 'benchmark-data.ts'),
  dests: [join(S3, 'dsh', 'benchmark-data.ts'), join(PLUGIN, 'benchmark-data.ts')],
})

const sha = (p) => {
  try { return statSync(p).size + ':' + readFileSync(p).length } catch { return null }
}
const brief = (p) => {
  if (!existsSync(p)) return '缺失'
  const b = readFileSync(p)
  return `${b.length.toLocaleString()} B`
}

let changed = 0
let same = 0
let missing = 0

console.log('='.repeat(64))
console.log(CHECK ? '数据同步核对（只读）' : '数据同步（工作副本 → 其余落点）')
console.log('='.repeat(64))

for (const t of TARGETS) {
  if (!existsSync(t.src)) {
    console.log(`\n⚠️ ${t.name} —— 工作副本缺这个文件，跳过`)
    missing++
    continue
  }
  const srcBuf = readFileSync(t.src)
  console.log(`\n${t.name}  源 ${brief(t.src)}`)
  for (const d of t.dests) {
    const ok = existsSync(d)
    const identical = ok && readFileSync(d).equals(srcBuf)
    const mark = identical ? '✅ 一致' : (ok ? '❌ 不同' : '⚠️ 缺失')
    console.log(`  ${mark}  ${d.replace(UP, '<upload>').replace(process.env.USERPROFILE ?? '', '~')}  ${brief(d)}`)
    if (!identical) {
      if (!CHECK) {
        if (!existsSync(dirname(d))) {
          console.log(`        目录不存在，跳过（该包可能不含此类文件）`)
          continue
        }
        copyFileSync(t.src, d)
        console.log(`        → 已写入`)
        changed++
      } else {
        changed++
      }
    } else {
      same++
    }
  }
}

console.log('\n' + '='.repeat(64))
if (CHECK) {
  console.log(`核对结果：${same} 处一致 / ${changed} 处不同或缺失`)
  console.log(changed > 0 ? '跑 `node tools/sync-data.mjs`（不带 --check）即可同步' : '全部同步')
} else {
  console.log(`同步结果：${changed} 处已更新 / ${same} 处本就一致`)
  if (changed > 0) {
    console.log('\n后续动作：')
    console.log('  · Python 侧：已立即生效，无需重启')
    console.log('  · TS 侧 benchmark_check：需重启 DSH 才生效')
    console.log('  · 如需发版：python tools/rebuild-packs.py --only 01 / --only 03，再重传附件、同步 main')
  }
}
console.log('='.repeat(64))
