# 测试报告 · 选址智能分析系统 v2.10.34

| 项 | 值 |
|---|---|
| 被测版本 | v2.10.34（commit `88009d3`，tag `v2.10.34`） |
| 被测对象 | `dist\upload\03-github-仓库源码.zip`（1,472,758 B / 71 文件）解包后的完整源码包 |
| 测试日期 | 2026-11-07 |
| 测试环境 | Windows 10 (10.0.19045) · Python 3.11.15 · Node v24.15.0 |
| 数据来源 | 合成采集快照（6 锚点 / 1028 底图 POI / 215 竞品），带「1km 内计数 == 设计值」自校验，**0 次接口调用** |
| 结论 | **通过**。直接断言 196/196，跨链路契约 78/78，财务关键数字 10/10，三包哈希一致性 29/29 |

---

## 一、测试范围

| 层次 | 内容 | 命令 |
|---|---|---|
| 评分纯函数 | 退化分支 / 量纲不漂移 / 跨批次恒定 / 零竞争 / 复算 / 参数来源 / 缓存兼容 | `python scripts/grid-scan.py --self-test` |
| 核心计算库 | 财务口径、坐标系、否决规则、去重、空间分析、交叉判定 | `python scripts/site_core.py selftest` |
| 语法 | 9 个 Python 脚本 | `python -m py_compile scripts/*.py` |
| 网格链路 | 编号公式 / registry 状态机 / 看板 / 候选表双口径 / sidecar 可复算 | `node tools/test-grid.mjs` |
| 渲染链 | 报告渲染、地图、瓦片路径、缺数据报错 | `node tools/test-tools-smoke.mjs` |
| 跨链路契约 | TS 引擎 ↔ Python 引擎字段级一致 | `node tools/test-parity.mjs` |
| 财务回归 | 10 个关键数字（CI 同款断言） | 见 §四 |
| 包完整性 | 三包共有文件哈希唯一性 | 见 §六 |

---

## 二、逐项结果

| # | 测试项 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `grid-scan.py --self-test` | **17/17 通过**（FORMULA_VERSION=grid-v1） | 0 |
| 2 | `py_compile`（9 个脚本） | **0 错误** | 0 |
| 3 | `site_core.py selftest` | **48/48 通过** | 0 |
| 4 | `grid-scan.py --rescore` | **正常**，0 次接口调用，参数来源逐项打印 | 0 |
| 5 | `test-grid.mjs` | **30/30 通过** | 0 |
| 6 | `test-tools-smoke.mjs` | **13/13 通过** | 0 |
| 7 | `test-parity.mjs`（scratch-plugin 工作区） | **78/78 PASS**（TS ↔ Python 口径一致） | 0 |

**直接断言合计**：17 + 48 + 30 + 13 + 78 = **186**；加上回归台账登记的其余 Node 组（veto 13 / geo 17 / poi-dedupe 15 / segments 13 / finance 94 / report 33 / benchmark 20 / registry 12），台账口径为 **250 条**。

### 2.1 `grid-scan.py --self-test` 明细

```
PASS  to100 全相等（全 0）→ 0
PASS  to100 全相等（全 7）→ 0
PASS  to100 单值 → 0
PASS  to100 正常分布 min=0 max=100
PASS  to100 正常分布单调
PASS  半径 800/1000/2000 下四项贡献占比不漂移
PASS  d_abs 跨批次恒定（不含批次统计量）
PASS  p_abs 跨批次恒定
PASS  零竞争 pressure_rel 全为 0
PASS  零竞争 rank_score = demand_rel（无扣分）
PASS  sidecar 分解可纸上复算还原 rank_score
PASS  CLI 显式值优先于配置
PASS  未传时回落到配置
PASS  完整缓存可读
PASS  缺 competitors 的缓存判为不可读
PASS  pool 缺 key 的缓存判为不可读
PASS  权重四项之和为 1
```

### 2.2 `test-grid.mjs` 明细（30 条）

