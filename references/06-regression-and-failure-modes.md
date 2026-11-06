# 回归基线与失败模式台账

> 用途：改完任何口径、模板、脚本后，照这份跑一遍确认没改坏。
> 这是「评估-反馈闭环」的落点——每次踩过的坑都记在这里，不靠记忆。

## 一、自动化基线（当前 v2.10.35）

```bash
# 技能包内可直接跑（零依赖、离线）
python scripts/site_core.py selftest        # 48/48
python scripts/grid-scan.py --self-test     # 17/17（评分纯函数，不联网、不需要 Key）

# 源码包内：网格链路要按顺序自举（含测试夹具，0 次接口调用）
node tools/fixtures/make-grid-pool.mjs                                    # 生成 out/grid 夹具
python scripts/grid-scan.py --city 广州 --district 天河 --rescore          # 生成候选表 + sidecar
node tools/test-grid.mjs                                                  # 30/30
node tools/check-text.mjs                                                 # 发布文本控制字符 = 0

# 源码包内跑全量
cd <源码包>
pnpm test && pnpm typecheck                 # 250 + 0 error
```

| 组 | 条数 | 覆盖 |
|---|---|---|
| test-veto | 13 | 否决规则（提醒语义，不裁决） |
| test-geo | 17 | 等时圈 / 距离 / 坐标偏移 |
| test-poi-dedupe | 15 | 去重 / 前置清洗 / 分段 |
| test-segments | 13 | 竞争分段 × 价位段 |
| test-finance | 94 | 三档 / 保本 / 回本 / 锚点 / 租期 / 空间 / 比值 / 翻台风险 |
| test-report | 33 | 报告结构 / 段落完整性 |
| test-benchmark | 20 | 19 城 × 48 业态对标 |
| test-grid | 30 | 网格编号公式 + 候选评分双口径 + sidecar 可复算（v2.10.34 由 16 增至 30，+14） |
| registry --self-test | 12 | 网格注册表自检 |
| test-tools-smoke | 13 | 渲染链（含默认瓦片路径回归） |
| **合计** | **250** | 其余组条数不变，本轮只记 test-grid 的增量 |

**基线：250/250 通过 + typecheck 0 error + Python selftest 48/48 + grid-scan self-test 17/17。**

数字变了不是坏事，但**必须能解释为什么变**。解释不了就是改坏了。

## 二、失败模式台账（踩过的坑，按症状索引）

### 判定与展示不同源

| 症状 | 根因 | 判据 |
|---|---|---|
| 数值 36 却被判成「可接受上限」 | 判定用未舍入值（36.000000000000004）、展示用舍入值（36） | 制造一个正好落在标尺边界的用例，看判定是否与展示一致 |
| 翻台 1.499 判红但显示贴线 0.0012 | 同上，方向相反 | 同上 |

**规矩**：连续判定用原值，贴标尺的判定用展示值。两类不能混。

### 网格候选评分（v2.10.34 集中修复）

| 症状 | 根因 | 判据 |
|---|---|---|
| 只改 `radius`，排序大幅变化但原始计数一点没变 | **量纲混用**：密度项（个/km²）与绝对计数项 `(cof+ban)`、无量纲比值项（职住比）直接加权相加，各项权重随半径漂移 | 同一组原始计数下，`radius=800` 与 `2000` 的四项贡献占比必须完全相同 |
| 同一锚点换一批候选，分数从 30 变 4.1 | 把本批 min-max 的**相对分**当绝对分用，还对外声称「可横向对比」 | 跨批次/跨城市只能比 `d_abs`；`rank_score` 只在本批有效，CSV 列名已区分 |
| 改了 `params/grid.json` 完全不生效 | **权重双份**：脚本顶部常量一份、配置文件一份，而脚本根本不读文件 | 改一个值 → 输出「本次生效参数」的来源应随之变化；传非法值应 `exit 1`，不是静默回退 |
| 全场零竞争，候选反而被扣 40 分 | `to100` 退化分支返回 `50` → `pressure=50` × `k=0.8` | 造「所有候选竞品数 = 0」的批次，`pressure_rel` 必须全为 `0` |
| 分数对不上也查不出原因 | CSV 只有成品分，没有逐项贡献、归一化基准、参数快照 | sidecar 必须能纸上复算还原 `rank_score`（`test-grid.mjs` F 段断言之） |
| `test-grid.mjs` 三条 python 断言恒失败 | 测试从 `tools/` 找 `grid-registry.py`，实际它在 `scripts/` | 干净检出跑一次，A/B 段应 PASS——不能靠本机历史环境蒙混 |

