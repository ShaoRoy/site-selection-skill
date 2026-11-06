# 网格扫描与覆盖管理

> 目的：不给具体商圈时，**从一张空白地图上找出「先去哪几个地方找铺」**，并记住哪片做过、哪片没做。

---

## 一、网格编号（永久、全球唯一）

```
网格边长 0.005° ≈ 500m × 450m（广州）
grid_id = G{floor((lat + 90) / 0.005)}_{floor((lng + 180) / 0.005)}

例：23.119825, 113.333776 → G22623_58666
```

**为什么不按城市切**：城市边界会调整，序号会冲突；经纬度不会。

同时存 `geohash` 6 位，方便跟外部数据（平台后台、第三方）对齐。

编号公式只有一份真源：`scripts/grid-registry.py` 的 `grid_id()`。
`run-site.mjs` 里有一份 JS 复刻，**由 `test-grid.mjs` 断言两者一致**，防漂移。

---

## 二、状态机

```
未扫描 → 已扫描 → 已评估 → 已现场 → 候选池 / 已否决 / 已签约
```

| 状态 | 谁写的 | 含义 |
|---|---|---|
| 未扫描 | `grid-registry.py --create` | 铺底，还没查过 |
| 已扫描 | `grid-scan.py` | 有候选分数，但没做点位评估 |
| 已评估 | `run-site.mjs` | 有完整报告 |
| 已现场 | `run-site.mjs`（有 barriers 时）/ `walk-matrix.py` | 有动线阻断实测 |
| 已否决 / 已签约 | 人工 | 终态 |

**每次跑工具自动写，不手工维护**——手工填表没人能坚持三个月。

`history` 只追加不覆盖：半年后能回看这个网格什么时候扫的、评估过几次、为什么被否。

---

## 三、额度策略（硬门）

```
python scripts/grid-scan.py --city 广州 --district 天河 --dry-run
```

**默认只估算，不执行。**

| 预估调用量 | 行为 |
|---|---|
| ≤ `warn_threshold` | `--execute` 直接跑 |
| `warn_threshold` ~ `hard_limit` | 打印明细，要求 `--execute --yes` |
| > `hard_limit` | **拒绝**，提示缩小 `--district` / `--bbox` / `--top` |

**三个阈值不是常量，来自 `params/grid.json` 的 `quota` 段**（`warn_threshold` / `hard_limit` /
`daily_limit` / `min_interval_s`）。v2.10.34 之前它们是脚本内硬编码，改配置不生效；
现在脚本会打印「额度门来自 params[...].quota」以示生效来源，字段缺失或取值非法直接 `exit 1`。

实测：广州天河区（36 地铁 + 43 商场 → 55 锚点、9 个切片）= **176 次，约 1.8 分钟，占日配额 3.5%**。

**`--rescore`**：复用 `out/grid/_pool-<城市>-<区>.json` 采集快照重新打分，**0 次调用**。调权重、改 k 值都用它。
缓存结构只增字段不删字段：旧缓存仍可读，但关键字段（`anchors` / `pool` 四个 key / `competitors`）
缺失时明确报错，不填默认值。

---

## 四、打分模型（`FORMULA_VERSION = grid-v1`）

**双口径并存，各有边界，不可混用。**

### 4.1 绝对口径：`d_abs` / `p_abs`（可跨批次、跨城市比较）

四项统一为**密度**（个/km²）后各自乘权重求和。公式只依赖「本锚点的原始计数 + 参数」，
不含任何批次统计量——同一锚点换一批邻居、换一个城市跑，数值都不变。

```
area_km2 = π × (radius_m / 1000)²
住宅密度 = 住宅区 POI ÷ area_km2
办公密度 = 写字楼 POI ÷ area_km2
咖啡密度 = 咖啡   POI ÷ area_km2
配套密度 = (咖啡 + 银行) POI ÷ area_km2

d_abs = 0.30×住宅密度 + 0.20×办公密度 + 0.25×咖啡密度 + 0.25×配套密度
p_abs = 竞品 POI ÷ area_km2
```

**为什么不用职住比做权重项**：职住比（写字楼÷住宅）是无量纲比值，和密度不是同一量纲。
把它直接加进密度和，等于让权重随半径漂移——同一条街，`radius=800` 时配套项占 23.5%，
`radius=2000` 时占 65.1%，你以为在改半径，实际在改模型。
所以 `grid-v1` 起职住比降级为**报告参考字段**（CSV 仍输出 `job_housing_ratio`），不参与打分。

### 4.2 相对口径：`demand_rel` / `pressure_rel` / `rank_score`（仅供本批排名）

```
demand_rel   = min-max(d_abs)   到 0~100
pressure_rel = min-max(p_abs)   到 0~100
rank_score   = demand_rel − pressure_rel × k
```

**关键：`rank_score` 是「本批内相对值」，不可跨批次比较。**
绝对阈值在不同片区不可比——珠江新城 1km 内 20 家竞品很正常，郊区 5 家就算多。
所以排序与分档仍按本批相对位置：

- 分档按**排名**：Top 10% = A，Top 33% = B，其余 C
- 每行附一句 `reason`（需求强/竞争激烈/适合细分业态…）