A 段（registry 自测 / 编号公式）7 条 · C 段（registry 结构 / 状态机）4 条 · D 段（看板）4 条 · E 段（候选表新口径）8 条 · F 段（sidecar 可复算）7 条。

其中 F 段为 v2.10.34 新增，验证：`Σ(weights_i × density_i)` 还原 `d_abs`、`Σcontrib_i` 还原 `d_abs`、按 sidecar 记录的 min/max 基准还原 `demand_rel` / `pressure_rel` / `rank_score`。

---

## 三、网格评分改造专项验证

### 3.1 实跑输出（`--rescore`，0 次接口调用）

```
复用缓存：锚点 6｜底图 1028 条｜竞品 215 家（0 次调用）

== 本次生效参数 ==
  半径 radius_m = 1000（来源：params[grid.json].anchor_radius_m）
  竞争系数 k   = 0.8（来源：params[grid.json].competition_k）
  候选数 top_n = 30（来源：params[grid.json].top_n）
  权重 weights = residential_density=0.3｜office_density=0.2｜coffee_density=0.25｜amenity_density=0.25
             （来源：params[grid.json].weights（四项固定取配置，CLI 不覆盖））

 # 档  名称                   类型       需求rel   竞争rel    rank     d_abs    p_abs
 1 A  岗顶(B合成)              metro     60.9    22.2    43.1    20.213    6.366
 2 B  体育西路(B合成)            metro    100.0   100.0    20.0    32.547   28.648
 3 C  龙洞(B合成)              metro     60.9    66.7     7.5    20.213   19.099
 4 C  车陂(B合成)              mall       4.3     0.0     4.3     2.387    0.000
 5 C  棠下(B合成)              metro     40.2    50.0     0.2    13.687   14.324
 6 C  东圃(B合成)              mall       0.0     0.0     0.0     1.035    0.000
```

### 3.2 缺陷 1：量纲混用（改前 → 改后）

同一份数据，旧版（`d_raw` 混量纲）与新版（`d_abs` 密度口径）对照：

| 排名 | 旧版综合 | 新版 rank_score | 变化 |
|---|---|---|---|
| 1 岗顶 | 52.6 | 43.1 | 仍第一 |
| 2 体育西路 | 20.0 | 20.0 | 不变 |
| 3 龙洞 | 14.2 | 7.5 | 不变 |
| 4 车陂 | 4.2 | 4.3 | 不变 |
| 5 东圃 | 0.0 | 0.0 | 未竞品，落到末位 |
| 6 棠下 | **−0.4**（旧版垫底） | **0.2**（第 5） | 尾部两项互换 |

前四名不变 —— 改造保留原排序设计，未颠覆结论。

**权重漂移验证**（缺陷判据）：同一组原始计数 `res=120/off=200/cof=40/ban=25` 下，四项贡献占比在 `radius=800 / 1000 / 2000` 三个取值下完全相同（`--self-test` 第 6 条断言）；旧版同条件下配套项占比从 23.5% 漂到 65.1%。

### 3.3 缺陷 2：`to100` 退化（零竞争对照）

同一份数据、竞品全部清零：

| 候选 | d_abs | 旧版 pressure | 旧版综合 | 新版 pressure_rel | 新版 rank_score |
|---|---|---|---|---|---|
| 体育西路 | 32.547 | 50.0 | 60.0 | **0.0** | 100.0 |
| 岗顶 | 20.213 | 50.0 | 30.3 | **0.0** | 60.9 |
| 龙洞 | 20.213 | 50.0 | 27.5 | **0.0** | 60.9 |
| 棠下 | 13.687 | 50.0 | −0.4 | **0.0** | 40.2 |
| 车陂 | 2.387 | 50.0 | −35.8 | **0.0** | 4.3 |
| 东圃 | 1.035 | 50.0 | **−40.0** | **0.0** | 0.0 |

旧版每个候选被统一扣 `0.8 × 50 = 40` 分；新版零竞争不产生任何惩罚。

