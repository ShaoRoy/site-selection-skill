#!/usr/bin/env python3
"""
demand-fetch.py —— 需求侧指标自动采集（高德 POI，零付费接口）

用 POI 密度与业态结构替代「人口热力」，全部免费、可复核：
  · 住宅密度      住宅区 POI 数 / km²
  · 职住结构      写字楼 ÷ 住宅区      （>1 偏就业型，<1 偏居住型）
  · 配套成熟度    商场 + 学校 + 地铁站 数量
  · 消费力代理    精品咖啡 + 银行网点 + 高端餐饮 密度（比挂牌价更贴近真实消费）
  · 交通可达      最近地铁站/公交站距离

用法：
  python tools/demand-fetch.py "广州市天河区珠江新城" --radius 3000 --out survey/demand/GZ-ZJXC-001.json

注意：所有指标都是**代理**，不是实测人口。脚本会在输出里标注每个指标的代理性质。
"""

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

# Windows 控制台默认 GBK，遇到 km² 之类的字符会直接崩；强制 UTF-8 并容忍无法编码的字符
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

AMAP_KEY_FILE = str(Path.home() / ".dsh" / "secrets" / "amap.key")
API = "https://restapi.amap.com/v3"

# 请求间隔（秒）：高德个人 key 的 QPS 上限普遍很低，宁慢勿封
MIN_INTERVAL_S = 0.6

# 调用统计：用来判断「真的是 0 个」还是「接口其实没返回数据」
CALLS = {"total": 0, "ok": 0, "failed": 0, "retried": 0}

# 日配额累计：高德免费额度通常是 5000 次/日，跨点位批量跑会撞上限，
# 而撞上限的表现是「静默返回 0」，所以必须自己记账。
DAILY_LIMIT = 5000
QUOTA_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "survey", "demand", ".quota.json"
)


def load_quota():
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        with open(QUOTA_FILE, encoding="utf-8-sig") as f:
            q = json.load(f)
        if q.get("date") != today:
            return {"date": today, "calls": 0}
        return q
    except (FileNotFoundError, json.JSONDecodeError):
        return {"date": today, "calls": 0}


def save_quota(quota):
    os.makedirs(os.path.dirname(QUOTA_FILE), exist_ok=True)
    with open(QUOTA_FILE, "w", encoding="utf-8") as f:
        json.dump(quota, f, ensure_ascii=False)

# 类目扫描：关键词 → 输出字段
CATEGORY_SCANS = [
    ("住宅区", "residential"),
    ("写字楼", "office"),
    ("购物中心", "mall"),
    ("学校", "school"),
    ("地铁站", "metro"),
    ("公交站", "bus"),
    ("停车场", "parking"),
]

# 消费力代理：品牌密度
BRAND_SCANS = [
    (["星巴克", "瑞幸咖啡", "库迪咖啡", "Manner"], "coffee"),
    (["招商银行", "中国银行", "建设银行", "工商银行"], "bank"),
    (["海底捞", "西贝", "太二"], "premium_dining"),
]


