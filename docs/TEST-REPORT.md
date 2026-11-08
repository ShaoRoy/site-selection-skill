# 测试报告 · 选址智能分析系统 v2.10.36

| 项 | 值 |
|---|---|
| 被测版本 | v2.10.36（commit `9d473d8` 起，补修后未升版） |
| 被测对象 | `dist\upload\03-github-仓库源码.zip`（1,489,479 B / 74 文件）解包后的完整源码包 |
| 测试日期 | 2026-11-07（v2.10.36 收口轮复测） |
| 测试环境 | Windows 10 (10.0.19045) · Python 3.11.15 · Node v24.15.0 |
| 工作区依赖 | `dist\site-selection\node_modules` 为 **Junction** → `scratch-plugin\node_modules`（`dsh-tools@0.1.0-rc.8` / `cordis@4.0.5` / `typescript@5.6.3`）；未使用 `cp -a` 复制，避免断内部软链 |
| 数据来源 | 合成采集快照（6 锚点 / 1028 底图 POI / 215 竞品），由 `tools/fixtures/make-grid-pool.mjs` 生成并自带「1km 内计数 == 设计值」自校验，**0 次接口调用** |
| 结论 | **通过**。见下方逐项表；跨链路契约由 78 项提升至 **136 项**（v2.10.36 新增 `sensitivity` 4 行 × 7 字段比对） |

> 本报告取代 v2.10.34 版。历史结论（parity 78/78、直接断言 196/196）已不适用，保留在文末「历史版本」小节便于对照。

---

## 一、测试范围

| 层次 | 内容 | 命令 |
|---|---|---|
| 发布文本守卫 | 控制字符 / 孤立 CR / README 徽章（单行·14 个·绝对 https）/ Markdown 表格与标题层级 / docs 白名单 | `node tools/check-text.mjs` |
| 评分纯函数 | 退化分支 / 量纲不漂移 / 跨批次恒定 / 零竞争 / 复算 / 参数来源 / 缓存兼容 | `python scripts/grid-scan.py --self-test` |
| 核心计算库 | 财务口径、坐标系、否决规则、去重、空间分析、交叉判定 | `python scripts/site_core.py selftest` |
| 语法 | 9 个 Python 脚本 | `python -m py_compile scripts/*.py` |
| 网格链路 | 编号公式 / registry 状态机 / 看板 / 候选表双口径 / sidecar 可复算 | `node tools/test-grid.mjs` |
| 渲染链 | 报告渲染、地图、瓦片路径、缺数据报错 | `node tools/test-tools-smoke.mjs` |
| 跨链路契约 | TS 引擎 ↔ Python 引擎字段级一致（含 `sensitivity`） | `node tools/test-parity.mjs` |
| 财务回归 | 10 个关键数字 + 敏感度档位一致（CI 同款断言） | 见 §四 |
| 包完整性 | 三包共有文件哈希唯一性 | 见 §六 |

---

## 二、逐项结果

| # | 测试项 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `check-text.mjs` | **控制字符 0 / 徽章 14 / TAB 0 / docs 白名单 6/6** | 0 |
| 2 | `grid-scan.py --self-test` | **17/17 通过**（FORMULA_VERSION=grid-v1） | 0 |
| 3 | `py_compile`（9 个脚本） | **0 错误** | 0 |
| 4 | `site_core.py selftest` | **48/48 通过** | 0 |
| 5 | 网格夹具 + `grid-scan --rescore` | **正常**，0 次接口调用，参数来源逐项打印 | 0 |
| 6 | `test-grid.mjs` | **30/30 通过** | 0 |
| 7 | `test-tools-smoke.mjs` | **13/13 通过** | 0 |
| 8 | `test-parity.mjs` | **136/136 PASS**（TS ↔ Python 口径一致） | 0 |
| 9 | 空仓自举（解压到空目录按序跑） | 夹具 → rescore → test-grid **30/30** | 0 |

### 计数口径说明（避免数字打架）

| 口径 | 条数 | 含义 |
|---|---|---|
| 源码包全量 `pnpm test` | **250** | 10 组 node 测试之和（`references/06` 为唯一基准） |
| TS ↔ Python 契约 | **136** | 两条引擎逐字段比对；v2.10.34 之前只有 78 且未覆盖 `sensitivity` |
| Python 侧自检 | **48** | `site_core.py selftest` |
| 网格评分纯函数 | **17** | `grid-scan.py --self-test` |
| 网格链路 | **30** | `test-grid.mjs` |
| 渲染链 | **13** | `test-tools-smoke.mjs` |

---

## 三、v2.10.36 新增：敏感度口径统一（P1）

报告里「敏感度：各参数 ±20% 对谈判锚点的影响」曾**同一张表两把尺子**：基准列取 base 档、两端扰动取 pessimistic 档。修复后：

