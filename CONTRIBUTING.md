# 参与与反馈

本项目的核心约束是**口径一致**：同一个指标在 Python 引擎、TS 渲染链、报告正文里必须是同一个数。所以这里的规则都围绕「让问题可复现、让改动可验证」写，不是客套话。

## 一、提 issue 前，先跑四项自检

在含 `scripts/` 的目录下执行（即本 SKILL.md 所在目录）：

```bash
cd <本 SKILL.md 所在目录>
python scripts/site_core.py selftest        # 期望 48/48
python scripts/site_core.py formats         # 期望 业态规则可加载
python scripts/grid-scan.py --self-test     # 期望 17/17
python scripts/grid-registry.py --self-test # 期望 12/12
```

只做财务测算时**不需要任何 API Key**。四项任一失败，直接带着输出提 bug，不必再跑业务命令。

## 二、一个可定位的报告长什么样

| 必填项 | 说明 |
|---|---|
| 版本 | `manifest.json` 的 `version`，或 git tag |
| 宿主 | WorkBuddy / DSH / Claude Code / claude.ai / 其他 Agent / 纯命令行 |
| 环境 | 操作系统 + `python -V`；渲染链或网格链路问题补 `node -v` |
| 复现命令 | 完整命令含全部参数，多步按顺序 |
| 期望 vs 实际 | 期望写口径来源（公式或 `references/` 的哪一节）；实际贴原始输出 |
| selftest 尾部 | 四条命令的结论行 |

缺其中任意一项，尤其缺 `selftest` 输出，问题基本只能靠猜。

**脱敏**：贴 `probe.json`、`out/grid` 缓存前，先删掉 Key、cookie、内网地址。仓库里的 issue 是公开且长期可检索的。

## 三、不受理的几类

- **「这个店能不能开」**：项目只出证据与缺口，不做裁决；这是设计边界，不是能力不足。
- **要求预测真实营业额 / 保证回本**：所有财务数都是基于输入参数与行业基准的推演，报告里标了三档情景。
- **新增 OSM 或其他 POI 数据源**：POI 双源固定为高德 + 腾讯；OSM 仅用于静态底图与可选路网层，不参与 POI 口径。
- **商业授权**：走邮件，不走 issue（见 [LICENSE](LICENSE) 第二条）。

## 四、Pull Request

提交前请本地跑通 CI 的同一套检查（共 19 个 `run` 步骤）：

```bash
python -m py_compile scripts/*.py
node tools/check-text.mjs
python scripts/site_core.py selftest
node tools/test-tools-smoke.mjs
node tools/test-parity.mjs      # 136 项字段比对
```

额外约定：

- **改公式必须双引擎同步**：Python 侧 `scripts/site_core.py` 与 TS 侧同时改，并升 `FORMULA_VERSION`；只改一边会让 `test-parity.mjs` 直接红。
- **改口径必须加断言**：新规则进 `selftest`，不许「代码改了、基线没动」。
- **改 README**：只改仓库根的 `README.md`，包内副本由维护者在发版时同步（两包 README 要求逐字节一致）。
- **不加图片**：报告截图是唯一的示例图，其余优化只用文字。
- **不改历史**：CHANGELOG 已发布的版本段落不复写。

## 五、许可

本项目采用 [Custom NonCommercial License](LICENSE)，**不是 OSI 开源许可**。提交 PR 即表示同意你的贡献以同一许可分发，并保留原作者署名与仓库链接。不接受把项目改为 OSI / Creative Commons 许可的改动。

商业使用（付费产品、商业 SaaS、对外 API、收费交付、企业内部经营性系统等）须事先取得作者书面许可。
