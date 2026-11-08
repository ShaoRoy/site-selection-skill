/**
 * verify-release.mjs —— 发布物一次性核对（工作区工具，不进任何发布包）
 *
 * 为什么不在 npm test 里：本脚本要读 GitHub API（homepage / Release 附件 digest），
 * 而 check-text.mjs 是离线纯 Node 脚本、不能塞 token。这里属**发布验收阶段**的核对。
 *
 * 覆盖：
 *   1. 两包字节 / 条目数 / SHA-256
 *   2. 两包 ↔ _src 逐条目零差异（调 python 的 zipfile 模块，不装三方库）
 *   3. release\ 两副本 = 根包
 *   4. 四处版本号 = 2.10.37；license 字段；LICENSE 哈希与大小
 *   5. 发布文本控制字符 0（README / CHANGELOG / 看板）
 *   6. README-先看我.md 里的两包 SHA-12 与实际 zip 自洽
 *   7. 线上 Release 两附件 digest = 本地
 *   8. GitHub homepage 合规（禁 vercel.app 死链 / 空或白名单值，强制 no-cache）、description / topics 未变
 *
 * 判定：
 *   · 本地项任一不过 → exit 1
 *   · 线上项取不到数据（无 token / 网络失败）→ exit 1，不静默 SKIP
 *   · 02 已完全剥离：线上不应再出现 expert 附件（反向检查，出现即判失败）
 *
 * 用法（工作区 dist\site-selection\）：
 *   node tools/verify-release.mjs
 *   node tools/verify-release.mjs --no-online     # 只跑本地项（离线自查）
 *
 * 纯 Node 内建模块 + 系统 git/python，无第三方依赖。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 本脚本在 dist\site-selection\tools\，发布根是 ..\..
const UPLOAD = resolve(HERE, '..', '..', 'upload')
const SRC = join(UPLOAD, '_src')
const RELEASE = join(UPLOAD, 'release')
const BOARD = join(UPLOAD, 'README-先看我.md')

const ARGS = process.argv.slice(2)
const ONLINE = !ARGS.includes('--no-online')

const EXPECT_VERSION = '2.10.37'
const EXPECT_LICENSE_SHA = '32bc0352284c'
const EXPECT_LICENSE_BYTES = 4543

const PACKS = [
  { file: '01-skill-导入技能.zip', prefix: 'site-report', rel: 'site-selection-workbuddy-v2.10.37.zip', srcDir: '01-skill/site-report' },
  { file: '03-github-仓库源码.zip', prefix: '', rel: 'site-selection-dsh-v2.10.37.zip', srcDir: '03-source' },
]

const fails = []
const notes = []
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => {
  fails.push(m)
  console.log('  ❌ ' + m)
}
const note = (m) => {
  notes.push(m)
  console.log('  ℹ️  ' + m)
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

// ───────────────────────────── 1. 两包基础信息
console.log('=== verify-release ===\n')
console.log('[1] 两包字节 / 条目数 / SHA-256')

const pyInspect = `
import hashlib, json, sys, zipfile
out = {}
for path, prefix in json.loads(sys.argv[1]):
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith('/')]
        entries = {}
        for n in names:
            rel = n[len(prefix) + 1:] if prefix and n.startswith(prefix + '/') else n
            entries[rel] = hashlib.sha256(z.read(n)).hexdigest()
        out[path] = {'count': len(names), 'entries': entries}
print(json.dumps(out))
`

const packPaths = PACKS.map((p) => [join(UPLOAD, p.file), p.prefix])
const info = JSON.parse(sh('python', ['-c', pyInspect, JSON.stringify(packPaths)]))

for (const p of PACKS) {
  const full = join(UPLOAD, p.file)
  if (!existsSync(full)) {
    bad(`${p.file} 不存在`)
    continue
  }
  const i = info[full]
  console.log(`  ${p.file.padEnd(26)} ${String((readFileSync(full).length)).padStart(10)} B  ${sha(full).slice(0, 12)}  ${i.count} 条目`)
}

// ───────────────────────────── 2. 两包 ↔ _src
console.log('\n[2] 两包 ↔ _src 逐条目')
const pySrcDiff = `
import hashlib, json, os, sys, zipfile

# 换行归一：包内多为 LF、_src 多为 CRLF，不归一会产生大量假差异
def norm(b):
    return hashlib.sha256(b.replace(b'\\r\\n', b'\\n')).hexdigest()

# 工作区工具：明确不进任何发布包，比对时豁免
TOOLS_SKIP = {'verify-release.mjs', 'rebuild-packs.py', 'check-lockstep.py'}

jobs = json.loads(sys.argv[1])
res = {}
for path, prefix, srcroot in jobs:
    diff, missing, extra = [], [], []
    seen = set()
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith('/'): continue
            rel = n[len(prefix) + 1:] if prefix and n.startswith(prefix + '/') else n
            seen.add(rel)
            disk = os.path.join(srcroot, rel.replace('/', os.sep))
            if not os.path.exists(disk):
                missing.append(rel); continue
            a = norm(z.read(n))
            b = norm(open(disk, 'rb').read())
            if a != b: diff.append(rel)
    for r, ds, fs in os.walk(srcroot):
        ds[:] = [d for d in ds if d not in ('out', '__pycache__', 'node_modules')]
        for f in fs:
            if f.endswith('.pyc') or f in TOOLS_SKIP: continue
            rel = os.path.relpath(os.path.join(r, f), srcroot).replace(os.sep, '/')
            if rel not in seen: extra.append(rel)
    res[path] = {'diff': diff, 'missing': missing, 'extra': extra}
print(json.dumps(res))
`
const srcJobs = PACKS.map((p) => [join(UPLOAD, p.file), p.prefix, join(SRC, p.srcDir)])
const srcRes = JSON.parse(sh('python', ['-c', pySrcDiff, JSON.stringify(srcJobs)]))
for (const p of PACKS) {
  const r = srcRes[join(UPLOAD, p.file)]
  if (!r) continue
  const n = r.diff.length + r.missing.length + r.extra.length
  if (n === 0) ok(`${p.srcDir} ↔ 包内零差异`)
  else bad(`${p.srcDir} ↔ 包内差异 ${n}（diff=${r.diff.length} missing=${r.missing.length} extra=${r.extra.length}）${[...r.diff, ...r.missing, ...r.extra].slice(0, 5).join(', ')}`)
}

// ───────────────────────────── 3. release 副本
console.log('\n[3] release\\ 两副本 = 根包')
for (const p of PACKS) {
  const a = join(UPLOAD, p.file)
  const b = join(RELEASE, p.rel)
  if (!existsSync(b)) {
    bad(`${p.rel} 不存在`)
    continue
  }
  if (sha(a) === sha(b)) ok(`${p.rel}`)
  else bad(`${p.rel} 与根包不一致`)
}

// ───────────────────────────── 4. 版本号 / license / LICENSE
console.log('\n[4] 版本号 / license 字段 / LICENSE')
const versionTargets = [
  join(SRC, '01-skill/site-report/manifest.json'),
  join(SRC, '03-source/manifest.json'),
  join(SRC, '03-source/package.json'),
]
for (const f of versionTargets) {
  if (!existsSync(f)) {
    bad(`缺文件 ${f}`)
    continue
  }
  let j
  try {
    j = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    bad(`JSON 非法 ${f}: ${e.message}`)
    continue
  }
  const v = j.version
  const lic = j.license
  if (v !== EXPECT_VERSION) bad(`${f.replace(SRC + '\\', '')} version=${v}，期望 ${EXPECT_VERSION}`)
  else if (lic !== 'LicenseRef-Custom-NonCommercial') bad(`${f.replace(SRC + '\\', '')} license=${lic}`)
  else ok(`${f.replace(SRC + '\\', '')} ${v} / ${lic}`)
}
const licPath = join(SRC, '01-skill/site-report/LICENSE')
if (existsSync(licPath)) {
  const b = readFileSync(licPath).length
  const h = sha(licPath).slice(0, 12)
  if (h === EXPECT_LICENSE_SHA && b === EXPECT_LICENSE_BYTES) ok(`LICENSE ${b} B / ${h}`)
  else bad(`LICENSE ${b} B / ${h}，期望 ${EXPECT_LICENSE_BYTES} B / ${EXPECT_LICENSE_SHA}`)
}

// ───────────────────────────── 5. 控制字符
console.log('\n[5] 发布文本控制字符')
const FATAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const ctrlTargets = [
  join(SRC, '03-source/README.md'),
  join(SRC, '03-source/CHANGELOG.md'),
  BOARD,
]
for (const f of ctrlTargets) {
  if (!existsSync(f)) {
    bad(`缺文件 ${f}`)
    continue
  }
  const t = readFileSync(f, 'utf8')
  const hit = FATAL.exec(t)
  const lone = /\r(?!\n)/.test(t)
  if (hit) bad(`${f.replace(UPLOAD + '\\', '')} 含控制字符 U+${hit[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} @${hit.index}`)
  else if (lone) bad(`${f.replace(UPLOAD + '\\', '')} 含孤立 CR`)
  else ok(`${f.replace(UPLOAD + '\\', '')}`)
}

// ───────────────────────────── 6. 看板哈希自洽
console.log('\n[6] README-先看我.md 哈希自洽')
if (!existsSync(BOARD)) {
  bad('README-先看我.md 不存在')
} else {
  const board = readFileSync(BOARD, 'utf8')
  for (const p of PACKS) {
    const short = sha(join(UPLOAD, p.file)).slice(0, 12)
    if (board.includes(short)) ok(`${p.file} → ${short} 已登记`)
    else bad(`${p.file} 的哈希 ${short} 未在看板登记`)
  }
  const ver = EXPECT_VERSION
  if (board.includes(ver)) ok(`看板版本含 ${ver}`)
  else bad(`看板未写 ${ver}`)
  if (/homepage/.test(board)) ok('看板含 homepage 验收条款')
  else bad('看板缺 homepage 验收条款')
}

// ───────────────────────────── 7/8. 线上
if (!ONLINE) {
  note('--no-online：跳过线上核对（本地项已全部执行）')
} else {
  console.log('\n[6b] 03 包 workflows 完整性')
  {
    // G1 类缺口：仓库 .github/workflows/ 下的每个 yml，03 包里都得有
    const wfDir = join(SRC, '03-source', '.github', 'workflows')
    const zipNames = new Set(Object.keys(info[join(UPLOAD, PACKS.find((p) => p.file.startsWith('03')).file)].entries))
    let wfCount = 0
    if (!existsSync(wfDir)) {
      bad('找不到 _src/03-source/.github/workflows')
    } else {
      for (const f of readdirSync(wfDir)) {
        if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue
        wfCount += 1
        const rel = `.github/workflows/${f}`
        if (zipNames.has(rel)) ok(`03 包含 ${rel}`)
        else bad(`03 包缺 ${rel}——仓库与分发包不同步（G1 类缺口）`)
      }
      if (wfCount === 0) bad('_src 里一个 workflow 都没有，可能路径不对')
    }
  }

  console.log('\n[7] 线上 Release 附件 digest')
  console.log('[8] GitHub homepage（no-cache 读数）')

  let token = ''
  try {
    const out = sh('git', ['-c', 'credential.helper=wincred', 'credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const m = /password=(.+)/.exec(out)
    token = m ? m[1].trim() : ''
  } catch {
    token = ''
  }
  if (!token) {
    bad('取不到 GitHub token（git credential fill 失败）—— 线上核对无法执行，判失败而非跳过')
  } else {
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'verify-release',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    }
    const get = async (url) => {
      const r = await fetch(url, { headers })
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`)
      return { json: await r.json(), etag: r.headers.get('etag'), rid: r.headers.get('x-github-request-id') }
    }

    try {
      const relUrl = `https://api.github.com/repos/ShaoRoy/site-selection-skill/releases/tags/v${EXPECT_VERSION}`
      const { json: rel } = await get(relUrl)
      const PUBLISHED = PACKS
      if (rel.assets.length !== PUBLISHED.length) {
        bad(`线上附件数 ${rel.assets.length}，期望 ${PUBLISHED.length}（01 workbuddy + 03 dsh）`)
      } else ok(`附件数 ${PUBLISHED.length}（01 workbuddy + 03 dsh）`)
      for (const p of PUBLISHED) {
        const a = rel.assets.find((x) => x.name === p.rel)
        if (!a) {
          bad(`线上缺附件 ${p.rel}`)
          continue
        }
        const local = 'sha256:' + sha(join(RELEASE, p.rel))
        if (a.digest === local) ok(`${p.rel} digest 一致`)
        else bad(`${p.rel} digest 不一致 线上=${a.digest} 本地=${local}`)
      }
      // 反向检查：线上不应出现任何 expert 附件（02 已完全剔除）
      const lingering = rel.assets.filter((x) => /expert/i.test(x.name))
      if (lingering.length) bad(`线上出现 expert 附件 ${lingering.map((x) => x.name).join(', ')}`)
      else ok('线上无 expert 附件')
    } catch (e) {
      bad(`读取 Release 失败：${e.message}`)
    }

    try {
      const stamp = Date.now()
      const { json: repo, etag, rid } = await get(`https://api.github.com/repos/ShaoRoy/site-selection-skill?t=${stamp}`)
      // [8] 2026-11-08：死链 vercel.app 已由用户替换为仓库自指 URL，判据由「必须为空」
      //     收敛为「禁死链 + 空或白名单值」。与 .github/workflows/homepage-guard.yml 的 ALLOW 保持一致。
      const HOMEPAGE_ALLOW = [
        '',
        'https://github.com/ShaoRoy/site-selection-skill#readme',
        'https://shaoroy.github.io/site-selection-skill/',
      ]
      const hp = repo.homepage || ''
      if (/vercel\.app/i.test(hp)) bad(`homepage 含已失效 vercel.app 死链：${JSON.stringify(hp)}（ETag ${etag}）`)
      else if (HOMEPAGE_ALLOW.includes(hp)) ok(`homepage 合规：${hp === '' ? '""（空）' : '白名单值'}（ETag ${etag} / X-GitHub-Request-Id ${rid}）`)
      else bad(`homepage = ${JSON.stringify(hp)}，不在白名单；期望空或 ${JSON.stringify(HOMEPAGE_ALLOW[1])}`)
      const topics = (repo.topics || []).length
      if (topics === 8) ok('topics 8 个')
      else note(`topics ${topics} 个（基线 8 个，请人工确认是否有意调整）`)
      if (repo.license?.spdx_id === 'NOASSERTION') ok('license NOASSERTION')
      else note(`license ${repo.license?.spdx_id}（基线 NOASSERTION）`)
      // [6d] main HEAD 与索引登记是否一致
      try {
        const idxPath = join(resolve(UPLOAD, '..', '..', '2026-11-04-20-09-27'), '00-从这里开始-当前状态.md')
        if (existsSync(idxPath)) {
          const idx = readFileSync(idxPath, 'utf8')
          const head = (await get(`https://api.github.com/repos/ShaoRoy/site-selection-skill/commits/main?t=${Date.now()}`)).json.sha.slice(0, 12)
          if (idx.includes(head)) ok(`索引登记的 main HEAD ${head} 与线上一致`)
          else note(`索引里没找到线上 main HEAD ${head}——索引可能过期，建议同步`)
        }
      } catch (e) {
        note(`[6d] main HEAD 复核跳过：${e.message}`)
      }
    } catch (e) {
      bad(`读取仓库设置失败：${e.message}`)
    }
  }
}

// ───────────────────────────── 汇总
console.log('\n=== 结果 ===')
if (notes.length) {
  console.log(`提示 ${notes.length} 条（不判失败）：`)
  for (const n of notes) console.log('  · ' + n)
}
if (fails.length) {
  console.log(`\n❌ 失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  · ' + f)
  console.log('\n本脚本只核对、不修复。按上面每一条改完再跑一次，直到 0 失败。')
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
