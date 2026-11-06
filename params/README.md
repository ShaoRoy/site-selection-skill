# params/ 说明

**两条链路都读本目录：`scripts/grid-scan.py`（`--params`，默认指向 `params/grid.json`）与 `tools/run-site.mjs`。**
其余纯 Python 脚本（`site_core.py` 等）不读本目录，它们的参数来自命令行或 `overrides`。

## 各文件用途

| 文件 | 谁读 | 改了什么会生效 |
|---|---|---|
| `grid.json` | `scripts/grid-scan.py`（`--params`）、`tools/run-site.mjs` | 打分半径、权重、`k`、候选数、竞品词、额度门、采集切片 |
| `large_yuecai.json` | `tools/run-site.mjs` | 大型粤菜业态的默认财务参数 |
| `tea_house.json` | `tools/run-site.mjs` | 茶楼业态的默认财务参数 |
| `_template.json` | 人工参考 | 新建业态档时照抄结构 |

## 优先级与报错口径（v2.10.34 起）

1. **优先级**：CLI 显式传值 > `params/grid.json`。脚本会在输出里打印每一项的实际来源
   （例如 `radius_m = 1000（来源：params[grid.json].anchor_radius_m）`）。
2. **一律报错，不静默兜底**：参数文件不存在、JSON 非法、字段缺失、取值越界、
   `weights` 四项之和不等于 1 —— 任一情况都 `exit 1` 并指出具体字段，不存在
   「改配置没生效但看起来正常」这种状态。
3. **`schema_version` 必须为 2**。v2 把 `weights` 四项改为密度口径，
   旧版 `job_housing_ratio` 降级为报告参考字段（无量纲比值不能与密度相加）。

## `quota` 段已打通

`daily_limit` / `warn_threshold` / `hard_limit` / `min_interval_s` 在 v2.10.34 之前是
`scripts/grid-scan.py` 里的硬编码常量，改 `grid.json` 不生效。**现在已改为直接读取**，
脚本会在额度预估段打印「额度门来自 params[...].quota」以示生效来源。

## `--rescore` 与缓存

`out/grid/_pool-<城市>-<区>.json` 是采集快照，`--rescore` 复用它重新打分，0 次接口调用。
缓存结构只增字段不删字段：旧缓存仍可读；但**关键字段（`anchors` / `pool` 的四个 key /
`competitors`）缺失时明确报错**，不会填默认值蒙混过去。

## 相关文档

- 评分口径与手算示例：`docs/GRID.md` §4
- 公式登记：`references/02-formulas.md` §9（`grid-v1`）
- 失败模式台账：`references/06-regression-and-failure-modes.md`
