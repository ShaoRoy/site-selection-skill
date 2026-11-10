# 选址智能分析 Skill

<p><a href="https://github.com/ShaoRoy/site-selection-skill/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/ShaoRoy/site-selection-skill?style=flat-square&color=2ea44f&label=%E6%9C%80%E6%96%B0%E7%89%88"></a>&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/ShaoRoy/site-selection-skill/total?style=flat-square&label=%E4%B8%8B%E8%BD%BD"></a>&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ShaoRoy/site-selection-skill/actions/workflows/ci.yml/badge.svg"></a>&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/blob/main/tools/test-parity.mjs"><img alt="tests · parity" src="https://img.shields.io/badge/tests-136%20parity-brightgreen?style=flat-square"></a>&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Custom%20NonCommercial-ef9421?style=flat-square"></a>&nbsp;<img alt="Agent Skill · WorkBuddy" src="https://img.shields.io/badge/Agent%20Skill-WorkBuddy-2ea44f?style=flat-square">&nbsp;<img alt="AI Agent · LLM ready" src="https://img.shields.io/badge/AI%20Agent-LLM%20ready-8957e5?style=flat-square">&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/blob/main/README.md#%E5%AE%89%E8%A3%85"><img alt="Python 3.9+" src="https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square"></a>&nbsp;<img alt="GIS · 高德 / 腾讯" src="https://img.shields.io/badge/GIS-%E9%AB%98%E5%BE%B7%20%C2%B7%20%E8%85%BE%E8%AE%AF-2ea44f?style=flat-square">&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/blob/main/data/benchmarks.json"><img alt="基准库 19城×48业态·估算" src="https://img.shields.io/badge/%E5%9F%BA%E5%87%86%E5%BA%93-19%E5%9F%8E%C3%9748%E4%B8%9A%E6%80%81%C2%B7%E4%BC%B0%E7%AE%97-brightgreen?style=flat-square"></a>&nbsp;<img alt="Finance 三档测算" src="https://img.shields.io/badge/Finance-%E4%B8%89%E6%A1%A3%E6%B5%8B%E7%AE%97-ffd33d?style=flat-square">&nbsp;<img alt="Rent 极限租金反推" src="https://img.shields.io/badge/Rent-%E6%9E%81%E9%99%90%E7%A7%9F%E9%87%91%E5%8F%8D%E6%8E%A8-fe7d37?style=flat-square">&nbsp;<img alt="Offline 零 Key 可跑" src="https://img.shields.io/badge/Offline-%E9%9B%B6%20Key%20%E5%8F%AF%E8%B7%91-4c1?style=flat-square">&nbsp;<a href="https://github.com/ShaoRoy/site-selection-skill/blob/main/references/03-data-and-governance.md"><img alt="Evidence 可复核" src="https://img.shields.io/badge/Evidence-%E5%8F%AF%E5%A4%8D%E6%A0%B8-blueviolet?style=flat-square"></a></p>

## 🧑‍💻 适用人群

- **开店创业者**：第一次选址，想知道这个铺位到底值多少钱
- **连锁拓展**：批量评估候选点位，需要统一口径——跨批次/跨城市比绝对密度分 `d_abs`，同批排名看 `rank_score`（后者只在本批有效）
- **商业地产 / 招商**：给商户做点位可行性说明
- **GIS / 数据分析师**：需要一套可复核、可接入自己数据源的选址计算框架
- **AI Agent 开发者**：想给自己的 Agent 挂一个选址能力

---

## 你用的是哪个软件？