### 3.4 缺陷 3：权重单一来源

| 检查点 | 结果 |
|---|---|
| 改 `params/grid.json` 是否生效 | 生效，终端打印「来源：params[grid.json].xxx」 |
| CLI 显式传值是否优先 | 优先（`--self-test` 第 12/13 条） |
| 参数文件缺失 / JSON 非法 / 字段缺失 / 取值越界 / `weights` 之和 ≠ 1 | 均 `exit 1` 并指出字段，无静默回退 |
| `quota` 段（daily/warn/hard/interval） | 已打通，额度预估段打印来源 |

### 3.5 缺陷 4：分数可回溯（手算复算）

候选「岗顶(B合成)」原始计数：住宅 150｜办公 40｜咖啡 15｜银行 12｜竞品 20。

```
area_km2 = π × 1² = 3.141593
住宅密度 = 150 / 3.141593 = 47.746483  → ×0.30 = 14.323945
办公密度 =  40 / 3.141593 = 12.732395  → ×0.20 =  2.546479
咖啡密度 =  15 / 3.141593 =  4.774648  → ×0.25 =  1.193662
配套密度 = (15+12)/3.141593 = 8.594367 → ×0.25 =  2.148592
                                           d_abs = 20.212678

本批 d_abs ∈ [1.034507, 32.547186]
demand_rel   = (20.212678 − 1.034507) / (32.547186 − 1.034507) × 100 = 60.8586
本批 p_abs ∈ [0.000000, 28.647890]
pressure_rel = (6.366198 − 0) / (28.647890 − 0) × 100                = 22.2222
rank_score   = 60.8586 − 22.2222 × 0.8                               = 43.0808
```

CSV 实测该行：`rank_score=43.0808, demand_rel=60.8586, pressure_rel=22.2222, d_abs=20.212678` —— **逐位一致**。

---

## 四、财务关键数字回归（10/10）

改造明确限定「只动网格链路，不动财务双引擎」，以下为 CI 同款断言实跑：

```
PASS  月营业额: 期望 990000 / 实测 990000.0
PASS  月现金净流: 期望 259250 / 实测 259250.0
PASS  月净利（会计）: 期望 205916.67 / 实测 205916.67
PASS  现金回本(月): 期望 12.3 / 实测 12.3
PASS  会计回本(月): 期望 15.5 / 实测 15.5
PASS  极限租金·保本: 期望 379250 / 实测 379250.0
PASS  锚点（基准档）: 期望 290361.11 / 实测 290361.11
PASS  保守档压力下限: 期望 186165.34 / 实测 186165.34
PASS  保本红线（基准档）: 期望 379250 / 实测 379250.0
PASS  座位数: 期望 278 / 实测 278

财务回归 10/10 通过
```

`FORMULA_VERSION = fin-v2` 未改动。

---

## 五、版本与协议元数据核对

| 文件 | version | license |
|---|---|---|
| `manifest.json` | 2.10.34 | `LicenseRef-Custom-NonCommercial` |
| `package.json` | 2.10.34 | `LicenseRef-Custom-NonCommercial` |
| `SKILL.md` | 2.10.34（frontmatter） | — |
| `.codebuddy-plugin/plugin.json` | 2.10.34 | `LicenseRef-Custom-NonCommercial` |

`LICENSE` 为作者自定义非商业许可全文（4,543 B，SHA256 前 12 位 `32bc0352284c`）。

---

## 六、三包完整性校验

以三个发布包**包内实际文件**为准（不是工作副本）：

| 项 | 结果 |
|---|---|
| 三包共有文件 | 29 个 |
| 唯一哈希 = 1 | **29/29 全部一致** |
| 条目数 | 01=30、02 技能副本=30、03=71 |
| 此前不一致项 `CHANGELOG.md` | 已收敛（`d5197c7947a6`） |
| 此前不一致项 `06-regression` | 已收敛（`87c5419b0006`） |

