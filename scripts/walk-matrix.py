#!/usr/bin/env python3
"""
walk-matrix.py —— 批量算「点位 → 目标」的步行距离/时间

支持两家：
  --provider tencent  腾讯位置服务（默认）
  --provider amap     高德开放平台

── 腾讯配额实测（2026-11-05，控制台核对 + 接口实测）────────────────
  距离矩阵 /ws/distance/v1/matrix     6000 次/日 ｜ 并发 5 对/秒 ｜ 实测 1×5 通过、1×6 失败
  步行路线 /ws/direction/v1/walking/  6000 次/日 ｜ 并发 5 次/秒 ｜ 1 对/请求
  地点搜索 /ws/place/v1/search         **200 次/日** ｜ 并发 5 次/秒
  周边推荐 /ws/place/v1/here           **200 次/日** ｜ 并发 5 次/秒
  → 限制单位是 **OD 对数**，不是请求数（1×6 一次请求也会 120）
  → 官方文档写的「一对多 1×200」是认证后额度，当前离线 Key 实际只有 5 对/批
  → 真瓶颈是 POI 检索 200/日，步行距离额度（6000）反而宽裕

  吞吐参考（250 个目标）：
    matrix    : 50 次请求 × 1.2s ≈ 1 分钟
    direction : 250 次请求 × 1.2s ≈ 5 分钟  

两种算法：
  --method direction  逐条路线规划，**带 steps**，能数过街设施（默认用于小批量）
  --method matrix     距离矩阵，一次算 1×200，**不返回 steps**（用于大批量粗筛）
  --method auto       默认。腾讯 + 目标 ≥10 个时走 matrix，否则走 direction

腾讯步行 steps 带结构化枚举（高德只能靠文本匹配猜）：
  steps[].type  0 普通道路 / 1 过街天桥 / 2 地下通道 / 3 人行横道
  → crossings_est 与 facility_mix 直接读枚举，不猜文字

用法：
  # 逐条精细（带过街设施）
  python walk-matrix.py --origin "广州市荔湾区扬韬广场" \
      --targets survey/targets.csv --out out/walk.csv

  # 批量粗筛（1×200 一次算完，无过街设施）
  python walk-matrix.py --origin "23.124734,113.244246" \
      --targets survey/targets.csv --out out/walk.csv --method matrix

  # 只测单个目标
  python walk-matrix.py --origin "113.333776,23.119825" \
      --to-name "猎德站A出口" --to "113.3342,23.1195" --out out/one.csv

targets.csv 每行：name,lat,lng,kind
  坐标不知道时留空，脚本会按 name 检索（取第一个结果，需人工核对）

输出 CSV 字段：
  to_name,kind,to_lat,to_lng,straight_m,walk_m,walk_min,detour_ratio,
  crossings_est,facility_mix,route_note,barrier_type,time_window,note,
  provider,method

说明：
  · straight_m 为 haversine 直线距离；walk_m/walk_min 来自路网规划
  · crossings_est 为过街设施数量（腾讯读 type 枚举；高德为文本匹配的推断值）
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

# ── 服务商常量 ────────────────────────────────────────────────────────────
TENCENT_API = "https://apis.map.qq.com"
TENCENT_SECRET = os.path.join(os.path.expanduser("~"), ".dsh", "secrets", "tencent.key")
TENCENT_WALK = "/ws/direction/v1/walking/"
TENCENT_MATRIX = "/ws/distance/v1/matrix"
TENCENT_GEOCODE = "/ws/geocoder/v1/"
TENCENT_PLACE = "/ws/place/v1/search"
MATRIX_MAX_TO = 200          # 腾讯文档上限（企业认证后可用）
MATRIX_SAFE_BATCH = 5        # 本 Key 实测安全批次（并发 5 对/秒）；--matrix-batch 可覆盖

AMAP_API = "https://restapi.amap.com/v3"
AMAP_SECRET = os.path.join(os.path.expanduser("~"), ".dsh", "secrets", "amap.key")

# 调用间隔：腾讯免费 Key 的 QPS 明显低于高德。
# 实测：腾讯连续 0.6s 间隔会返回 status=120（每秒请求量超限），1.2s 间隔才稳定。
INTERVAL_S = {"tencent": 1.2, "amap": 0.6}
CALLS = {"total": 0, "ok": 0, "failed": 0}


class TencentRateLimited(RuntimeError):
    """腾讯 status=120：每秒请求量超限。

    实测限额单位是 **OD 对数**，不是请求数：
      1×4 通过、1×5 通过、1×6 失败
      连发 6 个 1×1 也全失败（共用同一秒的 5 对额度）
    官方文档写一对多 1×200，那是企业认证后的额度；本 Key 实测只有 5 对/秒（控制台并发量 5/5）。
    """

# 腾讯 steps[].type：步行设施类型
FACILITY = {0: "普通道路", 1: "过街天桥", 2: "地下通道", 3: "人行横道"}
CROSS_TYPES = (1, 2, 3)      # 有这三类才算一次「过街」

# 高德只能靠文本匹配（保留，但标注为推断值）
CROSS_WORDS = ("过街", "人行横道", "斑马线", "天桥", "地下通道", "通道", "过马路")

FIELDS = [
    "to_name", "kind", "to_lat", "to_lng", "straight_m", "walk_m", "walk_min",
    "detour_ratio", "crossings_est", "facility_mix", "route_note",
    "barrier_type", "time_window", "note", "provider", "method",
]


# ── 密钥 ──────────────────────────────────────────────────────────────────
def read_key(provider):
    env_name = "TENCENT_MAP_KEY" if provider == "tencent" else "AMAP_API_KEY"
    key = os.environ.get(env_name)
    if key and key.strip():
        return key.strip()
    path = TENCENT_SECRET if provider == "tencent" else AMAP_SECRET
    if not os.path.exists(path):
        raise SystemExit(
            f"未找到 {'腾讯' if provider == 'tencent' else '高德'} Key："
            f"设 {env_name} 或写入 {path}"
        )
    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith("#"):
                return s
    raise SystemExit(f"Key 文件为空：{path}")


# ── HTTP ─────────────────────────────────────────────────────────────────
def _http_json(url, interval=0.6):
    last = None
    for attempt in range(4):
        time.sleep(interval)
        CALLS["total"] += 1
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:            # 网络层错误也重试
            last = exc
            time.sleep(1.2 * (attempt + 1))
    CALLS["failed"] += 1
    raise RuntimeError(f"请求持续失败：{last}")


def tencent_call(path, params):
    q = dict(params)
    q["key"] = read_key("tencent")
    url = f"{TENCENT_API}{path}?{urllib.parse.urlencode(q)}"
    last = None
    # 腾讯成功是 status == 0（数值），与高德的 status == "1"（字符串）相反
    for attempt in range(5):
        data = _http_json(url, INTERVAL_S["tencent"])
        if data.get("status") == 0:
            CALLS["ok"] += 1
            return data
        last = data
        if data.get("status") == 120:       # 每秒请求量超限，退避重试（2/4/6/8s）
            time.sleep(2.0 * (attempt + 1))
            continue
        break
    CALLS["failed"] += 1
    st = (last or {}).get("status")
    if st == 120:
        raise TencentRateLimited(f"status=120 {((last or {}).get('message') or '')}")
    raise RuntimeError(
        f"腾讯接口失败：{(last or {}).get('message')} (status={st})"
    )


def amap_call(path, params):
    q = dict(params)
    q["key"] = read_key("amap")
    data = _http_json(f"{AMAP_API}/{path}?{urllib.parse.urlencode(q)}", INTERVAL_S["amap"])
    if str(data.get("status")) == "1":
        CALLS["ok"] += 1
        return data
    # 高德限流码 10021 重试由上层兜底
    CALLS["failed"] += 1
    raise RuntimeError(f"高德接口失败：{data.get('info')} ({data.get('infocode')})")


# ── 坐标 / 单位 ───────────────────────────────────────────────────────────
def parse_latlng(text):
    """接受 'lat,lng' 或 'lng,lat'：第一个数 >90 必是经度，自动识别。"""
    a, b = (float(x) for x in text.split(","))
    return (a, b) if abs(a) <= 90 else (b, a)


def tencent_coord(lat, lng):
    """腾讯要「纬度,经度」；高德要「经度,纬度」。写反会算到几千公里外且不报错。"""
    return f"{lat},{lng}"


def amap_coord(lat, lng):
    return f"{lng},{lat}"


def plausible_walk(minutes, distance_m):
    """步行速度 2~7 km/h 之外，判为单位搞错（matrix 秒 vs direction 分钟）。"""
    if minutes <= 0 or distance_m <= 0:
        return True
    speed_kmh = distance_m / minutes * 60 / 1000
    return 2.0 <= speed_kmh <= 7.0


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ── 地理编码 / POI 检索 ───────────────────────────────────────────────────
def geocode(address, city, provider):
    if provider == "tencent":
        d = tencent_call(TENCENT_GEOCODE, {"address": address, "region": city})
        loc = (d.get("result") or {}).get("location") or {}
        if "lat" not in loc:
            raise SystemExit(f"地理编码无结果：{address}")
        return float(loc["lat"]), float(loc["lng"])
    d = amap_call("geocode/geo", {"address": address, "city": city})
    codes = d.get("geocodes") or []
    if not codes:
        raise SystemExit(f"地理编码无结果：{address}")
    lng, lat = (float(x) for x in codes[0]["location"].split(","))
    return lat, lng


def search_poi(name, city, provider):
    """名称 → (lat, lng, 命中名)。取第一个结果，需人工核对。"""
    if provider == "tencent":
        d = tencent_call(TENCENT_PLACE, {
            "keyword": name, "boundary": f"region({city},0)",
            "page_size": 1, "page_index": 1,
        })
        data = d.get("data") or []
        if not data:
            return None
        loc = data[0].get("location") or {}
        if "lat" not in loc:
            return None
        return float(loc["lat"]), float(loc["lng"]), data[0].get("title", "")
    d = amap_call("place/text", {"keywords": name, "city": city, "offset": 1, "page": 1})
    pois = d.get("pois") or []
    if not pois:
        return None
    lng, lat = (float(x) for x in pois[0]["location"].split(","))
    return lat, lng, pois[0].get("name", "")


# ── 步行：腾讯 ───────────────────────────────────────────────────────────
def walk_tencent_detail(origin, dest):
    """逐条路线规划，带 steps。返回 dict；无路线返回 None。"""
    d = tencent_call(TENCENT_WALK, {
        "from": tencent_coord(origin[0], origin[1]),
        "to": tencent_coord(dest[0], dest[1]),
    })
    routes = (d.get("result") or {}).get("routes") or []
    if not routes:
        return None
    r0 = routes[0]
    dist = float(r0.get("distance") or 0)
    # 腾讯 direction/walking 的 duration 单位是**分钟**（实测 1160m → 18）
    minutes = float(r0.get("duration") or 0)
    steps = r0.get("steps") or []

    crossings = 0
    mix = {}
    for s in steps:
        t = s.get("type")
        if isinstance(t, int) and t in CROSS_TYPES:
            crossings += 1
            mix[t] = mix.get(t, 0) + 1
    facility_mix = "、".join(
        f"{FACILITY[t]}×{n}" for t, n in sorted(mix.items())
    ) if mix else "全程无过街设施"

    brief = " → ".join(
        (s.get("instruction") or "").split("；")[0][:18] for s in steps[:3]
    )
    return {
        "dist": dist, "minutes": minutes, "crossings": crossings,
        "facility_mix": facility_mix, "brief": brief,
        "method": "direction", "detail": True,
    }


def walk_tencent_matrix(origin, targets, batch=None):
    """1×N 距离矩阵，**自适应分批**。

    腾讯的限额单位是 OD 对数（实测免费 Key 为 5 对/秒），不是请求数，
    而官方文档写的 1×200 是认证后额度。所以这里从 MATRIX_MAX_TO 起试，
    撞到 status=120 就把批次减半重试，直到成功或降到 1。

    返回 (结果列表, 探测到的单批上限 or None)。
    注意：矩阵**不返回 steps**，crossings_est=-1、facility_mix 为空。
    """
    out = [None] * len(targets)
    start_batch = batch if batch and batch > 0 else MATRIX_SAFE_BATCH
    size = min(start_batch, max(1, len(targets)))
    discovered = None          # 实测单批上限（对数）
    i = 0
    while i < len(targets):
        chunk = targets[i:i + size]
        tos = ";".join(tencent_coord(t["lat"], t["lng"]) for t in chunk)
        try:
            d = tencent_call(TENCENT_MATRIX, {
                "mode": "walking",
                "from": tencent_coord(origin[0], origin[1]),
                "to": tos,
            })
        except TencentRateLimited:
            if size <= 1:
                raise                       # 1 对都超限，放弃矩阵
            size = max(1, size // 2)
            discovered = size
            print(f"  ⚠️ 矩阵批次触发限流，缩到 {size} 对/批"
                  f"（腾讯限额按 OD 对数计，免费 Key 通常 5 对/秒）")
            continue

        rows = (d.get("result") or {}).get("rows") or []
        els = (rows[0].get("elements") if rows else None) or []
        if discovered is None and len(chunk) > 1:
            discovered = len(chunk)
        for k, e in enumerate(els):
            if i + k >= len(out):
                break
            dist = float(e.get("distance") or 0)
            dur_raw = float(e.get("duration") or 0)
            # 矩阵 duration 单位是**秒**（实测 1132m → 1029s，约 4.0 km/h）
            minutes = dur_raw / 60.0
            if not plausible_walk(minutes, dist):
                minutes = dur_raw        # 万一单位变了，退回按分钟并留证据
                print(f"  ⚠️ 矩阵 duration 单位异常（{dur_raw} 对 {dist:.0f}m），已按分钟处理")
            out[i + k] = {
                "dist": dist, "minutes": minutes, "crossings": -1,
                "facility_mix": "", "brief": "矩阵批量（无 steps）",
                "method": "matrix", "detail": False,
            }
        i += len(chunk)
    return out, discovered


# ── 步行：高德 ───────────────────────────────────────────────────────────
def walk_amap_detail(origin, dest):
    d = amap_call("direction/walking", {
        "origin": amap_coord(origin[0], origin[1]),
        "destination": amap_coord(dest[0], dest[1]),
    })
    paths = (d.get("route") or {}).get("paths") or []
    if not paths:
        return None
    p = paths[0]
    dist = float(p.get("distance") or 0)
    # 高德 direction/walking 的 duration 单位是**秒**（实测 712m → 570，约 4.5 km/h）
    minutes = float(p.get("duration") or 0) / 60.0
    steps = p.get("steps") or []
    crossings = 0
    for s in steps:
        text = f"{s.get('instruction', '')}"
        if any(w in text for w in CROSS_WORDS):
            crossings += 1
    brief = " → ".join(
        (s.get("instruction") or "").split(";")[0][:18] for s in steps[:3]
    )
    return {
        "dist": dist, "minutes": minutes, "crossings": crossings,
        "facility_mix": "文本匹配推断（高德无结构化字段）",
        "brief": brief, "method": "direction", "detail": True,
    }


# ── 阻断初判 ─────────────────────────────────────────────────────────────
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


# ── 主流程 ───────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--origin", required=True, help="起点：地址或坐标（lat,lng 或 lng,lat 皆可）")
    ap.add_argument("--targets", help="目标 CSV（name,lat,lng,kind）")
    ap.add_argument("--to-name")
    ap.add_argument("--to", help="单个目标坐标")
    ap.add_argument("--kind", default="")
    ap.add_argument("--city", default="广州")
    ap.add_argument("--out", required=True)
    ap.add_argument("--provider", choices=["tencent", "amap"], default="tencent")
    ap.add_argument("--method", choices=["auto", "direction", "matrix"], default="auto",
                    help="auto：腾讯且目标≥10 走 matrix，否则 direction（matrix 无 steps）")
    ap.add_argument("--batch-threshold", type=int, default=10,
                    help="auto 模式切 matrix 的目标数阈值，默认 10")
    ap.add_argument("--matrix-batch", type=int, default=None,
                    help=f"矩阵单批对数，默认 {MATRIX_SAFE_BATCH}（实测安全值）；企业认证后可调大到 200")
    args = ap.parse_args()

    # 高德没有 matrix 实现，显式拒绝以免静默降级
    if args.provider == "amap" and args.method == "matrix":
        raise SystemExit("高德未实现 matrix；请用 --method direction（或 --provider tencent）")

    if "," in args.origin and all(ch.isdigit() or ch in ".-," for ch in args.origin):
        olat, olng = parse_latlng(args.origin)
    else:
        olat, olng = geocode(args.origin, args.city, args.provider)
    print(f"起点：{olat:.6f},{olng:.6f}（{args.provider}）")

    # 目标解析
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
                    hit = search_poi(name, args.city, args.provider)
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

    # 选算法
    method = args.method
    if method == "auto":
        method = "matrix" if (args.provider == "tencent" and len(targets) >= args.batch_threshold) else "direction"

    print(f"目标 {len(targets)} 个｜算法 {method}"
          + ("（矩阵批量，无过街设施明细）" if method == "matrix" else "（逐条，带 steps）"))

    # 批量矩阵一次算完
    batch = None
    if method == "matrix":
        try:
            batch, limit = walk_tencent_matrix((olat, olng), targets, args.matrix_batch)
            if limit is not None:
                print(f"  实测本 Key 矩阵单批上限：{limit} 对"
                      f"（官方 1×{MATRIX_MAX_TO} 需企业认证提额）")
        except TencentRateLimited as exc:
            print(f"  ⚠️ 矩阵连 1 对都超限，回退逐条：{exc}")
            method = "direction"
            batch = None
        except RuntimeError as exc:
            print(f"  ⚠️ 矩阵失败，回退逐条：{exc}")
            method = "direction"
            batch = None

    rows = []
    for i, t in enumerate(targets):
        straight = haversine_m(olat, olng, t["lat"], t["lng"])
        res = batch[i] if batch is not None else None
        if res is None:
            try:
                res = (walk_tencent_detail((olat, olng), (t["lat"], t["lng"]))
                       if args.provider == "tencent"
                       else walk_amap_detail((olat, olng), (t["lat"], t["lng"])))
            except RuntimeError as exc:
                print(f"  ⚠️ {t['name']}：{exc}")
                res = None

        if res is None:
            walk_m, walk_min, cross = -1, -1, -1
            mix, brief = "无步行路径", "无步行路径"
            ratio = None
            actual_method = method
        else:
            walk_m, walk_min, cross = res["dist"], res["minutes"], res["crossings"]
            mix, brief = res["facility_mix"], res["brief"]
            actual_method = res["method"]
            ratio = round(walk_m / straight, 2) if straight > 0 else None
            # 单位自检：不合理的步行速度要立刻暴露，不能静默出数
            if walk_m > 0 and not plausible_walk(walk_min, walk_m):
                print(f"  ⚠️ {t['name']}：步行速度异常（{walk_m:.0f}m / {walk_min:.1f}分），请查单位")

        barrier = guess_barrier(ratio)
        rows.append({
            "to_name": t["name"], "kind": t["kind"],
            "to_lat": round(t["lat"], 6), "to_lng": round(t["lng"], 6),
            "straight_m": round(straight, 0), "walk_m": round(walk_m, 0),
            "walk_min": round(walk_min, 1),
            "detour_ratio": ratio if ratio is not None else "",
            "crossings_est": cross, "facility_mix": mix, "route_note": brief,
            "barrier_type": barrier, "time_window": "all",
            "note": "自动生成，现场需复核",
            "provider": args.provider, "method": actual_method,
        })
        flag = "" if barrier == "" else f"  ← 初判 {barrier}"
        print(f"  {t['name']}: 直线 {straight:.0f}m → 步行 {walk_m:.0f}m / {walk_min:.1f}分"
              f"（{ratio if ratio else '—'}×）{flag}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    blocked = [r for r in rows if r["barrier_type"]]
    print(f"\n已写入 {args.out}｜共 {len(rows)} 条，其中 {len(blocked)} 条初判有阻断")
    print(f"接口调用 {CALLS['total']} 次（成功 {CALLS['ok']}，失败 {CALLS['failed']}）")
    print("提醒：barrier_type 为按绕行倍数自动初判，**现场必须复核**——导航绕远 ≠ 人过不去。")
    if method == "matrix":
        print("注意：matrix 模式不返回 steps，crossings_est=-1、facility_mix 为空。"
              "要过街设施明细请用 --method direction。")


if __name__ == "__main__":
    main()