| 宿主 | 下载 | 安装方式 | 交付报告 |
|---|---|---|---|
| **WorkBuddy** | [`site-selection-workbuddy-v2.10.42.zip`](https://github.com/ShaoRoy/site-selection-skill/releases/latest) | 「导入技能」直接导入 | 文字分析报告（Markdown） |
| **DeepSeek Harness** | [`site-selection-dsh-v2.10.42.zip`](https://github.com/ShaoRoy/site-selection-skill/releases/latest) | `install.ps1` / `git clone` | HTML 报告（需 Node ≥ 18） |

> **给 Agent 的判据**：WorkBuddy（能「导入技能」或存在 `~/.workbuddy/`）→ 第一行；DeepSeek Harness（存在 `~/.dsh/` 或能调用 `dsh`）→ 第二行。两边共用同一套 Python 计算引擎，**数字与口径一致**，仅报告载体不同；DSH 出 HTML 需 `probe.json` 或调研表 CSV，现场采集还需高德 Key。
> ⚠️ 别用 GitHub 网页的「Code → Download ZIP」：会多套一层 `site-selection-skill-main/`，导入时报「未找到 SKILL.md」。

---

## 业务侧：3 分钟用起来

> **报告给的是参考判断（估算 · 仅供参考），不是决定**：数字、依据与边界都列出来了，怎么做由你定。

> 不用看代码。想知道「怎么提需求 / 哪些数字能改」，就看这一节和
> [`references/08-business-guide.md`](references/08-business-guide.md)。

### 1. 怎么提需求：说三句话

| 说什么 | 例子 | 说多细 |
|---|---|---|
| **在哪** | 广州天河华夏路 12 号 | 商场店说清楼层与铺号 |
| **做什么** | 大型粤菜，600 ㎡ | 业态 + 面积，有层高更好 |
| **钱怎么算** | 月租 15 万，毛利率 62%，投入 350 万 | 从租金开始往上加；营业额不用估（见下） |

**说到哪一步，决定你拿到什么**：只说地址 → 商圈初选；加上月租金（能换算成元/月且 ≥1000）→ 双源单点评估；
再加毛利率 / 初始投资 → 完整财务锁盘。少给几项也行，报告会把缺的标成「待确认」。

**营业额不用你估**：店还没开，本来就没有。报告反过来算三个数——**每月/每日最低业绩**（月租+人力+其他固定）÷（毛利率−税率），再 ÷30 得日、
**产能上限**（座位×正常翻台×客单价）、**目标回本所需营业额**（投入÷目标月数÷（毛利率−税率）÷30）。
不给营业额时，报告按「建筑面积 × 该业态每㎡月营收基准 ÷ 30」估一个**日营业额**（月营业额 = 日 × 30，基准取自行业平均数），
并在《待确认的假设》里标明「按业态坪效基准估算」——不冒充实测；你手里有同城同品牌同面积店的收银数据时替换掉它即可。

**不用给的东西**：日营业额（除实测值）、点评评分与门店月售（可刷，一律不采）、「能不能开」的结论（不裁决）、行业平均值（内置基准库有）。


### 2. 哪些指标可以调整

| 类别 | 有哪几个 | 改了影响 |
|---|---|---|
| **A · 你自己给的数** | 毛利率、月租金、月人力、月其他固定、初始投资、租期、年递增、目标回本周期 | 直接决定回本与极限租金——这 8 项里有 7 项是你能拿单据核实的 |
| **B · 业态基准值** | 回本 24 个月、租售比 12%/18%、厨房 30%、每座 2.4 ㎡、翻台 2.5/3.5、每㎡营收 900 元等 | **基准取自行业平均数**（`data/benchmarks.json`，912 行 / 19 城 / 48 业态，行业基数 × 城市系数缩放），不是你拍的也不是某家店的最好成绩；不对就换档案或改键，并在 `param_source` 写明依据 |
| **C · 找点位的旋钮** | 半径 1000 米（大店 1500/小店 800）、候选 30 个、竞争惩罚 0.8/0.4、需求四项权重（和为 1）、竞品关键词 | 只影响筛哪些点，不影响财务结论 |

**规矩**：参数是校准现实的，不是校准结论的——算出来难看就原样呈现；改过的数必须在报告「待确认假设」里能看到来源。

## 本地数据位（自己长期维护的官方数据）

项目在 `local/` 留了一个**专门放数据的地方**：你常驻的城市（例如广州）可以持续按官方公布数据更新，
其他城市由你自行调取维护。项目**不写爬虫、不主动抓取**。

- 复制 `local/_template.json` 为 `<城市>.json`，逐条填 `value / unit / source / published_at / collected_at`。
- 只收**官方公开统计与公开市场数据**，不收自家门店经营数据；数据有延后或不准确，报告会显示发布年份，不假装实时。
- 取值优先级：**A 本地实测/官方 > B 内置行业基准 > C 模型估算 > D 占位**；报告显示本次实际命中的等级。
- 按城市隔离，**不要改 `data/cities.json` 的广州基数**（其他 19 城由它缩放推算）。
- 校验：`node tools/local-data.mjs --check`（CI 也跑）。字段与示例见 `local/README.md`。

## 报告示例
<p align="center">
<img width="840" alt="选址智能分析报告示例" src="https://github.com/user-attachments/assets/64caf3b5-9d64-4bc3-acba-c47f6e9c060f" />
</p>

### 示例对话（仅格式演示）

> ⚠️ 下面是**包内脚本实算**的真实输出，参数见末尾复现命令。换成你所在的城市与业态，数字会不同。

**你**：帮我评估一下这个铺位：广州天河某商场 1 楼 80㎡，月租 1.8 万，投资 25 万，客单价 18 元，做新式茶饮

**Agent**：

```text
筛次判定：第 2 筛（检出月租金 18000 元）→ 腾讯+高德双源校验
月营业额 105,000 元 ｜ 保本日营业额 2,094 元
回本：现金口径 9.8 个月 ｜ 会计口径 12 个月
极限租金：保本上限 43,525 元/月 ｜ 目标回本上限 33,108 元/月
当前租金 18,000 元/月，距目标上限还有 15,108 元/月余量
租售比 17.1% → 偏高（茶饮健康线 15%，警戒线 20%）
每个数字都能用 site_core.py 复算
```

复现：

```bash
python scripts/site_core.py finance \
  --params '{"daily_revenue":3500,"gross_margin":0.65,"monthly_rent":18000,"monthly_labor":15000,"monthly_other_fixed":5000,"initial_investment":250000}' \
  --area 80 --space '{"avg_ticket":18}' --format tea_drink --target 24
```

## 📌 适用业态 & 范围

### 内置基准覆盖（19 城 × 48 业态）

全部为**餐饮**业态：正餐酒楼、茶楼早茶、火锅、烧烤、日料、西餐、茶饮咖啡、烘焙甜品、快餐档口、面食粉面、卤味熟食、夜宵小龙虾等 48 个细分档。

```bash
python scripts/site_core.py formats   # 查系统当前认的全部业态与基准映射
```

### 可测算但无内置基准（需自填参数）

| 大类 | 典型业态 |
|---|---|
| 零售 | 便利店、生鲜超市、专卖店、社区团购自提点 |
| 生活服务 | 美容美发、洗衣、维修、宠物服务、健身 |
| 教培 | 素质教育、职业技能、托育 |
| 仓配 | 前置仓、网格仓、末端驿站 |

这些业态**能算财务与商圈**（`finance` / `geo` 用你自己填的参数），但 `benchmark` 没有对标数据，调用会明确返回 `matched: false` 并提示如何补 `data/formats.json`——**不会静默套用餐饮基准冒充**。

### 适用范围

- **全国通用**：不绑定任何单一城市。基准库收录 19 城；未收录城市会**明确告知**并列出可用城市，不静默套用其他城市数据（见下方[在其他城市 / 地区使用](#在其他城市--地区使用)）。
- **全流程覆盖**：商圈初选（第 1 筛）→ 单点评估（第 1.5 筛）→ 双源校验（第 2 筛）→ 财务锁盘（第 3 筛）。
- **判断留给你**：系统只列证据与缺口，不替你决定「能不能开」。

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
| **多坐标系转换** | WGS84 ↔ GCJ02（高德系火星坐标）互转，`export-geojson.py --crs` 一条参数切换，解决底图偏移 |
| **步行圈 / 车行圈** | 内圈步行 10 分钟 + 外圈车行 5 分钟，双口径截流评估 |
| **等时圈估算** | 基于路网的步行可达范围分析，未接本地路网时降级为直线估算（标注【估算】） |
| **POI 空间聚合** | 按距离 / 时间范围聚合周边 POI，自动统计品类分布、密度、最近距离 |
| **空间去重** | 同品类 POI 自动去重，白名单品类保留，避免竞品重复计数 |
| **动线阻断分析** | 点位到地铁口 / 竞品 / 小区大门的步行距离与路径阻断识别 |
| **城市网格扫描** | 按经纬度网格批量扫描区域，自动标记已覆盖 / 未覆盖网格 |
| **地理编码** | 地址 → 经纬度坐标，支持批量点位解析 |

## 数据源与对接能力

本项目的数据维度参照商用选址平台设计，用公开数据源实现同一套分析框架。

### 数据维度对标（个人版实现方式）

商用选址平台的核心维度是：客群画像、到访洞察、商圈成熟度。本项目用公开数据源实现**同一套分析框架**。

| 维度 | 商用平台 | 本项目 |
|---|---|---|
| 商圈成熟度 | 实时客流 | POI 业态密度 + 品牌密度（咖啡 / 银行 / 高端餐饮）代理 |
| 竞对分布 | 商圈竞品库 | 高德 POI + 三重去重 + 三级分层 |
| 人流动线 | 停留时长 | 等时圈 + 现场动线阻断实测 |
| 客群画像 | 人口属性画像 | 职住比 + 住宅/写字楼结构（代理） |

### 当前已接入的数据源

| 数据源 | 用途 | 状态 |
|---|---|---|
| **高德开放平台 POI** | 周边业态、竞品、交通配套采集（**全量主力**） | ✅ 已接入（个人 Key，须选「Web 服务」类型） |
| **高德步行路径规划** | 动线阻断初判（点位 → 地铁口 / 竞品 / 小区大门） | ✅ 已接入，供第 1/1.5 筛使用 |
| **腾讯位置服务 POI** | 竞品交叉校验（第 2 筛，抽样） | ✅ 已接入；四个 POI 接口各 200/日 |
| **腾讯步行路径规划** | 动线阻断精算，`steps[].type` 给结构化过街设施 | ✅ 已接入，供第 2 筛使用 |
| **行业基准库（19 城 × 48 业态）** | 财务结论的现实性对标 | ✅ 已内置 `data/benchmarks.json` |

> **联网调用只有上面两家（高德 + 腾讯），都用个人免费额度**——不需要企业认证、不需要付费、Key 互不通用。
> 包内还有两个**不联网、不占额度、默认关闭**的可选环节，不用开通任何账号：
> **WorldPop 人口栅格**（需自备 GeoTIFF + GDAL，`data/worldpop/` 为空时自动跳过并在报告里留痕）、
> **OSM 路网等时圈**（需自建 Valhalla/OSRM，未部署时降级为直线估算并标【估算】）。
> 报告里嵌的静态底图取自 OSM 瓦片，无账号无额度，按点位缓存；取不到就不放底图并明写原因。

### 数据源分工：按筛次，不按偏好

**为什么不是「哪家好用就用哪家」**：腾讯四个 POI 接口（`place/search`、`place/detail`、
`place/here`、`place/explore`）**各 200 次/日，合计 800/日**——只够少数点位做深度校验。
高德那边没有这个限制，所以全量采集必须走高德。

| 筛次 | POI 采集 | 步行距离 |
|---|---|---|
| 第 1 筛 商圈初选 | **高德** | 不算（网格级不算步行） |
| 第 1.5 筛 单点评估 | **高德**（单源） | **高德**——初判参考值 |
| **第 2 筛（带租金）** | **腾讯 + 高德双源** | **腾讯**——带 `steps.type`，决策值 |
| 第 3 筛 财务锁盘 | 不采集 | 不采集 |

**为什么步行用腾讯**：高德只给 `instruction` 中文描述，要数过街设施得匹配文字；
腾讯 `steps[].type` 是数值枚举（`0` 普通道路 / `1` 过街天桥 / `2` 地下通道 / `3` 人行横道），
直接数，且在报告里能写成「人行横道×1、过街天桥×1」这种明细。

**同一项目不要中途换源**——换源等于换口径，历史报告不可比。

报告《数据质量》段会写明本次是单源还是双源；单源时不会声称「双源交叉验证」。

### 开通与 Key 配置（3 分钟）

两家数据源各有一个控制台，**Key 互不通用**。下表是官方入口，以及本项目**实际读取凭证的位置**（代码事实，非建议）：

| 数据源 | 官方入口 | 凭证怎么给 | 常见坑 |
|---|---|---|---|
| **高德** POI / 地理编码 / 步行路径 | 开放平台 [lbs.amap.com](https://lbs.amap.com/)　·　Key 管理 [console.amap.com/dev/key/app](https://console.amap.com/dev/key/app) | 环境变量 `AMAP_API_KEY`，或文件 `~/.dsh/secrets/amap.key`（单行纯文本） | 创建 Key 时**服务平台必须选「Web 服务」**；选成「Web端(JS API)」调用会直接鉴权失败 |
| **腾讯位置服务** POI / 步行路线 / 距离矩阵 | 官网 [lbs.qq.com](https://lbs.qq.com/)　·　Key 管理 [lbs.qq.com/dev/console/key/manage](https://lbs.qq.com/dev/console/key/manage) | 环境变量 `TENCENT_MAP_KEY`，或文件 `~/.dsh/secrets/tencent.key` | 建 Key 后要勾选 **WebServiceAPI**；四个 POI 接口各 200/日，别拿腾讯做全量采集 |
| **行业基准库** | 无外部调用 | 内置 `data/benchmarks.json` | 19 城 × 48 业态均为**估算值不是实测**，报告会标注 |

> 只做财务测算、不采集数据时，**一个 Key 都不需要**——`site_core.py` 的全部计算都能用手输参数跑通。

### 配额实测（2026-11-05 控制台核对 + 接口实测）

| 接口 | 日额度 | 并发 | 实测有效规模 |
|---|---|---|---|
| 腾讯距离矩阵 `matrix?mode=walking` | 6000/日 | 5 对/秒 | **1×5 对/请求**（1×6 就 120） |
| 腾讯步行路线 `direction/v1/walking` | 6000/日 | 5 次/秒 | 1 对/请求 |
| 腾讯 `place/search` | **200/日** | 5 次/秒 | 1 关键词/请求（每点位约 3 次） |
| 腾讯 `place/detail` / `here` / `explore` | **各 200/日** | 5 次/秒 | 同上 |

三条必须知道：

1. **限额单位是 OD 对数，不是请求次数**——1×6 只是一次请求，照样超限。
   官方文档写的「一对多 1×200」是**企业认证后**额度，个人 Key 实测只有 5 对/批。
2. **三处 duration 单位各不相同**：腾讯 direction = 分钟、腾讯 matrix = **秒**、高德 direction = **秒**。
   混用就是 60 倍误差；脚本内置 `plausible_walk()`（步行速度 2~7 km/h 自检）会当场报警。
3. **一次第 2 筛只比单源多花 3 次腾讯请求**（500m 半径、44 家实测），占日额度 1.5%。
   日额度可支撑约 66 个双源点位。

### 数据调用说明（节流 / 重试 / 缓存 / 失败行为）

下面是脚本的**真实行为**，不是建议值：

| 环节 | 实现 | 后果 |
|---|---|---|
| **节流** | 高德 0.6 s/次、腾讯 1.2 s/次（`walk-matrix.py`）；`demand-fetch.py` 0.6 s/次；`grid-scan.py` 按内置 `QUOTA` | 个人 Key 的 QPS 普遍 ≤3，节流写死在代码里，不靠用户自觉 |
| **限流重试** | 腾讯 `status=120` → 退避 2/4/6/8 s 且**批次减半**重试；高德 `10021` 同样退避 | 不静默丢点；降到 1 对仍失败则整步失败退出 |
| **缓存** | 网格扫描结果落 `out/grid/*.json`，分 `anchors` / `pool` / `competitors` 三段 | 任一段缺失即判「缓存不可读」→ 重新采集，**不会拿半份数据算出完整结论** |
| **缺 Key** | 直接 `exit 1`，并打印修复命令（`未找到高德 Key：设 AMAP_API_KEY 或写入 …`） | 不静默降级、不套用其他城市基准 |
| **坐标系** | 内部统一 WGS84；`export-geojson.py --crs gcj02` 可保持高德坐标对齐底图 | 只做 WGS84 ↔ GCJ02 互转，不涉及其他坐标系 |
| **数据落地** | `probe.json`（采集结果）+ `out/`（网格、地图、报告） | 报告附录逐条列字段来源，可回查是哪一次调用 |

调用一次第 2 筛的真实开销：POI 双源约 3 次腾讯请求 + 若干次高德请求，步行比较约 5 对。
按上面的日额度，单日可支撑约 66 个双源点位；超过就先分批，不要硬撞限额。

**免费额度够不够个人用？够，而且是明确够。** 高德 + 腾讯两家全部只用免费个人额度，不需要企业认证、不需要付费：

| 源 | 免费额度 | 一次评估实际消耗 | 能吃多少 |
|---|---|---|---|
| 腾讯位置服务 | 四个 POI 接口各 **200/日**；步行路线、距离矩阵各 **6000/日** | 第 2 筛约 3 次 POI + 5 对步行 | **约 66 个双源点位/日** |
| 高德开放平台 | 个人 Key 的免费日配额远高于上面的调用量级 | 一次商圈扫描通常几十到几百次请求 | 单店 / 小连锁日常评估**用不完** |

> 也就是说：**做一套完整的门店评估，不需要付任何地图 API 费用**。
> 只有在「一天要跑几十个点位以上」或需要平台级客流数据时，才需要谈付费或企业资质。
> 真撞到 QPS 也别慌——脚本内置节流（高德 0.6 s / 腾讯 1.2 s）和退避重试（2/4/6/8 s），会自己顶住。

### 拿不到的能力（需商业授权）

| 接口 | 影响 |
|---|---|
| `/ws/indoor/direction/walking` 室内外一体化步行 | **商场/综合体铺位的室内动线无法计算，必须现场实测** |
| `/ws/place/v1/search_by_polygon` 多边形搜索 | 商圈边界只能圆形近似，不能贴合不规则地块 |
| `/ws/snaptoroads/v1` 路网吸附 | 「点位是否临可通行道路」只能人工判断 |

> **关于「替换数据源」**：各采集脚本（`demand-fetch.py` / `grid-scan.py` / `walk-matrix.py`）
的调用目前是**直接写在各脚本内部**的，没有统一适配层。将来接入商业数据源时，
需要先抽出 `datasource/` 适配层再替换实现——**不是改一行配置就能完成**。

## 设计原则

- **不判断"能不能开"**，只列证据与缺口
- **每个数字可追溯**：公式 + 代入值 + 结果
- **缺省必须披露**：用了默认值就写进台账
- **不用可刷的数据验证模型**（点评评分 / 月售一律不采）
- **人口数据无公开免费接口**，当前用 POI 代理指标（职住比、住宅/写字楼密度）；WorldPop 栅格只作可选离线核对，**包内不含栅格数据**
- **报告必须写明数据源模式**：本次是单源还是双源；单源时不声称「双源交叉验证」
- **不用眼看判租金**：从对话识别金额交给 `site_core.py rent`，含面积/营业额防误触

## 质量保障（数字为什么不飘）

这个项目的结论是数字，测试就是它的护栏。全部断言在每次 push 时自动执行，不靠人工触发：

| 层 | 内容 | 条数 |
|---|---|---|
| 核心计算 | `site_core.py selftest`：营收 / 毛利 / 现金净流 / 会计净利 / 双口径回本 / 极限租金 / 座位模型 | 48 |
| 网格评分 | `grid-scan.py --self-test` 纯函数断言，加「夹具 → 打分 → 链路」端到端（**0 次接口调用**） | 17 + 30 |
| 调研表解析 | `test-survey-csv.mjs`：千分位、引号、空尾列、年份开头等边界——锁死一次真实的「12750 → NaN → 默认值」误判 | 12 |
| 坐标换算 | `test-worldpop.py`：WGS84 ↔ 栅格行列换算（缺 GDAL 的 2 项**显式跳过**，不假通过） | 18 + 2 |
| 渲染链 | `test-tools-smoke.mjs`：报告生成、HTML 自包含、无未渲染占位、缺数据时明确报错 | 13 |
| 跨引擎契约 | `test-parity.mjs`：TS 引擎 ↔ Python 引擎逐字段比对，口径不许分叉 | 136 |

- **合计 274 条断言通过**（另有 2 条因缺 GDAL 显式跳过，不算通过）。
- **CI 18 步**（`.github/workflows/ci.yml`）+ 独立契约 job，每次 push 必跑；**不设 `continue-on-error`、不设 `|| true`**，任一步非零即整次失败。
- **发布门禁**：`verify-release.mjs` 8 类核对——两包 ↔ `_src` ↔ `release` ↔ 线上附件 digest 逐字节比对、看板哈希自洽、homepage 回读；`check-lockstep.py` 强制 01 ↔ 03 同源、两份 README 全文逐字节一致、工作副本不得落后于已发布源码。
- **可复算**：报告每个数字都给公式 + 代入值 + 结果，附录列出字段来源；用了默认值必须写进假设台账。

> 想自己验一遍：`npm test` 跑快速段（文本 + 渲染冒烟 + 136 项契约，约 3 秒）；
> `node tools/test-full.mjs` 按 CI 的步骤全量跑一遍（命令直接从 `ci.yml` 解析，不另存一份）。

## 依赖与环境

### 必需

| 依赖 | 版本 | 用途 | 缺失后果 |
|---|---|---|---|
| **Python** | ≥ 3.9 | 全部计算脚本 | 脚本类功能不可用（SKILL.md 方法论仍可读） |
| **高德开放平台 Key** | 免费注册（[lbs.amap.com](https://lbs.amap.com/)） | POI 检索 / 地理编码 / 步行路径 | 采集类脚本报缺凭证 |

### 可选（按需安装）

| 依赖 | 用途 | 缺失后果 |
|---|---|---|
| **openpyxl** | import-benchmarks.py 读取 Excel 底稿 | 仅更换行业基准数据时需要，日常运行不受影响 |
| **Node.js ≥ 18 + pnpm** | DSH 原生插件、运行测试套件 | 只能用 Python 脚本模式，无原生工具 |
| **Docker + Valhalla / OSRM** | 真实路网等时圈（本地部署） | 降级为直线估算，报告标注【估算】 |
| **QGIS ≥ 3.28** | 读取人口栅格 GeoTIFF、出正式地图 | 纯计算不受影响，仅影响栅格处理与制图 |
| **磁盘 3 GB** | Valhalla 广东瓦片约 2 GB（可选） | 只用 Python 模式约需 5 MB |

### 每个脚本的真实依赖

| 脚本 | 第三方包 |
|---|---|
| site_core.py（6 个核心工具） | **无**，纯标准库 |
| grid-scan.py / grid-registry.py | **无** |
| demand-fetch.py / walk-matrix.py | **无** |
| import-benchmarks.py | openpyxl |

> 也就是说：**装个 Python 3.9 就能跑核心计算**，其余都是可选的。

### 支持的平台

| 平台 | 说明 |
|---|---|
| Windows 10 / 11 | 推荐，install.ps1 一键安装（PowerShell 5.1 或 7 均可） |
| macOS / Linux | Python 脚本同样可用，手动复制目录到 ~/.dsh/skills/restaurant-location-analysis |

## 安装

### 前置依赖

- **Python 3.9+**（脚本类功能需要；纯方法论模式可不用）
- **高德开放平台 Web 服务 Key**（POI / 地理编码 / 步行路径必需；无 Key 时脚本会报缺凭证，但 Skill 方法论本身可读）

### 方式 A：一键脚本（推荐，Windows）

> `install.ps1` 在**源码包**（`site-selection-dsh-v2.10.42.zip`）里；
> 本技能包不含它，如果你只拿了技能包，用下面的「方式 B：手动安装」。

```powershell
# 1. clone 或下载本仓库
git clone https://github.com/ShaoRoy/site-selection-skill.git
cd site-selection-skill

# 2. 运行安装脚本（默认装到 ~/.dsh/skills/restaurant-location-analysis）
powershell -File install.ps1

# 装到自定义目录：
# powershell -File install.ps1 -Target "D:\your\skills\restaurant-location-analysis"
```

脚本会自动做三件事：复制文件 → 检查 Python/openpyxl → 检查高德 Key。

### 方式 B：手动安装

```powershell
# 1. clone 仓库
git clone https://github.com/ShaoRoy/site-selection-skill.git "$env:USERPROFILE\.dsh\skills\restaurant-location-analysis"
cd "$env:USERPROFILE\.dsh\skills\restaurant-location-analysis"

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
cd "$env:USERPROFILE\.dsh\skills\restaurant-location-analysis"
python scripts/site_core.py selftest
```

看到 `48 passed` / 全绿，说明计算内核 OK。如果报错，先看是不是 Python 版本低于 3.9。

### DSH 原生插件挂载（可选）

如果你用 DSH，除了 Python 脚本模式，还可以挂原生 TypeScript 工具：

1. 打开 `dsh/cordis.patch.yml`，按里面注释把插件条目加到 DSH 的配置里
2. 重启 DSH，让插件索引生效
3. 重启后在对话里说"用 site-selection 评估一下 XXX 铺位"验证是否触发

### WorkBuddy 上传：只需打包技能

本包只有一个上传入口：

| 入口 | 要求 | 怎么打包 |
|---|---|---|
| **导入技能** | zip 根目录直接有 `SKILL.md` | 把仓库**内容**打包，不带最外层文件夹 |

```bash
git clone https://github.com/ShaoRoy/site-selection-skill.git
# 直接用 Release 里的 site-selection-workbuddy-v2.10.42.zip，不要自己打包
```

> ⚠️ **不要用 GitHub 网页的「Download ZIP」直接上传**——它会套一层
> `site-selection-skill-main/`，「导入技能」会报「所选文件夹中未找到 SKILL.md」。


### 上传报错对照

| 报错 | 原因 | 解法 |
|---|---|---|
| 所选文件夹中未找到 SKILL.md | 包多套了一层文件夹 | 用**不带外层文件夹**的包 |
| 没有 skill | SKILL.md frontmatter 缺 `name` / `description` | 当前版本两者齐备，无需处理 |

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
| Agent 不触发 Skill | 检查是否真的解压到了 `~/.dsh/skills/restaurant-location-analysis/`（目录名必须是 `restaurant-location-analysis`，与 `manifest.json` 的 `name` 一致；不要用仓库名 `site-selection-skill`） |
| `openpyxl` 导入失败 | `pip install openpyxl`；只有 `import-benchmarks.py` 需要 |
| 路径含中文 / 空格 | 部分脚本对路径敏感，建议装在纯英文路径 |
| 高德额度耗尽 | 个人开发者默认日额度 5000 次，网格扫描前先 `--dry-run` 看预计调用量 |

## 命令行快速开始（开发者）

```bash
# ── 先自检：引擎能不能跑（零网络、零 Key）─────────────────────────
python scripts/site_core.py selftest          # 48 条断言

# ── 判断该进哪一筛：从口语里识别月租金 ────────────────────────────
python scripts/site_core.py rent --text "租金2万一个月"
# → {"hit": true, "monthly_rent": 20000, "advice": "enter_stage2"}
#   认出 20000元/月 / 2w/月租 / 月租两万 / 租金三万五 / 一年租金24万（自动折月）
#   不认 租金两百五（<1000）/ 面积1200㎡ / 一天卖2万 / 转让费30万

# ── 扫一片区域，找候选点位（第 1 筛，只用高德）─────────────────────
python scripts/grid-scan.py --city 广州 --district 天河 --execute

# ── 给某点位算需求侧指标 ─────────────────────────────────────────
python scripts/demand-fetch.py "广州白鹅潭万象城" --radius 3000 --out demand.json

# ── 算动线阻断（第 1.5 筛用高德初判 / 第 2 筛用腾讯精算）───────────
# 腾讯带 steps.type，能数天桥/地道/人行横道；高德只有文本描述
python scripts/walk-matrix.py --origin "23.1035,113.2361" \
  --targets targets.csv --out barriers.csv --provider tencent          # 第 2 筛
python scripts/walk-matrix.py --origin "23.1035,113.2361" \
  --targets targets.csv --out barriers.csv --provider amap             # 第 1.5 筛

# 大批量粗筛用矩阵（1×5 对/请求，比逐条快 5 倍，但拿不到 steps）
python scripts/walk-matrix.py --origin "23.1035,113.2361" \
  --targets targets.csv --out barriers.csv --method matrix

# ── 跑完整流程（自动判定筛次；带租金才启用双源）───────────────────
node tools/run-site.mjs --profile=test-500m \
  --address="广州市荔湾区扬韬广场" --survey="survey/xxx.csv"
# 输出会明确写：
#   筛次判定：第 2 筛（检出月租金 290000 元）→ 腾讯+高德双源校验
#   源模式：双源（高德 + 腾讯交叉校验）

# ── 看网格覆盖进度 ──────────────────────────────────────────────
python scripts/grid-registry.py --city 广州 --summary

# ── 财务测算 ───────────────────────────────────────────────────
python scripts/site_core.py finance --format large_yuecai --area 1200 --catchment L2 \
  --params params.json --space space.json --out finance.json

# ── 行业基准对标 ────────────────────────────────────────────────
python scripts/site_core.py benchmark --city 广州 --format 粤式茶楼早茶 --area 1200 \
  --investment-wan 320 --rent-wan 12 --ticket 230 --revenue-wan 99 --payback 15.5 --margin 0.208

# ── 看当前生效的业态规则（自定义规则改了先跑这个）──────────────────
python scripts/site_core.py formats

# ── 人口栅格：按城市裁切（一次性，之后复用；需 QGIS 的 GDAL）──────
"QGIS/bin/python-qgis-ltr.bat" scripts/worldpop-clip.py \
  --src "D:/下载/chn_ppp_2020.tif" --city 广州 --outdir data/worldpop

# 点位人口采样 + 与 POI 代理交叉校验
"QGIS/bin/python-qgis-ltr.bat" scripts/worldpop-sample.py \
  --tif data/worldpop/gz_pop_2020_100m.tif --center "23.1035,113.2361" --proxy-intensity 42.3

# ── 导出 GeoJSON 给 QGIS（自动做 GCJ-02 → WGS84，偏移约 621m）──────
python scripts/export-geojson.py --probe probe.json --out gis --crs wgs84
```

## 报告里有什么

标准交付物是**自包含单文件 HTML**（见 SKILL.md「报告交付」）；同目录还会生成一份同名 `.md` 作纯文本备查，内容与 HTML 同源。主要包含：

| 段 | 内容 |
|---|---|
| **结论** | 一句话定性 + 三个支撑数字；下方附**术语白话速查表** |
| **数据质量** | 原始/去重/剔除条数、双源覆盖率、**数据源模式（单源还是双源）** |
| **竞品分布** | 势力份额 Top20、截流两轴、三级分层 |
| **交通可达** | 最近地铁、停车场 |
| **需求侧** | POI 代理指标 + WorldPop 人口交叉校验 |
| **场地核查** | 待核实清单（**提醒，不裁决**） |
| **财务测算** | **三档情景参数**（基准 ×1/×1、保守 ×0.85/×1.05、乐观 ×1.15/×0.97，报告可据此复算每一档）· 极限租金 · 租期现金流 · 空间容量 · 比值校验 · 假设台账 · 敏感度 |
| **行业基准对标** | 逐项偏离 + 数据性质警示 |
| **附录** | 每个数字的公式与本次代入值 |

> **只想看怎么读报告**：跳到 [`references/08-business-guide.md`](references/08-business-guide.md) 第三节，
> 那里按「先看三处 / 其余备查 / 四个常见误读」组织，不含任何命令。

**术语有白话注解**：报告里行业口径较多（截流、势力份额、翻台、坪效、极限租金…），
对不熟悉这行的人不易读。所以：

- 「结论」段内有一张 **24 条术语白话速查表**（`### 看不懂的话先看这里`）
- 关键表格行就地注成 `原说明 —— 大白话`，例如
  `第二轴·竞争截流压力 | **重度截流**（heavy）—— 抢客的店太多，客人还没走到你门口就被别人截走了`

## 目录结构

> 下表是**源码仓库**的完整结构。「导入技能」包只带
> `SKILL.md` / `references/` / `scripts/` / `data/` / `params/` / `templates/`——
> `dsh/`、`tools/`、`docs/`、`assets/`、`install.ps1`、`PROMPT.md` 都不在技能包里。

```
site-selection-skill/
├── SKILL.md              # 方法论、三条已定口径、公式全书、报告交付规则
├── CHANGELOG.md          # 版本更新记录
├── manifest.json         # Skill 清单与运行时声明
├── PROMPT.md             # Agent 提示词模板
├── install.ps1           # Windows 安装脚本
├── scripts/              # 9 个可移植 Python 脚本
│   ├── site_core.py         # 核心库（6 个工具全移植，纯 Python）
│   ├── grid-scan.py         # 网格扫描
│   ├── grid-registry.py     # 网格台账
│   ├── demand-fetch.py      # 需求侧采集
│   ├── walk-matrix.py       # 动线阻断
│   ├── worldpop-clip.py     # 人口栅格裁切（按城市）
│   ├── worldpop-sample.py   # 点位人口采样 + 交叉校验
│   ├── export-geojson.py    # 导出 GeoJSON 给 QGIS
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
├── data/                 # 数据（可替换）
│   ├── benchmarks.json   # 行业基准库（可补录城市）
│   ├── cities.json       # 城市系数（投资/租金/客单/客流）
│   └── formats.json      # 业态规则（可自定义，优先于内置）
├── local/                # 本地数据位（用户长期维护的官方公开数据，详见「本地数据位」节）
│   ├── README.md         # 字段说明与示例
│   ├── _template.json    # 城市数据模板（不计入计算）
│   └── guangzhou.json    # 示例城市（已脱敏，不参与计算）
├── docs/                 # 文档
│   ├── FEATURES.md
│   ├── GRID.md
│   ├── COMPLIANCE-CHECKLIST.md
│   ├── DECISIONS.md
│   ├── LAUNCH.md
│   ├── SKILL-FULL.md     # 历史全文留档（旧口径已废止，勿据此立项）
│   └── CUSTOMIZE.md      # 自定义与地区适配手册
└── assets/               # 报告示例截图
```

## 跑在哪边、报告谁来写

两边共用同一套计算引擎（`scripts/site_core.py`，口径以其中 `FORMULA_VERSION` 为唯一真源），**数字一致，只是报告载体不同**：
01 技能包只有引擎与文档，报告由 Agent 按 `SKILL.md` 的结构自行组织；03 源码包额外带 `tools/run-site.mjs` + `tools/report.mjs`，自动产出 md/html。

## 在其他城市 / 地区使用

> 本项目开发与验证以**广州（广东）**为主。换到其他地区（例如上海、山东、川渝、江浙），
> 下面分三类说清楚：哪些直接能用、哪些必须替换、没替换会发生什么。
>
> **完整改造手册见 [docs/CUSTOMIZE.md](https://github.com/ShaoRoy/site-selection-skill/blob/main/docs/CUSTOMIZE.md)**（含上海本帮菜、山东鲁菜的完整示例）。

### 一、直接可用（与地区无关）

| 能力 | 说明 |
|---|---|
| 财务双口径测算 | 现金回本 / 会计净利，公式与地区无关 |
| 极限租金反推 | 保本上限、目标回本上限、跨档锚点 |
| 租期现金流 / 空间容量对账 | 年递增、翻新、座位、翻台、坪效 |
| POI 去重与三级分层 | 逻辑通用 |
| 坐标系转换 | 全国统一 GCJ-02 / WGS84 |
| 网格编号与台账 | 经纬度算法通用 |
| 截流两轴定级 | 距离与份额阈值通用 |

### 二、必须替换（与地区强相关）

| 项 | 广东现状 | 换地区要做的事 |
|---|---|---|
| **城市基准数据** | 19 城，含青岛；**无济南 / 烟台 / 潍坊 / 临沂** | 用 import-benchmarks.py 补录，或接受「无基准」并在报告中写明来源 |
| **业态关键词** | 粤菜 / 早茶 / 茶楼 / 点心有专属参数 | 换成当地业态词；未命中会落到通用默认值 |
| **业态参数文件** | params/large_yuecai.json、`tea_house.json` | 复制 params/_template.json 改名，改回本目标与租售比区间 |
| **行政区名** | --city 广州 --district 天河 | 用高德 `adname` 原名，如 --city 济南 --district 历下 |

### 三、上海用户：基准库有，但要选对业态

上海在 19 个城市里，但要注意三点：

| 坑 | 说明 |
|---|---|
| 业态名对不上 | 基准库用原始业态名（如「早餐包子铺档口(15-30㎡)」），「包子铺」能模糊匹配，「早餐」不一定 |
| 城市系数不同 | 上海相对广州：投资 ×1.15、租金 **×1.30**、客单价 ×1.20、客流 ×1.10。用广州参数套上海会低估租金压力 |
| 本帮菜无专属参数 | 默认落到「中型正餐」24 月，需在 data/formats.json 加规则（见 CUSTOMIZE.md） |

### 四、未覆盖时的行为（明确告知，不静默兜底）

| 情况 | 程序行为 |
|---|---|
| 城市不在基准库 | 返回 city_in_benchmark: false + 列出全部可用城市，**不套用其他城市** |
| 业态关键词未命中 | 落到通用默认值（中式正餐 24 月 / 租售比 11~17%），**报告须标注「业态参数未校准」** |
| 行政区名写错 | 高德返回空，网格扫描 0 锚点，直接报错而不是静默返回空表 |
| 人口栅格 | 全国覆盖，与地区无关；用 `worldpop-clip.py` 从全国 tif 裁出城市窗口（约 7 MB/城市） |


<!-- ③ 关键词：纯文本，可被搜索引擎与大模型直接抓取 -->

<p>
  <strong>关键词</strong>：餐饮选址评估 · 商圈分析 · 竞品截流 · 极限租金反推 · 财务三档测算 · 实体门店 · 高德 / 腾讯双源 GIS · QGIS · AI Agent Skill · WorkBuddy · DeepSeek Harness · 可复核报告
</p>
> 参数驱动的实体门店**选址评估** Agent 能力包 · v2.10.42
>
> 内置 **19 城 × 48 个餐饮业态**基准，覆盖正餐酒楼、茶楼早茶、火锅、烧烤、日料、西餐、茶饮咖啡、烘焙甜品、快餐档口、面食粉面、卤味熟食等细分档。
> 非餐饮业态（零售 / 生活服务 / 教培 / 仓配）可用自定义参数测算财务与商圈，但**没有内置基准可对标**——报告会明确标注，不会拿餐饮基准冒充。

Tool 硬算 + Skill 只翻译。所有确定性计算交给脚本，Skill 只负责定口径、组织流程、把结果翻译成人能读的报告。

---

## 局限

- 等时圈若未接本地路网引擎，降级为直线估算（标注【估算】）
- 人口核对需 QGIS（GDAL）与按城市裁切的栅格；未启用时报告会写明原因并提示按「单源」看待
- 动线阻断需现场实测
- 行业基准为行业平均，单店实际 ±30%
- POI 数据为公开接口参考值，非精准探针客流

## 免责声明

本项目仅为 AI 辅助决策工具，所有计算结果基于公开数据与经验模型推演，**不保证盈利，不构成经营建议**。开店决策务必结合线下实地考察、人工复核与专业判断。

## 作者 / 联系方式

**作者：** ShaoRoy
**Email：** yingshao113113@gmail.com

如有问题、建议或合作交流，欢迎邮件联系。

## 支持本项目

本项目由作者无偿维护。
打赏为自愿赠与行为，不附带任何服务承诺或特权。

<img src="assets/sponsor-wechat.jpg" width="240" alt="微信收款码 · 自愿打赏" />

- 不支持，功能完全一样；支持了，也不会多出任何功能或服务
- 不承诺维护时限、不提供优先支持；商业用途请另按 [LICENSE](LICENSE) 第二条取得作者书面许可，与本节无关

## License

[Custom NonCommercial License](LICENSE) · 作者自定义非商业许可（**非 OSI 开源许可**，不适用任何 Creative Commons 许可）

- **可以**：阅读、学习、本地运行、修改与二次开发；分享原仓库链接或原样转发原始发布包；把本作品重新打包成 Skill / 插件 / 专家包 / 模板并**免费**分发
- **必须**：完整保留 LICENSE 全文、版权声明与联系方式；署名 Copyright (c) 2026 ShaoRoy 并注明来源项目与原始仓库链接；如作过修改须标注「已修改」
- **禁止**：一切商业性使用——出售、付费产品、付费 Skill / 专家包 / 插件、订阅服务、商业 SaaS、对外 API、收费咨询 / 外包 / 项目交付、企业内部经营性系统、广告或流量变现
- 商业授权须事先取得作者**书面**许可（另有协商条款）
- 协议全文见 [LICENSE](LICENSE)