### 参数与路径

| 症状 | 根因 | 判据 |
|---|---|---|
| 底图全丢且不报错 | `arg()` 默认 null 用 `!== undefined` 判 → 默认路径变 `<cwd>/null` | 不传 `--tiles` 跑一次 render-static-map，看「N 张命中」是否 > 0 |
| 瓦片找不到 | `tiles/` 是 **probe 所在目录的兄弟**，不是 probe 的兄弟：`out/点位/probe.json` → `out/tiles/` | 同上 |
| 自动缩放换 zoom 后没图 | 圈层跨度一变 zoom 从 16 变 17，缓存没这层 | 看「瓦片 N 张命中」是否为 0 |
| CSV 整表解析为空不报错 | GBK / UTF-16 编码 | 财务参数是否全回落默认值 |
| 只换档案业务判读不变 | 业态码从调研表 `meta.format_code` 读，不是从 profiles 读 | 换表不换档案看结论是否变 |

### 沙箱与运行环境

| 症状 | 根因 | 判据 |
|---|---|---|
| 冒烟在受限沙箱 12/13，完整权限 13/13 | `execFileSync` 默认 `pipe` 捕获 stdout 会 EPERM | 改 `stdio:['ignore', fd, 'ignore']` 重定向到文件 |
| `python site_core.py` 无参数 | 旧版返回用法错误退出 2 | **v2.10.14 起已改**：无参数打印用法并退出 0（查帮助不是错误）；错子命令仍退出 2 |

### 打包发布

| 症状 | 根因 | 判据 |
|---|---|---|
| 平台解析失败：不是 `{skill-name}/` 结构 | zip 根目录平铺 | 顶层条目应只有 1 个文件夹 |
| 平台解析失败：examples 超限 | `examples_zh` / `examples_en` 各最多 3 条 | 数条目 |
| 平台判「未通过更新」 | 版本号未 +0.0.1 | 与上一版比 version |
| 资产不生效 | `plugin.json` 有 skills 目录但没登记 `skills` 字段 | 解压后按 `plugin.json` 的路径实际找一遍 |
| 版本四处不一致 | 升版脚本漏扫 `.codebuddy-plugin/` | 逐个 JSON 核对 version |
| 同一份文档三包哈希不一致 | 只改了源码包，没同步技能包 / 专家包副本 | 逐文件列哈希，唯一值必须 = 1 |

## 三、最近版本变更摘要

| 版本 | 一句话 |
|---|---|
| 2.10.34 | 网格候选评分三项缺陷修复 + 分数可回溯（双口径 / to100 退化 / 权重单一来源 / sidecar）；协议由 CC BY-NC 4.0 改为作者自定义非商业许可；三包 CHANGELOG 与回归台账收敛到唯一哈希 |
| 2.10.33 | 同步手改 README（适用人群前置、移除关键词块）+ 重打三包 |
| 2.10.32 | 协议 MIT → CC BY-NC 4.0；同步最新 README |
| 2.10.31 | 同步手改 README 徽章层与关键词行 |
| 2.10.17 | 偏好台账 + 回归基线进专家包 |
| 2.10.17 | 专家包 P0 一致性：注册 skills / 嵌套结构 / 统一九段骨架 / 清旧口径 |
| 2.10.11 | examples 各 3 条 + frontmatter 只留规范字段 |
| 2.10.10 | 按技能规范重构：`{skill-name}/` 包裹 + author + SKILL.md 拆分 84% |
| 2.10.9 | 补 package.json / tsconfig / 类型桩，typecheck 可跑 |
| 2.10.8 | 锚点与保本红线改基准档（压力档并列） |
| 2.10.7 | 回本 36 月边界误判（判定与展示同源） |
| 2.10.6 | H1 dedupe 必崩 / H2 额度护栏 / E3 双标尺 / E4 基准库标注 |
| 2.10.5 | CSV BOM + same_type 与 dedupe 计数对齐 |

完整变更见 `CHANGELOG.md`。

## 四、改完必须做的三件事

1. **跑基线**：`selftest` + `grid-scan --self-test` + `test-tools-smoke` + （源码包）`pnpm test && pnpm typecheck`
2. **核对断言数**：变了就要能解释
3. **写进本文件**：新踩的坑补进第二节对应表格，别靠记忆
