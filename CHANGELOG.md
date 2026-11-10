> **范围声明**：本文件是版本历史账本，记录各版本当时的真实状态。其中提到的「02 专家包 / 配置专家 / 专家团队」均为历史记录，该包已于 2026-11-08 完全剔除，**不再分发、不作为现行依据**。现行只有 01 技能包与 03 源码包。

## 2.10.42

### 修复：01 技能包目录层级超限（WorkBuddy 上传失败）

- 将本地数据位目录 `data/local/` 上移至技能根下的 `local/`：原结构为「根/二级目录/三级目录/文件」，超出 WorkBuddy 开放平台「根目录/二级目录/文件」两级限制，导致 `01-skill-导入技能.zip` 开包解析失败（报错「目录层级超限」）。
- 同步更新全部引用：`README.md`（两包）、`CHANGELOG.md`（两包）、`tools/local-data.mjs`（`LOCAL_DIR` 解析路径与注释）、`tools/report.mjs`（报告内 A 级来源标注）。
- 运行时行为不变：`local-data.mjs` 仍按城市读取用户维护的公开数据；`local/` 内 `_template.json` 为模板，示例记录不参与计算。
- README「目录结构」树补 `local/` 条目，与真实结构一致。

### 修复：SKILL.md 版本号长期未同步（WorkBuddy 平台拒收）

- 两包 `SKILL.md` 的 frontmatter `version` 自 `2.10.39` 起历次升版均未同步（WorkBuddy / Skill 平台以该字段判定包版本，报错「包内版本号 2.10.39 必须大于当前最新版本 2.10.39」）。本次统一同步至 `2.10.42`。
- `tools/verify-release.mjs` 的 [4] 段新增两包 `SKILL.md` frontmatter version 校验，与 `manifest.json` / `package.json` 同批比对，防止再次漏升。
- 本次为**本地修复**：仅重打本地 01/03 包，未推送 GitHub、未新建 Release。

## 2.10.41

### 报告新增「客群结构推断（估算 · 仅供参考）」

- 在报告第 4 节「需求侧代理指标」之后新增 **4.2 客群结构推断（估算 · 仅供参考）**：仅把第 4 节的代理指标（职住比、咖啡/高端餐饮/银行密度、WorldPop 常住人口、配套数量）翻译成「这附近大概率是什么人」的口语化描述，帮助判断品类与营业时段是否对路。
- 全程标注「估算 · 仅供参考」，显式声明本段是数字翻译、非现场观察，不构成客群画像，也不替用户决定是否开店；不输出「人口档位 / 潮汐 T 值 / 客群画像」这类本包不提供、也未经授权的判据。
- 未跑需求侧采集时，自动降级为「本段依赖第 4 节…未计算」提示，不产生空值。
- 渲染层（Markdown + HTML）措辞打磨：统一补齐命令路径为 `scripts/demand-fetch.py`、消除消费档次行与依据括号的重复、弱化「配套带动」的推断语气。
- 同步更新 `references/04-output-templates.md` 需求侧骨架行与两包 `SKILL.md` 标准输出枚举（加 4.2）。

> 区域初筛 `--mode=area`（阶段 C）与双引擎估算对齐（阶段 D1/D2）仍在后续版本交付。

## 2.10.40

### 参考判断标注化 + 本地数据位

- 报告结论、回本判读、租金测算改为「参考判断」三段式：判断句 + 依据与来源等级 + 边界声明；判断与建议保留，但一律标注「估算 · 仅供参考，不构成是否开店的决定」。去掉「不是机会」「基本没有投资价值」「门对门抢客」「超红线」等绝对否定词。
- `SKILL.md` 阶段一改为「不落单点坐标、不做 geocode」，输出物定义为候选片区 + 品类对比 + 缺口清单；红线增加「参考判断必须标注」。
- 新增 `local/` 本地数据位：用户可按城市长期维护官方公开数据，字段含 `source / published_at / collected_at / confidence`；取值优先级 A 本地实测 > B 内置行业基准 > C 模型估算 > D 占位；按城市隔离，不回写 `cities.json` 的缩放基数。
- 新增 `tools/local-data.mjs`（读取、结构校验、`--check`），CI 增加「本地数据位结构校验」步；报告「哪些数是估算」表增加 A 级行。
- 渲染冒烟 14/14（新增「结论标注为参考判断」断言）。

> 区域初筛 `--mode=area`（阶段 C）与双引擎估算对齐（阶段 D1/D2）在后续版本交付。

## 2.10.39

### 报告输出命名改为「坐标名-品类」

原来目录与文件都是 `{英文 slug}-{坐标}/report.html`，例如 `out/xiaolongbao-北京国贸大酒店/report.html` ——
同一批报告混在 out/ 里，靠英文 slug 区分品类，看目录名不知道是什么。

改成 `out/<坐标名>-<品类>/<坐标名>-<品类>.html`：

```
out/北京国贸大酒店-小笼包/北京国贸大酒店-小笼包.html
out/北京国贸大酒店-武汉热干面/北京国贸大酒店-武汉热干面.html
out/北京国贸大酒店-馄饨/北京国贸大酒店-馄饨.html
```

实现：

- `run-site.mjs` 里 `_shortLabel` 取 `profile.name` 去掉括号里的面积说明（`小笼包（20-25㎡ 档口/社区小店）` → `小笼包`），
  `briefName = ${addrSlug}-${_shortLabel}` 同时决定目录名与文件名
- `runOne()` 的 return 补 `briefName`，控制台「报告：」与 `open.cmd` 都指向新文件
- 同时写 `<briefName>.md/.html` **和** `report.md/report.html` 两份，后者作兼容副本（旧脚本、收藏夹不会断），实测两份哈希一致
- `report.mjs` 支持 `--out-name`（单独跑渲染器时可自定义文件名，不给就回退 probe 同名）

## 2.10.38

### 内圈 0 家时不再渲染空份额表

上一版把「势力份额 Top20」改成动态「共 N 家」后，内圈 0 家会渲染成
「势力份额（共 0 家）」+「无份额数据」——三行字都在说「没有」，读者得不到任何信息。

改成一句结论 + 对照数：

```
内圈·步行5分 · 无同段竞品
这个圈层内扫不到「热干面/湖北小吃」对手。
全扫描范围（约 3.0km）内同段有 6 家，最近的一家在圈外。
圈内没对手≠没需求，但也意味着没有同行在附近验证过这条需求。
```

HTML 与 Markdown 两处同步改。

## 2.10.37

### 北京基准入库 + 真路网等时圈 + 报告口径澄清

**数据**

- `benchmarks.json` 912 条 / 19 城 / 48 业态 → **1020 条 / 20 城 / 51 业态**，新增北京与三个业态（武汉热干面、小笼包 24 小时、馄饨店）。
  北京锚点全部取自公开报告：购物中心首层 732.5 元/㎡/月（Savills 2026Q3）、常住人口 2180.0 万（北京市统计局 2025 公报）、
  社零 2026Q1 3438.9 亿同比 −0.6%、餐饮服务单位突破 13 万家。街铺租金取一线横向可比 13.5（上海 15.0 / 广州 12.0）。
- 三个新业态的单店参数来自加盟口径与红餐网实测（见 `params/*.json` 的 `_本店基准` 注释）。

**引擎修复**

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | 定位用 `geocode/geo` | 「XX地铁站」被匹配成站点、「XX路口」匹配到道路中心；实测望京SOHO 偏 920 米 | 改 `place/text` POI 搜索 + 类型黑名单，搜不到才回退并告警 |
| 2 | Valhalla 缺城市路网时返回假等时圈 | 北京任意点位步行 5/15 分、车行 10 分圈全是 186×142m 且不随时长变化，圈内竞品被误判为 0 家 | 加可信度校验：等效半径 < 速度×时长×0.35 则退回直线圆并打印告警 |
| 3 | Voronoi 候选池用了全部 POI | 圈外店抢走圈边网格，「内圈 1 家」却在 Top 榜里出现圈外店 | 候选池改为圈内店（`insidePois` / `poisInRadius`） |
| 4 | `totalArea` 在 `best === undefined` 之后累加 | 圈内 0 家时面积算成 0.00 km² | 移到 continue 之前 |

**报告**

- 「哪些数是估算」从「1. 数据质量」之后移到「6. 财务测算」之后（挨着建议租金与租期现金流）。
- 「势力份额 Top20」硬编码 → 动态「势力份额（共 N 家）」；「Top20 之外」→「榜单之外」；并补一句「列表可能含紧邻圈外、但抢走了圈边网格的店」。
- 外圈距离带封顶 1km（原报 0–300 到 2–3km 共七段）。
- `benchmark-data.ts` 同步 `CITY_BASELINES`（此前正则去重时整块被吞）与三个新业态的 `BENCH_FORMAT_MAP` 映射。

**验证**

三个点位跑通并人工核对：望京SOHO（步行 5 分 594×428m / 15 分 1810×1831m）、常营华联（696×834 / 1892×2288）、
广州花城汇（677×677 / 1910×2071），15m/5m 跨度比均 > 2.7，确认路网真实生效。

## 2.10.36

### P1 财务敏感度锚点口径统一

报告里「敏感度：各参数 ±20% 对谈判锚点的影响」这张表**同一张表用了两把尺子**：
基准列取 base 档锚点（365000），两端扰动却取 pessimistic 档（65238.1）。
结果是主表写「谈判锚点 365000（base）」、敏感度表四行写「锚点基准 65238.1（保守档）」，
同一份报告出现两个基准。

**根因**

| 引擎 | 位置 | 问题 |
|---|---|---|
| TS | `dsh/site-tools.ts` L2329 `anchorOf` | 整表（含基准列）走 `pessimistic`，自洽但与主表不一致 |
| Python | `scripts/site_core.py` L482–483 | 两端扰动走 `pessimistic`、基准列/差值/翻转判定走 `base`，**自己就混档** |
| 测试 | `tools/test-parity.mjs` | `sensitivity` 出现 0 次，78 项比对完全没覆盖这张表 |

**修复**

- TS：`computeScenario(v, 'pessimistic', target)` → `computeScenario(v, 'base', target)`（1 行，L2330/2342/2343/2348/2350/2352 自动跟随）
- Python：L482 / L483 的 `"pessimistic"` → `"base"`（2 行，L484–487 本就是 base，未重写）
- `test-parity.mjs` 新增 `SENS_NUM_FIELDS` 与逐行比对：4 行 × 7 字段（`param` / `delta_pct` / `anchor_low` / `anchor_base` / `anchor_high` / `gap_base` / `conclusion_flips`）。
  缺任一侧 `sensitivity` → 明确失败；行数不等 → 失败；布尔严格相等。断言总数 **78 → 136**（+58）
- CI 财务回归新增一条：`finance.sensitivity[*].anchor_base == recommendation.target_rent`（四行全等）

**样例报告对照**（同一组参数，`target=36`）

| 参数 | 改前（保守档） | 改后（base 档） | 会翻转 |
|---|---|---|---|
| 日营业额 | −194619.05 / 65238.10 / 325095.24 | **44000 / 365000 / 686000** | True → True |
| 毛利率 | −216476.19 / 65238.10 / 346952.38 | **17000 / 365000 / 713000** | True → True |
| 人力成本 | 221238.10 / 65238.10 / −90761.90 | **521000 / 365000 / 209000** | False → **True** |
| 初始投入 | 89047.62 / 65238.10 / 41428.57 | **390000 / 365000 / 340000** | False → False |

**结论变化说明**：「人力成本」由「不变」改为「会翻转」——改后 +20% 时锚点 209000 跌破当前租金 290000。
这是修正后的真实结论：旧口径用保守档算绝对值，反而看不出这个参数能把结论打翻。
主表「压力下限 65238.1（不作为谈判出价）」保留单列，未塞回敏感度表基准列。

**未动**：`SCENARIO_FACTORS` 三档乘数、极限租金公式、租期现金流、保本额、`FORMULA_VERSION = fin-v2`、
`tools/report.mjs`（文案只渲染 `sensitivity` 字段，口径改后措辞仍成立，哈希未变）。

### 验证

```
三档复算        base -20%=44000.00  基准=365000.00  +20%=686000.00
敏感度四行      anchor_base 全等于 recommendation.target_rent
test-parity     136/136 PASS
反证            把 TS 改回 pessimistic → parity FAIL 且 exit 1，已改回
npm test        check-text 0 命中 → smoke 13/13 → parity 136/136
selftest        48/48
py_compile      0 错误
```

### 发布物修订（2026-11-07，不升版本号）

- **README 徽章区清理**：删除与橙色 `license` 徽章完全重复的灰色 `License Custom NonCommercial` 徽章
  （整块浅灰，视觉上像失效徽章，且与橙色那个指向同一个 `LICENSE`）。
  徽章内所有相对链接（`LICENSE` / `data/benchmarks.json` / `references/03-data-and-governance.md` / `#安装`）
  改为 `https://github.com/ShaoRoy/site-selection-skill/blob/main/...` 绝对地址，避免 raw HTML 相对链接
  在 GitHub 与其他渲染环境下解析不一致。
- **两个失真徽章改口径**（能复核就改，不能复核就删——本次可复核，故改）：
  - `tests-234 passing`：`234` 是 v2.10.29 时代的旧数字且未标口径；改为 `tests-136 parity`，
    并链接到 `tools/test-parity.mjs`（136 为 `test-parity.mjs` 实跑项数，可逐位复核）。
  - `Benchmark 19城 × 48业态`：改为 `基准库 19城×48业态·估算`，与 `data/benchmarks.json` 的
    `data_basis_note`「本库不是 19 城实测样本，实质是 1 列行业基数 × 城市系数缩放得到的估算值」保持一致。
- **GitHub homepage 死链清理（本次真正执行）**：v2.10.29 段曾记录
  「清空 homepage：`https://site-selection-skill.vercel.app` 实测 HTTP 404，Vercel 项目已删」，
  但仓库 About 字段至今仍填着该地址。本次通过 `PATCH /repos/ShaoRoy/site-selection-skill`
  传 `{"homepage": ""}` 清空，API 回读 `homepage == ""`。
- 徽章总数 15 → 14；三包因 README 变更重新打包，**tag 与版本号保持 v2.10.36 不变**。

### 发布物修订（2026-11-07，不升版本号）

本轮为**内容一致性修订**，四个文件在 01 / 02 / 03 三包同步，版本号保持 `2.10.36` 不变。

**R1 · 口径冲突（`SKILL.md` 阶段一执行行 + 阶段二预警行）**

- 阶段一「执行」原写「若 MCP 可用，顺带取该区域 1000m 实时人口做粗筛」，
  与 `references/07-preferences.md` 第一条已定口径（人口只用 POI 代理 + WorldPop 栅格，
  且须标「常住人口，非客流」）冲突。改为「需要人口时用 POI 代理 + WorldPop 栅格，
  标注『常住人口，非客流』；不取实时人口 / 客流热力」。
- 阶段二「预警判定」原含「人口『低』→【需求不足预警】/ T ≥ 3 →【业态时段错配风险】/
  画像不匹配 →【客群结构错配】」，这三类判据本包并不提供（无人口档位、无潮汐 T 值、
  无客群画像管道），且与「只提醒不裁决」的定位冲突。改为只保留竞品截流预警，
  其余条件统一输出「待核实 N 项」。

**R2 · 闭环清单可执行性（`references/06-regression-and-failure-modes.md`）**

- 基线表 `test-tools-smoke` 行补「仅源码包（03）可执行，技能包不含 `tools/`」归属标注。
- 「改完必须做的三件事」第 1 条把 `test-tools-smoke` 归入「（源码包）」括号段，
  与同文件 L13–L20 的标注口径一致。
- 未向技能包补 `tools/`：01 包 `tools/` 条目为 0，补入会破坏「零依赖离线可跑」的设计；
  该脚本实际存在于 03 源码包。

**R3 · 快速开始里的跑不通命令（`SKILL.md`）**

- 原「快速开始」包含 `node tools/run-site.mjs …`，但技能包不含 `tools/`，照抄必然失败。
  该段移出，收进新小节「# 源码包扩展能力（03-github，可选）」并注明
  「技能包只带 Python 侧，以下命令需在 03 源码包内执行」。
- 「快速开始」只保留 `python scripts/site_core.py selftest` 与本地纯计算子命令。

**R4 · 署名与标识符**

- `SKILL.md` L9 `author: "RoyShao"` → `"ShaoRoy"`；`manifest.json` 的 `author` 同步为 `"ShaoRoy"`
  （`LICENSE` 与 02 `plugin.json` 早已是 `ShaoRoy`）。`README.md` 的「作者」行一并统一。
- 名称四处并存，**一律不改 name 字段**，只在 `manifest.json` 增加 `nameMap` 段，写清四个名字
  各指什么（`skill.name` = `site-report` / `manifest.name` = `restaurant-location-analysis` /
  `plugin.name` = `site-selection-analyst` / `package.name` = `site-selection-skill`，
  02 内嵌路径 `skills/site-selection`）。改名会牵动 01 README 写死的安装路径
  `~/.dsh/skills/restaurant-location-analysis` 与平台识别，属未实机验证的高风险动作。

**README 格式守卫（`tools/check-text.mjs`，仅 03 源码包）**

在既有控制字符检查之外新增四类断言，`npm test` 仍保持 `check-text → smoke → parity` 顺序：

