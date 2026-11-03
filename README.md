# 选址智能评估 Skill

> 给 AI Agent 用的连锁餐饮 / 实体门店选址评估能力包 · v2.5.1

Tool 硬算 + Skill 只翻译。所有确定性计算交给脚本，Skill 只负责定口径、组织流程、把结果翻译成人能读的报告。

---

## 报告示例

![选址报告 - 商圈步行圈与竞品分布](assets/report-sample-2.jpg)

![选址报告 - 地图竞品分析](assets/report-sample-1.jpg)

---

## 它能干什么

| 能力 | 说明 |
|---|---|
| **城市网格扫描** | 按网格批量扫一片区域，自动筛候选点位 |
| **需求侧采集** | POI 代理指标：周边小区、写字楼、学校、交通 |
| **竞品格局分析** | 步行圈内竞品数量、距离、品类分布、份额 Top8 |
| **截流两轴** | 内圈步行圈 + 外圈车行圈，双口径客流截流评估 |
| **财务双口径测算** | 保本营业额、毛利、回本周期、投产 ROI |
| **行业基准对标** | 同业态、同城市、同面积的行业均值对标 |
| **动线阻断分析** | 点位到地铁口 / 竞品 / 小区大门的步行距离 |
| **证据链报告** | 每个数字可追溯：公式 + 代入值 + 结果 |

## GIS 空间分析能力

| 能力 | 说明 |
|---|---|
| **多坐标系转换** | WGS84 / GCJ02（高德）/ BD09（百度）互转，解决不同数据源坐标系不一致问题 |
| **步行圈 / 车行圈** | 内圈步行 10 分钟 + 外圈车行 5 分钟，双口径截流评估 |
| **等时圈估算** | 基于路网的步行可达范围分析，未接本地路网时降级为直线估算（标注【估算】） |
| **POI 空间聚合** | 按距离 / 时间范围聚合周边 POI，自动统计品类分布、密度、最近距离 |
| **空间去重** | 同品类 POI 自动去重，白名单品类保留，避免竞品重复计数 |
| **动线阻断分析** | 点位到地铁口 / 竞品 / 小区大门的步行距离与路径阻断识别 |
| **城市网格扫描** | 按经纬度网格批量扫描区域，自动标记已覆盖 / 未覆盖网格 |
| **地理编码** | 地址 → 经纬度坐标，支持批量点位解析 |

## 数据源与对接能力

本项目分析框架与商用选址平台（百度慧眼、腾讯 LBS 数据魔方）对齐，**预留了数据源对接层**。

### 商用平台对接（企业版）

项目支持对接百度慧眼、腾讯 LBS 数据魔方的商业客流数据接口，用于输出客群画像、人口热力、到访洞察等高价值数据。

- 个人演示版本采用公开 POI、路网、开源人口栅格数据，通过 QGIS 做缓冲区、可达性、空间叠加，模拟商圈成熟度、竞对分布、人流动线评估，实现一套和商用平台对齐的选址分析框架。
- 企业采购慧眼 / 数据魔方数据源后，**可直接替换底层数据接入层**，无需改动上层分析逻辑与报告结构。

### 替代数据来源（个人演示版，合规免费）

| 数据源 | 用途 | 获取方式 |
|---|---|---|
| **高德开放平台 POI** | 周边业态、竞品、交通配套采集 | 个人开发者注册，Web 服务 Key |
| **OSM 开源路网** | 步行路径、可达性、路网分析 | Geofabrik 免费下载 |
| **世界人口栅格 / 国内人口普查栅格** | 需求侧代理、人口密度估算 | 中科院、WorldPop 公开 GIS 数据 |
| **七普人口、城市规划公开矢量** | 人口结构、片区规划参考 | 政府公开数据 |
| **美团 / 大众点评 POI（爬虫）** | 餐饮业态密度、竞对分布（学习演示用，商用需授权） | Python 采集脚本 |

