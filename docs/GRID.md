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

编号公式只有一份真源：`tools/grid-registry.py` 的 `grid_id()`。
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
python tools/grid-scan.py --city 广州 --district 天河 --dry-run
```

**默认只估算，不执行。**

| 预估调用量 | 行为 |
|---|---|
| ≤ 500 | `--execute` 直接跑 |
| 500 ~ 1500 | 打印明细，要求 `--execute --yes` |
| > 1500 | **拒绝**，提示缩小 `--district` / `--bbox` / `--top` |

实测：广州天河区（36 地铁 + 43 商场 → 55 锚点、9 个切片）= **176 次，约 1.8 分钟，占日配额 3.5%**。

**`--rescore`**：复用 `out/grid/_pool-<城市>-<区>.json` 采集快照重新打分，**0 次调用**。调权重、改 k 值都用它。

---

## 四、打分模型

```
需求原始分 = 住宅密度×0.30 + 职住比×0.20 + 咖啡密度×0.25 + 配套(咖啡+银行)×0.25
竞争压力   = 锚点 1km 内竞品数
综合       = 归一化(需求) − 归一化(压力) × k
```

**关键：分数是「本批内相对值」，不是绝对值。**

绝对阈值在不同片区不可比——珠江新城 1km 内 20 家竞品很正常，郊区 5 家就算多。所以：

- 需求与压力都先做 min-max 归一化到 0~100
- 分档按**排名**：Top 10% = A，Top 33% = B，其余 C
- 每行附一句 `reason`（需求强/竞争激烈/适合细分业态…）

`k` 按业态：大店 0.8（更怕竞争），小店 0.4。

---

## 五、局限（必须写在报告里）

| 局限 | 后果 | 缓解 |
|---|---|---|
| POI 收录偏差 | 城中村、新盘、小商户漏采 → 密度被低估 | 与现场观察交叉验证 |
| 网格是区域不是铺位 | 只能给「去哪找」，给不了「租哪间」 | 第 2 筛解决 |
| 商场内部铺位不在 POI | 商场锚点只代表"这个商场有人流" | 单独看楼层业态 |
| 锚点密度不均 | 市中心锚点多，可能偏向市区 | 按区分层取样 |

**网格扫描不做的事**：不给租金、不给铺位、不判能不能开。**那是第 2、3 筛。**

---

## 六、常用命令

```powershell
# 铺底：把某片区域的网格全部标成未扫描，覆盖率才有意义
python tools/grid-registry.py --city 广州 --create --bbox 23.09,113.30,23.21,113.44

# 扫一片
python tools/grid-scan.py --city 广州 --district 天河 --dry-run
python tools/grid-scan.py --city 广州 --district 天河 --execute

# 改权重后重排（0 调用）
python tools/grid-scan.py --city 广州 --district 天河 --rescore

# 查进度
python tools/grid-registry.py --city 广州 --summary
python tools/grid-registry.py --city 广州 --status 未扫描
python tools/grid-registry.py --grid-id G22623_58666 --show

# 覆盖地图
python tools/grid-registry.py --city 广州 --map   → out/grid/grid-map.html

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