**退化分支**：本批 `d_abs` 或 `p_abs` 全场同值（例如所有候选 1km 内都没有竞品）时，
相对分取 **0**，不是 50。旧版取 50 会让零竞争统一扣 `0.8×50 = 40` 分，
等于零竞争反被罚，是明确的符号错误。

`k` 按业态：大店 0.8（更怕竞争），小店 0.4。

### 4.3 手算示例（实跑输出，可逐位核对）

参数：`radius=1000`、`k=0.8`、权重 0.30/0.20/0.25/0.25。
候选「岗顶(B合成)」原始计数：住宅 150｜办公 40｜咖啡 15｜银行 12｜竞品 20。

```
area_km2 = π × 1² = 3.141593
住宅密度 = 150 / 3.141593 = 47.746483  → ×0.30 = 14.323945
办公密度 =  40 / 3.141593 = 12.732395  → ×0.20 =  2.546479
咖啡密度 =  15 / 3.141593 =  4.774648  → ×0.25 =  1.193662
配套密度 = (15+12)/3.141593 = 8.594367 → ×0.25 =  2.148592
                                           d_abs = 20.212678

本批 d_abs 区间 [1.034507, 32.547186]
demand_rel   = (20.212678 − 1.034507) / (32.547186 − 1.034507) × 100 = 60.8586
本批 p_abs 区间 [0.000000, 28.647890]
pressure_rel = (6.366198 − 0) / (28.647890 − 0) × 100                = 22.2222
rank_score   = 60.8586 − 22.2222 × 0.8                               = 43.0808
```

CSV 该行实测：`rank_score=43.0808, demand_rel=60.8586, pressure_rel=22.2222, d_abs=20.212678`
—— 逐位一致；同样数字完整落在 sidecar `candidates-<城市>-<区>.score.json` 里。

（上例用的是 `--rescore` 对合成快照的实跑结果，合成数据由 `tools/fixtures/make-grid-pool.mjs` 生成、
自带「1km 内计数 == 设计值」自校验，用于在没有 Key 的环境里复现。顺序：
`node tools/fixtures/make-grid-pool.mjs` → `python scripts/grid-scan.py --city 广州 --district 天河 --rescore` → `node tools/test-grid.mjs`。）

### 4.4 落盘与可回溯

| 落盘物 | 内容 |
|---|---|
| `candidates-<城市>-<区>.csv` | 逐项原始计数、四项密度、`d_abs`/`p_abs`、`demand_rel`/`pressure_rel`、`rank_score`、`score_formula_version` |
| `candidates-<城市>-<区>.score.json` | 参数快照（radius / k / weights / 来源）、归一化基准（本批 min/max）、逐候选的密度与加权贡献分解、公式文本 |
| 终端输出 | 每项参数的**实际来源**（CLI 还是 `params/grid.json`） |
| `grid/registry.json` | 写入 `rank_score`（仅本批可比，台账文案已注明） |

**代理标注**：POI 密度是 PROXY 代理指标，不是实测人流；密度分母固定为打分半径对应的圆面积。

---

## 五、局限（必须写在报告里）

| 局限 | 后果 | 缓解 |
|---|---|---|
| POI 收录偏差 | 城中村、新盘、小商户漏采 → 密度被低估 | 与现场观察交叉验证 |
| **POI 密度是代理指标（PROXY）** | 密度不等于实测人流，商圈热度可能被高估或低估 | 报告里必须标「代理」，不得写成「客流」 |
| **`rank_score` 只能同批比较** | 换一批候选，同一锚点的相对分会变 | 跨批次/跨城市比 `d_abs`，不比 `rank_score` |
| 网格是区域不是铺位 | 只能给「去哪找」，给不了「租哪间」 | 第 2 筛解决 |
| 商场内部铺位不在 POI | 商场锚点只代表"这个商场有人流" | 单独看楼层业态 |
| 锚点密度不均 | 市中心锚点多，可能偏向市区 | 按区分层取样 |

**网格扫描不做的事**：不给租金、不给铺位、不判能不能开。**那是第 2、3 筛。**

---

## 六、常用命令

```powershell
# 铺底：把某片区域的网格全部标成未扫描，覆盖率才有意义
python scripts/grid-registry.py --city 广州 --create --bbox 23.09,113.30,23.21,113.44

# 扫一片
python scripts/grid-scan.py --city 广州 --district 天河 --dry-run
python scripts/grid-scan.py --city 广州 --district 天河 --execute

# 改权重后重排（0 调用）
python scripts/grid-scan.py --city 广州 --district 天河 --rescore

# 查进度
python scripts/grid-registry.py --city 广州 --summary
python scripts/grid-registry.py --city 广州 --status 未扫描
python scripts/grid-registry.py --grid-id G22623_58666 --show

# 覆盖地图
python scripts/grid-registry.py --city 广州 --map   → out/grid/grid-map.html

# 看板
node tools/index-dashboard.mjs                    → out/index.md
```

---

## 七、与其他环节的衔接

```
第 1 筛   grid-scan 全城/全区扫        → Top 30 候选（A/B/C 档）
第 1.5 筛 run-site 逐点评估             → 竞品/份额/财务/基准对标
第 2 筛   walk-matrix + 现场            → 动线阻断、人流、铺位、租金
第 3 筛   财务锁盘 + 谈判               → 锚点、租期、翻新
```

每一环跑完都会把网格状态往前推一格，`out/index.md` 自动汇总。
