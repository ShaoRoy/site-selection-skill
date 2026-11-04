#!/usr/bin/env python3
"""
walk-matrix.py —— 批量算「点位 → 目标」的步行距离/时间（高德步行路径规划）

解决的问题：OSM 路网缺天桥/地道/护栏，本地等时圈会穿墙。
高德有实地采集，它的步行路径是「现实中真能走通」的那条，比 OSM 准。

用法：
  # 1) 先生成待测目标模板（目标点坐标从 probe.json / 高德检索拿）
  python tools/walk-matrix.py --origin "广州市天河区珠江新城" --targets survey/barriers/targets.csv --out survey/barriers/GZ-ZJXC-001.csv

  # 2) targets.csv 每行：name,lat,lng,kind
  #    kind ∈ metro / competitor / community / bus / anchor
  #    坐标不知道时留空，脚本会用高德按名称检索（取第一个结果，需人工核对）

  # 3) 只测单个目标
  python tools/walk-matrix.py --origin "113.333776,23.119825" --to-name "猎德站A出口" --to "113.3342,23.1195"

输出 CSV 字段：
  to_name,kind,to_lat,to_lng,straight_m,walk_m,walk_min,detour_ratio,
  crossings_est,route_note,barrier_type,time_window,note

说明：
  · straight_m 为 haversine 直线距离；walk_m/walk_min 来自高德步行规划
  · crossings_est 为**推断值**：数路线上含「过街/人行横道/天桥/地下通道/斑马线」的步骤
  · barrier_type 按 detour_ratio 自动初判，**现场需人工复核**
"""

import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

API = "https://restapi.amap.com/v3"
KEY_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "secrets", "amap.key")
MIN_INTERVAL_S = 0.6
CALLS = {"total": 0, "ok": 0, "failed": 0}

CROSS_WORDS = ("过街", "人行横道", "斑马线", "天桥", "地下通道", "通道", "过马路")

FIELDS = [
    "to_name", "kind", "to_lat", "to_lng", "straight_m", "walk_m", "walk_min",
    "detour_ratio", "crossings_est", "route_note", "barrier_type", "time_window", "note",
]