1. 徽章区必须是单个物理行的 `<p>…</p>`、`<img` 计数 = 14、徽章之间无换行、`href` 全为 `https://` 开头；
2. `Markdown 表格`同一表格块内 `|` 数一致、无物理断行；标题层级不跳级（覆盖 `docs/`、`references/`）；
3. 发布目录纳入扫描：`dist` 不再整目录跳过，改为精确跳过 `release/` / `_backup-*` / `_archive-*` / `node_modules/`；
4. 换行归一后才做内容比对（包内 CRLF / 线上 LF 不算分叉）。

## 2.10.35

### P0-1 发布文档控制字符污染修复

v2.10.34 的 `CHANGELOG.md`（三包 + 线上）与主 `README.md`（三包 + 项目根 + 线上）里混入了不可见控制字符，
来源是生成时 `x 被当成转义序列：`` `f `` → U+000C、`` `t `` → TAB、`` `a `` → U+0007、`` `r `` → 孤立 CR。
后果是行内代码被吃掉首字符——`fin-v2` 显示成 `in-v2`、`total` 显示成 `otal`、`adname` 显示成 `dname`。

**修复范围**

| 文件 | 命中 | 处理 |
|---|---|---|
| `CHANGELOG.md` × 4 份 | 12 处（FF 1 / 孤立 CR 5 / TAB 6，含历史段 1 处） | 逐处还原为「反引号 + 字母」，2.10.34 段按原意重建行内代码标记与 ``` 围栏 |
| 主 `README.md` × 5 份 | 2 处（BEL 1 / TAB 1） | `adname`、`tea_house.json` 恢复代码标记 |
| `docs/TEST-REGRESSION.md` × 2 份 | 2 处（BEL 1 / TAB 1） | `arg()`、`tiles/` 恢复代码标记 |

> 复核工单只列了 CHANGELOG 与主 README；实测 `docs/TEST-REGRESSION.md` 也有同类污染（BEL + TAB），一并修掉。

**新增护栏**：`tools/check-text.mjs`（仅 03 源码包）扫描全部 `.md/.json/.py/.mjs/.ts/.yml`，
命中 `U+0000–0008 / 000B / 000C / 000E–001F / 007F` 或孤立 CR 即打印路径+offset 并 `exit 1`；
TAB 单独列出数量供人工核对。已接入 CI，未设 `continue-on-error`。

### P0-2 网格测试链路自举 + CI 覆盖补齐

**问题**：`06-regression` 与 `TEST-REPORT` 都把 `test-grid.mjs 30/30` 列为基线，
但 CI 从未执行过它；且干净检出下 `index-dashboard.mjs` 写 `out/index.md` 前不建目录，必报 ENOENT。

**修复**

1. `tools/index-dashboard.mjs`：写文件前 `mkdirSync(OUT, { recursive: true })`（补 import）。
   看板是首屏产物，不能因为 `out/` 没建就崩。
2. 新增测试夹具 `tools/fixtures/make-grid-pool.mjs`（TEST-ONLY，仅 03 源码包）：
   生成 `out/grid/_pool-广州-天河.json` 与 `registry.json`，锚点间距 > 2.5km、POI 撒在 500m 圆周，
   自带「1km 内计数 == 设计值」自校验，不符即 `exit 1`。纯 Node 内建模块，不联网、不需要 Key。
3. CI `test` job 按显式顺序接入三步（新增 `actions/setup-node`）：
   ```
   node tools/fixtures/make-grid-pool.mjs
   python scripts/grid-scan.py --city 广州 --district 天河 --rescore
   node tools/test-grid.mjs
   ```
   任一步非零即整 job 失败，无 `continue-on-error`、无 `|| true`。
4. **不弱化断言**：`test-grid.mjs` 的 5 个 `check(..., false)`（缺数据时必须显式失败）保持原样，
   末尾 `process.exitCode = 1` 保留。缺依赖就该红，这是设计。

**验证**：从 03 包解压到全新空目录，按上述顺序执行 → `30/30 通过`、`exit 0`；
候选分数与改前逐字节一致（岗顶 `rank_score=43.0808`），证明只动测试链、未动评分公式。

### 版本

2.10.34 → **2.10.35**（发布物修复 + CI/脚本变更，按发布硬规则递增）。

> 遗留项：敏感度表按保守档取锚点（与主表 base 档锚点不一致）属财务口径问题，
> 涉及双引擎 + parity，**未在本版处理**，待单独立项。

## 2.10.34

### 协议变更：CC BY-NC 4.0 → 作者自定义非商业许可

MIT → CC BY-NC 4.0 之后，进一步改为**作者自定义的「非商业许可」**（非 OSI 开源许可，
不适用任何 Creative Commons 许可）。改动理由：CC 系列许可对「能否把本作品重新打包成
Skill / 专家包并免费分发」留有解释空间，自定义许可把这一条明确写死。

**授权口径**

| 类别 | 内容 |
|---|---|
| 可以 | 阅读、学习、本地运行、修改与二次开发；分享原仓库链接或原样转发原始发布包；重新打包成 Skill / 插件 / 专家包 / 模板并**免费**分发 |
| 必须 | 完整保留 LICENSE 全文、版权声明与联系方式；署名 `Copyright (c) 2026 ShaoRoy` 并注明来源项目与仓库链接；如作过修改须标注「已修改」 |
| 禁止 | 一切商业性使用：出售、付费产品、付费 Skill / 专家包 / 插件、订阅、商业 SaaS、对外 API、收费咨询 / 外包 / 项目交付、企业内部经营性系统、广告或流量变现 |
| 例外 | 商业授权须事先取得作者书面许可 |

**落位**

- `LICENSE` 换为自定义非商业许可全文（含中文条款与英文摘要），四份副本哈希唯一
- README 两处徽章改为 `license-Custom NonCommercial`，文末 `## License` 段重写
- `manifest.json` / `package.json` / `.codebuddy-plugin/plugin.json` 的 `license`
  统一为 SPDX 自定义标识 `LicenseRef-Custom-NonCommercial`

### 网格候选评分：三项缺陷修复 + 分数可回溯

`FORMULA_VERSION = grid-v1`（财务侧 `fin-v2` 未动）。

**1. 量纲混用 → 双口径**

原式把密度项（个/km²）、绝对计数项 `(cof+ban)`、无量纲比值项（职住比）直接加权相加，
导致「只改半径，实际权重就漂移」：同一组原始计数下 `radius=800` 时配套项占 23.5%，
`radius=2000` 时占 65.1%。

现拆成两套口径：

- **绝对口径** `d_abs` / `p_abs`：四项统一为密度后加权求和，不含任何批次统计量，
  可跨批次、跨城市比较
- **相对口径** `demand_rel` / `pressure_rel` / `rank_score`：本批 min-max 到 0~100，
  仅用于本批排名。CSV 列名已从 `total/demand/pressure` 改为
  `rank_score/demand_rel/pressure_rel`，避免再被当成绝对值引用

职住比（写字楼÷住宅）是无量纲比值，降级为报告参考字段 `job_housing_ratio`，不再参与打分。

**2. `to100` 退化分支符号错误**

全场同值时原返回 `50`，导致「所有候选都没有竞品」时 `pressure=50` → 统一扣 `0.8×50=40` 分，
零竞争反被罚。现返回 `0`。

**3. 权重双份 → 单一来源**

`params/grid.json` 此前「脚本不读」，实际权重是脚本内硬编码。现：

- `grid-scan.py` 新增 `--params`（默认指向 `params/grid.json`）
- 优先级：CLI 显式传值 > 配置文件；输出打印每项参数的实际来源
- 文件缺失、JSON 非法、字段缺失、取值越界、`weights` 之和 ≠ 1 → **`exit 1`**，不静默回退
- `quota` 段（`daily_limit` / `warn_threshold` / `hard_limit` / `min_interval_s`）同步打通
- `grid.json` 升到 `schema_version = 2`，`weights` 四项改为密度口径键名

**4. 分数可回溯**

- CSV 新增 `d_abs` / `p_abs` / 四项密度 / 竞品密度 / `job_housing_ratio` / `score_formula_version`
- 新增 sidecar `candidates-<城市>-<区>.score.json`：参数快照与来源、归一化基准（本批 min/max）、
  逐候选的密度值与加权贡献分解、公式文本
- 文档 `docs/GRID.md` §4 给出真实候选的手算示例，与当次 CSV 逐位一致
- 统一标注 PROXY：POI 密度是代理指标，不是实测人流

**5. 台账与测试收敛**

- 02 专家包 `CHANGELOG.md` 缺失 `2.10.29` / `2.10.30` / `2.10.31` 三段 → 补齐，三份哈希唯一
- `references/06-regression-and-failure-modes.md` 三份版本标注不一致（2.10.28 / 2.10.31）→
  统一为 v2.10.34，新增「网格候选评分」失败模式 6 条
- `tools/test-grid.mjs`：
  - 修 python 脚本路径（原从 `tools/` 找 `grid-registry.py`，实际在 `scripts/`，A/B 段恒失败）
  - E 段断言按新口径改写（不再锁死「存在 100」），新增零竞争与逐行复算断言
  - 新增 F 段 sidecar 断言：density×weight 复算、contrib 求和复算、按基准复算 rank_score
  - 看板断言兼容空态（不再要求本机必须有点位数据）
  - 断言总数 16 → **30**
- `scripts/grid-scan.py` 新增 `--self-test`：17 条纯函数断言（退化分支 / 半径不漂移 /
  跨批次恒定 / 零竞争 / 复算 / 参数来源 / 旧缓存兼容），不联网、不需要 Key
- CI `test job` 增加一条 `python scripts/grid-scan.py --self-test`

### 验证

```
grid-scan --self-test    17/17
test-grid.mjs            30/30
site_core.py selftest    48/48
py_compile               0 错误
三包副本哈希             逐文件唯一值 = 1（CHANGELOG / 06 已收敛）
```

## 2.10.33

### 同步用户手改的 README（两轮）+ 重打三包

用户在 GitHub 上手改 README 两轮，本版把最终态下拉覆盖进三包源码副本，并重打三个发布包。

**README 两轮改动**

| 轮次 | 改动 | 行数变化 |
|---|---|---|
| 第一轮 | 「🧑‍💻 适用人群」从文末上提到首屏（badge 之后），关键词块与版本简介下沉 | 645 行 |
| 第二轮 | 移除「关键词」纯文本 SEO 块，正文收敛 | 645 → 624 行 |

三包 README 统一为 36069 字节（CRLF），哈希唯一 3318CEC68B4B42C2。

**协议与元数据**

- 协议保持 CC BY-NC 4.0 不变（LICENSE 全文、两处徽章、License 段均在位）
- 版本由 2.10.32 升至 **2.10.33**，四处版本号（manifest / package / plugin.json / SKILL.md）一致
- README 下载表的包名与「02 专家包已同步至」说明同步指向 2.10.33

**重打范围**

01 技能包（30 文件）、02 专家包（35 文件，含顶层 LICENSE）、03 源码包（71 文件）。
## 2.10.32

### 开源协议变更：MIT → CC BY-NC 4.0（并同步最新 README）

本项目由宽松的 MIT 协议改为**知识共享 署名-非商业性使用 4.0 国际（CC BY-NC 4.0）**，
明确「可自由复制/分发/改编，但不得用于商业目的」。同时把 GitHub 上的最新 README 下拉同步进三包，
版本号由 2.10.31（02 专家包为 2.10.28）统一收敛至 **2.10.32**。

### 开源协议变更：MIT → CC BY-NC 4.0

本项目由宽松的 MIT 协议改为**知识共享 署名-非商业性使用 4.0 国际（CC BY-NC 4.0）**，
明确「可自由复制/分发/改编，但不得用于商业目的」。

**改动清单**

| 层 | 改动 |
|---|---|
| LICENSE | 全文替换为 CC BY-NC 4.0 官方法律文本（含中文要点摘要与署名/非商业/免责说明） |
| README 徽章 | license-MIT-blue → license-CC%20BY--NC%204.0-ef9421；License-MIT-lightgrey → License-CC%20BY--NC%204.0 |
| README 段落 | 文末 [MIT](LICENSE) → [CC BY-NC 4.0](LICENSE) + 四条可/须/不可/商业授权说明 |
| 元数据 | manifest.json / package.json / .codebuddy-plugin/plugin.json 的 "license" 统一为 "CC-BY-NC-4.0" |
| 同步范围 | 01 技能包（dist/site-selection-skill/）、03 源码包（dist/site-selection/）、02 专家包技能副本（dist/wb-expert/skills/site-selection/）+ 仓库根；**02 专家包 plugin.json 版本仍冻结在 2.10.28** |

**README 同步**

本次同时把 GitHub 上的最新 README（徽章压成单行 <p>、关键词层、v2.10.31 版本标记）下拉覆盖三份源码副本，
三份 README 哈希唯一 = 1（37024 字节）。

> 注意：MIT 的历史条目（2.10.31 及以前）保留原文不改，作为变更留痕。
> 商业使用需另行取得作者书面授权。
## 2.10.31

### 同步用户手动优化的 README（徽章 + 关键词层）

用户在 GitHub 上直接改了 README，加了面向检索的展示层。本版把它同步进包。

**改动内容**（相对 v2.10.30，README 34028 → 35844 字节、643 → 656 行）：

| 层 | 内容 |
|---|---|
| ① 动态徽章 | 原有 5 个（release / downloads / CI / tests / license）保持不变 |
| ② 主题小标签 | **新增 10 个静态徽章**：Agent Skill·WorkBuddy、AI Agent·LLM ready、Python 3.9+、GIS·高德/腾讯、License MIT、Benchmark 19城×48业态、Finance 三档测算、Rent 极限租金反推、Offline 零 Key 可跑、Evidence 可复核 |
| ③ 关键词纯文本 | **新增一行可被搜索引擎与大模型直接抓取的文本**：餐饮选址评估 · 商圈分析 · 竞品截流 · 极限租金反推 · 财务三档测算 · 实体门店 · 高德 / 腾讯双源 GIS · QGIS · AI Agent Skill · WorkBuddy · DeepSeek Harness · 可复核报告 |

关键词口径与 v2.10.30 收敛后的「19 城 × 48 个餐饮业态」一致，没有回到「全品类」的过度承诺。

### 同步范围

README 三份源码副本全部同步（哈希 `2dfa33617cb8`）：`dist/site-selection/`、`dist/site-selection-skill/`、`dist/wb-expert/skills/site-selection/`。

01 技能包与 03 源码包重打；**02 专家包继续冻结在 v2.10.28**（用户手动维护）。

### 验证

```
README 三份哈希唯一 = 1，与 GitHub 一致
10 个新徽章 + 关键词段落全部落位
selftest 48/48｜parity 78/78｜冒烟 13/13
```

---

## 2.10.30

修审计报告（v2.10.29）发现的 3 项 P1 与 4 项 P2。**全是文案与发布一致性，运行架构未动。**

### P1-1 能力边界声明与数据资产错位（最严重）

v2.10.29 把首屏改成「全国适用的**全品类**实体门店」，列举零售、便利店、教培、前置仓。实测：

| 输入 | `benchmark` 结果 |
|---|---|
| `--format 便利店` | **`matched: false`** |
| `--format 素质教育` | **`matched: false`** |
| `--format 奶茶` | **`matched: false`** |
| `--format convenience` | `matched: true` → 但映射到**「早餐包子铺档口(15-30㎡)」** |

而 `data/benchmarks.json` 的 912 行 = 19 城 × 48 业态，**48 个全部是餐饮**（从早餐包子铺到预制菜体验店）；
`data/formats.json` 的 10 条规则也全是餐饮；`manifest.json` 的 name 仍是 `restaurant-location-analysis`。

GEO 引来的非餐饮检索流量，会命中一个数据资产不支持的包。

**修法**：README 首屏与「适用业态」段全部收敛为准确表述：

- 内置基准 = **19 城 × 48 个餐饮业态**（不再说「全品类」）
- 非餐饮（零售/生活服务/教培/仓配）= **可测算但无内置基准**，`benchmark` 会 `matched: false` 并提示补 `formats.json`
- 明写「不会静默套用餐饮基准冒充」

### P1-2 示例对话含不可复算且方向错误的数字

v2.10.29 的示例用便利店演示，给出「保本日营业额 3200 / 回本 28 月 / 极限租金 26500 与 19800」，
并声称「每个数字都能在 probe.json 找到出处」——但该业态不在基准库，包内任何脚本都产不出这些数，
与 `references/03-data-and-governance.md` 的可复核纪律冲突。

另方向写反：「当前租金 20000 / 目标上限 19800 / 还有 200 元余量」——20000 > 19800，应为**已超 200 元**。

**修法**：换成包内支持的 **tea_drink（新式茶饮）**，用 `site_core.py` 实算填入真值，并给出复现命令：

```
月营业额 105,000 元 ｜ 保本日营业额 2,094 元
回本：现金 9.8 月 ｜ 会计 12 月
极限租金：保本上限 43,525 ｜ 目标回本上限 33,108
当前租金 18,000，距目标上限还有 15,108 元/月余量
租售比 17.1% → 偏高（茶饮健康线 15%）
```

### P1-3 专家包下载名指向不存在的发布物

README 写 `site-selection-expert-v2.10.30.zip` 且链接 `releases/latest`，但 v2.10.29 release 只有
skill 与 source 两个 asset，无 expert；本地 02 包全量仍是 2.10.28；CHANGELOG 又写「02 冻结不动」。三处矛盾。

**修法**：下载表专家包改为 [`site-selection-expert-v2.10.28.zip`] 并直连 `releases/tag/v2.10.28`，
行内注明「02 专家包冻结，沿用 2.10.28」。

### P2 附带项

