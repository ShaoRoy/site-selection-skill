# 本地服务与数据中心

> 摘自 SKILL.md 原「本地服务与开关 / 人口核对」两节。含 Docker、WorldPop 栅格、降级策略。

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