def read_key():
    key = os.environ.get("AMAP_API_KEY")
    if key:
        return key.strip()
    with open(KEY_FILE, encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                return line.strip()
    raise SystemExit("未找到高德 Key：设 AMAP_API_KEY 或写入 secrets/amap.key")


def api_get(path, params):
    params = dict(params)
    params["key"] = read_key()
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(4):
        time.sleep(MIN_INTERVAL_S)
        CALLS["total"] += 1
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("status") == "1":
            CALLS["ok"] += 1
            return data
        last = data
        if str(data.get("infocode")) == "10021":
            time.sleep(1.2 * (attempt + 1))
            continue
        CALLS["failed"] += 1
        raise RuntimeError(f"高德接口失败：{data.get('info')} ({data.get('infocode')})")
    CALLS["failed"] += 1
    raise RuntimeError(f"持续限流：{last.get('info')}")


def geocode(address, city="广州"):
    data = api_get("geocode/geo", {"address": address, "city": city})
    codes = data.get("geocodes") or []
    if not codes:
        raise SystemExit(f"地理编码无结果：{address}")
    lng, lat = (float(x) for x in codes[0]["location"].split(","))
    return lat, lng


def search_poi(name, city="广州"):
    """名称 → 坐标（取第一个）。结果需人工核对，尤其地铁站要写具体出口。"""
    data = api_get("place/text", {"keywords": name, "city": city, "offset": 1, "page": 1})
    pois = data.get("pois") or []
    if not pois:
        return None
    lng, lat = (float(x) for x in pois[0]["location"].split(","))
    return lat, lng, pois[0].get("name", "")


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def walking(origin, dest):
    """返回 (距离米, 分钟, 过街次数估计, 路线摘要)。"""
    data = api_get("direction/walking", {
        "origin": f"{origin[1]},{origin[0]}",
        "destination": f"{dest[1]},{dest[0]}",
    })
    paths = (data.get("route") or {}).get("paths") or []
    if not paths:
        return None
    p = paths[0]
    dist = float(p.get("distance") or 0)
    dur = float(p.get("duration") or 0)
    steps = p.get("steps") or []
    crossings = 0
    for s in steps:
        text = f"{s.get('instruction', '')}"
        if any(w in text for w in CROSS_WORDS):
            crossings += 1
    brief = " → ".join(
        (s.get("instruction") or "").split(";")[0][:18] for s in steps[:3]
    )
    return dist, dur / 60.0, crossings, brief


def guess_barrier(ratio):
    if ratio is None:
        return ""
    if ratio <= 1.25:
        return ""
    if ratio <= 1.6:
        return "psych"
    if ratio <= 2.5:
        return "flyover"
    return "fence"


def parse_latlng(text):
    """接受 'lat,lng' 或 'lng,lat'：第一个数 >90 必是经度，自动识别。"""
    a, b = (float(x) for x in text.split(","))
    return (a, b) if abs(a) <= 90 else (b, a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--origin", required=True, help="起点：地址或坐标（lat,lng 或 lng,lat 皆可）")
    ap.add_argument("--targets", help="目标 CSV（name,lat,lng,kind）")
    ap.add_argument("--to-name")
    ap.add_argument("--to", help="单个目标坐标")
    ap.add_argument("--kind", default="")
    ap.add_argument("--city", default="广州")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if "," in args.origin and all(ch.isdigit() or ch in ".-," for ch in args.origin):
        olat, olng = parse_latlng(args.origin)
    else:
        olat, olng = geocode(args.origin, args.city)
    print(f"起点：{olat:.6f},{olng:.6f}")

    targets = []
    if args.to and args.to_name:
        tlat, tlng = parse_latlng(args.to)
        targets.append({"name": args.to_name, "lat": tlat, "lng": tlng, "kind": args.kind})
    if args.targets and os.path.exists(args.targets):
        with open(args.targets, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                name = (row.get("name") or "").strip()
                if not name:
                    continue
                lat = (row.get("lat") or "").strip()
                lng = (row.get("lng") or "").strip()
                if not lat or not lng:
                    hit = search_poi(name, args.city)
                    if hit is None:
                        print(f"  ⚠️ 检索不到：{name}（跳过）")
                        continue
                    lat, lng, _ = hit
                targets.append({
                    "name": name, "lat": float(lat), "lng": float(lng),
                    "kind": (row.get("kind") or "").strip(),
                })
    if not targets:
        raise SystemExit("没有目标：给 --targets 或 --to/--to-name")

    print(f"目标 {len(targets)} 个，开始算步行路径…")
    rows = []
    for t in targets:
        straight = haversine_m(olat, olng, t["lat"], t["lng"])
        try:
            res = walking((olat, olng), (t["lat"], t["lng"]))
        except RuntimeError as exc:
            print(f"  ⚠️ {t['name']}：{exc}")
            res = None
        if res is None:
            walk_m, walk_min, cross, brief = -1, -1, -1, "无步行路径"
            ratio = None
        else:
            walk_m, walk_min, cross, brief = res
            ratio = round(walk_m / straight, 2) if straight > 0 else None
        barrier = guess_barrier(ratio)
        rows.append({
            "to_name": t["name"], "kind": t["kind"],
            "to_lat": round(t["lat"], 6), "to_lng": round(t["lng"], 6),
            "straight_m": round(straight, 0), "walk_m": round(walk_m, 0),
            "walk_min": round(walk_min, 1), "detour_ratio": ratio if ratio is not None else "",
            "crossings_est": cross, "route_note": brief,
            "barrier_type": barrier, "time_window": "all", "note": "自动生成，现场需复核",
        })
        flag = "" if barrier == "" else f"  ← 初判 {barrier}"
        print(f"  {t['name']}: 直线 {straight:.0f}m → 步行 {walk_m:.0f}m / {walk_min:.1f}分（{ratio if ratio else '—'}×）{flag}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    blocked = [r for r in rows if r["barrier_type"]]
    print(f"\n已写入 {args.out}｜共 {len(rows)} 条，其中 {len(blocked)} 条初判有阻断")
    print(f"接口调用 {CALLS['total']} 次（成功 {CALLS['ok']}）")
    print("提醒：barrier_type 为按绕行倍数自动初判，**现场必须复核**——导航绕远 ≠ 人过不去。")


if __name__ == "__main__":
    main()