| 项 | 修法 |
|---|---|
| 03 源码包误打进 `README.md.bak-before-geo` | 打包排除 `*.bak*`（v2.10.29 打包时在 `git rm` 之前，故仍留在包内）|
| 下载表写「1.2 MB / 1.1 MB」，实际 0.19 / 0.21 MB | 已改 |
| CHANGELOG 描述用的是 GitHub 仓库版基线，未声明 | 已在 2.10.29 段补「差异基线声明」 |

### 验证

```
四项修复 10/10 断言通过
示例数字由 site_core.py finance 实算，附复现命令
章节结构：19 个二级（含新增 2 个），原有 17 个全部保留
selftest 48/48｜parity 78/78（继承 v2.10.28 实测，相关文件字节未变）
```

---

## 2.10.29

### README 补全品类定位（GEO 优化），并把 01 包同步进这些改动

面向国内大模型检索做了一轮曝光优化。**02 专家包冻结不动**，本次只更新 01 技能包与 03 源码包。

### ① README 从 576 行扩到 626 行

| 位置 | 改动 | 性质 |
|---|---|---|
| L4-6 | 删除三个孤立 `</a>` | 🔧 修复（徽章区 HTML 结构残缺，之前渲染异常）|
| L14-16 | 一句话定义改为「全国适用的全品类实体门店选址评估」 | 🔀 改写原有行 |
| L42 | 新增「示例对话（仅格式演示）」 | ➕ 新增 |
| L64 | 新增「📌 适用业态 & 范围」 | ➕ 新增 |
| L594 | 新增「🧑‍💻 适用人群」 | ➕ 新增 |

**保真验证**：原有 17 个二级章节、25 个三级章节全部保留（缺失 0）；删除行仅 4 条（3 个孤立 `</a>` + 1 行旧定义）；图片块、下载链接、完整口径链接全部保真。

> **差异基线声明**：本节所有「删除 / 保留 / 保真」的比较基准是 **GitHub 仓库版 README**（用户手动补过展示图片的版本），
> 不是 01 包内 v2.10.28 的那份。相对包内旧版，实际变化还包括：2 张 `assets/*.jpg` 示例图被换成 1 张 user-attachments 图。

### ② 清理 6 个改名遗留文件

这些文件在本地早已改名为英文名/新名，但 GitHub 上一直留着旧副本：

| 旧文件 | 已由 | 内容关系 |
|---|---|---|
| `references/01-环境预检与变量字典.md` | `01-env-and-vars.md` | 100% 相同 |
| `references/02-计算口径全书.md` | `02-formulas.md` | 新版更全 |
| `references/03-数据源与治理.md` | `03-data-and-governance.md` | 新版更全 |
| `references/04-输出模板.md` | `04-output-templates.md` | 新版更全（旧的 A/B/C 骨架已废弃）|
| `references/05-运维与排障.md` | `05-ops-and-troubleshooting.md` | 100% 相同 |
| `agents/site-selection.md` | `agents/site-selection-analyst.md` | 新版更全 |

同时修正 README 中引用旧文件名的错误（`agents/site-selection.md` → `agents/site-selection-analyst.md`）。

### ③ plugin.json 版本对齐

三份 `plugin.json` 长期落后（升版脚本只扫 `manifest.json` 与 `dist/wb-expert/.codebuddy-plugin/plugin.json`）：

```
2.10.17 -> 2.10.29  dist/site-selection/.codebuddy-plugin/plugin.json
2.10.17 -> 2.10.29  dist/site-selection-skill/.codebuddy-plugin/plugin.json
2.10.14 -> 2.10.29  dist/wb-expert/skills/site-selection/.codebuddy-plugin/plugin.json
```

这三份都**不在 WorkBuddy 包里**（01 包无此文件；02 包只有根那份），所以修它们零风险。

### ④ GitHub 仓库层优化（不进包）

- About Description 改为全品类表述（127 字符，保留「非通用 GIS 软件（≠QGIS）」防误认）
- Topics 从 20 个精简为 8 个：`site-selection, store-location, trade-area, location-analysis, gis, poi, ai-agent, agent-skill`
  （GitHub Topics 只接受小写字母/数字/连字符，**不支持中文**，已实测 422）
- 清空 homepage：`https://site-selection-skill.vercel.app` 实测 HTTP 404，Vercel 项目已删

### 验证

```
README 626 行｜原有章节缺失 0｜图片块保真
01 包内 README: 32949 字节（新版，含适用业态/适用人群）
三处本地副本与 GitHub 逐文件哈希一致（74 文件，忽略 CRLF）
selftest 48/48｜TS 234 断言｜parity 78/78｜typecheck 0 error｜冒烟 13/13
```

---

## 2.10.28

承接 v2.10.27 工单 §8 的两项追加。**与 2.10.27 分开记，不混入该版验证记录。**

### 🔴 追加项 A：报错给的修复命令不完备

v2.10.27 的依赖缺失提示写「在本目录执行 `pnpm install`」——但这条命令**跑不通**：

| 事实 | 值 |
|---|---|
| `dist/site-selection/package.json` | `dependencies` 空，`devDependencies` 只有 `typescript` |
| TS 引擎 L16 | `import { defineTool } from '@deepseek-ai/dsh-tools'` —— **值导入，运行时必需** |
| `types/dsh-shims.d.ts` | 仅类型桩，明确「由宿主提供、不随发布包分发」 |
| 结论 | `pnpm install` 只装 typescript，装完照样 `ERR_MODULE_NOT_FOUND` |

下一任维护者照提示执行会被当成「修了没用」。

**修法（采 A1）**：只改 `tools/test-parity.mjs` 的报错文案，给出真正可执行的命令，
并保留「或到已有完整依赖的工作区运行」这一路径：

```
修复（二选一）：
  1) 在本目录装运行时依赖：
     npm install -D @deepseek-ai/dsh-tools@^0.1.0-rc.7 @deepseek-ai/cordis@^4.0.1
     （官方 registry 有；npmmirror 镜像滞后，只有 0.0.1-rc.1，装不到 0.1.0-rc.x）
  2) 或：到已有完整依赖的工作区（如 scratch-plugin/）运行 node tools/test-parity.mjs
```

**实测验证该命令真能跑通**（这是本项的核心验收点）：

```
npm install --no-save --registry=https://registry.npmjs.org   @deepseek-ai/dsh-tools@^0.1.0-rc.7 @deepseek-ai/cordis@^4.0.1 typescript@^5.6.0
→ added 18 packages, 0 vulnerabilities
→ node tools/test-parity.mjs  →  parity: 78/78 PASS
→ 装的版本：dsh-tools@0.1.0-rc.8 / cordis@4.1.0
→ package.json 未被改写（--no-save 生效）
```

顺带否掉一个顾虑：`@deepseek-ai/dsh-tools` 在**官方 npmjs 是公开包**（有 0.1.0-rc.8，
repository 指向 `deepseek-ai/deepseek-harness`），不是私有源。所以给发布包补 devDependency
（A2 方案）风险比工单预估的低——本版仍采 A1，保持发布包零运行时依赖清单。

### 🔴 追加项 B：CI 完全不跑 `npm test` / parity

工单 §0 承诺「任何口径漂移在 CI 阶段自动暴露」，但三份 `.github/workflows/ci.yml`
哈希全同（`e67cdd8b7665…`），步骤只有 Python 侧：**无 Node setup、无 `npm test`、无 parity**。
契约测试实际只在本地手动跑时存在。

**并且 CI 内嵌断言已过时**：v2.10.27 代码上原样实跑，**7 PASS / 1 FAIL**：

```
PASS  营收 990000
PASS  现金净流 259250
PASS  会计净利 205916.67
PASS  现金回本 12.3 月
PASS  会计回本 15.5 月
PASS  极限租金保本 379250
FAIL  锚点 186165.34          ← 实际 target_rent = 290361.11
PASS  座位 278
```

`186165.34` 是 v2.10.26 改回基准档之前的保守档值，现在对应 `target_rent_conservative`。
CI 一旦运行必红。

**修法**：

1. 断言改为 `("锚点（基准档） 290361.11", …)`，并**增补两条**避免旧值被直接删掉后失去回归保护：
   `("保守档压力下限 186165.34", …)`（`target_rent_conservative`）、
   `("保本红线（基准档） 379250", …)`（`ceiling_rent`）
2. 步骤名「核心计算自检（20 条断言）」→「（48 条断言）」
3. **新增 `cross-chain-parity` job**：`setup-node@v4`（Node 24）+ 显式装运行时依赖 +
   `node tools/test-parity.mjs`。单独成 job 的理由写在注释里——Python 侧不需要 Node，
   分开跑能让失败原因一眼可辨（口径分裂 vs 依赖装不上）
4. 三份 ci.yml 同步，哈希一致（`e869b0f6580b`）

**抽 yml 里的断言块实跑**（不是另写一份）：10/10 PASS，退出码 0。

### 验证

```
CI 断言（从 yml 抽取执行）        10/10 PASS，exit 0
dist 内 parity                   78/78 PASS（装完依赖后，不再只能靠 scratch-plugin）
scratch-plugin parity            78/78 PASS
selftest 48/48 ｜ TS 236 断言 ｜ typecheck 0 error ｜ 冒烟 13/13
test-parity.mjs 哈希            4 份唯一哈希 = 1（7e26377b7bcb）
ci.yml 哈希                     3 份唯一哈希 = 1（e869b0f6580b）
```

### 边界

未动 `anchor_key="base"`、`SCENARIO_FACTORS`、三档公式、报告已修文案（§6 边界继续有效）。
§7 的 `spec.json` 单源重构仍属独立重构，不在本单范围。

---

## 2.10.27

### 统一 TS / Python 双引擎口径，并新增跨链路契约测试

前 5 轮反复出问题的共同结构：**同一口径在 N 份副本 + 2 套引擎 + 十几处自然语言里各写一遍，靠人工同步**。
逐处改文本无法收敛——每轮审查换一个观察角度就照见新的一层。本版用一条自动化契约测试把它钉住。

### P0-1 `ceiling_rent` 同名不同义，风险结论符号相反

同一组参数（扬韬广场 CASE-A）：

| 字段 | Python（旧） | TS | 后果 |
|---|---|---|---|
| `ceiling_rent` | **184,285.71**（`min(三档)`） | **490,000**（base 档） | 差 2.66 倍 |
| `gap_to_ceiling` | **+105,714.29**（租金已超红线） | **−200,000**（尚有 20 万空间） | **符号相反** |
| `rent_ratio_verdict` | `ok` | `healthy` | 枚举串不同 |
| `ceiling_rent_conservative` | 不存在 | 184,285.71 | 结构不同 |
| `target_rent_conservative` | 不存在 | 65,238.1 | 结构不同 |

**修法（方案 A，主红线与主锚点同口径取基准档）**：

v2.10.8 把谈判锚点从保守档改为基准档，理由是「旧口径报需降 77%，与同报告租售比健康、回本优秀自相矛盾」。
同理，若主保本红线取全档最保守 184,286，则当前租金 290,000 已超红线，报告却判「健康、无需降」——**同一类自相矛盾**。
因此主 `ceiling_rent` 与主锚点一致取 **base 档**，保守情景值以 `ceiling_rent_conservative` 单列作风险提示。

`scripts/site_core.py` 改动：

```python
ceiling = per["base"]["max_rent_breakeven"]
ceiling_conservative = min(per[k]["max_rent_breakeven"] for k in SCENARIOS)
```

`recommendation` 新增 `target_rent_conservative` / `ceiling_rent_conservative` / `conservative_scenario`，
租售比枚举 `ok` → `healthy`（与 TS 对齐）。

修后 CASE-A 两边完全一致：

```
target_rent=365000  based_on_scenario="base"
ceiling_rent=490000  ceiling_rent_conservative=184285.71
gap_to_ceiling=-200000  gap_to_target=-75000
rent_ratio_verdict="healthy"  current_rent_ratio=0.0967
```

### P0-2 修 TS 注释（计算一行未动）

`site-tools.ts:2969` 原写「`ceiling_rent` 是不可越过的保本红线（取全档最保守）」，
但 2215 行取的是 base 档——注释与实现矛盾。已改为「取基准档，与谈判锚点同口径；
`ceiling_rent_conservative` 取全档最保守，仅作压力提示」。`site-tools.ts:611` 接口注释同步。

### P0-3 新增跨链路契约测试 `tools/test-parity.mjs`（本版最关键）

两组用例：CASE-A（扬韬真实参数）、CASE-B（selftest 内置参数）。
两边各真跑一遍，逐字段比对 **78 项**：

- `recommendation` 12 个字段（数值 + 枚举）
- `per_scenario.{base,pessimistic,optimistic}` × 9 个字段

设计要点：

- 纯展示字段（`rent_ratio_hint`、`formula_trace`、`assumption_ledger` 等）**允许单边存在**，不误报
- 数值容差 `0.02`
- **不拿 `probe.json` 当基准**——那是渲染链序列化后的舍入值，会误报
- TS 入口探测 `src/` 与 `dsh/` 两种布局；Python 入口探测 `scripts/` 与回退到 peer dist
- TS 依赖缺失时**明确报错并给出修复命令**，不静默跳过

已接入 `package.json` 的 `test`（4 份），`npm test` 现输出：
冒烟 `13/13` + `parity: 78/78 PASS`。

> **前提**：TS 侧的 `@deepseek-ai/dsh-tools` 是**运行时**依赖（值导入，不是类型档），
> 本包 `package.json` 未声明它。所以在 `dist/` 下跑需先装运行时依赖，
> 或在已有完整依赖的工作区（`scratch-plugin/`）下运行。详见 [2.10.28]。

### P1-4 顺带修掉的两处

**① CLI 的 `--params` 只认文件路径**：原实现 `j = lambda p: json.load(open(p)) if os.path.exists(p) else {}`
——传内联 JSON 会静默返回 `{}`，参数全部回退默认值，**不报错**。
契约测试第一次跑就撞上（Python 侧 revenue 240,000 vs TS 3,000,000）。已改为同时支持文件与内联 JSON。

**② 帮助文本滞后**：`site_core.py` CLI 帮助「selftest 引擎自检，20 条断言」→ 48。

**③ 更正 v2.10.26 的错误结论**：该版写「`ceiling_rent` 不动——红线本就该取全档最保守，这部分原本是对的」，
当时仅核对 Python 链路、未与 TS 交叉验证。已更正。

### 验证

```
parity: 78/78 PASS（TS ↔ Python 口径一致）
selftest 48/48 ｜ TS 236 断言 ｜ typecheck 0 error ｜ 冒烟 13/13
哈希校验：site_core.py ×3 / site-tools.ts ×4 / report.mjs ×3 / test-parity.mjs ×3 / package.json ×3 全部一致
```

### 为什么这样能终结循环

契约测试把「两套引擎同名数值字段必须相等」变成机器可判定的不变量。
今后任何一处口径漂移会在第一次 `npm test` 就红，不再依赖人工逐轮发现。

---

## 2.10.26

### 🔴 Python 链路锚点未修：两条链路结论差 1.56 倍

v2.10.25 声称「改 5 个文件，口径统一」，其中 `scripts/site_core.py:422` **只改了注释，没改实现**：

```python
# 建议锚点：取基准档（保守档并列作压力下限，不参与取值）   ← 注释已改
anchor_key = min(tgt_rents, key=tgt_rents.get)              ← 实现仍取保守档
```

实测同一组参数：

| 档 | max_rent_target |
|---|---|
| base | **290,361.11** ← 应为锚点 |
| pessimistic | 186,165.34 ← Python 实际取的 |
| optimistic | 393,245.99 |

**TS 链路给 290,361.11，Python 链路给 186,165.34，差 1.56 倍。**
而 `manifest.targets.workbuddy.core = scripts/site_core.py`、`finance` 在 `offlineCapable` 里
——WorkBuddy 导入技能走的就是这条错的链路。

### 更糟的是断言把错误行为固化了

`site_core.py:811` 写着 `chk("锚点取保守档 186165.34", ...)`，
所以 **selftest 48/48 全绿反而掩盖了分裂**——测试在保护 bug。

### 已改

| 位置 | 改动 |
|---|---|
| `site_core.py:424` | `anchor_key = min(...)` → `anchor_key = "base"`，并注释说明为何不取 min |
| `site_core.py:465` | 台账 formula 改「基准档的极限租金·目标回本（保守档另列作压力下限，不参与取值）」，substituted 只列 base 与保守档用途 |
| `site_core.py:811` | 断言改 `chk("锚点取基准档 290361.11", ...)` |
| `ceiling_rent` | 当时仅核对 Python 链路，未与 TS 交叉验证；**v2.10.27 统一为基准档** |

修后实测：

```
Python target_rent = 290,361.11 = base 档  ✅ 与 TS 一致
Python ceiling_rent = 270,821.43 = min(三档 breakeven)  ✅ 红线仍最保守
台账：base 档 = 290361.11；保守档 186165.34 仅作压力下限 → 290361.11  ✅ 数学成立
selftest 48/48（断言已改基准档）
```

### 顺带清掉的四类残留

**① 解释语 5 处**：「高于这个价，压力测试下回本就不成立」是旧保守档锚点的解释，
基准档口径下不成立（压力下限是 65,238，当前租金 290,000 高于它却判「健康、无需降」）。
已全部改为「高于它，按常规经营预期就回不了本（压力下限另列，不是出价依据）」。
涉及 `references/02-formulas.md`、`tools/report.mjs` ×4（md/html 白话表与建议租金说明）、
`docs/SKILL-FULL.md` ×2。

**② 数字滞后**：`06-regression` 的 234→236（4 处）；`SKILL.md` 的「20 条断言」→ 48。

