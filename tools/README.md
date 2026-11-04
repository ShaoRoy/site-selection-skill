# tools/ —— 报告渲染器（零依赖，Node 18+）

这些脚本把 `probe.json`（点位分析结果）渲染成可交付的 HTML 报告，并汇总点位进度看板。
**纯 Node 内建模块，不需要 npm install。** 没有 Node 时，按 `SKILL.md` 的报告结构由模型直接组织输出。

---

## 谁需要跑这层

| 场景 | 是否需要 |
|---|---|
| DSH 内使用 | ❌ 插件已内置同一套渲染器 |
| WorkBuddy / 任意 Agent 且环境有 Node | ✅ 跑 `report.mjs` 出完整 HTML |
| 纯对话、无代码执行环境 | ❌ 用 `SKILL.md` 的 Markdown 报告结构 |

---

## 一条命令出报告

```bash
node tools/report.mjs --in=<路径>/probe.json [--profile=<业态档案>]
```

产出：`<probe 同目录>/report.md` + `report.html`

`report.html` 是**自包含单文件**：地图瓦片以 base64 内嵌，断网、发微信、存 PDF 都能看。

---

## 想要地图，先下瓦片

报告里的地图来自本地瓦片缓存。缺瓦片时报告不会塞空图，而是给出补齐命令。

```bash
# 按点位下（推荐，1.5km 约 20～60 张）
node tools/tile-cache.mjs --center=23.124734,113.244246 --radius=1500 --zoom=16 --out=./tiles

# 按城市下（内置 8 城：广州/深圳/上海/北京/杭州/成都/济南/青岛）
node tools/tile-cache.mjs --city=广州 --zoom=13-15 --out=./tiles
```

然后渲染时指到同一目录：

```bash
node tools/render-static-map.mjs --probe=probe.json --tiles=./tiles
node tools/report.mjs --in=probe.json
```

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `report.mjs` | **核心**：probe.json → report.md / report.html（含内嵌地图、Top20 两栏榜、点击联动、工具栏） |
| `render-static-map.mjs` | 生成静态 SVG 地图（瓦片 base64 内嵌、按主圈层自动缩放） |
| `render-map.mjs` | 生成可缩放拖动的交互版 map.html（可选） |
| `tile-cache.mjs` | 高德瓦片下载与缓存（并发、断点续传） |
| `import-survey.mjs` | 调研表 CSV → JSON（财务参数、现场字段） |
| `profile-build.mjs` | 业态档案建档 / 校验 / 脚手架 |
| `run-site.mjs` | 全流程编排：采集 → 分析 → 财务 → 报告 |
| `isochrone.mjs` | 路网等时圈（Valhalla / OSRM，无引擎时降级为直线） |
| `index-dashboard.mjs` | 刷新进度看板 `out/index.md` |
| `guangzhou-probe.mjs` | 采集入口（双源 POI） |
| `review-segments.mjs` | 竞争分段人工复核 |
| `test-tools-smoke.mjs` | 渲染链冒烟测试（13 条，**包内可直接跑**） |
| `test-grid.mjs` | 网格编号 / registry / 看板测试 |
| `sample-survey.csv` | 调研表样例 |
| `index-dashboard.mjs` | 汇总各点位状态与网格覆盖，生成进度看板（`run-site.mjs` 跑完自动调用） |

---

## 输入是什么

`report.mjs` 只吃 `probe.json`，字段结构见 DSH 插件的 `geo_analyze` / `poi_dedupe` / `financial_calc` 输出。

最小可用结构：

```json
{
  "center": { "lat": 23.124, "lng": 113.244 },
  "dedupe": { "raw": 93, "effective": 63, "same_type_count": 15, "other_type_count": 48 },
  "rings": [{ "label": "内圈·步行10分", "inside": 56, "top": [{ "name": "深巷饭店", "share_pct": 6 }] }],
  "finance": { "per_scenario": { "base": { "revenue": 1500000 } }, "recommendation": {} },
  "population": { "rings": { "500": { "population": 51887, "density_per_km2": 66064 } } }
}
```

字段缺失时对应段落会显示「本段未执行」并给出补齐命令，不会静默留空。

---

## 已知边界

- `report.mjs` 生成的 HTML 依赖浏览器渲染；PDF 请用浏览器「打印 → 存为 PDF」（页内含「存为 PDF」按钮）
- 瓦片从高德 CDN 拉取，离线环境需预先缓存
- `render-map.mjs` 的交互版是独立文件，报告已不依赖它

---

## 调研表编码要求（重要）

CSV **必须存为 UTF-8**。

- Excel：另存为 → **CSV UTF-8（逗号分隔）**
- WPS：另存为 → CSV，编码选 UTF-8
- 记事本/VS Code：直接存 UTF-8

**用 GBK / UTF-16（Windows Excel 中文默认）会怎样**：整张表解析为空，且**不报错**——
报告照常生成，只是财务段全部回落业态默认值，你会以为是系统算错。

另：数字里带千分位（`150,000`）请加引号 `"150,000"`，否则会被当成两列。

---

## 包内能跑哪些测试

| 测试 | 包内可跑 | 说明 |
|---|---|---|
| `test-tools-smoke.mjs` | ✅ 13 条 | 只依赖 node 内建 + 本包文件 |
| `test-grid.mjs` | ⚠️ 部分 | 需要 Python 与 `out/` 目录 |
| 其余 7 个 `test-*.mjs` | ❌ | 依赖 `../src/site-tools.ts` 与 `node_modules`（`@deepseek-ai/dsh-tools`），只在完整开发工作区可跑 |

**完整 232 条断言需要开发工作区**（含 `scratch-plugin/` 与 `node_modules`）。
发布包内置的引擎在 `dsh/site-tools.ts`，是 DSH 插件形态，不是可直接 import 的独立模块。

想快速验证包没坏：

```bash
node tools/test-tools-smoke.mjs
```
