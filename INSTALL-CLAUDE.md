# 在 Claude 上安装与使用

本技能包原为 WorkBuddy「导入技能」格式，同时符合 Claude 的 Agent Skills 目录规范，可直接安装到 Claude Code 使用。以下为实测通过的步骤与两处必须调整的地方。

适用：Claude Code（本地 CLI / VS Code 扩展）。上传 claude.ai 网页版另有字段限制，见第 5 节。

---

## 1. 安装位置

把整个 `site-report/` 目录整体复制过去，不要只拷 `SKILL.md`。

| 用途 | 目标路径 |
| --- | --- |
| 个人技能（本机所有项目可用） | `~/.claude/skills/site-report/` |
| 项目技能（仅当前仓库） | `<项目根>/.claude/skills/site-report/` |

Windows 下 `~` 即 `C:\Users\<用户名>`。装完后应能读到 `~/.claude/skills/site-report/SKILL.md`。

验证是否被识别：启动 `claude --debug`，日志里搜 `site-report`；或在会话中直接输入 `/site-report` 看是否出现在菜单。

---

## 2. 必做调整：命令路径基准（否则全部报错）

`SKILL.md` 正文中的命令写作 `python scripts/site_core.py ...`，这是相对**技能目录**的写法。Claude 的当前工作目录是你打开的项目目录，**不是**技能目录，照抄会得到：

```
can't open file '<项目目录>\scripts\site_core.py': [Errno 2] No such file or directory
```

执行任何 `scripts/` 下的命令前，先定位到技能目录。两种等价写法：

```bash
# 写法 A：先切换目录
cd ~/.claude/skills/site-report
python scripts/site_core.py selftest

# 写法 B：用 Claude 提供的技能目录变量（不受 cwd 影响，推荐）
python "${CLAUDE_SKILL_DIR}/scripts/site_core.py" selftest
```

`${CLAUDE_SKILL_DIR}` 由 Claude Code 在读取 SKILL.md 时替换为该技能的实际路径。若你的版本不展开此变量，用写法 A。

**脚本本身不受 cwd 影响**：所有脚本都用 `os.path.abspath(__file__)` 定位 `data/`、`params/`，从任意目录调用都能正确读到包内数据，只是入口路径要写对。

---

## 3. 依赖

零第三方依赖，无需 `pip install`。全部脚本只用 Python 标准库（`json` / `csv` / `math` / `re` / `urllib` 等）。

- Python 3.8+。Windows 上 `python` 与 `python3` 皆可，以本机 `python --version` 能跑为准。
- `scripts/worldpop-clip.py` 与 `scripts/export-geojson.py` 需要 GDAL，属**可选**能力：未安装时只影响世界人口栅格裁剪与 GeoJSON 导出，不影响主链路，脚本会给出降级提示而非崩溃。

---

## 4. 凭据（只有采集类才需要）

离线能力（财务、否决、去重、地理、对标、租金识别）不需要任何凭据。

需要联网采集时，通过环境变量提供：

```bash
export AMAP_API_KEY="你的高德 Key"          # Linux / macOS / Git Bash
set AMAP_API_KEY=你的高德Key                # Windows cmd
$env:AMAP_API_KEY = "你的高德Key"           # PowerShell
```

| 变量 | 用途 | 缺失后果 |
| --- | --- | --- |
| `AMAP_API_KEY` | POI / 竞品 / 交通采集 | 采集类脚本不可用，离线能力照常 |
| `TENCENT_MAP_KEY` | 周边 POI 交叉校验 | 降级为单源高德，报告需注明 |

脚本按「环境变量优先 → 文件回退」读取，Claude 环境变量优先级最高，无需创建任何密钥文件。

---

## 5. 上传 claude.ai 网页版的额外限制

本地 Claude Code **忽略**未知 frontmatter 字段，可原样使用。

但上传 claude.ai、走 Skills API 或用官方 `package_skill.py` 打包时，frontmatter 只允许 6 个字段，本包现有 8 个扩展字段（`display_name` / `display_name_en` / `description_zh` / `description_en` / `version` / `author` / `examples_zh` / `examples_en`）会导致**硬报错**：

```
Unexpected key(s) in SKILL.md frontmatter: ...
```

上传前把 frontmatter 换成下面这段（正文不动）：

```yaml
---
name: site-report
description: "实体门店选址评估：高德竞品扫描 + 腾讯交叉校验双源 GIS，驱动商圈初筛、现场复核、财务锁盘；含截流两轴定级、极限租金反推、租期现金流、空间容量对账、假设台账与敏感度。"
license: MIT
allowed-tools: Bash(python ${CLAUDE_SKILL_DIR}/scripts/*)
---
```

`allowed-tools` 会让该技能的脚本执行免于逐次权限询问；不需要可删掉这一行。

---

## 6. 安装后自检（复制即用）

```bash
cd ~/.claude/skills/site-report
python scripts/site_core.py selftest          # 期望 48/48 通过
python scripts/grid-scan.py --self-test       # 期望 17/17 通过
python scripts/grid-registry.py --self-test   # 期望 12/12 通过
python scripts/site_core.py benchmark --city 广州 --format "中式正餐(川湘粤家常)" --area 1200 --rent-wan 18 --ticket 90
```

最后一条应返回 `"matched": true`，`sample_size: 20`，并给出回本周期分位。若返回 `matched: false`，`--format` 要传基准库里的业态名（脚本会列出全部可用值），或用 `data/formats.json` 里的别名（如 `large_yuecai`、`tea_house`）。

---

## 7. 可以不管的文件

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | WorkBuddy / DSH 的依赖声明，Claude 不读，保留不影响运行 |
| `params/` | 参数档（财务假设模板），`site_core.py finance` 会用到 |
| `local/` | 本地商圈档案模板与示例，可自行增补 |
| `data/` | 基准库（20 城 × 51 业态 / 1,020 条）与城市、业态索引，必须保留 |
| `references/` | 分册说明，正文按需引用，删除会导致部分章节断链 |

---

## 8. 与 WorkBuddy 的差异

| 项 | WorkBuddy | Claude Code |
| --- | --- | --- |
| 安装方式 | 导入 `01-skill-导入技能.zip` | 复制 `site-report/` 到 skills 目录 |
| 命令路径 | 相对技能目录即可 | 必须 `cd` 或用 `${CLAUDE_SKILL_DIR}` |
| frontmatter 扩展字段 | 正常读取 | 本地忽略；上传 claude.ai 会报错 |
| 凭据 | 宿主凭据机制 + 环境变量 | 仅环境变量 |
| HTML 报告 | 01 包不含 Node 渲染链，出 Markdown | 同样出 Markdown；需要 HTML 请用 03 源码包 |
