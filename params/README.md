# params/ 说明

**这个目录只有一条链路会读：`tools/run-site.mjs`（DSH 侧编排器）。**

纯 Python 脚本（`scripts/*.py`）**不读本目录**——它们的参数是脚本内的常量，
或在命令行参数里传。所以在只装了技能包（不含 `tools/`）的环境里，
本目录的文件是**摆设**，改它们不会有任何效果。

## 各文件用途

| 文件 | 谁读 | 改了什么会生效 |
|---|---|---|
| `grid.json` | `tools/run-site.mjs` | 网格边长、采集切片、竞品关键词 |
| `large_yuecai.json` | `tools/run-site.mjs` | 大型粤菜业态的默认财务参数 |
| `tea_house.json` | `tools/run-site.mjs` | 茶楼业态的默认财务参数 |
| `_template.json` | 人工参考 | 新建业态档时照抄结构 |

## 已知未打通的地方

- `grid.json` 的 `quota` 段（`daily_limit` / `hard_limit` / `min_interval_s`）
  在 `scripts/grid-scan.py` 里是**硬编码常量**，改这里不生效。
  要改请直接改脚本顶部，或改完用 `--rescore` 重排（0 次接口调用）。
- 想彻底消除这个不一致，需要给 `grid-scan.py` 加一个 `--params` 参数去读本目录——
  尚未实现。
