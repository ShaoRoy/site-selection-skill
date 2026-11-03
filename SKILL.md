---
name: site-selection
display_name: 选址智能评估
display_name_en: Site Selection Intelligence
description: 连锁实体商业（尤其餐饮）选址评估。当用户要评估某个门店点位、判断商圈、核算租金是否合理、估算回本周期、批量筛选候选点位时使用。输出证据链报告，不做"能不能开"的判断。
description_zh: 连锁实体商业选址评估：城市网格扫描、竞品去重与三级分层、截流两轴定级、财务双口径回本、极限租金反推、行业基准对标、人口栅格交叉校验。输出证据链报告，不判断能不能开。
description_en: Site selection evaluation for chain restaurants and retail. Covers grid scanning, competitor deduplication and tiering, dual-axis interception grading, cash and accounting payback, rent-ceiling back-calculation, industry benchmark comparison, and population raster cross-validation. Produces an evidence-chain report without passing a go/no-go verdict.
version: 2.9.0
license: MIT
author: RoyShao
tags: [选址, GIS, 餐饮, 财务, 商圈分析]
targets: [workbuddy, dsh]
title: "选址智能评估 Site Selection Intelligence"
summary: "连锁餐饮 / 实体门店选址评估：网格扫描、竞品去重与三级分层、截流两轴定级、财务双口径回本、极限租金反推、行业基准对标、人口栅格交叉校验。输出证据链报告，不判断能不能开。"
read_when:
  - 用户要评估某个门店点位、商铺、商场铺位
  - 用户问这个租金贵不贵、多久回本、极限租金多少
  - 用户要在一片区域里筛候选点位
  - 用户要分析商圈、竞品格局、客流截流
  - 用户提供现场踏勘信息（动线、距离、阻断）
---

# 选址评估 Skill

**核心原则：Tool 硬算 + Skill 只翻译。**
所有确定性计算交给脚本，本 Skill 只负责：定口径、组织流程、把结果翻译成人能读的报告。**不得自己编数、估数、圆数。**

---

## 渲染器（可选，需要 Node 18+）

	ools/ 目录带一套零依赖渲染器，能把 probe.json 直接渲染成可交付的 HTML 报告
（内嵌地图瓦片、Top20 两栏榜单、点击门店高亮、一键存 PDF）。

`ash
node tools/report.mjs --in=<probe.json 路径> [--profile=<业态档案>]
`

**没有 Node 也能用**：本节「报告结构」给的是 Markdown 骨架，模型可按它直接组织输出，
只是没有地图和点击联动。

什么时候跑渲染器、什么时候手写 Markdown：

| 场景 | 做法 |
|---|---|
| 环境有 Node | 跑 
eport.mjs，产出单文件 HTML（断网可看、可直接发人） |
| 只有对话能力 | 按下面的报告结构手写 Markdown |
| 要 PDF | 打开 HTML 点「存为 PDF」，页内已内嵌地图 |

详见 	ools/README.md。


## 〇、两种运行方式

| 运行时 | 用什么 | 怎么装 |
|---|---|---|
| **任意 Agent（WorkBuddy 等）** | `scripts/site_core.py`（6 个工具全移植，纯 Python） | 解压即用，`python scripts/site_core.py selftest` 自检 |
| **DSH** | `dsh/site-tools.ts` 原生插件（6 个工具） | 按 `dsh/cordis.patch.yml` 挂载后重启 |

两者**计算口径完全一致**（`fin-v4`），只是调用方式不同。DSH 里也可直接调 Python 版，互不冲突。

```bash
# 自检（20 条断言）
python scripts/site_core.py selftest

# 财务测算
python scripts/site_core.py finance --format large_yuecai --area 1200 --catchment L2 \
  --params params.json --space space.json --out finance.json

# 场地核查 / 坐标系 / 去重 / 空间 / 基准对标
python scripts/site_core.py veto --format large_yuecai --fields fields.json
python scripts/site_core.py crs  --crs wgs84 --points points.json
python scripts/site_core.py dedupe --pois pois.json --whitelist "餐饮|粤菜|酒楼"
python scripts/site_core.py geo --center "23.1035,113.2361" --pois pois.json --mode walk --minutes 10
python scripts/site_core.py benchmark --city 广州 --format 粤式茶楼早茶 --area 1200 \
  --investment-wan 320 --rent-wan 12 --ticket 230 --revenue-wan 99 --payback 15.5 --margin 0.208
```

---

## 一、什么时候用

| 触发场景 | 走到哪一步 |
|---|---|
| "帮我看看这个铺能不能开" | 第 1.5 筛单点评估 |
| "这片区域哪里适合开店" | 第 1 筛网格扫描 |
| "这个租金贵不贵" | 财务测算 + 极限租金反推 |
| "多久能回本" | 财务双口径测算 |
| "现场看过了，跟你说下情况" | 第 2 筛动线阻断录入 |