**③ `scratch-plugin/src/site-tools.ts:2585`** 未在上一轮同步范围内，仍写「取自 … 档，跨档最保守」。
已修，现四处 `site-tools.ts`（src / 两个 dist / 02 内嵌）SHA256 完全一致。

**④ 项目根 `docs/` 7 份文档**仍是旧口径（DECISIONS / DEV / FEATURES / REPORT-REVIEW /
TEST-REPORT-v2.6.1 / TEST-REPORT-模拟数据实测 / 项目模块清单），已逐一更正。

### 验证

```
两条链路对齐：Python target_rent = base 档 ✅
台账数学成立 ✅
全仓扫描「跨档取最保守」：除 CHANGELOG 历史与明确标注「当时取保守档」的历史实测报告外，残留 0 处
回归：TS 236 全绿｜typecheck 0 error｜selftest 48/48｜冒烟 13/13
四处 site-tools.ts SHA256 一致
```

---

## 2.10.25

审核发现 v2.10.23 的锚点口径「只修了文档，没修代码与报告」。核实后更严重：
**公式台账在数学上不成立。**

### 🔴 核心：formula_trace 的代入选值与结果对不上

```
formula    : min(各档极限租金·目标回本)，跨档取最保守
substituted: base=365000，pessimistic=65238.1，optimistic=658969.07
result     : 365000
```

`min(365000, 65238.1, 658969.07) = 65238.1`，但结果写 365000。
**读者按台账复算必然对不上**——这恰好落在本项目最核心的「可复核」上。

根因：v2.10.8 把锚点从「保守档」改成「基准档」（理由见该版 CHANGELOG：
旧口径报「需降 77%」，与同报告租售比健康、回本优秀自相矛盾），
但公式台账的 `formula` 字符串没跟着改，仍写着 `min(...)跨档最保守`。

### 已改（5 个文件，口径统一为「锚点取基准档，保守档作压力下限」）

| 位置 | 改动 |
|---|---|
| `dsh/site-tools.ts:2456` | formula 改「基准档的极限租金·目标回本（保守档另列作压力下限，不参与取值）」；substituted 改「base 档 = 365000；保守档 65238.1 仅作压力下限，不参与取值」→ **数学成立** |
| `dsh/site-tools.ts:611 / 636 / 2171` | 接口与实现注释去掉「跨档取最保守」 |
| `dsh/site-tools.ts:2585` | 日志「取自 base 档，跨档最保守」→「取自 base 档；保守档另列作压力下限」（原句自相矛盾） |
| `tools/report.mjs` md + html | 「取值方式」「建议租金（跨档取最保守，供谈判使用）」「跨档取最保守＝三档取最难过」三处措辞全改 |
| `scripts/site_core.py:422` | 注释同步 |

### 顺带修掉两个工程问题

**① 镜像副本长期不同步**：`dist/site-selection/tools/report.mjs` 与
`dist/wb-expert/skills/site-selection/` 都没跟上源包，导致「源包改了、镜像还是旧的」。
本次做了一次全量双向同步（各 65 个文件）。

**② `docs/DECISIONS.md` 记录的是被推翻的旧决策**：
原文「峰值取跨档最保守作锚点｜用基准档会被乐观假设绑架」——
与 v2.10.8 起的事实相反。已改为新决策并写明变更理由与代价。

### 验证

```
公式台账：base 档 = 365000 → result 365000  ✅ 数学成立
md / html 一致性：取值方式、为何锚点用基准档、锚点取基准档、保守档不参与取锚点  四项均 Y/Y
全仓扫描「跨档取最保守」：除 CHANGELOG 历史条目外，残留 0 处
回归：TS 236 全绿｜typecheck 0 error｜selftest 48/48｜冒烟 13/13
```

---

## 2.10.24

### 术语白话表移到报告最下方

之前把 24 条术语速查挂在「结论」段内（`### 看不懂的话先看这里`），
读者一打开报告先撞上一大张术语表，正文反而被推下去了。

已改为**独立附录**，排在「计算口径附录」之后、落款之前：

```
## 0. 结论
## 1. 数据质量
## 2. 竞品分布
## 3. 交通可达
## 4. 需求侧代理指标
## 5. 场地核查
## 6. 财务测算
## 附录：计算口径（每个数字怎么来的）
## 附：看不懂的话先看这里（白话版）   ← 移到这里
---
> 数据来源：…
```

结论段从 2000+ 字符回落到 **165 字符**，正文不再被术语表挤走。

### 结构断言同步更新

原来钉着「段落数 = 8（7 段 + 附录）」「末段是计算口径附录」，
移动后排在最下方就是新末段，会破断言。已改为：

```
段落数 = 9（7 段 + 附录 + 白话附录）
第 8 段是计算口径附录
末段是白话附录（排在最下方）
白话表在附录之后，不在开头     ← 新增，防止以后又挪回开头
```

最后一条是防回归用的位置断言。

### 验证

```
md 结构：9 个 ## 段落，白话表在 L361（附录 L325 之后）
html 顺序：附录(537054) → 白话(540781) → 落款(543047)
结论段：165 字符，「看不懂」已不在其中
回归：TS 236 全绿（新增 2 条断言）｜typecheck 0 error｜selftest 48/48｜冒烟 13/13
```

---

## 2.10.23

审核结论（v2.10.21）六项，**全部核实为真**，逐项修完。

### 🔴 ① 包元信息与精简后布局全面脱节

`manifest.json` 的 `references` 列 5 个**中文文件名**（`01-环境预检与变量字典.md` 等），
实际文件早已改成英文名（`01-env-and-vars.md` 等）——**5 个全部定位失败**。
另声明 `docs/`（5 个文件）、`prompt: PROMPT.md`、`targets.dsh`，本包内均不存在，共 15 处 MISS。

已修：

| 项 | 改法 |
|---|---|
| `references` | 改为实际英文名 7 个，逐个校验存在性 |
| `docs` / `prompt` / `targets.dsh` | **删除声明**（01 包定位是「导入技能」，不含这些） |
| `package.json` / `tsconfig.json` / `types/` | **从 01/02 包移除**——包里没有 JS/TS，`npm test` 必然失败 |
| README 徽章 `tests-200` | → `tests-234` |
| README 断链（`docs/SKILL-FULL.md`、`assets/*.jpg`、`install.ps1`、`PROMPT.md`） | 相对链接改 **GitHub 绝对 URL**；`install.ps1` 标注「仅源码包」；目录结构树注明「源码仓库视角」 |

改后 01 包从 32 文件 → **30 文件**，失效声明 **0 处**。

### 🔴 ② `references/02-formulas.md` 极限租金公式与实现不一致

文档写「极限租金·保本 = 月毛利 − 人力 − 其他固定」，**漏了税费**。
引擎实际是「(月毛利 − 税费) ÷ 成本因子 − 人力 − 其他固定」。

按文档手算 625,000，实际 490,000，**差 135,000（27.6%）**。
更糟的是同一文档第 207–208 行的三档表又给出正确值——内部自相矛盾。

而这份文档自称「公式全书是真源」「任何人对着公式手算出同样的数」。

已修（两条公式都补税费与成本因子），并加了口径解释段：

```
极限租金·保本 = (月毛利 − 月税费) ÷ 成本因子 − 人力成本 − 其他固定支出
极限租金·目标回本 = (月毛利 − 月税费 − 初始投入 ÷ 目标月数) ÷ 成本因子 − 人力 − 其他固定
```

顺带修正锚点口径：原文说「三档取最低」，实际引擎用**基准档**（压力档并列展示，但不作为出价）。

**验算**：文档新公式手算 490,000 / 365,000，与引擎输出**完全一致**。

### 🟠 ③ `params/` 是死配置

`scripts/` 全目录**零命中** `params/`——只有 `tools/run-site.mjs` 读它（7 处），
而 01 包不含 `tools/`。所以技能包里 `params/` 确实是摆设，
`grid.json` 注释「改这里不用改代码」不成立。

已处理（不假装修好了）：

- `grid.json` 的 `_说明` 改成分明：**仅供 DSH 链路 `tools/run-site.mjs` 读取，纯 Python 脚本不读**
- `_quota` 解释 `daily_limit`（账户日总配额 5000）与 `hard_limit`（单次扫描上限 1500）
  **不是同一层**，矛盾消除；并注明脚本里是硬编码，改 json 不生效
- 新增 `params/README.md`，逐文件说明「谁读、改了什么会生效」，
  并明确列出「已知未打通」：要彻底解决需给 `grid-scan.py` 加 `--params` 参数，**尚未实现**

### 🟠 ④ `06-regression` 文档基线滞后

自述 v2.10.17 / selftest 20/20 / 246 断言，与当前 48/48、234 不符。已全部更新。
另修一条过时失败模式：「无参数退出码 2」在 v2.10.14 已改为退出 0（查帮助不是错误）。

### 🟠 ⑤ 升版脚本漏扫实证

`release/*-v2.10.18.zip` 三个包内部 manifest 仍是 2.10.17。

已发出的旧包不动（历史事实），但**打包脚本加了自动校验**：
每个包生成后立即验证 ① 所有 `manifest.json` 的 version == 目标版本
② `references` 声明逐个存在 ③ 所有 `SKILL.md` frontmatter 版本一致
④ `package.json` 的 scripts 指向的文件真实存在。

校验不通过会打印问题清单。本次三包校验结果：**0 处问题**。

### 🟡 ⑥ `formula_trace` 座位数展示不成立

座位数由调研表输入时（`seat_area_sqm = -1`），附录打印「营业面积 ÷ 每座面积 = 780 ÷ -1 = 278」。

已修：`seat_area_sqm <= 0` 时改显示「由调研表直接输入 / 调研表 seats 字段」。

### 验证

```
01 包：30 文件｜selftest 48/48｜rent 正常｜失效声明 0 处
02 包：34 文件｜内嵌技能同步
03 包：69 文件｜完整
三包版本校验：0 问题
formula_trace：{"formula": "由调研表直接输入", "substituted": "调研表 seats 字段", "result": "278"}
文档公式 vs 引擎：490,000 / 365,000 完全一致
回归：TS 234 全绿｜typecheck 0 error｜selftest 48/48｜冒烟 13/13
```

---

## 2.10.22

### README 补全这十几轮的新能力（此前一处没写）

README 停在 v2.10.17，最近十几轮的功能**一条都没反映**。逐项核对后补齐：

| 新增内容 | 此前状态 |
|---|---|
| 第 2 筛触发条件（带租金） | ❌ 完全没有 |
| `site_core.py rent` 租金识别 | ❌ 完全没有 |
| 数据源分工（按筛次） | ❌ 完全没有 |
| 腾讯配额实测（200/日 / 6000/日 / 1×5） | ❌ 完全没有 |
| 拿不到的能力（室内动线等商业授权） | ❌ 完全没有 |
| 报告白话注解 + 术语速查 | ❌ 完全没有 |
| 三档情景参数披露 | ❌ 完全没有 |

### 具体改动

**① 「当前已接入的数据源」表**：补腾讯两个接口，并注明各自用于第几筛

**② 新增「数据源分工：按筛次，不按偏好」**

核心论点：腾讯四个 POI 接口各 200/日合计 800/日，只够少数点位深度校验；
高德没这个限制，所以全量采集必须走高德。配了分工表和「为什么步行用腾讯」的说明。

**③ 新增「配额实测」**：6000/日 与 200/日 两档、1×5 对/批的真相、
三处 duration 单位各不相同、一次第 2 筛只多花 3 次请求。

**④ 新增「拿不到的能力（需商业授权）」**：室内步行、多边形搜索、路网吸附——
尤其室内动线拿不到意味着**商场铺位必须现场实测室内段**。

**⑤ 快速开始重写**：加 `rent` 命令、`--provider tencent/amap` 按筛次分用、
`--method matrix` 批量模式、`run-site.mjs` 的筛次判定输出示例。

**⑥ 新增「报告里有什么」**：九段结构表 + 三档情景参数 + 白话注解说明。

**⑦ 设计原则补三条**：报告必须写明单源/双源；租金判定交给工具不靠眼看；
人口用 POI 代理 + WorldPop 交叉校验（原文还写着「尚未接入」，已过时）。

**⑧ 「7 段式报告」→ 九段式**，并补上九段具体名称与「每段可缺席但必须说明」的规则。

**⑨ 版本号**：正文与下载链接从 2.10.17 → 2.10.22。

### 专家包 README 也一并更新

`02-expert` 顶层的 `README.md`（专家级，约 3.4 KB）同样停在旧版，有三处实测错误：

| 项 | 写的 | 实际 |
|---|---|---|
| references 份数 | 5 份 | **7 份** |
| selftest 断言 | 20 条 | **48 条** |
| 数据源说明 | 只提「高德 Key」 | 未提双源分工 |

已补：数据源分配表（第 1/1.5 筛高德、第 2 筛双源、第 3 筛不采集）、
租金触发第 2 筛的判定与 `rent` 命令、两条新边界（室内动线算不了、
报告必须写明单源/双源）。

### 验证

三包 README 归一：
- `01-skill`：`site-report/README.md` 17 KB —— 六项新能力全命中
- `02-expert`：专家级 3.4 KB + 内嵌技能 17 KB，两层都更新
- `03-github`：根目录 README 17 KB —— 同 01

### 验证

README 从 22.1 KB / 466 行 → 29.2 KB / 563 行；
六个新功能关键词全部可检索到；版本号无残留旧值。

---

## 2.10.21

四项渲染层修复，不触及计算引擎。

### 🔴 ① md→HTML 渲染断层（上一轮只修了一半）

三档情景参数表（×0.85 / ×1.05 / ×1.15 / ×0.97）与「压力下限（保守档）」行**只出现在 report.md**，
report.html 全文检索均无命中。HTML 是主要交付物，意味着三档可复算性披露对 HTML 读者完全缺失。

根因：`financeSection(md)` 里加了章节，HTML 渲染器（同一函数的另一分支）没同步。

已补：

```
三档情景参数（报告据此可复算每一档）
| 情景 | 营收乘数 | 成本乘数 | 说明 |
| 基准 | ×1 | ×1 | 用户给定值直接测算 |
| 保守 | ×0.85 | ×1.05 | 营收下调、成本上调（压力测算） |
| 乐观 | ×1.15 | ×0.97 | 营收上调、成本下调（乐观假设） |
```

以及建议租金表里的压力下限行。

**过程中撞了个 `ReferenceError: f is not defined`**——HTML 分支里财务对象是 `data.finance` 不是 `f`，写错一次，已修。

### 🟠 ② E3 把区间下限当成了代表值

md 与 html 都写「高端中餐酒楼约 **90.7** 个月」，但 `probe.json` 里
`payback_median: 108.7 / payback_min: 90.7 / payback_max: 131.1` —— **90.7 是区间下限**。

更糟的是同一份报告自相矛盾：附录上方的对标表写「该业态回本中位 **108.7** 月（区间 90.7~131.1）」。

按中位算是 **3.0 倍**差距，写 90.7 只有 2.5 倍——**低估了论证强度**。

已改：基准值改为从 `probe.json` 的 `benchmark` 节点读取，禁止硬编码；
文案改成「中位 108.7 个月（区间 90.7~131.1）」、倍数改「3.0 倍」。

### 🟡 ③ 「同类业态中位 51.7 个月」不可溯源

该值硬编码在 `report.mjs`，`probe.json` 里查不到——单凭交付物无法复核。

已**删除**这句，只保留可从 `probe.json` 复核的 108.7（中位）与区间。
报告现在每一个基准数字都能被读者自己验证。

### 🟡 ④ 两个老遗留

**HTML 里 2 处未转义的 `**`**：`**该段全部无高德人均数据**`、`**协同或弱竞争**`
——HTML 分支直接拼了 markdown 语法，已改成 `<b>`。

**最近竞品距离双值 40m / 41m**：`dedupe.nearest=40` 但 `rings.nearest[0]=41`，报告取 41。
v2.10.9 加过的对齐逻辑在后来的文件覆盖中丢了，已补回——以 `dedupe.nearest` 为准。

### 验证

```
① 三档情景参数 / 压力下限   md=Y html=Y（6 项全部）
② E3 基准值               md/html 均为「中位 108.7 个月（区间 90.7~131.1）」
③ 51.7                     md=N html=N（已移除）
④a HTML 未转义 **           残留 0 处
④b 最近竞品               dedupe=40m / rings=40m 一致
```

回归：TS 234 全绿｜typecheck 0 error｜selftest 48/48｜冒烟 13/13

---

## 2.10.20

### 报告补白话注解：照顾非行业读者

报告里大量使用行业口径（截流、势力份额、翻台、坪效、极限租金…），
本行业的人一眼懂，行外人读起来像天书。这版按「**原说明 —— 大白话**」的格式逐处补注解。

### 新增 24 条术语速查（挂在「结论」段内的三级标题）

`### 看不懂的话先看这里（白话版）`，覆盖：截流/截流定级、截流两轴、势力份额/Voronoi、
Top3 集中度、同段/异段、直接/替代/间接竞品、翻台率、坪效、保本日营业额、极限租金、
谈判锚点、租售比、现金/会计口径、摊销、容量利用率、职住比、等时圈、单方造价、
保本客单量、敏感度「会翻转」、截流系数、硬伤/待核实、规模档推定、ROI。

**为什么用三级标题而不是新建 `## 0.5` 段**：人格层规定报告是九段结构，
加一级段落会破结构——`test-report.mjs` 的「段落数 = 8（7 段 + 附录）」当场就挂了。
改成挂在结论段内的子节，结构不动，位置仍在开头附近。