| 参数 | 改前（保守档） | 改后（base 档） | 会翻转 |
|---|---|---|---|
| 日营业额 | −194619.05 / 65238.10 / 325095.24 | **44000 / 365000 / 686000** | True → True |
| 毛利率 | −216476.19 / 65238.10 / 346952.38 | **17000 / 365000 / 713000** | True → True |
| 人力成本 | 221238.10 / 65238.10 / −90761.90 | **521000 / 365000 / 209000** | False → **True** |
| 初始投入 | 89047.62 / 65238.10 / 41428.57 | **390000 / 365000 / 340000** | False → False |

**反证**：把 `site-tools.ts` 的 `anchorOf` 改回 `pessimistic` → `test-parity.mjs` 输出逐字段差异并 `exit 1`；改回后 136/136。

---

## 四、财务回归（CI 同款断言）

参数：`daily_revenue=30000 / gross_margin=0.62 / monthly_rent=120000 / monthly_labor=150000 / monthly_other_fixed=40000 / initial_investment=3200000`，`area=1200`、`avg_ticket=230`、`catchment=L2`、`large_yuecai`。

| 断言 | 期望 | 结果 |
|---|---|---|
| 营收 | 990,000 | ✅ |
| 现金净流 | 259,250 | ✅ |
| 会计净利 | 205,916.67 | ✅ |
| 现金回本 | 12.3 月 | ✅ |
| 会计回本 | 15.5 月 | ✅ |
| 极限租金保本 | 379,250 | ✅ |
| 锚点（基准档） | 290,361.11 | ✅ |
| 保守档压力下限 | 186,165.34 | ✅ |
| 保本红线（基准档） | 379,250 | ✅ |
| 座位 | 278 | ✅ |
| **敏感度 4 行 `anchor_base` 均等于 `target_rent`** | 290,361.11 | ✅ |

---

## 五、发布文本守卫（v2.10.36 新增）

`check-text.mjs` 已从「只查控制字符」扩为四类断言，并进入 `npm test` 第一段：

| 规则 | 判定 |
|---|---|
| 控制字符 `U+0000–0008 / 000B / 000C / 000E–001F / 007F`、孤立 CR | 致命 |
| README 徽章必须单行 `<p>`、`<img` = 14、`href` 全 `https://`、无 `vercel.app` | 致命 |
| Markdown 表格同块竖线数一致、标题层级不跳级 | 致命（docs 白名单 6 处除外） |
| `dist` 精确跳过 `release/` `_backup-*` `_archive-*` `node_modules/` | 保证发布看板进扫描 |

**白名单反证（两组）**

1. 在 `docs/_whitelist_probe.md` 注入 3 列 vs 2 列不齐的表格 → `exit 1`，输出 `docs\_whitelist_probe.md @L6 表格行竖线数 3，表头为 4`；移除后 `exit 0`。
2. 改动被白名单锁定的文件的前置行（`SKILL-FULL.md` 头部加 3 行）→ 行号失配、`exit 1`。这是**有意设计**：白名单按「文件 + 行号」硬锁定，不随内容漂移。

当前白名单（6 处，全部实测存在）：

```
docs/SKILL-FULL.md@L33
docs/未处理事项.md@L12
docs/未处理事项.md@L13
docs/未处理事项.md@L23
docs/未处理事项.md@L33
docs/未处理事项.md@L55
```

---

## 六、包完整性

| 检查 | 结果 |
|---|---|
| 三包共有文件 | **29 个，唯一哈希 = 1** |
| 条目数 | 01=30 / 03=**81** |
| 01 ↔ 03 同源文件 | **28/28** 归一化后逐字节一致（README 除外） |
| `_src` ↔ 包内 | 三个包逐条目零差异（`verify-release.mjs` 第 [2] 项） |
| `release\` 三副本 | 与根包逐字节相同 |

---

## 七、未覆盖 / 已知边界

| 项 | 说明 |
|---|---|
| 真实 POI 采集 | 全流程用合成快照，**0 次接口调用**；真实 Key 下的高德 / 腾讯双源未在本轮验证 |
| WorkBuddy 实机导入 | 平台识别与安装路径 `~/.dsh/skills/restaurant-location-analysis` **未实机验证** |
| 03 包运行时依赖 | `package.json` 只声明 `typescript`，`dsh-tools` / `cordis` 未声明；当前靠工作区 Junction 才能跑 parity，属长期待立项 |
| `docs/SKILL-FULL.md` | 历史全文存档，含已废止旧口径，已加存档标注，不参与验收 |

---

## 八、历史版本对照

| 版本 | 契约断言 | 说明 |
|---|---|---|
| v2.10.34 | 78/78 | 未覆盖 `sensitivity`；`anchorOf` 取 pessimistic |
| v2.10.35 | 78/78 → 修文本污染，财务未动 | — |
| **v2.10.36** | **136/136** | 新增 `sensitivity` 4 行 × 7 字段；TS 与 Python 双端统一到 base 档 |