> 注：百度慧眼 / 腾讯 LBS 数据魔方为面向企业的 B 端付费产品，不开放个人注册；本项目个人演示版采用上述公开数据源替代，分析方法论与指标体系与商用平台一致。

## 设计原则

- **不判断"能不能开"**，只列证据与缺口
- **每个数字可追溯**：公式 + 代入值 + 结果
- **缺省必须披露**：用了默认值就写进台账
- **不用可刷的数据验证模型**（点评评分 / 月售一律不采）
- 人口数据无公开渠道，用 POI 代理指标

## 安装

### 前置依赖

- **Python 3.9+**（脚本类功能需要；纯方法论模式可不用）
- **高德开放平台 Web 服务 Key**（POI / 地理编码 / 步行路径必需；无 Key 时脚本会报缺凭证，但 Skill 方法论本身可读）

### 方式 A：一键脚本（推荐，Windows）

```powershell
# 1. clone 或下载本仓库
git clone https://github.com/ShaoRoy/site-selection-skill.git
cd site-selection-skill

# 2. 运行安装脚本（默认装到 ~/.dsh/skills/site-selection）
pwsh -File install.ps1

# 装到自定义目录：
# pwsh -File install.ps1 -Target "D:\your\skills\site-selection"
```

脚本会自动做三件事：复制文件 → 检查 Python/openpyxl → 检查高德 Key。

### 方式 B：手动安装

```powershell
# 1. clone 仓库
git clone https://github.com/ShaoRoy/site-selection-skill.git "$env:USERPROFILE\.dsh\skills\site-selection"
cd "$env:USERPROFILE\.dsh\skills\site-selection"

# 2. 安装 Python 依赖（仅 import-benchmarks.py 需要 openpyxl）
pip install openpyxl
```

### 配置高德 Key

二选一：

```powershell
# 方式 1：环境变量（当前会话）
$env:AMAP_API_KEY = "你的高德 Web 服务 Key"

# 方式 1 持久化（用户级，重启终端生效）
[Environment]::SetEnvironmentVariable("AMAP_API_KEY", "你的高德 Web 服务 Key", "User")

# 方式 2：写入密钥文件（推荐，避免环境变量泄露到子进程）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\secrets" | Out-Null
"你的高德 Web 服务 Key" | Out-File -FilePath "$env:USERPROFILE\.dsh\secrets\amap.key" -Encoding ascii -NoNewline
```

> 注意：高德控制台要选 **「Web 服务」** 类型的 Key，不要用 Android / iOS / Web端(JS API) 类型，否则接口会报 `INVALID_USER_KEY`。

### 自检（必做）

```powershell
cd "$env:USERPROFILE\.dsh\skills\site-selection"
python scripts/site_core.py selftest
```

看到 `20 passed` / 全绿，说明计算内核 OK。如果报错，先看是不是 Python 版本低于 3.9。

### DSH 原生插件挂载（可选）

如果你用 DSH，除了 Python 脚本模式，还可以挂原生 TypeScript 工具：

1. 打开 `dsh/cordis.patch.yml`，按里面注释把插件条目加到 DSH 的配置里
2. 重启 DSH，让插件索引生效
3. 重启后在对话里说"用 site-selection 评估一下 XXX 铺位"验证是否触发

### 验证安装成功

自检通过后，在你的 Agent 里发一句：

```
用 site-selection 帮我评估一下：广州天河珠江新城某商场 1 楼 80㎡ 奶茶铺，月租 1.8 万，投资 25 万，客单价 18 元。
```

Agent 应该会：读 `SKILL.md` → 调 `scripts/site_core.py` 算财务口径 → 输出带公式追溯的报告。如果它直接"凭感觉"给结论，说明 Skill 没被加载，回上面检查目录位置。

### 常见坑