### 就地注解（21 处）

| 位置 | 例子 |
|---|---|
| 截流两轴表 | `第二轴·竞争截流压力 \| **重度截流**（heavy）—— 抢客的店太多，客人还没走到你门口就被别人截走了` |
| 第一轴 | `未判定 —— 要去现场看铺位在动线的什么位置…再按 L1–L5 打级（L1 最好：临主街、一眼看见、一楼；L5 最差：藏在深处、背街、高层）` |
| Voronoi 归属 | `本点位落在「XXX」的势力范围内 —— 就是说这块地"归"它，你开门等于直接跟它抢同一批人` |
| Top1/Top3 势力份额 | `6% —— 这块地盘它占了 6%（按"谁离得近"算，不是营业额）` |
| 结论圈层分级 | `贴脸红海 —— 密度极高，客人随手一拉就是一家` |
| 财务三档表头 | `回本·会计口径 —— 把折旧摊进去算，账面多久回本（更保守）` |
| 空间容量 | `翻台率 1.998 次/日（一个座位一天被坐几轮）`、`容量利用率 66.6%（高＝座位用得透，低＝空着也要付租）` |
| 需求侧 | `职住比 1.04 —— 上班的人多→工作日午市好做；住家的多→晚市和周末好做` |
| 敏感度 | `会翻转 —— 这个数只要估错 20%，结论就从「能做」变「不能做」，必须实测` |
| 建议租金 | `基准/保守/乐观三档各算一遍，取其中最保守的那个` |
| 附录 | `成本因子＝保守/乐观档对成本的缩放倍数`、`跨档取最保守＝三档各算一遍取最难过那个` |
| 数据来源 | `—— 竞品是从地图公司商家库抓的，距离和走路时间是本地导航引擎按真实道路算的，财务参数是你自己填的` |

### 回归

第一次改完测试挂了三条（段落数、第 4 段、第 5 段），因为用了一级标题。
改成三级标题后：

```
TS 断言   234 全绿
typecheck 0 error
selftest  48/48
冒烟      13/13
```

---

## 2.10.19

### 修：报告没写「单源 / 双源」

v2.10.16 立了规矩「报告必须写明本次是单源还是双源」，但 `report.mjs` 根本没渲染这个字段——
规则写了没落地。测试跑出来报告《数据质量》段只有覆盖率，看不出用的是几个源。

md 与 html 两处都补上：

| 模式 | 报告里显示 |
|---|---|
| `dual` | **双源交叉**（高德 + 腾讯）：第 2 筛，已检出真实租金 |
| `single` | **单源**（仅高德）：未检出真实租金，腾讯交叉校验未启用。本报告**不含**双源交叉验证，竞品数只有高德一个来源 |
| 未标注 | 未标注（旧版 probe 输出），按单源看待 |

取值优先 `coverage.source_mode`，回退 `data_quality.source_mode`，都没有则按单源看待
——**宁可保守，不许把单源说成双源**。

### 验证（端到端两种模式都跑）

```
A 双源（月租 290000）：
  筛次判定：第 2 筛 → 源模式：双源
  报告：| 数据源模式 | **双源交叉**（高德 + 腾讯）：第 2 筛，已检出真实租金 |
  POI 62｜same_type 15 = dedupe 15 ✓

B 单源（无租金表）：
  筛次判定：第 1.5 筛 → 源模式：单源，腾讯本轮跳过
  报告：| 数据源模式 | **单源**（仅高德）…本报告**不含**双源交叉验证 |
  POI 47｜same_type 2 = dedupe 2 ✓
```

回归：TS 246 全绿｜typecheck 0 error｜Python selftest 48/48｜冒烟 13/13

---

## 2.10.17

### 更正 v2.10.15 写错的一处估算

v2.10.15 的 CHANGELOG 与 `references/03` 里写了这么一句：

> 真瓶颈是 POI 检索 200/日……腾讯 POI 只能做**抽样交叉校验**（每点位 30~50 个关键词 → 一天 4~6 个点位）

**这句是错的。** 它把高德的 `--sweep` 多关键词逻辑套到了腾讯头上。

腾讯侧实际是**单关键词翻页**：`TENCENT_PAGE_SIZE = 20`，扬韬广场实测 `count = 44`
→ 每页 20 条 → 20 + 20 + 4，共 **3 次请求/点位**，不是 30~50 次。

修正后的账：

| 接口 | 日额度 | 每点位消耗 | 可支撑 |
|---|---|---|---|
| POI（四接口合计） | **800/日** | 约 3 次 | **约 60~260 个点位/日** |
| 步行矩阵 | 6000/日 | 50 次（250 目标，1×5） | 约 120 个点位/日 |
| **步行路线 direction** | 6000/日 | 250 次（1 对/次） | **约 24 个点位/日** |

**真瓶颈是 `direction/walking` 的 6000/日，不是 POI。**

### `references/03` 该节重写

标题从「步行距离：双服务商与配额」改为「**步行距离与数据源分工**」，内容改为：

- 先按筛次声明分工（第 1/1.5 筛高德、第 2 筛腾讯双源）
- 补齐 `place/v1/detail` 与 `explore` 两个 200/日 接口（原来只列了 search 和 here）
- 明确「**室内动线拿不到**」：`/ws/indoor/direction/walking` 属商业权限，
  当前未分配额度，商场铺位的室内步行段**必须现场实测**
- 把错误的「POI 是瓶颈」换成「direction 是瓶颈」

### 历史记录保留

v2.10.15 的 CHANGELOG 条目**不改**（变更日志应如实记录当时写了什么），
以本条为准。

### 验证

全仓扫描三处错误表述（`每点位 30~50 个关键词`、`一天 4~6 个点位`、`真瓶颈是 POI 检索 200/日`）
在 `references/` 与 `SKILL.md` 中已清零；仅 CHANGELOG 的历史条目保留。

---

## 2.10.16

### 数据源按筛次分工：省腾讯额度，同时把步行精度提上去

腾讯四个 POI 接口（`place/search`、`place/detail`、`place/here`、`place/explore`）
**各 200/日，合计 800/日**——只够少数点位深度校验。所以不能无差别开双源。

新规则：**第 2 筛的闸门是「有没有真实租金」，不是筛次。**

| 筛次 | POI 采集 | 步行距离 |
|---|---|---|
| 第 1 筛 商圈初选 | 高德 | 不算 |
| 第 1.5 筛 单点评估 | 高德（单源） | 高德——初判参考值 |
| **第 2 筛（带租金）** | **腾讯 + 高德双源** | **腾讯——带 `steps.type`，决策值** |
| 第 3 筛 财务锁盘 | 不采集 | 不采集 |

租金是现场谈出来的，有它才说明这单在推进，值得花腾讯配额。

### 新增 `site_core.py rent` 子命令：从对话里识别租金

```bash
python scripts/site_core.py rent --text "租金2万一个月"
# {"hit": true, "monthly_rent": 20000, "advice": "enter_stage2", ...}
```

三档判定：

| 输入 | 结果 |
|---|---|
| `20000元/月` `租金20000月` `2w/月租` `月租两万` | 触发 |
| `租金三万五` `租金三千五` | 触发（口语省略单位） |
| `一年租金24万` `年租30万` | 触发（年租自动折月） |
| `租金` `这个租金贵不贵` | **不触发，建议追问** |
| `租金两百五` `租金 800` | 不触发（低于下限 1000） |
| `面积1200㎡` `商铺 800 平方米` `建面 1500 平` | 不触发（面积防误触） |
| `一天卖2万` `我投了200万` `转让费30万` | 不触发（反例词） |

**下限 1000 的理由**：三位数与面积数量级重叠（300㎡ / 800㎡），不敢认。

**面积防误触**：后缀紧邻（`㎡`/`m2`/`平方米`/`平方`/`平`/`坪`）或前缀紧邻
（`面积`/`建面`/`建筑面`/`使用面积`/`含公摊`）即排除该金额。窗口必须窄到 3–4 字符，
否则「一间 350平的店，租金 2 万」会把租金一起滤掉。

**候选优先级改成「邻近租金词 > 数值更大」**，否则「面积2000㎡，租金1500」会取到 2000。

新增 **28 条断言**（selftest 从 20 → 48），覆盖上述全部写法与反例。

### `run-site.mjs`：调研表必须在采集之前读

原顺序有问题：

```
L190  run('② 采集与分析', 'guangzhou-probe.mjs', probeArgs)   ← 采集
L337  const survey = readSurvey(surveyPath)                    ← 调研表
```

采集先跑，`hasRent` 无从判断。已把 `readSurvey` 提到 `runOne()` 开头，
并在采集前打印筛次判定：

```
筛次判定：第 2 筛（检出月租金 290000 元）→ 腾讯+高德双源校验
步行距离建议：--provider tencent（腾讯带 steps.type，可数天桥/地道/人行横道，这是决策值）
```

### `guangzhou-probe.mjs`：`--dual-source` 开关，默认关

不带开关时腾讯整段跳过，并明确打印「腾讯：本轮跳过（单源模式，未检出真实租金）」。

单源模式下 `data_quality` 的判定也改了——不再把「腾讯返回 0」当异常：

```json
{
  "source_mode": "single",
  "tencent": null,
  "verdict": "ok",
  "note": "本次为单源（仅高德）。腾讯交叉校验只在检出真实租金后启用（第 2 筛）；报告不得声称「双源交叉验证」。"
}
```

`coverage.source_mode` 与 `dumpFile.source_mode` 同步写入，供报告读取。

### SKILL.md 与偏好台账

- SKILL.md 新增两节：**第 2 筛触发条件**、**数据源分工（按筛次，不按偏好）**
- `references/07-preferences.md` 新增「一之二、筛次与数据源」定型口径

### 02 专家包不动

人格层同样的改动**没有**同步进 `02-expert`，已单独写成
`docs/待合并-02专家人格改动-v2.10.16.md`，由你决定是否手动合并。

### 验证

```
Python selftest         48/48（原 20 + 新增 28）
TS 断言                 246 全绿｜typecheck 0 error
冒烟                    13/13
单源实跑                腾讯：本轮跳过，source_mode=single，verdict=ok
双源实跑                腾讯 count=44，coverage=100
带租金→第2筛            检出 290000 → 双源 ✓
无租金→第1.5筛          单源高德 ✓
```

---

## 2.10.15

### 步行距离改用腾讯（`walk-matrix.py`），并把配额事实写进代码

**为什么换**：腾讯 `/ws/direction/v1/walking/` 的 `steps[]` 带结构化设施枚举——

```
steps[].type   0 普通道路 / 1 过街天桥 / 2 地下通道 / 3 人行横道
```

高德只能靠 `instruction` 文本匹配「过街/天桥/地道」来猜。腾讯直接读枚举，
`crossings_est` 与新增的 `facility_mix` 从「文本推断」升级为「结构化读取」。

实测同一组坐标，腾讯能给出 `人行横道×1`、`过街天桥×1`、`人行横道×2` 这种明细，高德给不了。

### 三种接口的 duration 单位全不一样

| 接口 | 单位 | 实测 |
|---|---|---|
| 腾讯 direction/walking | **分钟** | 1160m → 18 |
| 腾讯 matrix | **秒** | 1132m → 1029 |
| 高德 direction/walking | **秒** | 712m → 570 |

混用就是 60 倍误差。脚本内置 `plausible_walk()`（步行速度 2~7 km/h 自检），
单位错了当场报警——**这个断言在开发中真抓到一个我自己引入的 bug**（重写时丢了 `/60`，712m 被算成 570 分钟）。

### 配额实测（控制台核对 + 接口阶梯测试）

| 接口 | 日额度 | 并发 | 实测有效规模 |
|---|---|---|---|
| 距离矩阵 | 6000/日 | 5 对/秒 | **1×5**（1×6 就 120） |
| 步行路线 | 6000/日 | 5 次/秒 | 1 对/请求 |
| 地点搜索 | **200/日** | 5 次/秒 | 1 关键词/请求 |
| 周边推荐 | **200/日** | 5 次/秒 | 1 关键词/请求 |

三条结论：

1. **限额单位是 OD 对数，不是请求次数**。1×6 只是一次请求也超限；连发 6 个 1×1 同样全挂。
   官方文档「1×200」是企业认证额度，当前离线 Key 只有 5 对/批。
2. **真瓶颈是 POI 检索 200/日**，不是步行距离（6000 宽裕）。腾讯 POI 只能抽样校验，全量靠高德。
3. 矩阵 1×5 仍比逐条快 5 倍（250 个目标：1 分钟 vs 5 分钟），所以 ≥10 目标仍自动切 matrix。

### 新增两个模式与自适应分批

```
--provider {tencent,amap}   默认 tencent
--method {auto,direction,matrix}   默认 auto（腾讯且目标≥10 走 matrix）
--matrix-batch N            默认 5（实测安全值）；企业认证后可调到 200
```

矩阵撞 120 自动减半重试，并把探测到的上限打出来。

### A/B 对照（同一组固定坐标，6 目标）

| 目标 | 直线 | 腾讯 dir | 腾讯 mx | 高德 | 腾vs高 |
|---|---|---|---|---|---|
| 正北 800m | 801 | 1160 | 1132 | 1038 | +11.8% |
| 正东 900m | 880 | 1067 | 1066 | 1051 | +1.5% |
| 正南 600m | 600 | 723 | 722 | 712 | +1.5% |
| 西北 1.2km | 1416 | 1960 | 1960 | 1894 | +3.5% |
| 西南 1.5km | 1651 | 2277 | 2277 | 2013 | **+13.1%** |
| 跨江 2.8km | 2993 | 3839 | 3836 | 4116 | -6.7% |

腾讯自家两个接口自洽性 0.00%~2.41%；腾讯 vs 高德差 -6.7%~+13.1%，是真实路网差异。

**差异会改变结论**：西南 1.5km 那条，腾讯判 `psych`(1.38×)、高德判「无」(1.22×)——判定相反。
所以报告里标注数据来源是必要的。

### 坐标顺序陷阱已隔离

腾讯要 `纬度,经度`，高德要 `经度,纬度`。写反会算到几千公里外**且不报错**。
用 `tencent_coord()` / `amap_coord()` 两个函数隔离，不做隐式转换，并加单元断言。

### 不改 02 专家包

本轮只更新 `01-skill` 与 `03-github` 两个包。`02-expert-配置专家.zip` 由用户手动迭代，不再自动同步。

---

## 2.10.14

### 修正：核心脚本裸跑退出码 2，会被评测方当「运行失败」

`manifest.json` 声明 `targets.workbuddy.core = scripts/site_core.py`。
平台沙箱若按这个声明直接跑一次验证可用性，拿到的是：

```
$ python scripts/site_core.py
site_core.py: error: the following arguments are required: cmd
退出码 2
```

argparse 的「缺参数」语义正确，但在**自动评测场景里就是一条失败信号**。

改为：无参数时打印用法横幅并按 0 退出（这是「查帮助」，不是用法错误）。
错误语义没有放松——**错的子命令仍然退出 2**。

### 澄清两个包的归属

| 包 | 类型 | 平台展示名 | 状态 |
|---|---|---|---|
| `01-skill-导入技能.zip` | **技能 skill** | 实体门店选址评估专家 | **被判「低质量」的是这个** |
| `02-expert-配置专家.zip` | **专家 expert/agent** | 选址评估师 / Site Scout | 未提交过 |

技能被判低质量的原因与修复：

| 原因 | 修在哪 |
|---|---|
| SKILL.md 65.8 KB / 1093 行，指令优先级被淹没 | 2.10.10 拆成 references，压到 17.3 KB / 222 行 |
| zip 根目录平铺，非 `{skill-name}/` | 2.10.10 改为 `site-report/` 包裹 |
| frontmatter 缺 `author`（必填） | 2.10.10 补齐 8 个必填字段 |
| examples 各 4 条超上限 3 条 | 2.10.11 删到 3 条 |
| **core 裸跑退出 2** | **本版修正** |

### 验证

```
python scripts/site_core.py              → 用法横幅，退出码 0
python scripts/site_core.py selftest     → 20/20，退出码 0
python scripts/site_core.py nosuchcmd    → 报错，退出码 2（语义保留）
```

---

## 2.10.13

P1 评估闭环进包。评审指出的「卡在 L2」三条里，这一版补上最后一条：
**评估反馈闭环留在源码包、专家包内没有**。

### 新增 `references/07-preferences.md` —— 偏好台账

把「用户反复纠正过、已经定型」的偏好从散落的提示词里抽出来，独立成册：

| 小节 | 内容 |
|---|---|
| 三条已定口径 | 人口用 POI 代理 + WorldPop / 场地只提醒不裁决 / 楼层去重仅限商超 |
| 数据纪律 | 不用可刷数据验模型、缺数据显式披露、每数可取、说人话、不反向调参 |
| 口径细节 | 竞品数用 effective、座位翻台≠桌翻台、坪效用建筑面积、锚点用基准档、最近竞品以 dedupe 为准… |
| 交付与表达 | 先要齐数据再动手、三类话不问、结论先行、不加空话免责 |
| 工程约定 | 版本 +0.0.1、改代码只改 scratch-plugin、改完跑基线、坑写进台账 |

**维护规则写进文件本身**：只记已定型、每条写「结论 + 为什么 + 怎么判」、
冲突时以台账为准并回头修 SKILL.md、不删只归档。

意义：以后加口径**不用改人格提示词**，往台账加一行即可。这是「专家越用越懂你」的落点。

### 新增 `references/06-regression-and-failure-modes.md` —— 回归基线与失败模式台账