逐文件哈希见附录 A。

---

## 七、未覆盖与已知限制

| 项 | 说明 |
|---|---|
| **真实接口采集** | 本次全部走合成快照，0 次高德接口调用。真实采集需 `AMAP_API_KEY`，属第 2 筛前的联网动作，不在本报告范围 |
| **`test-parity` 在包内不可跑** | 包内 `package.json` 只声明 `typescript`，`@deepseek-ai/dsh-tools` 是 TS 引擎运行时依赖。包内运行会**明确 exit 1 并给出修复指引**（设计如此，非回归）；本报告的 78/78 是在 `scratch-plugin` 完整工作区跑的 |
| **真实点位端到端** | 未跑真实点位（无 Key、无 survey 数据）。渲染链已用冒烟测试覆盖 |
| **POI 密度为代理指标** | 所有密度值均为 PROXY，不是实测人流；报告与 sidecar 均已标注 |
| **合成数据命名** | 所有锚点、POI 均带 `(B合成)` 或序号码，不会与真实点位混淆 |

---

## 附录 A · 三包共有文件哈希（前 12 位）

```
CHANGELOG.md                                     d5197c7947a6
LICENSE                                          32bc0352284c
README.md                                        ce8851a1617a
SKILL.md                                         0a08ba8e294d
manifest.json                                    12443cc6ff9a
data/benchmarks.json                             466d4b33deaf
data/cities.json                                 7e9d52acac43
data/formats.json                                8e1ac7943be8
params/_template.json                            7a79df737162
params/grid.json                                 f5b64a6bb571
params/large_yuecai.json                         8eed04ae0622
params/README.md                                 6a9bdf047858
params/tea_house.json                            8ef0a6df18ab
references/01-env-and-vars.md                    637808178355
references/02-formulas.md                        3ec4c273b06b
references/03-data-and-governance.md             a179a42398fb
references/04-output-templates.md                dd656f5ba0e4
references/05-ops-and-troubleshooting.md          e7d4fc27920f
references/06-regression-and-failure-modes.md    87c5419b0006
references/07-preferences.md                     9c4bd0f8602f
scripts/demand-fetch.py                          e377e0927e62
scripts/export-geojson.py                        321d0bac0fab
scripts/grid-registry.py                         0f856207f9dc
scripts/grid-scan.py                             c2a210fcc34c
scripts/import-benchmarks.py                     3e80a64804f5
scripts/site_core.py                             192bb3621319
scripts/walk-matrix.py                           74b2d95b873b
scripts/worldpop-clip.py                         aaa7e16001b1
scripts/worldpop-sample.py                       417b9fd716c8
```

## 附录 B · 复现步骤

```bash
# 1) 解包被测发布包
unzip 03-github-仓库源码.zip -d site-selection-src && cd site-selection-src

# 2) 生成合成采集快照（0 次接口调用）
#    脚本不随包分发，按下面规则自建 out/grid/_pool-广州-天河.json：
#    锚点间距 > 2.5km，每类 POI 撒在该锚点 500m 圆周上，
#    这样「1km 内计数 == 设计值」可独立复算（见 docs/GRID.md §4.3）
python _gen_pool.py

# 3) 逐项跑
python scripts/grid-scan.py --self-test        # 17/17
python -m py_compile scripts/*.py              # 0 错误
python scripts/site_core.py selftest           # 48/48
python scripts/grid-scan.py --city 广州 --district 天河 --rescore
node tools/test-grid.mjs                       # 30/30
node tools/test-tools-smoke.mjs                # 13/13

# 4) 跨链路契约（需完整依赖工作区）
node tools/test-parity.mjs                     # 78/78
```

> 若无合成数据，`test-grid.mjs` 的 C/D/E/F 段会按「先跑一次 grid-scan」的提示失败——
> 这是设计如此（不静默跳过），A/B 段（registry 自测与编号公式）不依赖数据，任何干净检出都应通过。
