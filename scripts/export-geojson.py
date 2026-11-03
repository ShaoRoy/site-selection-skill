#!/usr/bin/env python3
"""
export-geojson.py —— 把 probe.json 导出成 GeoJSON，供 QGIS / ArcGIS / kepler.gl 使用

⚠️ 坐标系陷阱：我们的坐标是高德 GCJ-02（火星坐标），QGIS 默认 WGS84。
   直接加载会整体偏移约 300~600 米。**必须**加 --crs wgs84 转换后再用。

用法：
  python tools/export-geojson.py --probe out/<点位>/probe.json --out out/<点位>/gis
  python tools/export-geojson.py --probe ... --out ... --crs wgs84        # 转成 WGS84（QGIS 用这个）
  python tools/export-geojson.py --probe ... --out ... --crs gcj02        # 保持高德坐标（和高德底图对齐）

产出：
  <out>/points.geojson      竞品/POI 点（含分段、人均、距离）
  <out>/center.geojson      候选点位本身
  <out>/isochrone.geojson   等时圈（直线估算多边形，报告里标【估算】）
  <out>/README.txt          坐标说明与 QGIS 打开步骤
"""

import argparse
import json
import math
import os

A = 6378245.0
EE = 0.00669342162296594323


def _out_of_china(lat, lng):
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


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
    if _out_of_china(lat, lng):
        return lat, lng
    dlat = _tlat(lng - 105, lat - 35)
    dlng = _tlng(lng - 105, lat - 35)
    rad = lat / 180 * math.pi
    magic = 1 - EE * math.sin(rad) ** 2
    sq = math.sqrt(magic)
    dlat = (dlat * 180) / ((A * (1 - EE)) / (magic * sq) * math.pi)
    dlng = (dlng * 180) / (A / sq * math.cos(rad) * math.pi)
    return lat + dlat, lng + dlng


def gcj02_to_wgs84(lat, lng):
    """迭代反解，精度 < 0.5m（一次近似够用，这里做 3 次收敛）。"""
    if _out_of_china(lat, lng):
        return lat, lng
    wlat, wlng = lat, lng
    for _ in range(3):
        glat, glng = wgs84_to_gcj02(wlat, wlng)
        wlat -= glat - lat
        wlng -= glng - lng
    return wlat, wlng


def hav(a1, o1, a2, o2):
    R = 6371000.0
    p1, p2 = math.radians(a1), math.radians(a2)
    dp, dl = p2 - p1, math.radians(o2 - o1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", required=True)
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--crs", default="wgs84", choices=["wgs84", "gcj02"])
    ap.add_argument("--ring-index", type=int, default=-1, help="用第几个圈层画等时圈，默认内圈")
    args = ap.parse_args()

    with open(args.probe, encoding="utf-8-sig") as f:
        d = json.load(f)

    center = d.get("center") or {}
    clat, clng = float(center.get("lat", 0)), float(center.get("lng", 0))
    conv = (lambda la, ln: gcj02_to_wgs84(la, ln)) if args.crs == "wgs84" else (lambda la, ln: (la, ln))

    rings = d.get("rings") or []
    if args.ring_index < 0:
        ring = next((r for r in rings if r.get("is_primary")), rings[0] if rings else {})
    else:
        ring = rings[args.ring_index] if len(rings) > args.ring_index else {}
    radius = float(ring.get("radius") or ring.get("radius_m") or d.get("isochrone_radius") or 0)

    # 竞品点：优先取 rings.inside 明细，其次 pois
    pois = []
    for r in rings:
        for p in (r.get("inside_detail") or []):
            pois.append(p)
    if not pois:
        pois = d.get("pois") or []
    if not pois:
        pois = ring.get("nearest") or []

    feats = []
    for p in pois:
        try:
            lat, lng = float(p["lat"]), float(p["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        la, ln = conv(lat, lng)
        props = {"name": p.get("name") or p.get("title") or "",
                 "dist_m": p.get("distance_m") or (round(hav(clat, clng, lat, lng)) if clat else None)}
        for k in ("segment", "cost", "rating", "source", "brand"):
            if p.get(k) is not None:
                props[k] = p[k]
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [ln, la]},
                      "properties": {k: v for k, v in props.items() if v is not None}})

    out = args.out
    os.makedirs(out, exist_ok=True)

    def dump(name, obj):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)

    dump("points.geojson", {"type": "FeatureCollection", "features": feats})

    cla, cln = conv(clat, clng)
    dump("center.geojson", {"type": "FeatureCollection", "features": [{
        "type": "Feature", "geometry": {"type": "Point", "coordinates": [cln, cla]},
        "properties": {"kind": "candidate_site", "scene": d.get("scene", ""),
                       "note": "候选点位中心"}}]})

    if radius > 0:
        pts = []
        for i in range(65):
            ang = 2 * math.pi * i / 64
            dlat = (radius * math.sin(ang)) / 111320.0
            dlng = (radius * math.cos(ang)) / (111320.0 * math.cos(math.radians(clat)))
            la, ln = conv(clat + dlat, clng + dlng)
            pts.append([ln, la])
        dump("isochrone.geojson", {"type": "FeatureCollection", "features": [{
            "type": "Feature", "geometry": {"type": "Polygon", "coordinates": [pts]},
            "properties": {"label": ring.get("label", "等时圈"), "radius_m": radius,
                           "method": "直线估算【估算】",
                           "warning": "非路网等时圈，遇江面/快速路会高估可达范围"}}]})

    note = f"""QGIS 打开步骤
========================================
1. 坐标系：本包坐标为 {args.crs.upper()}
   - crs=wgs84 → QGIS 新建工程用 EPSG:4326，直接加载
   - crs=gcj02 → 只适合叠高德/腾讯在线底图；叠政府 WGS84 数据会偏 300~600m

2. 拖入文件（或 图层 → 添加图层 → 添加矢量图层）
   points.geojson      竞品/POI 点，{len(feats)} 个
   center.geojson      候选点位
   isochrone.geojson   等时圈（{radius:.0f} 米，{ '直线估算【估算】' if radius else '未生成' }）

3. 建议叠加的数据（QGIS 侧补）
   - 控规用地 / 用地性质（政府开放数据，多为 SHP/GPKG）
   - 行政区与街道边界
   - 地铁站出入口（不是站点中心点！）
   - 小区边界与户数
   - 真实路网（用于 ORS Tools 插件做路网等时圈）

4. 出图前记得
   - 工程 CRS 统一为 EPSG:4326（或 4547 广州地方坐标）
   - 等时圈若用直线估算，图上必须标"估算"
   - 高德底图是 GCJ-02，与 WGS84 数据叠加会偏移，**不要混用**
"""
    with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as f:
        f.write(note)

    print(f"已导出到 {out}")
    print(f"  坐标系：{args.crs.upper()}")
    print(f"  points: {len(feats)} 个｜center: 1｜isochrone: {'有' if radius else '无'}（半径 {radius:.0f}m）")
    if args.crs == "wgs84":
        dl, dn = wgs84_to_gcj02(clat, clng)
        print(f"  校验：GCJ→WGS 修正量约 {hav(clat, clng, dl, dn):.0f} 米")


if __name__ == "__main__":
    main()
