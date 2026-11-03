#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
worldpop-clip.py —— 从 WorldPop 全国栅格裁出任意城市窗口

源文件（4.7 GB，只需下载一次）：
  https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/CHN/chn_ppp_2020.tif

用法（QGIS 的 Python 自带 GDAL）：
  # 裁内置城市
  "D:\\QGIS 3.44.8\\bin\\python-qgis-ltr.bat" scripts/worldpop-clip.py \
      --src "D:\\下载\\chn_ppp_2020.tif" --city 济南 --outdir data/worldpop

  # 裁任意区域（自己给 bbox：minLng,maxLat,maxLng,minLat）
  ... worldpop-clip.py --src <tif> --bbox "116.65,37.00,117.45,36.35" --name jn

  # 批量
  ... worldpop-clip.py --src <tif> --all --outdir data/worldpop
"""
import argparse
import json
import os
import sys
import time

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# 城市 bbox：minLng, maxLat, maxLng, minLat（略放宽，覆盖都市圈）
CITIES = {
    "北京": ("bj", 116.05, 40.25, 116.90, 39.55),
    "上海": ("sh", 120.85, 31.90, 122.00, 30.65),
    "广州": ("gz", 112.90, 23.95, 114.10, 22.50),
    "深圳": ("sz", 113.75, 22.90, 114.65, 22.40),
    "佛山": ("fs", 112.60, 23.35, 113.40, 22.60),
    "东莞": ("dg", 113.55, 23.15, 114.30, 22.65),
    "重庆": (["cq"][0], 105.28, 32.20, 110.20, 28.15),
    "成都": ("cd", 103.60, 31.45, 104.90, 30.05),
    "杭州": ("hz", 119.55, 30.55, 120.75, 29.85),
    "武汉": ("wh", 113.70, 31.40, 115.10, 29.95),
    "苏州": ("su", 120.30, 32.05, 121.25, 30.75),
    "西安": ("xa", 108.40, 34.75, 109.50, 33.65),
    "南京": ("nj", 118.35, 32.60, 119.30, 31.20),
    "长沙": ("cs", 112.50, 28.55, 113.65, 27.85),
    "天津": ("tj", 116.70, 40.25, 118.05, 38.55),
    "青岛": ("qd", 119.90, 36.55, 120.75, 35.85),
    "济南": ("jn", 116.65, 37.00, 117.45, 36.35),
    "宁波": ("nb", 121.05, 30.35, 122.30, 28.85),
    "郑州": ("zz", 112.85, 34.95, 114.15, 34.30),
    "合肥": ("hf", 116.70, 32.55, 117.65, 31.35),
    "昆明": ("km", 102.35, 25.45, 103.20, 24.40),
}


def clip(src, bbox, out, gdal):
    if os.path.exists(out):
        return "skip", os.path.getsize(out) / 1024 / 1024
    t0 = time.time()
    ds = gdal.Translate(out, src, projWin=list(bbox), projWinSRS="EPSG:4326",
                        format="GTiff",
                        creationOptions=["COMPRESS=DEFLATE", "TILED=YES", "PREDICTOR=3"])
    ds = None
    return f"{time.time()-t0:.1f}s", os.path.getsize(out) / 1024 / 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="WorldPop 全国栅格路径")
    ap.add_argument("--outdir", default="data/worldpop")
    ap.add_argument("--city", help="内置城市名，如 济南")
    ap.add_argument("--bbox", help="自定义 minLng,maxLat,maxLng,minLat")
    ap.add_argument("--name", help="自定义输出的英文代号")
    ap.add_argument("--all", action="store_true", help="裁全部内置城市")
    ap.add_argument("--list", action="store_true", help="列出内置城市")
    a = ap.parse_args()

    if a.list:
        print("内置城市：")
        for k, v in CITIES.items():
            print(f"  {k:<4} {v[0]:<4} bbox=({v[1]}, {v[2]}, {v[3]}, {v[4]})")
        return

    try:
        from osgeo import gdal
    except ImportError:
        raise SystemExit("需要 GDAL。请用 QGIS 的 Python 运行："
                         r'"D:\QGIS 3.44.8\bin\python-qgis-ltr.bat" scripts/worldpop-clip.py ...')
    gdal.UseExceptions()

    if not os.path.exists(a.src):
        raise SystemExit(f"源文件不存在：{a.src}")

    os.makedirs(a.outdir, exist_ok=True)
    jobs = []
    if a.all:
        jobs = [(k, v[0], v[1:]) for k, v in CITIES.items()]
    elif a.bbox:
        box = [float(x) for x in a.bbox.split(",")]
        if len(box) != 4:
            raise SystemExit("--bbox 需要 4 个值：minLng,maxLat,maxLng,minLat")
        jobs = [(a.name or "custom", a.name or "custom", box)]
    elif a.city:
        if a.city not in CITIES:
            raise SystemExit(f"内置城市里没有「{a.city}」。可用：{'、'.join(CITIES)}")
        v = CITIES[a.city]
        jobs = [(a.city, v[0], v[1:])]
    else:
        raise SystemExit("需要 --city / --bbox / --all 之一")

    print(f"源：{a.src}")
    print(f"输出目录：{a.outdir}\n")
    total = 0
    for name, code, box in jobs:
        out = os.path.join(a.outdir, f"{code}_pop_2020_100m.tif")
        try:
            status, mb = clip(a.src, box, out, gdal)
            total += mb
            print(f"  {name:<4} {code:<4} {status:>8}  {mb:>6.1f} MB  → {os.path.basename(out)}")
        except Exception as e:
            print(f"  {name:<4} {code:<4}   失败：{e}")
    print(f"\n合计 {total:.1f} MB")


if __name__ == "__main__":
    main()