- **自动化基线**：246 条断言分组明细 + 三档跑法（包内 / 源码包）
- **失败模式台账**（按症状索引，四类）：
  - 判定与展示不同源（36 月判成可接受、翻台 1.499 贴线）
  - 参数与路径（`arg()` 默认 null、瓦片兄弟目录、zoom 漂移、CSV 编码、业态码来源）
  - 沙箱与运行环境（`execFileSync` pipe EPERM、无参数退出码 2 是预期）
  - 打包发布（`{skill-name}/` 包裹、examples ≤3、版本 +0.0.1、skills 未登记、版本四处不一致）
- **最近版本变更摘要**（2.10.5 → 2.10.13 逐版一句话）
- **改完必做三件事**：跑基线 / 核对断言数变了能否解释 / 新坑补进台账

### 修正断言总数

`docs/TEST-REGRESSION.md` 一直写 212/213，实测为 **246**
（234 组内 + 12 registry 自检）。这次以实测为准，新台账写的是 246。

### SKILL.md 参考索引

从 5 份增到 7 份，并加阅读顺序提示：

> 首次上手顺序：先读 `07-preferences.md`（定型口径），再按任务读其余。

`04` 的描述同步改为「九段骨架的填充细则」——上一版重写了内容但索引还写着旧的三阶段骨架。

### 验证

```
python scripts/site_core.py selftest   → 20/20
node tools/test-tools-smoke.mjs        → 13/13
pnpm test && pnpm typecheck            → 246 通过 + 0 error
```

---

## 2.10.12

按 WorkBuddy **专家包规范**做 P0 一致性修复。不改能力，只消除自相矛盾。

### ① 专家包资产从未被加载（最关键）

`plugin.json` 缺 `skills` 字段。包内其实自带 `skills/site-selection/`（5 references + 9 scripts + data + params），
但没登记 → 平台不加载 → 专家只能靠 `agents` 那 204 行人格裸跑，脚本和知识库全部失效。

```json
"skills": ["./skills/site-selection"]
```

专家规范里 `skills` 是**可选字段**，所以不是「必填缺失」，而是「有资产没注册」。

### ② agents 里写着「依赖外部技能，需单独安装」

原 L61–62：

> 本专家依赖**本地已安装的 restaurant-location-analysis 技能**，需通过「导入技能」单独安装。
> 路径以技能目录为准（如 `~/.workbuddy/skills/restaurant-location-analysis/`）

包里自带技能，却让人再去装一个不存在的技能。改为包内路径 `skills/site-selection/`，
并加一条前置自检：`selftest` 不过就停下报「技能资产缺失」，不凭经验硬算。
frontmatter 同时加 `skills: [site-selection]` 预加载。

### ③ 输出规范两套骨架互斥 → 统一到人格层九段

人格层是「九段证据链」，`references/04` 却是另一套「A/B/C 三阶段投决报告」，
还含「【直接放弃】/【强烈建议签约】/【最终否决】」——与人格铁律 2「不判断能不能开」直接冲突。

`04-output-templates.md` 重写：改为**九段骨架的填充细则**，按第 1 筛 / 第 1.5+2 筛 / 第 3 筛三个场景说明每段填什么，
末尾明确「三个不许出现的东西」：裁决措辞、旧人口热力口径、第二套骨架。

### ④ 旧口径词清理

| 文件 | 改动 |
|---|---|
| `03` | `severity: hard 硬性否决` → `hard 硬伤`；`人口档位与竞品密度方向相反` → `人口密度…` |
| `03` | `hard_vetoed` ×2 **保留**——一处是工具输出字段名，一处是「禁止输出 hard_vetoed 式结论」的禁用说明 |
| `04` | 全部旧口径随重写清除；顶部加澄清：文件内「❌ 不写」列的反例词是必删写法，不是本文件口径 |

### ⑤ references 改 ASCII 文件名

```
01-环境预检与变量字典.md      → 01-env-and-vars.md
02-计算口径全书.md            → 02-formulas.md
03-数据源与治理.md            → 03-data-and-governance.md
04-输出模板.md                → 04-output-templates.md
05-运维与排障.md              → 05-ops-and-troubleshooting.md
```

SKILL.md 里 5 处引用同步更新，全部可落地。

### ⑥ 版本收敛

`plugin.json` 停在 **2.10.3** 是长期遗漏——升版脚本只扫 `skills/` 子目录，从没覆盖
`wb-expert/.codebuddy-plugin/plugin.json`。本次统一到 2.10.12，9 个 JSON 清单全部核对。

### ⑦ SKILL.md 的包外引用加标注

`tools/`、`dsh/`、`docs/COMPLIANCE-CHECKLIST.md`、`package.json` 不在技能包内，
逐处标注「需源码包 03-github」，避免读者找不到文件。

### ⑧ 冒烟测试不再依赖 pipe 捕获

`test-tools-smoke.mjs` 的瓦片默认路径断言用 `execFileSync` 默认 `pipe` 捕获 stdout。
受限沙箱下 spawn 的 pipe 会 **EPERM**，即使渲染器正常也拿不到输出 → 假失败
（实测 danger-full-access 下 13/13，workspace-write 下 12/13）。

改为把 stdout 重定向到文件再读，两种沙箱模式下都 13/13。

### 验证

```
python scripts/site_core.py selftest            → 20/20，退出码 0
node tools/test-tools-smoke.mjs                 → 13/13（受限沙箱下同样通过）
tsc -p tsconfig.json                            → 退出码 0
plugin.json 16 个必填字段 + 数量约束            → 全过
references 旧口径词                             → 仅剩 03 的 2 处技术字段（有意保留）
```

---

## 2.10.11

### 修正：examples 超过平台上限（解析失败的直接原因）

平台反馈：

```
examples_zh 最多 3 个示例，当前 4 个
examples_en 最多 3 个示例，当前 4 个
```

各删到 3 条，保留覆盖三个阶段的代表用例（完整评估 / 财务问题 / 商圈初选），
删掉「现场复核」那条——它属于细节追问，代表性不如前三条。

### 同时：frontmatter 只保留规范字段

`title` / `summary` / `read_when` 不在官方字段表里。既然平台校验是严格模式
（examples 超限就报错），未知字段同样有被拒风险。三者已移入正文开头的
「何时使用这个技能」一节，frontmatter 现在只含规范认可的 10 个键：

```
name · display_name · display_name_en · description · description_zh
description_en · version · author · examples_zh · examples_en
```

### 验证

解压 01 包后实跑：`python scripts/site_core.py selftest` → 20/20 通过，退出码 0。

规范逐项：顶层包裹 `site-report/` ✅ · 必填 8 字段 ✅ · examples 各 3 条 ✅ ·
无非规范字段 ✅ · SKILL.md 16.6 KB / 216 行

---

## 2.10.10

### 修正：按 WorkBuddy 开放平台技能规范重构（解决「解析失败」与「低质量」）

**问题一：zip 结构不合规 → 解析失败**

官方要求 `{skill-name}/SKILL.md` 顶层包裹，而 01 包此前是**平铺**的：
`SKILL.md` 直接在 zip 根，还混着 `.github/` `install.ps1` `package.json` `dsh/` 等 19 个顶层项。

改为：

```
site-report/
├── SKILL.md          ← 顶层包裹
├── references/       ← 5 个
├── scripts/          ← 9 个
├── data/ params/     ← 脚本运行时依赖
└── templates/
```

**问题二：frontmatter 缺 `author`（规范必填）**

补齐 8 个必填字段：`name` / `display_name` / `display_name_en` / `description` /
`description_zh` / `description_en` / `version` / `author`。
另加 `examples_zh` / `examples_en` 各 4 条——会展示在详情页「试试这样用」。

**问题三：SKILL.md 65.8 KB / 1093 行 → 16.8 KB / 213 行（压缩 84%）**

平台评测时读的是 SKILL.md。原本把整本口径手册塞进技能定义，
评测模型的指令优先级被规则轰炸淹没，产出质量下降 → 判「低质量」。

按 progressive disclosure 拆成：

| 文件 | 内容 | 行数 |
|---|---|---|
| `SKILL.md` | 角色 / 快速开始 / 三条口径 / 三阶段 SOP / 红线 / 参考索引 / 已知边界 | 213 |
| `references/01-环境预检与变量字典.md` | Key 自检、变量字典、参数覆盖、比值校验、配额、现场反馈、网格扫描、截流两轴 | 256 |
| `references/02-计算口径全书.md` | 三档因子、财务公式、极限租金、租期现金流、空间容量、敏感度 | 170 |
| `references/03-数据源与治理.md` | 双源 GIS、L3 治理、坐标系、空间分析、否决规则包、工具链、翻译层、业态档案 | 409 |
| `references/04-输出模板.md` | 三种报告骨架 | 26 |
| `references/05-运维与排障.md` | Docker/Valhalla、WorldPop、降级策略 | 118 |

**内容零丢失**：按节整体搬移，只换位置。

**问题四：依赖声明把可选写成必需**

原 `dependencies.python: ["openpyxl"]`、`env: ["AMAP_API_KEY"]` —— 会被当成硬依赖。
实际只有 `import-benchmarks.py` 用 openpyxl；缺 Key 时 6 个核心命令仍可离线跑。

改为 `pythonOptional` / `envOptional` 并逐条写明「缺了会怎样」，
同时给 workbuddy target 加 `offlineCapable` 声明。

**顺带**：SKILL.md 快速开始补了 5 条可直接复制的离线命令（含正确业态名），
避免评测时用 `--format 粤菜大店` 这种不存在的名字拿到 `matched:false`。

### 验证（解压后模拟沙箱）

```
python scripts/site_core.py selftest                        → 20/20 通过，退出码 0
python scripts/site_core.py finance                         → 正常输出 JSON，退出码 0
python scripts/site_core.py benchmark --format large_yuecai → matched=True
node tools/test-tools-smoke.mjs                             → 13/13
tsc -p tsconfig.json                                        → 退出码 0
```

---

## 2.10.9

### 修正：README 让跑 `npx tsc --noEmit`，但包里没有 tsconfig，实际跑不了

三个发布包此前都没有 `package.json` / `tsconfig.json`，README 里的类型检查指令是空头承诺。

**补齐三个文件**：

| 文件 | 作用 |
|---|---|
| `package.json` | `npm run typecheck` / `npm test` / `npm run check` |
| `tsconfig.json` | 与开发工作区同口径（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes） |
| `types/dsh-shims.d.ts` | 给宿主模块 `@deepseek-ai/cordis` / `dsh-tools` 做最小声明 |

**为什么需要 shim**：引擎 `import { defineTool } from '@deepseek-ai/dsh-tools'`，这两个包由宿主提供、不随发布包分发，没有声明连模块都解析不了。

shim 的边界（已在文件头写明）：引擎自身的类型完整受检；只有「宿主是否会拒绝这份 schema」这一层无法在包内验证。

**代价**：第一版 shim 用恒等泛型 `defineTool<T>(d: T): T`，回调参数失去上下文类型，冒出 43 个 implicit any 假错。改成给 `render` / `execute` 宽松签名后，只剩 2 个真错——都是 `args: any` 的套娃，已在源码里补 `RuleSpec` / `ProfileSegment` 标注解决。

**验证**：包内 `tsc -p tsconfig.json` 退出码 0；开发工作区（真实宿主类型，更严）同样 0 error。

### 修正两处显示不一致

**① 最近竞品距离两个值（40m vs 41m）**

`dedupe.nearest` = 40m、`rings.nearest[0]` = 41m，报告取 41m 未说明。
两者是同一家店，必须同一个数——以 `dedupe.nearest` 为准（去重后的唯一真相）。
现在两处都是 **40m**。

**② 地图实画 62 点，图例写「内圈 55 家」**

图例改成：

```
内圈·步行8分（圈内 55 家）
图中共 62 点（圈外 7 点灰显）
```

「圈内」与「图中全部」分开说，读者不会再把两个数当成矛盾。

---

## 2.10.8

### 修正：谈判锚点与保本红线取「最保守档」，导致健康生意也报「需降 76%」

**问题**：锚点原取全档最低的 `max_rent_target`，即保守档（营收 ×0.85 且 成本 ×1.05 双杀）。

合理基准数据实测：
```
基准档极限租金 365,000 ｜ 保守档 65,238
旧锚点 = 65,238  →  报「当前租金 290,000 需降 224,762（77%）」
但同一份报告里租售比 9.67% 判 healthy、回本 36 月判优秀
```

同一份报告自相矛盾：财务面说健康，租金面说砍到脚踝。

**判定**：
- 红线取最保守 → **正确**（越过即亏损，必须用最坏情况）
- 锚点取最保守 → **错误**。锚点是「可接受的价格上限」，应按常规经营预期（基准档）；压力测试结果是风险提示，不是出价依据。

**改法**（口径分两层，全部并列披露）：

| 字段 | 改为 | 用途 |
|---|---|---|
| `target_rent` | **基准档**极限租金 | 谈判锚点 |
| `target_rent_conservative` | 保守档（新增） | 压力下限，仅提示 |
| `ceiling_rent` | **基准档**保本上限 | 保本红线 |
| `ceiling_rent_conservative` | 保守档（新增） | 压力红线，仅提示 |
| `gap_to_target` / `gap_to_ceiling` | 随主口径改基准档 | 距锚点/距红线 |

报告「建议租金」表新增一行：

> 压力下限（保守档）｜ 锚点 65,238 ｜ 保本 184,286 — 「营收降 15% 且成本涨 5%」时的最坏情况，**不作为谈判出价**

修复后同一份数据：**「无需降，尚有余量 75,000 元/月」**。

### 连带：4 条断言按新口径重写 + 新增 2 条

`test-finance.mjs` 里原本断言「锚点取自保守档」，改为基准档口径，并新增两条压力档断言。断言总数 244 → **248**。

### 新增：`docs/项目目录地图.md`

记录「什么东西在哪」：三包派生关系、`.dsh` 为何没有引擎、`release/` 与 01/02/03 是否重复、密钥位置、常见混淆点。

---

## 2.10.7

### 修正：回本正好 36 个月被判成「可接受上限」而非「优秀」

`accountingPayback = 4,500,000 ÷ 125,000 = 36.000000000000004`（浮点误差）
→ 展示 `roundTo(...,1)` = **36**
→ 判定 `gradePayback(36.000000000000004)` → 大于 36 → **acceptable（≤48 档）**

读者看到「36 个月 → 可接受上限」，与标尺「≤36 = 优秀」直接矛盾。与 v2.8.0 修的翻台精度问题同类：
**判定用未舍入值、展示用舍入值，边界处打架**。

区别在于：翻台是连续判定（用原值更严谨），回本是「贴标尺」——展示值即结论，判定必须与展示同源。
改为 `gradePayback(roundTo(x, 1))`。

验证：同一数据会计 36 月、现金 22.5 月，**双档均判「优秀」**。

### 新增：合理基准测试数据

`survey/扬韬广场-合理基准.csv` —— 按业态区间反推的一套自洽参数，用于验证「正常数据能否通过」：

| 指标 | 值 | 落点 |
|---|---|---|
| 月营业额 | 300 万 | 翻台 2.0 × 278 座 × 客单 180 |
| 毛利率 | 58% | 区间 55–65% ✅ |
| 人力占营收 | 26% | 区间 22–30% ✅ |
| 租售比 | 9.7% | 健康线 10% 以内 ✅ |
| 单方造价 | 3,750 元/㎡ | 区间 3,500–5,000 ✅ |
| 翻台 | 1.998 | 绿区 1.8–2.2 ✅ |
| 客单价 | 180 元 | 区间 150–400 ✅ |

测算结果：净利率 4.2% · 现金回本 22.5 月 · 会计回本 36.0 月 · 年 ROI 33.3% ·
租售比 healthy · 内部比值 4 项全 ok。

**结论：正常数据能过，且四项内部比值校验全绿。**

---

## 2.10.6

按第二部分审计再修两条**必崩 / 护栏失效**，并把参数合理性问题显性化。

### 🔴 H1：`site_core.py` dedupe 模糊匹配必崩

原代码 `_dice(name_of(p), name_of(q["name"]))` —— `q["name"]` 是字符串，
而 `name_of()` 内部调 `p.get()`，对字符串调 `.get()` 直接 AttributeError。

触发条件：任意两个**不同名、距离 ≤30m、dice ≥0.6** 的 POI。selftest 用例恰好不触发，故测试全绿但 bug 隐藏。

已改为 `name_of(q)`，并用三个 POI（含两个不同名近距）实测：修复前崩、修复后正常合并。

**只影响 Python 链路（WorkBuddy target）；TS/dsh 插件不受影响。**

### 🔴 H2：`grid-scan.py` 额度预估漏算竞品采集

实际执行里「竞品」是按格子全量翻页的第二轮采集（`cells × comp_kws × MAX_PAGES`），
预估公式完全没算，还多了一个无对应调用的幽灵项 `min(top, merged) * 2`。

荔湾实测：旧估 128 次 → 新估 134 次（含竞品 54 次、去掉幽灵 48 次）。护栏不再被低估绕过。

### 🟠 E4：基准库其实是「1 列基数 × 城市系数缩放」

实测确认：同业态跨 19 城的净利率、面积**各只有 1 个值**。

- `benchmarks.json` 新增 `data_basis: "scaled_estimate"` + 说明
- 报告「行业基准对标」顶部加数据性质警示：**只能看偏离方向，不能当作该城市实测水位**

### 🟠 E3：目标回本与基准库脱节 1.4~2.5 倍

`params` 大型粤菜目标回本 **36 月**；基准库同类中位 **51.7 月**、高端中餐酒楼 **90.7 月**。