def read_key():
    key = os.environ.get("AMAP_API_KEY")
    if key:
        return key.strip()
    with open(AMAP_KEY_FILE, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    raise SystemExit("未找到高德 Key：设 AMAP_API_KEY 或写入 secrets/amap.key")


def api_get(path, params):
    """带节流与重试：高德个人 key 有 QPS 限制（常为 3 次/秒以内）。"""
    params = dict(params)
    params["key"] = read_key()
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"

    last_err = None
    for attempt in range(4):
        time.sleep(MIN_INTERVAL_S)
        CALLS["total"] += 1
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("status") == "1":
            CALLS["ok"] += 1
            return data
        last_err = data
        # 10021 = CUQPS_HAS_EXCEEDED_THE_LIMIT，退避后重试
        if str(data.get("infocode")) == "10021":
            CALLS["retried"] += 1
            time.sleep(1.2 * (attempt + 1))
            continue
        CALLS["failed"] += 1
        raise RuntimeError(f"高德接口失败：{data.get('info')} ({data.get('infocode')})")

    CALLS["failed"] += 1
    raise RuntimeError(f"高德接口持续限流：{last_err.get('info')} ({last_err.get('infocode')})")


def geocode(address, city):
    params = {"address": address}
    if city:
        params["city"] = city
    data = api_get("geocode/geo", params)
    codes = data.get("geocodes") or []
    if not codes:
        raise SystemExit(f"地理编码无结果：{address}")
    g = codes[0]
    lng, lat = (float(x) for x in g["location"].split(","))
    return lat, lng, g.get("level", "")


def count_poi(lat, lng, keyword, radius):
    """只取总数（count），翻页拿数量没必要——选址看的是量级。"""
    data = api_get("place/around", {
        "location": f"{lng},{lat}",
        "keywords": keyword,
        "radius": radius,
        "offset": 1,
        "page": 1,
        "extensions": "base",
    })
    try:
        return int(data.get("count") or 0)
    except (TypeError, ValueError):
        return 0


def nearest_poi(lat, lng, keyword, radius):
    """最近一个 POI 的名称与距离（高德返回的 distance 是字符串）。"""
    data = api_get("place/around", {
        "location": f"{lng},{lat}",
        "keywords": keyword,
        "radius": radius,
        "offset": 1,
        "page": 1,
        "sortrule": "distance",
        "extensions": "base",
    })
    pois = data.get("pois") or []
    if not pois:
        return None
    p = pois[0]
    try:
        d = int(p.get("distance") or -1)
    except (TypeError, ValueError):
        d = -1
    return {"name": p.get("name", ""), "distance_m": d}


def circle_area_km2(radius_m):
    return math.pi * (radius_m / 1000.0) ** 2


def density(count, area_km2):
    return round(count / area_km2, 1) if area_km2 > 0 else 0.0


def score_block(metrics, weights):
    """把各分项归一到 0~1 后加权。归一基准是经验上限，写进输出便于复核。"""
    total = 0.0
    used = 0.0
    detail = {}
    for key, (value, cap) in metrics.items():
        w = weights.get(key, 0)
        if value is None or w == 0:
            continue
        norm = max(0.0, min(1.0, value / cap)) if cap > 0 else 0.0
        detail[key] = {"value": value, "cap": cap, "normalized": round(norm, 3), "weight": w}
        total += norm * w
        used += w
    score = round((total / used) * 100, 1) if used > 0 else None
    return score, detail, round(used, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--city", default=None,
                    help="城市名。地址里已含城市名时可省略；跨城市使用时建议显式指定")
    ap.add_argument("--radius", type=int, default=3000)
    ap.add_argument("--inner-radius", type=int, default=1000)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    lat, lng, level = geocode(args.address, args.city)
    quota = load_quota()
    if quota["calls"] >= DAILY_LIMIT * 0.9:
        print(f"⛔ 今日已用 {quota['calls']} 次，接近高德日配额 {DAILY_LIMIT}：后续调用可能只返回 0，先换 Key 或等明日重置")
    area_km2 = circle_area_km2(args.radius)
    inner_km2 = circle_area_km2(args.inner_radius)
    print(f"坐标：{lat:.6f}, {lng:.6f}（匹配级别：{level}）｜扫描半径 {args.radius}m ≈ {area_km2:.2f} km²")

    counts = {}
    for kw, field in CATEGORY_SCANS:
        c = count_poi(lat, lng, kw, args.radius)
        counts[field] = c
        print(f"  {kw}：{c}")

    brand = {}
    for kws, field in BRAND_SCANS:
        brand[field] = sum(count_poi(lat, lng, kw, args.inner_radius) for kw in kws)
        print(f"  品牌[{field}]（{args.inner_radius}m）：{brand[field]}")

    nearest_metro = nearest_poi(lat, lng, "地铁站", args.radius)
    nearest_bus = nearest_poi(lat, lng, "公交站", args.inner_radius)

    # ---- 数据质量审计：区分「真的是 0 个」与「接口其实没返回数据」 ----
    zero_cats = [k for k, v in counts.items() if v == 0]
    zero_brands = [k for k, v in brand.items() if v == 0]
    total_probes = len(counts) + len(brand)
    zero_probes = len(zero_cats) + len(zero_brands)
    all_zero = total_probes > 0 and zero_probes == total_probes

    if CALLS["failed"] > 0:
        verdict, dq_note = "degraded", "有请求失败，部分指标缺失，本次结论不可用"
    elif all_zero:
        verdict, dq_note = "suspicious", "全部类目返回 0：不是当地没有 POI，而是接口没给数据——先查配额、Key 权限、坐标"
    elif total_probes > 0 and zero_probes / total_probes > 0.5:
        verdict, dq_note = "partial", "过半类目返回 0，可能配额不足或关键词与当地业态不符"
    else:
        verdict, dq_note = "ok", "全部类目均有返回"

    data_quality = {
        "api_calls": CALLS["total"],
        "ok": CALLS["ok"],
        "failed": CALLS["failed"],
        "retried": CALLS["retried"],
        "zero_categories": zero_cats,
        "zero_brands": zero_brands,
        "all_zero": all_zero,
        "verdict": verdict,
        "note": dq_note,
        "quota_hint": "高德 Web 服务 POI 检索个人额度常见 5000 次/日；本次消耗见 api_calls，跨点位批量分析时需自行累计",
        "daily_calls_before": quota["calls"],
        "daily_calls_after": quota["calls"] + CALLS["total"],
        "daily_limit": DAILY_LIMIT,
    }

    # ---- 代理指标 ----
    res_density = density(counts["residential"], area_km2)
    office_density = density(counts["office"], area_km2)
    job_housing = round(counts["office"] / counts["residential"], 2) if counts["residential"] else None
    amenity = counts["mall"] + counts["school"] + counts["metro"]
    coffee_density = density(brand["coffee"], inner_km2)
    bank_density = density(brand["bank"], inner_km2)
    premium_density = density(brand["premium_dining"], inner_km2)

    metrics = {
        "住宅密度": (res_density, 60.0),          # 60 个/km² 视为高密度（经验上限）
        "职住结构": (job_housing, 1.0),           # 1.0 = 职住平衡
        "配套成熟度": (amenity, 120.0),
        "咖啡密度": (coffee_density, 12.0),
        "银行密度": (bank_density, 15.0),
        "高端餐饮密度": (premium_density, 4.0),
    }
    weights = {
        "住宅密度": 0.28,
        "职住结构": 0.12,
        "配套成熟度": 0.15,
        "咖啡密度": 0.15,
        "银行密度": 0.15,
        "高端餐饮密度": 0.15,
    }
    score, detail, weight_used = score_block(metrics, weights)

    # 数据完整度：本次全部指标都来自高德 POI，人口/月售缺失
    completeness = 0.6
    confidence = "中" if completeness >= 0.6 else "低"

    result = {
        "store_id": None,
        "address": args.address,
        "center": {"lat": round(lat, 6), "lng": round(lng, 6)},
        "captured_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "radius_m": args.radius,
        "inner_radius_m": args.inner_radius,
        "area_km2": round(area_km2, 2),
        "poi_counts": counts,
        "brand_counts_inner": brand,
        "nearest": {"metro": nearest_metro, "bus": nearest_bus},
        "proxies": {
            "residential_density_per_km2": res_density,
            "office_density_per_km2": office_density,
            "job_housing_ratio": job_housing,
            "amenity_count": amenity,
            "coffee_density_per_km2": coffee_density,
            "bank_density_per_km2": bank_density,
            "premium_dining_density_per_km2": premium_density,
        },
        "demand_score": {
            "score": score,
            "max": 100,
            "weight_used": weight_used,
            "detail": detail,
            "note": "全部为高德 POI 代理指标，非实测人口；权重与上限为经验值，可经 params 覆盖",
        },
        "data_completeness": completeness,
        "confidence": confidence,
        "data_quality": data_quality,
        "missing": [
            "街道级常住人口（政府公报多为图片/PDF，无免费接口）",
            "二手房挂牌均价（链家/贝壳反爬，建议人工采样 10~15 个小区）",
            "同业态点评月售（人工采样 10~15 家，用于校验本指数）",
            "地铁站级日均客流（官方仅公开线级与前十站点）",
        ],
        "proxy_caveat": {
            "住宅密度": "高德对长租公寓收录偏多、老旧小区偏少 → 可能高估新盘片区",
            "消费力代理": "用品牌密度代替收入水平 → 商业旺但居民消费力未必高，需与房价交叉验证",
            "职住结构": "写字楼 POI 含共享办公，可能高估就业人口",
        },
    }

    print(f"\n需求强度：{score}/100（完整度 {completeness:.0%}，置信度{confidence}）")
    print(f"  住宅密度 {res_density}/km²｜职住比 {job_housing}｜配套 {amenity}")
    print(f"  咖啡 {coffee_density}/km²｜银行 {bank_density}/km²｜高端餐饮 {premium_density}/km²")
    if nearest_metro:
        print(f"  最近地铁：{nearest_metro['name']} {nearest_metro['distance_m']}m")

    # 数据质量：接口没返回数据时必须吵醒使用者，不能静默出 0
    mark = {"ok": "✅", "partial": "⚠️", "suspicious": "⛔", "degraded": "⛔"}[verdict]
    print(f"\n{mark} 数据质量：{verdict}｜调用 {CALLS['total']} 次（成功 {CALLS['ok']}，失败 {CALLS['failed']}，重试 {CALLS['retried']}）")
    print(f"  {dq_note}")
    if zero_cats or zero_brands:
        print(f"  返回 0 的类目：{'、'.join(zero_cats + zero_brands)}")
    if verdict != "ok":
        print("  ⚠️ 本次指标不可直接用于决策，先排查数据源再重跑")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"\n已写入：{args.out}")

    quota["calls"] += CALLS["total"]
    save_quota(quota)
    print(f"今日累计调用 {quota['calls']}/{DAILY_LIMIT}（记账文件：survey/demand/.quota.json）")
    return result


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 网络/接口异常要明确报出来，不静默
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
