# 选址智能评估 Skill

> 给 AI Agent 用的连锁餐饮 / 实体门店选址评估能力包 · v2.5.1

Tool 硬算 + Skill 只翻译。所有确定性计算交给脚本，Skill 只负责定口径、组织流程、把结果翻译成人能读的报告。

---

## 报告示例

![选址报告 - 地图竞品分析](assets/report-sample-1.jpg)

![选址报告 - 商圈步行圈与竞品分布](assets/report-sample-2.jpg)

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

## 设计原则

- **不判断"能不能开"**，只列证据与缺口
- **每个数字可追溯**：公式 + 代入值 + 结果
- **缺省必须披露**：用了默认值就写进台账
- **不用可刷的数据验证模型**（点评评分 / 月售一律不采）
- 人口数据无公开渠道，用 POI 代理指标

## 安装

```powershell
# 1. 解压到 Agent 的 skills 目录
# 2. 配置高德 Key：
#    环境变量 AMAP_API_KEY，或写入 ~/.dsh/secrets/amap.key
# 3. Python 依赖
pip install openpyxl
# 4. 自检（20 条断言）
python scripts/site_core.py selftest
```

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

## License

[MIT](LICENSE)