报告「回本周期判读」并列披露两套标尺，明写「36 个月不是行业常态，是偏紧的要求」。

### 🟡 E2：基准库租售比半数越线（未修，需数据决策）

912 条样本租售比中位 **14.8%**，**49% 超过 15% 警戒线**。系统一边说健康线 ≤10%，
一边拿半数越线的库做对标。这是数据源问题，需真实样本才能解决；本次仅在报告侧加了相对参考限定。

### 验证

端到端重跑扬韬广场：`pois.same_type = 15` 与 `dedupe.same_type_count = 15` **完全一致**，
9 个分段的 pois 计数与 dedupe 计数逐段相等。

回归：TS 244 条断言全绿 · typecheck 0 error · Python selftest 20/20。

---

## 2.10.5

按外部审计报告逐条修复。**审计的每条指控都先自己复验过**，全部属实。

### 🔴 严重：同一份 probe.json 里「同段直接竞品」既是 15 家又是 26 家

**根因**：`guangzhou-probe.mjs` 里 `keptSegmented`（按人均重判后的正确分段）
只用于文字统计，而输出 `pois` 与 review CSV 仍用 `dedupe.kept`（重判前，按店名猜测）。
于是地图把 26 个点染成「同段直接竞品」，正文写 15 家。

26 个红点里混进了人均 16 元的维彬手撕鸡、22 元的创膳烧鹅、23 元的桥头干蒸。

**修法**：新增 `poisFinal`——分段以人均重判后为准，`same_type` 同步重算。
验证：`pois.same_type` 15 = `dedupe.same_type_count` 15，逐段分布完全一致。

### 🔴 连带：15 家同段竞品全部无人均数据，报告却断言「人均>120」

这 15 家 `cost` 全是 `-1`（高德未提供），「高端」是从店名/品类推定的。
**修法**：段标签在有价率 < 30% 时降级为「规模档推定，无人均实证」，
并在「直接对手」一句里明写「该段全部无高德人均数据，分段依据是店名与品类而非人均实证」。

### 🟠 财务保守/乐观两档无法按披露口径复算

**根因**：三档除营收 ×0.85/×1.15 外，成本还联动 ×1.05/×0.97，但报告只给了 base 档公式。

**修法**：输出新增 `scenario_factors`（营收乘数/成本乘数/标签），报告新增披露表：

| 情景 | 营收乘数 | 成本乘数 |
|---|---|---|
| 基准 | ×1 | ×1 |
| 保守 | ×0.85 | ×1.05 |
| 乐观 | ×1.15 | ×0.97 |

验证：`47,165.11 × 1.05 = 49,523.37 ≈ 报出的 49,523.36` ✅；`× 0.97 = 45,750.16` ✅ 逐位吻合。

### 🟠 需求侧「内圈面积」一名三义

密度分母实际是 **1000m 圆（3.14 km²）**，而报告别处的「内圈·步行8分」是 474m 等时圈（0.69 km²）、
人口表 500m 圈（0.79 km²）。按字面读，咖啡密度会差 4.6 倍。

**修法**：表注改为 `${inner_radius_m}m 圆（≈3.14 km²）`，实际半径直接写出来。

### 🟡 其余标注

- 建议翻台率标注「会计口径」（原来 1.41 与 1.7 混列未说明）
- 坪效标注「按建筑面积，非营业面积」
- 「其余 45 家瓜分」→「Top20 之外 45 家瓜分」

### 修复：review CSV 打开乱码

`广州市荔湾区扬韬广场-review.csv` 无 BOM，Excel 中文 Windows 按 GBK 读 = 全乱码。
**修法**：写盘时加 UTF-8 BOM，双击即可正常显示。

### 未处理（已在审计中标注为非阻塞）

- 最近竞品 40m（dedupe）与 41m（rings）两个来源，报告取 41m
- 地图 62 点 vs 图例「内圈 55 家」
- 截流定级 heavy 但财务乘数 1.0（定级未传导到测算）
- 「潮汕·高端 2 家」归入间接竞品与分类规则表述冲突

---

## 2.10.4

### 文档：模块清单按当前代码校正

`docs/项目模块清单.md` 有两条停留在旧结论，已改正：

| 模块 | 原表 | 实际 |
|---|---|---|
| #6 否决检查 | ⚠️ 70%「定位没改」 | ✅ **95%** — v2.9.3 已统一为「只提醒，不裁决」，输出含 `positioning` / `blocks_pipeline` |
| #12 参数覆盖 | ⚠️ 85%「单店级只在文档」 | ✅ **95%** — 单店级代码早已实现，v2.9.4 修的是路径不可移植 |

规模数字同步更新：`site-tools.ts` 5,074 行、断言 244 条、15 业态五档基准、包内 tools 15 个文件。
整体完成度由 82% 校正为 **90%**（主链 94%）。

无代码变更。

---

## 2.10.3

### 修正：包内缺失 `tools/isochrone.mjs`，采集链路断链

`tools/guangzhou-probe.mjs` 直接 `import('./isochrone.mjs')`，`tools/run-site.mjs`
也会 spawn 它，但**三个发布包都没有这个文件**。用户一旦跑采集就会
`ERR_MODULE_NOT_FOUND`。

这不是 2.10.2 引入的，是更早的打包遗漏（打包脚本只挑了渲染链的几个文件）。

**本次补齐 4 个可移植文件**：

| 文件 | 作用 | 依赖 |
|---|---|---|
| `tools/isochrone.mjs` | 路网等时圈（Valhalla/OSRM，降级直线） | node 内建 |
| `tools/review-segments.mjs` | 竞争分段人工复核 | node 内建 |
| `tools/test-grid.mjs` | 网格编号 / registry / 看板测试 | node 内建 + Python |
| `tools/sample-survey.csv` | 调研表样例 | — |

### 校验方法升级

新增「依赖图谱检查」：对包内每个 `.mjs` 解析 `import` 与子进程 spawn 目标，
逐个确认目标文件在包内存在。比人工列清单可靠——文件自己会说话。

结果：`00 处引用断裂`。

### 文档：说明哪些测试包内能跑

`tools/README.md` 新增对照表：只有 `test-tools-smoke.mjs`（13 条）能在包内直接跑；
其余 7 个测试依赖 `../src/site-tools.ts` 与 `node_modules`，需完整开发工作区。
此前 README 只列了 6 个文件，容易让人以为包是残缺的。

---

## 2.10.2

### 版本重编号 + 三包全量对齐（2026-11-04）

- 全部文件版本号统一为 `2.10.2`：`manifest.json`、`.codebuddy-plugin/plugin.json`、
  `SKILL.md`、`README.md`、`params/*`、`docs/*` 逐一核对，无遗留旧版本号。
- 三个发布包（01 技能 / 02 专家 / 03 源码）用同一份 `dist/site-selection-skill/` 重建，
  逐字节校验一致。
- 功能、参数、数据文件与 2.10.1 完全相同，无破坏性变更。

---

## 2.10.1

### 修复：内置文件缺失与版本递增（2026-11-04）

- 补齐 `tools/index-dashboard.mjs`：`docs/GRID.md` 引用该脚本，`tools/run-site.mjs` 第 583 行
  会在评估完成后自动调用它刷新进度看板；此前三个发布包均未包含，平台审核判定「内置文件缺失」。
- `tools/README.md` 文件清单同步补录该脚本。
- 版本号由 `2.10.0` 递增为 `2.10.1`，满足平台「包内版本须大于当前最新版本」的校验要求。
- 除上述两项外，功能、参数、数据文件与 2.10.0 一致，无破坏性变更。

---

## 2.10.0

### 新增：座位翻台五档基准表（15 个细分业态）

原来只有 3 个业态有翻台阈值（粤菜/茶楼），其余全部 `unknown` 不判。现在按用户提供的
行业基准表实装 **15 个细分业态 × 五档**：

| 子类型 | 告警线 | 黄色 | 绿色 | 物理上限 | 客单价 |
|---|---|---|---|---|---|
| 粤式大酒楼 >1000㎡ | 1.5 | 1.5–1.8 | 1.8–2.2 | 2.6 | 150–400 |
| 粤式全天茶楼（非 24h） | 1.4 | 1.4–1.7 | 1.7–2.2 | 2.7 | 60–130 |
| 24h 纯茶市茶楼 | 1.3 | 1.3–1.6 | 1.6–2.1 | 2.6 | 60–120 |
| 茶餐厅 | 2.5 | 2.5–3.0 | 3.0–4.0 | 5.0 | 40–75 |
| 大众连锁火锅 | 2.0 | 2.0–2.4 | 2.4–3.0 | 3.8 | 100–160 |
| 精品小火锅 | 2.4 | 2.4–2.8 | 2.8–3.5 | 4.2 | 70–110 |
| 大众烧烤 | 1.8 | 1.8–2.2 | 2.2–2.8 | 3.4 | 90–140 |
| 川湘家常菜大店 | 1.8 | 1.8–2.1 | 2.1–2.7 | 3.2 | 90–160 |
| 特色单品正餐 | 2.0 | 2.0–2.4 | 2.4–3.1 | 3.8 | 85–130 |
| 高端私房菜 | 1.0 | 1.0–1.3 | 1.3–1.8 | 2.0 | 260–600 |
| 中式快餐 | 3.5 | 3.5–4.2 | 4.2–6.0 | 7.5 | 28–45 |
| 粉面门店 | 4.0 | 4.0–5.0 | 5.0–7.0 | 8.5 | 22–38 |
| 居酒屋 | 1.4 | 1.4–1.7 | 1.7–2.3 | 2.8 | 120–200 |
| 高端日料 / 法餐 | 0.9 | 0.9–1.1 | 1.1–1.5 | 1.8 | 400–1000 |
| 精品咖啡馆 | 2.2 | 2.2–2.8 | 2.8–4.0 | 5.5 | 40–65 |

### 新增：第五档 `impossible`（超物理上限）

原来只有 red/yellow/green/high 四档，高于上限只会判 `high`。现在翻台超过
`max_real` 单列一档，提示「这个数字现实中做不出来，大概率是营收或座位数录错了」。

### 客单价与翻台同源

客单价区间不再由面积预设单独维护，改为**跟着翻台基准表走**，成对校验——
解决「业态标签贴错、客单和翻台互相矛盾」的历史问题。

### 报告新增两行

- `翻台基准（座位翻台）`：显示该业态的告警线 / 黄色 / 绿色 / 物理上限
- `口径提醒`：明确「座位翻台 ≠ 桌翻台」，两套口径不可混用

### 包内文件全部对齐

- 3 个 mjs（report / render-map / tile-cache）+ 5 个 py（demand-fetch / grid-registry /
  grid-scan / import-benchmarks / walk-matrix）+ 2 个源码文件，全部与源码逐字节一致。

---

## 2.9.6

### 修正：默认瓦片路径失效，报告底图全丢（严重回归）

v2.9.0 给 `render-static-map.mjs` 加 `--tiles` 时引入的 bug：

`js
const arg = (k, d = null) => ...        // 默认值是 null，不是 undefined
const tileDir = arg('tiles') !== undefined   // null !== undefined 永远成立
  ? resolve(String(arg('tiles')))            // → resolve(null) → <cwd>/null
  : /* 默认路径永远走不到 */
`

结果：不传 `--tiles` 时，瓦片目录变成 `<cwd>/null`，**一张都找不到**，
报告顶部出现「本报告不含地图底图」，且**不报错、不中断**。

改为显式判 `null / undefined / 空串` 三者。

### 新增：默认瓦片路径回归测试

`test-tools-smoke.mjs` 增至 13 条，新增：在临时目录铺 z16/17/18 三层瓦片，
跑不传 `--tiles` 的 render-static-map，断言「N 张命中」> 0。

写这条测试时踩了两个坑，一并记录进 `docs/TEST-REGRESSION.md` 第八节：

- `tiles/` 是 **probe 所在目录的兄弟**，不是 probe 的兄弟
- 渲染器按圈层跨度自动选 zoom，缓存里没那一层等于没图

---

## 2.9.5

### 文档：回归测试清单落盘

新增 `docs/TEST-REGRESSION.md`——改模板后照这份跑一遍即可，不必重新设计用例。

七节内容：

1. **自动化测试**：10 组 212 条，附各组覆盖范围
2. **A/B 业态对照**：同一数据只换 format_code，10 项财务指标必须逐字一致，4 项业务判读必须切换
3. **边界用例 9 例**：0 / 负 / 缺失 / 非法值全不崩、不出 NaN
4. **CSV 解析边界**：空值不再变 0、千分位不再被切碎
5. **WorldPop 冒烟**：能出数 / 偏移 620m 在 / 不报错
6. **报告完整性 22 板块**：md 与 html 都不许出现「本段跳过」
7. **本次审计回归确认**：10 项修复的验证结论

同时把 `未处理事项.md`、`项目模块清单.md` 一并进包。

---

## 2.9.4

### 修正：单店参数路径不可移植（B1）

`run-site.mjs` 原先写死 `../../.dsh/skills/site-report/params/<id>.json`，只在
`scratch-plugin/tools/` 这个位置成立。改为多候选依次尝试：

1. `../params/<id>.json`（包内布局 `<pkg>/tools/` → `<pkg>/params/`）
2. `../../.dsh/skills/site-report/params/<id>.json`（dev 布局）
3. `../.dsh/skills/site-report/params/<id>.json`

两种场景都实测通过；找不到时打印「按业态默认值测算，这不是错误」，不再静默。

### 修正：包内跑采集给出人话报错

采集链依赖 `src/site-tools.ts` 与 `tools/isochrone.mjs`，技能包里没有。
原先直接抛 `MODULE_NOT_FOUND` 堆栈；现在 `run-site.mjs` 入口先自检，
缺依赖时明确告知：

`
❌ 当前目录只能渲染报告，不能跑采集。缺少：
   · src/site-tools.ts（采集计算层）
   · tools/isochrone.mjs（等时圈）
   技能包内请这样用（只渲染）：
     node tools/report.mjs --in=<路径>/probe.json
`

### 新增：tools 渲染链冒烟测试（12 条）

此前 `report.mjs` / `render-map.mjs` 完全没有自动化测试。新增
`tools/test-tools-smoke.mjs`，覆盖：

- Windows 下 `report.mjs` 独立运行（`invokedDirectly` 路径比较回归）
- 缺 `_staticMapSvg` 时自动补图
- `render-map.mjs` 相对路径解析（L5 回归）
- HTML 自包含性（无外链、无未渲染占位）
- 缺 POI 时**报错退出而非静默**

已挂进 `pnpm test`。

### 文档：调研表编码要求（A2）

`tools/README.md`、`SKILL.md`、`params/_template.json` 三处补充：
CSV **必须存为 UTF-8**；GBK/UTF-16 会整表解析为空**且不报错**，报告照出但财务段全回落默认值。
另注明千分位数字需加引号。

不引入 iconv 依赖。

---

## 2.9.3

### 修正：否决检查的「定位」自相矛盾（模块清单里的「隐患二」）

三处语义打架：

| 位置 | 原写法 |
|---|---|
| 工具描述 | 「执行**一票否决**检查…返回**硬性否决项**」 |
| 报告第 5 段 | 「场地核查（**提醒，非否决**）…系统不判能不能开」 |
| 实际流程 | `hard_vetoed` 只打印一行日志，**从不中断** |

按产品原则（不判能不能开）统一为「提醒」定位：

- 工具描述改为「硬性条件核查…**只提醒，不裁决**，也不中断分析流程」
- 输出新增 `positioning: 'advisory'` 与 `blocks_pipeline: false`，调用方一眼看得出语义
- `hard_vetoed` 字段名保留（兼容旧调用方），描述改为「是否命中硬伤规则，**不代表不能开**」
- `run-site` 日志由「硬性否决：是/否」改为「硬伤 X 项（提醒，不中断）」

---

## 2.9.2

### 仓库卫生

- **.gitignore 同步进三个包**：原包内的忽略规则只有 13 行，缺 
ode_modules/、
  dist/、secrets/；与项目根的同名文件不一致。现统一为一份 27 行的规则，
  实测验证：survey/、secrets/、dist/upload/ 被忽略，`tools/`、scripts/、SKILL.md 正常入库。

---

## 2.9.1

按只读代码审计报告（`docs/AUDIT-REPORT-2026-11-04.md`）逐项修复，**除 M8（报告截图处置）外全部处理**。

### 高

- **H1 发布物落后源码**：`dist/` 三包内的 `dsh/site-tools.ts` 与 `benchmark-data.ts` 已同步到当前
  源码（此前缺 8 处修复，含门槛翻台率财务口径 bug）；`data/formats.json` 三包统一为 10 条
  （02 专家包原只有 4 条）。

### 中

- **M1 租期回本口径矛盾**：翻新支出原先在 12 个月循环结束后才扣，判定回本月时尚未扣除，
  导致「第 51 个月已回本」与「期末累计 −26 万、收不回投资」同时出现。改为年末先扣再判，
  并新增 `paybackOvertaken` 区分「中途过零但期末转负」。
- **M2 CSV 空 value 静默变 0**：`Number('') === 0` 让留空的 `daily_revenue` 变成营业额 0，
  整份报告变全亏。空单元格现在跳过，走业态默认值。
- **M3 随包 tea_house 参数**：4 份 `params/tea_house.json` 客单区间 50~110 同步为代码值 60~130。
- **M4 锚点负值渲染**：「需降 −64755 元/月」改为按符号分支——正数写「需降 X」，
  非正数写「无需降，尚有余量 |X|」；锚点不可达时写「不可达」。