| 现象 | 原因 / 解决 |
|---|---|
| `INVALID_USER_KEY` | 高德 Key 类型选错，去控制台换「Web 服务」类型 |
| `python: command not found` | 没装 Python 或没加 PATH；脚本类功能不可用，但 SKILL.md 方法论仍可读 |
| Agent 不触发 Skill | 检查是否真的解压到了 `~/.dsh/skills/site-selection/`（目录名要叫 `site-selection`，不是 `site-selection-skill`） |
| `openpyxl` 导入失败 | `pip install openpyxl`；只有 `import-benchmarks.py` 需要 |
| 路径含中文 / 空格 | 部分脚本对路径敏感，建议装在纯英文路径 |
| 高德额度耗尽 | 个人开发者默认日额度 5000 次，网格扫描前先 `--dry-run` 看预计调用量 |

## 快速开始

```bash
# 扫一片区域，找候选点位
python scripts/grid-scan.py --city 广州 --district 天河 --execute

# 给某点位算需求侧指标
python scripts/demand-fetch.py "广州白鹅潭万象城" --radius 3000 --out demand.json

# 算动线阻断（点位到地铁口 / 竞品 / 小区大门的步行距离）
python scripts/walk-matrix.py --origin "23.1035,113.2361" --targets targets.csv --out barriers.csv

# 看网格覆盖进度
python scripts/grid-registry.py --city 广州 --summary

# 财务测算
python scripts/site_core.py finance --format large_yuecai --area 1200 --catchment L2 \
  --params params.json --space space.json --out finance.json

# 行业基准对标
python scripts/site_core.py benchmark --city 广州 --format 粤式茶楼早茶 --area 1200 \
  --investment-wan 320 --rent-wan 12 --ticket 230 --revenue-wan 99 --payback 15.5 --margin 0.208
```

## 目录结构

```
site-selection-skill/
├── SKILL.md              # 方法论、六条硬纪律、公式全书、报告结构
├── manifest.json         # Skill 清单与运行时声明
├── PROMPT.md             # Agent 提示词模板
├── install.ps1           # Windows 安装脚本
├── scripts/              # 5 个可移植 Python 脚本
│   ├── site_core.py      # 核心库（6 个工具全移植，纯 Python）
│   ├── grid-scan.py      # 网格扫描
│   ├── grid-registry.py  # 网格台账
│   ├── demand-fetch.py   # 需求侧采集
│   ├── walk-matrix.py    # 动线阻断
│   └── import-benchmarks.py
├── dsh/                  # DSH 原生插件版（TypeScript）
│   ├── site-tools.ts
│   ├── benchmark-data.ts
│   └── cordis.patch.yml
├── params/               # 可覆盖的经验系数
│   ├── _template.json
│   ├── grid.json
│   ├── large_yuecai.json
│   └── tea_house.json
├── data/                 # 行业基准数据
│   ├── benchmarks.json
│   └── cities.json
├── docs/                 # 文档
│   ├── FEATURES.md
│   ├── GRID.md
│   ├── COMPLIANCE-CHECKLIST.md
│   ├── DECISIONS.md
│   └── LAUNCH.md
└── assets/               # 报告示例截图
```

## 两种运行方式

| 运行时 | 用什么 | 怎么装 |
|---|---|---|
| **任意 Agent（WorkBuddy 等）** | `scripts/site_core.py`（6 个工具全移植，纯 Python） | 解压即用 |
| **DSH** | `dsh/site-tools.ts` 原生插件 | 按 `dsh/cordis.patch.yml` 挂载后重启 |

两者**计算口径完全一致**（fin-v4），只是调用方式不同。

## 局限

- 等时圈若未接本地路网引擎，降级为直线估算（标注【估算】）
- 动线阻断需现场实测
- 行业基准为行业平均，单店实际 ±30%
- 高德热力 / POI 数据为公开接口参考值，非精准探针客流

## 免责声明

本项目仅为 AI 辅助决策工具，所有计算结果基于公开数据与经验模型推演，**不保证盈利，不构成经营建议**。开店决策务必结合线下实地考察、人工复核与专业判断。

## 作者 / 联系方式

**作者：** RoyShao
**Email：** yingshao113113@gmail.com

如有问题、建议或合作交流，欢迎邮件联系。

## License

[MIT](LICENSE)
