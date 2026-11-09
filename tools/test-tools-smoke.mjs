/**
 * test-tools-smoke.mjs —— tools/ 渲染链冒烟测试（E2 补充）
 *
 * 覆盖此前完全没有自动化测试的路径：
 *   1. report.mjs 独立运行（Windows 下 invokedDirectly 路径比较）
 *   2. 缺 _staticMapSvg 时自动调 render-static-map 补图
 *   3. render-map.mjs 相对路径解析（L5 回归）
 *   4. 产出 HTML 的自包含性与关键部件
 *
 * 不碰网络：全部用本地 fixture。
 */
import { execFileSync } from 'node:child_process'
import { openSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'))
const checks = []
const check = (label, ok) => checks.push([label, Boolean(ok)])

const tmp = mkdtempSync(join(tmpdir(), 'tools-smoke-'))
try {
  // ── 最小 probe.json（无 _staticMapSvg，用来触发自动补图逻辑）
  const probe = {
    center: { lat: 23.124734, lng: 113.244246 },
    address: '测试地址',
    scene: { label: '测试业态', pattern: '餐饮' },
    dedupe: { raw: 10, effective: 8, dropped: 1, merged: 1, same_type_count: 3, other_type_count: 5 },
    coverage: { amap: 90, tencent: 100 },
    transit: { nearest_metro_name: '测试站', nearest_metro_m: 250 },
    // render-map 强依赖 pois 数组；缺了会抛「数据里没有 POI」
    pois: [
      { name: '甲饭店', lat: 23.1255, lng: 113.2455, same_type: true, category: '餐饮服务;中餐厅' },
      { name: '乙便利店', lat: 23.1235, lng: 113.2425, same_type: false, category: '购物服务;便利店' },
    ],
    rings: [{
      label: '内圈·步行10分',
      inside: 8,
      top: [
        { name: '甲饭店', share_pct: 12.5 },
        { name: '乙饭店', share_pct: 9.0 },
        { name: '丙饭店', share_pct: 9.0 },
      ],
      nearest: [{ name: '甲饭店', distance_m: 80 }],
      distance_bands: [],
    }],
  }
  const probePath = join(tmp, 'probe.json')
  writeFileSync(probePath, JSON.stringify(probe, null, 2), 'utf8')

  // ── 1+2：独立运行 report.mjs，相对路径传入
  let ran = false
  try {
    execFileSync(process.execPath, [join(HERE, 'report.mjs'), `--in=${probePath}`], {
      cwd: tmp, stdio: 'ignore', timeout: 60000,
    })
    ran = true
  } catch { ran = false }

  check('report.mjs 独立运行退出码为 0', ran)
  check('产出 probe.md', existsSync(join(tmp, 'probe.md')))
  check('产出 probe.html', existsSync(join(tmp, 'probe.html')))

  const md = existsSync(join(tmp, 'probe.md')) ? readFileSync(join(tmp, 'probe.md'), 'utf8') : ''
  const html = existsSync(join(tmp, 'probe.html')) ? readFileSync(join(tmp, 'probe.html'), 'utf8') : ''

  check('md 含结论段', /## 0\. (结论|参考判断)/.test(md))
  check('md 结论标注为参考判断', md.includes('估算 · 仅供参考') && md.includes('不构成是否开店的决定'))
  check('md 含竞品分布', md.includes('竞品分布'))
  check('md 含势力份额榜', md.includes('势力份额'))
  check('html 非空且 > 10KB', html.length > 10240)
  check('html 无未渲染模板占位', !html.includes('${') && !html.includes('undefined'))
  check('html 无外链资源（自包含）', !/(?:src|href)="https?:\/\//.test(html))
  check('html 含工具栏', html.includes('__saveHtml'))

  // ── 3：render-map 相对路径（L5 回归）
  let mapOk = false
  try {
    execFileSync(process.execPath, [join(HERE, 'render-map.mjs'), 'probe.json'], {
      cwd: tmp, stdio: 'ignore', timeout: 60000,
    })
    mapOk = existsSync(join(tmp, 'probe-map.html'))
  } catch { mapOk = false }
  check('render-map.mjs 接受相对路径并出图（L5）', mapOk)

  // ── 5：默认瓦片路径（不传 --tiles 也要能找到 ../tiles）
  //     历史 bug：arg() 默认 null，用 !== undefined 判会永远成立，
  //     把默认路径变成 <cwd>/null，底图全丢且不报错。
  {
    const root = join(tmp, 'maptest')
    const mb = join(root, 'out')
    mkdirSync(mb, { recursive: true })
    // 约定：tiles/ 与 probe.json 所在目录同级
    //   probe = <root>/out/probe.json  →  tiles = <root>/tiles
    const tileRoot = join(root, 'tiles')
    // 1x1 透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    // 渲染器按圈层跨度自动选 zoom（可能 16/17/18），三层都铺瓦片
    for (const z of [16, 17, 18]) {
      const n = 2 ** z
      const tx0 = Math.floor(((113.244246 + 180) / 360) * n)
      const ty0 = Math.floor(
        ((1 - Math.log(Math.tan((23.124734 * Math.PI) / 180) + 1 / Math.cos((23.124734 * Math.PI) / 180)) / Math.PI) / 2) * n,
      )
      for (let dx = -3; dx <= 3; dx += 1) {
        for (let dy = -3; dy <= 3; dy += 1) {
          const d = join(tileRoot, String(z), String(tx0 + dx))
          mkdirSync(d, { recursive: true })
          writeFileSync(join(d, `${ty0 + dy}.png`), png)
        }
      }
    }
    writeFileSync(join(mb, 'probe.json'), JSON.stringify(probe, null, 2), 'utf8')
    // 不用默认 pipe 捕获 stdout：受限沙箱下 spawn 的 pipe 会 EPERM，
    // 那样即使渲染器正常也拿不到输出 → 假失败。改为把 stdout 重定向到文件再读。
    const logPath = join(tmp, 'render-static-map.out.txt')
    let outText = ''
    try {
      const fd = openSync(logPath, 'w')
      try {
        execFileSync(process.execPath, [join(HERE, 'render-static-map.mjs'), `--probe=${join(mb, 'probe.json')}`], {
          cwd: tmp, stdio: ['ignore', fd, 'ignore'], timeout: 60000,
        })
      } finally { closeSync(fd) }
    } catch { /* 非零退出也继续读日志，由断言判定 */ }
    try { outText = readFileSync(logPath, 'utf8') } catch { outText = '' }
    const hit = /(\d+) 张命中/.exec(outText)
    check('render-static-map 默认能找到 ../tiles（回归 null≠undefined）', hit !== null && Number(hit[1]) > 0)
  }

  // ── 4：绝不静默成功——缺场景字段时报错而非空白
  const brokenPath = join(tmp, 'broken.json')
  writeFileSync(brokenPath, JSON.stringify({ center: { lat: 23, lng: 113 } }), 'utf8')
  let brokenThrew = false
  try {
    execFileSync(process.execPath, [join(HERE, 'render-map.mjs'), brokenPath], {
      cwd: tmp, stdio: 'ignore', timeout: 30000,
    })
  } catch { brokenThrew = true }
  check('缺 POI 数据时 render-map 报错退出（不静默）', brokenThrew)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const pass = checks.filter(([, ok]) => ok).length
const fail = checks.length - pass
console.log(`\n=== tools 冒烟测试 ===`)
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(`\n${pass}/${checks.length} 通过`)
if (fail > 0) process.exit(1)
