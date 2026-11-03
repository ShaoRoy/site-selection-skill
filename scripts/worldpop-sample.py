#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
worldpop-sample.py —— 从 WorldPop 人口栅格取点位周边人口，用于交叉校验

依赖：GDAL（QGIS 自带即可）。Python 标准库以外的 numpy 也由 QGIS 提供。

用法（用 QGIS 的 Python 跑）：
  "D:\\QGIS 3.44.8\\bin\\python-qgis-ltr.bat" scripts/worldpop-sample.py \
      --tif data/worldpop/gz_pop_2020_100m.tif --center "23.1035,113.2361" --out pop.json

坐标系：点位是 GCJ-02（高德），栅格是 WGS84 —— 脚本内部自动转换，
        不转的话 500m 半径会偏 600m，结论全错。
"""
import argparse
import json
import math
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

A = 6378245.0
EE = 0.00669342162296594323


def _tlat(x, y):
    r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(y * math.pi) + 40 * math.sin(y / 3 * math.pi)) * 2 / 3
    r += (160 * math.sin(y / 12 * math.pi) + 320 * math.sin(y * math.pi / 30)) * 2 / 3
    return r


def _tlng(x, y):
    r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(x * math.pi) + 40 * math.sin(x / 3 * math.pi)) * 2 / 3
    r += (150 * math.sin(x / 12 * math.pi) + 300 * math.sin(x / 30 * math.pi)) * 2 / 3
    return r


def wgs84_to_gcj02(lat, lng):
    dlat = _tlat(lng - 105, lat - 35)
    dlng = _tlng(lng - 105, lat - 35)
    rad = lat / 180 * math.pi
    magic = 1 - EE * math.sin(rad) ** 2
    sq = math.sqrt(magic)
    dlat = (dlat * 180) / ((A * (1 - EE)) / (magic * sq) * math.pi)
    dlng = (dlng * 180) / (A / sq * math.cos(rad) * math.pi)
    return lat + dlat, lng + dlng


def gcj02_to_wgs84(lat, lng):
    wlat, wlng = lat, lng
    for _ in range(3):
        glat, glng = wgs84_to_gcj02(wlat, wlng)
        wlat -= glat - lat
        wlng -= glng - lng
    return wlat, wlng


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tif", required=True, help="WorldPop 裁剪后的 GeoTIFF")
    ap.add_argument("--center", help="GCJ-02 坐标 lat,lng")
    ap.add_argument("--radii", default="500,1000,3000", help="半径列表（米）")
    ap.add_argument("--out", help="输出 JSON 路径")
    ap.add_argument("--proxy-intensity", type=float, help="我们算出的需求强度（0-100），用于交叉判定")
    a = ap.parse_args()

    try:
        import numpy as np
        from osgeo import gdal
    except ImportError:
        raise SystemExit("需要 GDAL 与 numpy。用 QGIS 的 Python 运行："
                         r'"D:\QGIS 3.44.8\bin\python-qgis-ltr.bat" scripts/worldpop-sample.py ...')
    gdal.UseExceptions()

    if not a.center:
        raise SystemExit("需要 --center \"lat,lng\"（GCJ-02，和高德一致）")
    lat_g, lng_g = (float(x) for x in a.center.split(","))
    radii = [int(x) for x in a.radii.split(",") if x.strip()]

    ds = gdal.Open(a.tif)
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray().astype(np.float64)
    arr[arr < 0] = 0
    ox, px, _, oy, _, py = ds.GetGeoTransform()
    H, W = arr.shape

    lat_w, lng_w = gcj02_to_wgs84(lat_g, lng_g)
    shift = math.hypot((lat_w - lat_g) * 110574,
                       (lng_w - lng_g) * 111320 * math.cos(math.radians(lat_w)))

    out = {
        "tif": os.path.basename(a.tif),
        "cell_size_m": [round(abs(px) * 111320, 0), round(abs(py) * 110574, 0)],
        "input_gcj02": [lat_g, lng_g],
        "converted_wgs84": [round(lat_w, 6), round(lng_w, 6)],
        "crs_shift_m": round(shift, 0),
        "rings": {},
    }

    for r in radii:
        d_lat = r / 110574.0
        d_lng = r / (111320 * math.cos(math.radians(lat_w)))
        r0 = max(0, int((lat_w + d_lat - oy) / py))       # py<0：北界 row 更小
        r1 = min(H, int((lat_w - d_lat - oy) / py) + 1)
        c0 = max(0, int((lng_w - d_lng - ox) / px))
        c1 = min(W, int((lng_w + d_lng - ox) / px) + 1)
        if r1 <= r0 or c1 <= c0:
            out["rings"][str(r)] = {"in_raster": False}
            continue
        sub = arr[r0:r1, c0:c1]
        ys = ((oy + (np.arange(r0, r1) + 0.5) * py) - lat_w) * 110574
        xs = ((ox + (np.arange(c0, c1) + 0.5) * px) - lng_w) * 111320 * math.cos(math.radians(lat_w))
        mask = (ys[:, None] ** 2 + xs[None, :] ** 2) <= r * r
        pop = float((sub * mask).sum())
        area = math.pi * (r / 1000.0) ** 2
        out["rings"][str(r)] = {
            "in_raster": True, "population": round(pop), "area_km2": round(area, 2),
            "density_per_km2": round(pop / area) if area else 0,
        }

    # 交叉判定
    if a.proxy_intensity is not None:
        d1 = (out["rings"].get("1000") or {}).get("density_per_km2") or 0
        # 参考档位：一线城市核心 2 万以上算高密度，1 万以下算低密度
        dens_level = "高" if d1 >= 20000 else ("中" if d1 >= 10000 else "低")
        inten_level = "高" if a.proxy_intensity >= 60 else ("中" if a.proxy_intensity >= 40 else "低")
        combo = {
            ("高", "高"): ("成熟商圈", "人口与商业都强，竞争激烈，拼差异化"),
            ("高", "中"): ("居住型商圈", "人多商业中等，社区客为主，值得深挖"),
            ("高", "低"): ("机会点", "人口密集但商业未饱和，优先实地踏勘"),
            ("中", "高"): ("商务型商圈", "人口不多但消费力强，靠白领工作日客流"),
            ("中", "中"): ("一般商圈", "两头都在中位，看具体铺位定"),
            ("中", "低"): ("待观察", "人口中等但业态不足，取决于未来规划"),
            ("低", "高"): ("泡沫风险", "商业密集但常住人口少，需核实客流来源"),
            ("低", "中"): ("商务/过境型", "常住少，靠办公或过境客流"),
            ("低", "低"): ("排除", "人口与商业双低"),
        }.get((dens_level, inten_level), ("未知", ""))
        out["cross_check"] = {
            "worldpop_density_1km": d1, "worldpop_level": dens_level,
            "proxy_intensity": a.proxy_intensity, "proxy_level": inten_level,
            "verdict": combo[0], "interpretation": combo[1],
        }

    text = json.dumps(out, ensure_ascii=False, indent=2)
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"已写入 {a.out}")
        print(f"  GCJ→WGS 偏移 {shift:.0f}m｜1km 人口 {(out['rings'].get('1000') or {}).get('population', '—')}")
        if "cross_check" in out:
            c = out["cross_check"]
            print(f"  交叉判定：WorldPop {c['worldpop_level']}密度 × 代理强度 {c['proxy_level']} "
                  f"→ {c['verdict']}")
    else:
        print(text)


if __name__ == "__main__":
    main()