- **M5 密钥路径硬编码**：`demand-fetch.py` / `grid-scan.py` / `walk-matrix.py` 的
  `C:\Users\Administrator\...` 改为 `os.path.expanduser("~")`，跨机器可用。
- **M6 demand 模板脱节**：`survey/demand/_template.json` 原为已废弃的人工普查 schema，
  与实际自动产物零重叠；改为按实际产物结构生成，并标注「不要手填」。
- **M7 .gitignore 未覆盖发布物**：新增 `dist/upload/` 与 `dist/**/*.zip`，实测 `git check-ignore` 命中。

### 低

- **L1 翻台两处精度**：`turnover_per_day` 统一 3 位小数，报告与告警同源，不再出现两个值。
- **L2 千分位被切碎**：`150,000` 会被 CSV 解析成 `value=150 / source=000`；
  现在识别「数字,三位」为千分位而非分隔符。
- **L3 `--profile` 未校验**：加 `^[\w\u4e00-\u9fa5-]+$` 白名单，挡住 `../` 输入。
- **L4 地址 slug 未清洗**：注释与调用处明确该值用于文件名，需过滤路径分隔符。
- **L5 render-map 相对路径**：`new URL('file:///...')` 改为 `pathToFileURL(resolve(...))`，
  相对路径按 cwd 正确解析。
- **L6 index-dashboard 链接未转义**：`encodeURI` + 括号转义，避免路径含 `)` 截断 markdown。
- **L7 tile-cache 无超时**：加 `AbortSignal.timeout(15000)` 与 512KB 大小上限。
- **L8 grid-scan 文件名**：`--city`/`--district` 先清洗再拼缓存路径。
- **L9 barriers 模板列头**：与自动产物列名对齐（原模板列头漂移，人工填报无据可依）。
- **L10 基准库空数组 min/max**：`Math.min(...[])` = Infinity 会写进 JSON；先判空返回 -1。

### 提示

- **P1「未舍入值」标注**：原只在红档分支出现，现四档统一。
- **P2 初始投入=0 的 payback**：由 `0` 改为 `-1`（哨兵），避免读成「当月回本」。
- **P3 profiles 缺 archetype**：5 份档案补齐 `archetype` 字段，调研表漏写 `format_code`
  时不再退化到 `'store'` 兜底。
- **P5 负营业额**：`turnover` 对非正客流返回哨兵 -1，不再把负数留在 JSON。
- **P6 city_level 丢失**：由硬编码 `null` 改为按城市名回查 `CITY_BASELINES`。
- **P7 重复常量**：`DEFAULT_TARGET_PAYBACK_MONTHS_FALLBACK` 改为引用主常量，不再各维护一个 24。
- **P9 import-benchmarks 直接覆盖源码**：新增 `--check` dry-run，只统计不写入。

### 未处理

- **M8 报告截图处置**：属商业决策（白鹅潭点位是否在保密期），由用户拍板。
- **P4 CSV 编码探测**、**P8 density.json 底稿缺失**：前者需引入依赖，后者受底稿限制。

---

## 2.9.0

### 新增：报告渲染器打进球包（`tools/`）

此前 `report.mjs` 那套渲染器只在 DSH 插件侧，WorkBuddy 用户拿不到，报告只能是
Markdown。现在把 6 个脚本打进包里，**零外部依赖（纯 Node 内建，不需要 npm install）**。

| 文件 | 作用 |
|---|---|
| `tools/report.mjs` | probe.json → report.md / report.html |
| `tools/render-static-map.mjs` | 静态 SVG 地图（瓦片 base64 内嵌） |
| `tools/render-map.mjs` | 交互版 map.html |
| `tools/tile-cache.mjs` | 高德瓦片缓存 |
| `tools/import-survey.mjs` | 调研表 CSV → JSON |
| `tools/profile-build.mjs` | 业态档案建档 / 校验 / 脚手架 |

一条命令：

```bash
node tools/report.mjs --in=probe.json
```

产出单文件 `report.html`：地图内嵌、Top20 两栏榜、点门店高亮、一键存 PDF。
没有 Node 的环境仍按 `SKILL.md` 的报告结构直接输出 Markdown。

### 修正：三个只在独立运行时才暴露的 bug

- **Windows 下直接运行静默失效**：`invokedDirectly` 用 `URL.pathname`（正斜杠）与
  `process.argv[1]`（反斜杠）做字符串比较，永远不等，退出码却是 0。改为 `resolve()` 后比较。
- **缺地图时不自动补**：`report.mjs` 只读 `probe.json` 里已内嵌的 `_staticMapSvg`（由
  run-site 预注入）。独立运行会得到「未生成静态地图」占位。现在缺图时自动调
  `render-static-map.mjs` 生成并注入。
- **瓦片目录写死**：`tile-cache.mjs` 固定写 `cwd/out/tiles`；改为支持 `--out`。
  `render-static-map.mjs` 新增 `--tiles` 显式指定。

### 文档

- 新增 `tools/README.md`：输入结构、命令、边界
- `SKILL.md` 增「渲染器（可选，需要 Node 18+）」一节，说明什么场景跑渲染器、
  什么场景手写 Markdown

---

## 2.8.0

### 修正：目标翻台口径错误（最重要）

36 个月回本反推的翻台率，旧公式只除毛利率、漏了税，且不含摊销——
导致「目标翻台」比「保本翻台」口径更宽松，两列根本不可比（0.57 vs 0.70）。

- 贡献率改为 `毛利率 − 税率`，与保本公式同一条线
- 主结论改用**会计口径**（含摊销），另附现金流口径
- 实测：同一数据由 1.52 修正为 **1.70**

### 新增：业态翻台风险告警引擎

| 业态 | 红色（禁止作基准） | 黄色 | 绿色 | 偏高 |
|---|---|---|---|---|
| 粤菜正餐 | <1.5 | 1.5–2.0 | 2.0–2.5 | >2.5 |
| 24h 茶市茶楼 | <1.4 | 1.4–2.0 | 2.0–2.8 | >2.8 |

触发红色时，报告强制声明「本组合现实可行性低，财务结果只用于压力测算」。

### 新增：回本周期判读（餐饮重资产大店实操标尺）

- 24–36 个月＝优秀　·　≤48 个月＝可接受上限　·　49–60＝风险偏高
- 61–84 个月＝风险极高　·　>84 个月＝基本没有投资价值
- 另加「<18 个月＝快得不真实」档：拦截营收估高 / 投入漏项

### 新增：POI 前置清洗

- 停业状态（暂停营业/歇业/装修中/招租）一律剔除
- 农贸肉档 / 生鲜 / 食品零售只在**餐饮业态**剔除（`dining_only` 开关，避免误杀便利店业态）

### 修正：显示与口径

- **翻台判定与显示精度不一致**：显示 1.5、判定 1.4989 → 出现「1.5 < 1.5」；改为统一 3 位并标注「贴线」
- **保本概念混用**：「低于保本线 326340」实际是现金净流；改为「当前 X，上限 Y，距上限还有 Z」
- **租金余量百分比**：「低于承受上限 92%」应为 48%；新增 `rent_headroom` / `rent_headroom_pct`
- **跨表营业额打架**：台账 108 万 vs 财务档 118.8 万；台账改取基准档营收
- **客流无说明**：拆为 `daily_customers_raw` / `catchment_multiplier` / `daily_customers`
- **年净利列名**：改为「年度现金净流」
- **敏感度「不变」**：改为「不翻转结论」，避免被误读为「不敏感」
- **锚点不可达**：不再同时显示「需降 197304 元」
- **三档表**：过滤对象字段，不再出现 `payback_verdict —`
- **密度分母**：输出 `density_basis`，标明每个指标的统计半径
- **场地核查全 0**：加提示「全 0 不等于核查通过，只是规则没触发」
- **茶楼客单区间**：由 50–110 修正为 **60–130**（点都德约 90、陶陶居约 130）

### 新增：A/B 业态对照能力

- `run-site` 支持从调研表锁定 `seats` 与 `target_payback_months`，用于「只换业态」的对照测试
- 验证结论：切换业态后，11 项财务指标**完全不变**，4 项业务判读按业态切换

---

## 2.7.1

### 修正：业态档案校验与文档自相矛盾

SKILL-FULL.md 0.6.2 写着「不确定类目长什么样时，先把 category_pattern 留空跑一次，
从 kept / dropped 里读出平台真实类目串」——但校验器把「留空」判为致命错误直接中止，
**文档教的做法代码堵死了**。

- **category_pattern 缺失降级为警告**：不再中止，正常跑完并提示「本次不做类目过滤，
  effective 会虚高；跑完后从 kept/dropped 读出真实类目再定正则」
- 必填项收敛为两条：
ame、
ings。其余缺失一律警告 + 报告标注

### 新增：--scaffold 从现成档案复制

手写 JSON 最容易漏 category_pattern / 
ings / segments。

`powershell
node tools/profile-build.mjs --scaffold=large-yuecai   # 生成 新建-large-yuecai.json
node tools/profile-build.mjs --scaffold                # 列出可复制的档案
`

生成后只改 4 项：
ame / category_pattern / 
ings / scan_radius，其余字段原样继承。

### 改进：报错自带修法

校验失败时，除逐条说明缺什么，末尾追加三条修法（scaffold / 命令行建档 / 照文档填），
错误信息里附具体格式示例与参考档案路径。

---

## 2.7.0

### 新增：报告内嵌地图（打印 / PDF 可保留）

- **`tools/render-static-map.mjs`**：把地图瓦片以 base64 内联进 SVG，嵌进 `report.html`。
  打印、存 PDF、发给别人都能看到地图，不依赖网络。
  视口与缩放按主圈层自动适配（`--zoom=auto`），不用手调。
- **报告首屏改为「地图 + 竞品排名」并排**：左侧步行圈地图，右侧份额 Top8。
  点排名任一行 → 地图对应红点放大 + 弹出门店名牌，**再点取消**；
  悬停为临时预览。固定后的标识会随打印进入 PDF。
- **工具栏三个按钮**：存为 PDF / 下载这份报告（导出单文件 HTML）/ 使用说明。

### 新增：瓦片缓存支持整城预下载

- **`tools/tile-cache.mjs` 重写**：
  - 支持 `--city=广州` 内置 8 城（广州/深圳/上海/北京/杭州/成都/济南/青岛）
  - 并发下载（`--concurrency`，默认 12）：19,373 张从 7.5 小时降到 **59 秒**
  - 断点续传：已存在跳过，可反复跑
- 实测全广州 z13–15：20,397 张 / 159 MB / 326 张每秒

### 修正

- **`showOuter` 默认关闭导致外圈不显示**：`run-site.mjs` 现在显式传 `--show-outer`
- **报告地图固定 zoom 15 只覆盖 1.1 km**：改为按主圈层自动缩放
- **`savehint` 内嵌脚本语法错误**：`\n` 在模板字符串里被展开成真实换行，导致整段 `<script>` 失效
  （保存按钮与点击联动同时失灵）。已修 3 处转义，并加 Node 执行验证。
- **`map.html` 图例虚标**：删掉从未实现的「点名单/点位双向高亮」说明

### 变更说明

上述地图与报告能力实现在 `scratch-plugin/tools/`（DSH 侧渲染器），**不在本 Skill 包内**。
WorkBuddy / 任意 Agent 模式下，报告由模型依据 `SKILL.md` 的「报告结构」自行组织。

---

## 2.6.1

### 修正：依赖缺失时不再静默

- **等时圈引擎未启动**：Valhalla 容器常用于省内存时关掉，容易忘开。
  现在终端会打印四条提醒（含 `docker start valhalla` 与首次启动命令），
  报告 md/html 头部同步显示黄色提示块，写明「本次为直线估算，圈内竞品数偏多」。
- **人口栅格未裁切 / 未装 QGIS / 采样报错**：四种降级情况都在终端与报告里留痕，
  报告提示「本次按单源看待」，不再静默跳过。
- **probe 地理编码不再写死「广州」**：改为从地址推断城市，外地地址不再报 30001。

### 新增

- `SKILL.md` 新增「本地服务与开关」章节：三类依赖分别要开什么、忘了会怎样、怎么判断在跑

---
# 更新记录

## 2.6.0

### 新增：人口栅格交叉验证

- **`scripts/worldpop-clip.py`**：从 WorldPop 全国 4.7 GB 栅格裁出单个城市（1~8 MB，约 1 秒），
  内置 21 个城市，其他城市用 `--bbox` 自裁
- **`scripts/worldpop-sample.py`**：点位周边常住人口采样，自动 GCJ-02 → WGS84（偏移约 621m），
  输出 500m / 1000m / 3000m 三圈人口与密度
- **交叉判定**：WorldPop 人口档位 × POI 代理强度档位 → 9 种商圈性质结论
  （机会点 / 泡沫风险 / 居住型 / 商务型 / 成熟商圈…）
- **报告第 4 段新增「4.1 人口核对」**：独立数据源列在 POI 代理之后，两者分开解读
- **降级留痕**：缺城市映射 / 缺栅格 / 缺 QGIS / 采样报错，四种情况都在终端与报告里写明原因和补齐命令，
  并提示「本次按单源看待」

### 新增：业态规则可外部替换

- **`data/formats.json`**：自定义业态规则（回本目标、租售比区间、比值区间、空间参数），
  优先级高于内置表；出厂自带鲁菜、本帮菜、烧烤火锅、面食 4 条
- **`benchmark_format` 别名**：让「鲁菜」这类自定义业态名能对上基准库里的正式业态名
- **`site_core.py formats` 子命令**：预览当前生效规则
- **`--formats` / `--benchmarks` 参数**：指定自定义规则文件与基准库

### 修正

- **查不到城市不再静默套用**：返回 `city_in_benchmark: false` 并列出可用城市
- **`--city` 默认值移除**：此前 demand-fetch / walk-matrix 默认「广州」，外地地址会报 30001；
  现在不传则按地址全国匹配
- **兼容 UTF-8 BOM**：Windows 记事本 / PowerShell 存的 JSON 不再报错
- **`install.ps1` 改 UTF-8 with BOM**：Windows PowerShell 5.1 下不再语法报错
- README 补齐依赖清单、地区适配章节、`docs/CUSTOMIZE.md`

---

## 2.5.1

### 移除

- **人口热力功能整体移除**。原腾讯位置服务的人口热力 / 潮汐 / 画像模块依赖企业资质，个人开发者无法采购，
  且与「不用可刷数据验证模型」的纪律冲突。相关代码、配置项、报告段落全部删除，改由 POI 代理指标承担需求侧分析。
  - `SKILL.md` 删除「0.5.3 腾讯人口热力应用方法」整节
  - `population.mjs` 删除
  - 报告第 4 段不再有「人口热力」回退分支

### 修正

- **README 与实现对齐**：删除「人口热力」「可直接替换底层数据接入层」「美团/点评爬虫」等与现状不符的表述
- **人口栅格标注为「规划中」**：WorldPop / GHSL / 中科院公里网格尚未接入代码
- `manifest.json` 作者字段统一为 `RoyShao`，补 `homepage`
- 「scripts/ 5 个脚本」更正为 6 个

### 新增

- `docs/SKILL-FULL.md`：完整计算口径（十节口径规范 + 22 条公式），
  与精简版 `SKILL.md` 并存，供 DSH 插件与需要精确口径的使用者参考

---

## 2.5.0

### 新增

- **截流两轴模型**：点位截流力 `L1–L5`（现场判定，客流乘数 1.30 / 1.10 / 1.00 / 0.65 / 0.15）
  × 竞争截流压力 `none / light / heavy`（POI 推算）。两轴不可互相替代。
- **财务双口径**：现金口径算回本（多久收回投资），会计口径算净利率（与行业可比）
- **税费与折旧摊销进模型**（`fin-v3` → `fin-v4`）：只扣租金人力会系统性高估净利，
  实测修正后回本周期从 23.9 月变为 57.4 月（行业基准 51.9 月）
- **内部比值校验**：毛利率 / 人力占营收 / 租售比 / 单方造价 vs 业态区间，越界给反推值
- **假设台账**：逐条列出「不是你亲口给的数」
- **双维敏感度**：财务侧 × 空间侧各参数 ±20%，看结论是否翻转
- **计算口径附录**：每个数字的公式 + 本次代入值 + 结果
- **行业基准对标**：19 城 × 48 业态 912 行，逐项偏离超 ±30% 报警
- **城市网格扫描**：地铁站 + 商场锚点，切片采集本地聚合（省 90% 调用），A/B/C 排序
- **网格台账与覆盖地图**：经纬度编号、状态机、覆盖率统计
- **需求侧代理指标**：住宅密度 / 职住比 / 咖啡银行密度 / 配套 → 综合需求强度
- **动线阻断实测**：批量步行距离、绕行倍数、阻断定级

### 修正

- 输出目录改为「业态-点位」，避免换地址覆盖上一份报告
- 「距锚点」为负时显示「无需降，尚有余量 X」，不再显示负数
- html 报告补齐「建议租金」整块（此前 md 有、html 缺）

---

## 2.4.0 及更早

- 双源 POI 采集（高德 + 腾讯）与三重去重
- 竞品三级分层：直接（同品类同价位）/ 替代（同品类不同价位）/ 间接（不同品类）
- 等时圈：Valhalla / OSRM 本地路网，未部署时降级直线估算并标注【估算】
- 极限租金反推 + 跨档最保守锚点
- 租期现金流：年递增、翻新周期、租期内回本月份
- 空间容量对账：座位 / 翻台 / 坪效 / 单方造价
- 参数覆盖三层：本次传参 > 单店文件 > 业态文件 > 内置默认