---

## 二、四道筛选流程

```
第 1 筛   城市网格扫描    python scripts/grid-scan.py
第 1.5 筛 单点评估        site_core.py veto/finance/geo/dedupe + demand-fetch.py
第 2 筛   现场            python scripts/walk-matrix.py
第 3 筛   财务锁盘        site_core.py finance + benchmark
```

**每一筛只做本筛的事。** 第 1 筛不要碰租金、铺位、层高——那是第 2、3 筛。

---

## 三、六条硬纪律

1. **判断留给读的人**：不输出"能不能开"，只输出"还差哪几个数"
2. **每个数字可追溯**：公式 + 代入值 + 结果必须同时给出
3. **缺省必须披露**：用了默认值就写进台账，不静默兜底
4. **不用可刷的数据验证模型**：点评评分、门店月售一律不采
5. **不为凑结论反向调参**：参数是校准现实的，不是校准结论的
6. **人口数据没有公开渠道**：不要找、不要抓。用 POI 代理指标

---

## 四、各筛要点

### 第 1 筛 · 网格扫描

```bash
python scripts/grid-scan.py --city 广州 --district 天河 --dry-run    # 先看额度
python scripts/grid-scan.py --city 广州 --district 天河 --execute
python scripts/grid-scan.py --city 广州 --district 天河 --rescore    # 改权重，0 调用
```

- 锚点 = 地铁站 + 商场，300m 内合并
- **额度硬门**：>500 次需 `--yes`，>1500 次拒绝执行
- 分数是**本批内相对值**，A/B/C 按排名分档，跨批次不可比

### 第 1.5 筛 · 单点评估

三组数据：竞品与大配套（高德 POI）、需求侧代理（`demand-fetch.py`）、财务参数（调研表）。

**竞品三级分层**：直接（同品类同价位）/ 替代（同品类不同价位）/ 间接（不同品类）。

**截流两轴**（不可互相替代）：

| 轴 | 判什么 | 输出 |
|---|---|---|
| 点位截流力 | 铺位自身能截多少路过客流（**现场判定**） | L1~L5 |
| 竞争截流压力 | 对手抢走多少（POI 推算） | none/light/heavy |

### 第 2 筛 · 现场

```bash
python scripts/walk-matrix.py --origin "lat,lng" --targets targets.csv --out barriers.csv
python scripts/grid-registry.py --status-file status.json
```

**自然语言反馈四要素**（缺一个就追问）：目标能对号 / 通不通 / 多远多久 / 什么挡着。

**绕行倍数 > 1.5 判有阻断；> 3 基本等于两个世界。**

### 第 3 筛 · 财务

参数缺失就问，**不许估**。核心公式见第六节。

---

## 五、点位截流力分级（L1–L5）

| 级 | 名称 | 典型场景 | 客流乘数 |
|---|---|---|---|
| L1 | 顶级截流（千分点） | 地铁直出口第一铺、商场主入口第一卡位、步行街转角铺 | ×1.30 |
| L2 | 强截流（A 类点） | 商场主通道中段、临街无隔离栏一楼铺 | ×1.10 |
| L3 | 中等截流（B 类·基准） | 商场餐饮区内侧铺、社区街铺非转角、二楼临街铺 | ×1.00 |
| L4 | 弱截流（C 类点） | 商场高区末端、内街深处、隔护栏铺 | ×0.65 |
| L5 | 极低截流（D 类·慎选） | 负一层死角、独栋远离动线、商圈背街 | ×0.15 |

**判断口诀**：站在主入口往里看，能不能一路看到你的门头。

> ⚠️ 客户已给**实测日营业额**时，不要再乘 L 级系数——实测值已含位置因素。

---

## 六、核心公式（现金 / 会计双口径）

```
月营业额 = 日营业额 × 30
月毛利   = 月营业额 × 毛利率
月税费   = 月营业额 × 税费率（默认 4.5%）
月摊销   = 初始投入 ÷ 摊销月数（默认 60，非现金）
月固定   = 租金 + 人力 + 其他固定

月现金净流   = 月毛利 − 月税费 − 月固定
月净利（会计）= 月现金净流 − 月摊销

保本日营业额 = 月固定 ÷ (毛利率 − 税费率) ÷ 30
回本·现金    = 初始投入 ÷ 月现金净流
回本·会计    = 初始投入 ÷ 月净利      ← 与行业基准可比
ROI          = 月净利 × 12 ÷ 初始投入

极限租金·保本     = (月毛利 − 税费) ÷ 成本因子 − 人力 − 其他
极限租金·目标回本 = (月毛利 − 税费 − 投入÷目标月数) ÷ 成本因子 − 人力 − 其他
建议锚点         = min(各档极限租金·目标回本)     ← 跨档取最保守
```

**现金口径算回本，会计口径算净利率。** 摊销不是现金支出，混用会两头失真。

### 内部比值校验（不依赖外部数据）

| 指标 | 公式 | 越界含义 |
|---|---|---|
| 毛利率 | 直接取 | 虚高＝没扣折扣损耗 |
| 人力占营收 | 人力 ÷ 月营业额 | 偏低＝人力估少了 |
| 租售比 | 租金 ÷ 月营业额 | 超线＝租金结构不安全 |
| 单方造价 | 投入 ÷ 建筑面积 | 偏低＝投入漏项 |

越界必须给**反推值**（"按 22% 反推应为 15 万/月"），只说"偏低"没用。

---

## 七、报告结构（7 段 + 附录）

```
0 结论          一句话判定 + 支撑数字
1 数据质量      采集可信度（ok/partial/suspicious/degraded）
2 竞品分布      份额 / 距离带 / 截流两轴 / 三级分层 / 动线阻断
3 交通可达      含实测步行修正
4 需求侧代理    6 项代理指标 + 需求强度
5 场地核查      提醒，非否决；只列待核实项
6 财务测算      三档 + 极限租金 + 锚点 + 租期 + 空间 + 比值 + 台账 + 敏感度
附录 计算口径    每个数字的公式与代入值
```

**第 4 段缺失就写"未计算"并给补齐命令，不得用竞品数反推人口。**

---

## 本地服务与开关（哪些要开、哪些不用开）

三类外部依赖，要求完全不同——**最容易忘的是 Valhalla**。

| 功能 | 本地要开什么 | 忘了会怎样 |
|---|---|---|
| POI 采集 / 财务测算 / 网格扫描 | **什么都不用开**（联网 + 高德 Key） | 无 Key 时采集报缺凭证 |
| 人口栅格核对 | **什么都不用开**（只要装了 QGIS） | 报告写明「人口核对未执行」+ 补齐命令 |
| **等时圈（真实路网）** | **Docker + Valhalla 容器常驻，端口 8002** | 降级为直线估算，报告头部黄色提醒 |

### Valhalla：常忘的那一个

```
# 首次（约 2 GB 镜像 + 瓦片挂载）
docker run -dt --name valhalla -p 8002:8002 -v F:/gis/valhalla:/custom_files ghcr.io/gis-ops/docker-valhalla/valhalla:latest

# 之后（容器已存在）
docker start valhalla

# 不用时释放内存（约 1~2 GB）
docker stop valhalla
```

**判断是否在跑**：`docker ps --filter name=valhalla`
能访问 `http://localhost:8002/status` 返回 200 就是好的。

### 忘了开会怎样（不会静默）

**终端**：

```
⚠️ 等时圈引擎未启用：Valhalla(8002) 与 OSRM(5000) 都不可达
   本次等时圈为【直线估算】——遇江面、快速路、封闭小区会高估可达范围，圈内竞品数偏多。
   首次启动：docker run -dt --name valhalla -p 8002:8002 -v F:/gis/valhalla:/custom_files ghcr.io/gis-ops/docker-valhalla/valhalla:latest
   之后启动：docker start valhalla
   不用时可以 docker stop valhalla 释放内存（约 1~2 GB），下次跑之前记得再 start。
```

**报告头部**（md 与 html 都有黄色提示块）：

```
> ⚠️ 等时圈引擎未启用（Valhalla(8002) 与 OSRM(5000) 都不可达）
> 本次圈层为【直线估算】：直线估算遇江面/快速路会高估可达范围，圈内竞品数偏多。
> 启动：`docker start valhalla`（首次：`docker run -dt ...`）
```

### 直线估算偏差有多大

白鹅潭万象城实测：到芳村站**直线 586m，实测步行 1136m**（1.94 倍）。
隔江、隔快速路、小区封闭的场景，直线估算会把 15 分钟圈画大 1.5~2 倍，**圈内竞品数系统性偏多**。

所以：**要做最终结论前，先把 Valhalla 开起来重跑一次。**


## 人口核对（独立数据源交叉验证）

需求强度来自 POI 代理，测的是**商业活跃度**。常住人口是另一回事——两者对照才能看出商圈性质。

### 它测什么、不测什么

| | WorldPop 人口栅格 | POI 代理强度 |
|---|---|---|
| 测什么 | **常住人口**（晚上谁在这住） | **商务活跃度**（白天谁在这花钱） |
| 来源 | 卫星 + 普查建模，约 93m 栅格 | 高德 POI 密度加权 |
| 精度 | 官方估算，非实测 | 代理指标 |

**单看任何一个都会误判。** 例：CBD 常住人口密度往往低于老城区，但消费力强得多。

### 交叉判定表

| WorldPop 人口 | POI 代理强度 | 判定 | 含义 |
|---|---|---|---|
| 高 | 低 | **机会点** | 人口密集但商业未饱和，优先实地踏勘 |
| 高 | 高 | 成熟商圈 | 两头都强，竞争激烈，拼差异化 |
| 高 | 中 | 居住型商圈 | 社区客为主 |
| 中 | 高 | 商务型商圈 | 靠白领工作日客流 |
| 低 | 高 | **泡沫风险** | 商业密集但常住人口少，核实客流来源 |
| 低 | 低 | 排除 | 双低 |

### 怎么启用（一次性，约 10 分钟）

```bash
# 1) 下载全国栅格（4.7 GB，只需一次）
#    https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/CHN/chn_ppp_2020.tif

# 2) 裁出你的城市（每个 1~8 MB，约 1 秒）
"QGIS安装目录/bin/python-qgis-ltr.bat" scripts/worldpop-clip.py \
    --src "D:/下载/chn_ppp_2020.tif" --city 广州 --outdir data/worldpop

# 3) 自检
"QGIS安装目录/bin/python-qgis-ltr.bat" scripts/worldpop-sample.py \
    --tif data/worldpop/gz_pop_2020_100m.tif --center "23.1035,113.2361"
```

内置 21 个城市：北京 上海 广州 深圳 佛山 东莞 重庆 成都 杭州 武汉 苏州 西安 南京 长沙 天津 青岛 济南 宁波 郑州 合肥 昆明。
其他城市用 `--bbox "minLng,maxLat,maxLng,minLat"` 自己裁。

**依赖**：QGIS（提供 GDAL）。没装 QGIS 时该能力自动跳过，报告会写明原因。

### 未启用时会怎样

报告第 4 段会出现：

```
**人口核对（本次未执行）**
⚠️ 原因：杭州 的人口栅格还没裁
补齐：scripts/worldpop-clip.py --src <WorldPop全国tif> --city 杭州
本次报告缺少独立人口数据源，需求强度全部来自 POI 代理，请按「单源」看待。
```

**降级不静默**——缺哪一环、怎么补，都写在报告里。

### 坐标系必须转

点位是 GCJ-02（高德），栅格是 WGS84。**偏移约 621 米**——500m 半径的圈中心偏 621m，结论全错。
`worldpop-sample.py` 内部自动转换，并在输出里标出偏移量。


## 八、数据源纪律

| 数据 | 采用 | 说明 |
|---|---|---|
| 高德 POI（免费额度） | ✅ | 主力数据源 |
| 腾讯 POI | ✅ | 交叉校验 |
| 街道常住人口 | ⛔ | 政府公报多为图片/PDF，无免费接口 |
| 点评评分 / 月售 | ⛔ | 可刷；月售是外卖口径 |
| 二手房挂牌价 | ⚠️ | 仅辅助，需标结构偏差 |
| 人口热力 | ⏸ | 需企业资质，默认停用 |

---

## 九、常见错误

| ❌ 错 | ✅ 对 |
|---|---|
| 用 L4 替代"重度截流" | 两轴分开写 |
| 看到 heavy 就说不能开 | heavy 只说明竞争激烈 |
| 已给实测营业额又乘 L 级 | 二者选一 |
| 用竞品数量反推人口 | 自我循环 |
| 缺参数时按经验补一个 | 缺就标"待补"，不许编 |
| 为了结论好看调参数 | 参数校准现实，不校准结论 |

---

## 十、脚本清单

| 脚本 | 用途 | 依赖 |
|---|---|---|
| `site_core.py` | **6 个核心工具全移植**（finance/crs/veto/dedupe/geo/benchmark） | 无 |
| `grid-scan.py` | 城市网格扫描 → 候选点位 | 高德 Key |
| `grid-registry.py` | 网格编号 / 状态 / 覆盖率 / 覆盖地图 | 无 |
| `demand-fetch.py` | 需求侧 POI 代理指标 | 高德 Key |
| `walk-matrix.py` | 批量步行距离（动线阻断） | 高德 Key |
| `import-benchmarks.py` | 行业基准底稿 → JSON | openpyxl |
| `dsh/site-tools.ts` | DSH 原生插件（口径与 site_core.py 一致） | DSH 运行时 |

**高德 Key**：环境变量 `AMAP_API_KEY`，或写入 `~/.dsh/secrets/amap.key`（一行纯文本）。
