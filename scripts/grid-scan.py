#!/usr/bin/env python3
"""
grid-scan.py —— 城市网格扫描：锚点（地铁站 + 商场）→ 候选点位排序

回答「不给具体商圈时，先去哪几个地方找铺」。
只回答「人多不多、竞争挤不挤」；铺位、租金、层高、排烟属第 2、3 筛。

额度策略：
  默认 --dry-run，只估算不执行。--execute 才真跑。
  预估 > 500 次要 --yes；> 1500 次直接拒绝。
  --rescore 复用上次采集缓存，0 次调用重新打分。

用法：
  python tools/grid-scan.py --city 广州 --district 天河 --format 粤菜大店 -dry-run
  python tools/grid-scan.py --city 广州 --district 天河 --format 粤菜大店 --execute
  python tools/grid-scan.py --city 广州 --district 天河 --rescore     # 改权重后重排
"""

import argparse
import csv
import importlib.util
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
API = "https://restapi.amap.com/v3"
KEY_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "secrets", "amap.key")
GRID_DIR = os.path.join(ROOT, "out", "grid")

MIN_INTERVAL_S = 0.6
DAILY_LIMIT = 5000
CALLS = {"total": 0, "ok": 0, "failed": 0}

CELL_DEG = 0.05
CELL_RADIUS_M = 4000
MAX_PAGES = 3
ANCHOR_MERGE_M = 300
CELLAR_KEYWORDS = {"residential": "住宅区", "office": "写字楼", "coffee": "星巴克", "bank": "银行"}
DEFAULT_COMPETITORS = "粤菜,茶楼,烧腊"


# ────────────────────────── 基础工具 ──────────────────────────
def read_key():
    key = os.environ.get("AMAP_API_KEY")
    if key:
        return key.strip()
    with open(KEY_FILE, encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                return line.strip()
    raise SystemExit("未找到高德 Key")


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
        raise RuntimeError(f"高德失败：{data.get('info')} ({data.get('infocode')})")
    CALLS["failed"] += 1
    raise RuntimeError(f"持续限流：{last.get('info')}")


def haversine_m(a1, o1, a2, o2):
    r = 6371000.0
    p1, p2 = math.radians(a1), math.radians(a2)
    dp, dl = p2 - p1, math.radians(o2 - o1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def parse_loc(text):
    lng, lat = (float(x) for x in text.split(","))
    return lat, lng


# ────────────────────────── 采集 ──────────────────────────
def fetch_keyword(keyword, city, district=None, max_pages=8):
    out, page = [], 1
    while page <= max_pages:
        data = api_get("place/text", {
            "keywords": keyword, "city": city, "offset": 25, "page": page, "extensions": "base",
        })
        pois = data.get("pois") or []
        for p in pois:
            if not p.get("location"):
                continue
            ad = p.get("adname") or ""
            if district and district not in ad:
                continue
            lat, lng = parse_loc(p["location"])
            out.append({"name": p.get("name", ""), "lat": lat, "lng": lng, "adname": ad})
        if len(pois) < 25:
            break
        page += 1
    return out


def fetch_cell(kw, clat, clng):
    out = []
    for page in range(1, MAX_PAGES + 1):
        data = api_get("place/around", {
            "location": f"{clng},{clat}", "keywords": kw, "radius": CELL_RADIUS_M,
            "offset": 25, "page": page, "extensions": "base",
        })
        pois = data.get("pois") or []
        for p in pois:
            if p.get("location"):
                lat, lng = parse_loc(p["location"])
                out.append({"name": p.get("name", ""), "lat": lat, "lng": lng})
        if len(pois) < 25:
            break
    return out


def cells_for(bbox):
    la1, ln1, la2, ln2 = bbox
    la = min(la1, la2)
    cells = []
    while la < max(la1, la2):
        cur = min(ln1, ln2)
        while cur < max(ln1, ln2):
            cells.append((round(la + CELL_DEG / 2, 6), round(cur + CELL_DEG / 2, 6)))
            cur += CELL_DEG
        la += CELL_DEG
    return cells


# ────────────────────────── 打分与输出 ──────────────────────────
def to100(vals):
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return [50.0 for _ in vals]
    return [(v - lo) / (hi - lo) * 100 for v in vals]


def score_and_output(args, merged, pool, comp_pool):
    def near(rows, a, r):
        return sum(1 for p in rows if haversine_m(a["lat"], a["lng"], p["lat"], p["lng"]) <= r)

    area_km2 = math.pi * (args.radius / 1000.0) ** 2
    raw = []
    for a in merged:
        res = near(pool["residential"], a, args.radius)
        off = near(pool["office"], a, args.radius)
        cof = near(pool["coffee"], a, args.radius)
        ban = near(pool["bank"], a, args.radius)
        comp = near(comp_pool, a, args.radius) if comp_pool else 0
        res_d = res / area_km2
        job = (off / res) if res > 0 else 0.0
        raw.append({
            "name": a["name"], "kind": a["kind"],
            "lat": round(a["lat"], 6), "lng": round(a["lng"], 6),
            "residential": res, "office": off, "coffee": cof, "bank": ban, "competitor": comp,
            "d_raw": res_d * 0.30 + min(job, 2.0) * 0.20 + (cof / area_km2) * 0.25 + (cof + ban) * 0.25,
            "p_raw": float(comp),
        })

    d_norm = to100([x["d_raw"] for x in raw])
    p_norm = to100([x["p_raw"] for x in raw])
    k = args.k
    scored = []
    for i, x in enumerate(raw):
        scored.append({**x,
                       "demand": round(d_norm[i], 1),
                       "pressure": round(p_norm[i], 1),
                       "total": round(d_norm[i] - p_norm[i] * k, 1)})

    scored.sort(key=lambda x: -x["total"])
    top = scored[: args.top]
    n = len(top)
    for i, s in enumerate(top, 1):
        s["rank"] = i
        s["grade"] = "A" if i <= max(1, round(n * 0.1)) else "B" if i <= max(2, round(n * 0.33)) else "C"
        d, p = s["demand"], s["pressure"]
        if d >= 70 and p >= 70:
            s["reason"] = "需求强但竞争激烈，得靠差异化或错位竞争"
        elif d >= 70 and p < 70:
            s["reason"] = "需求强且竞争温和，优先考察"
        elif d < 40 and p < 30:
            s["reason"] = "竞争温和但需求一般，适合细分业态或差异化打法"
        elif d < 40 and p >= 70:
            s["reason"] = "需求一般还竞争激烈，除非租金极低否则不建议"
        else:
            s["reason"] = "需求与竞争均属中位，看具体铺位条件"

    os.makedirs(GRID_DIR, exist_ok=True)
    out_path = args.out or os.path.join(GRID_DIR, f"candidates-{args.city}-{args.district or 'all'}.csv")
    fields = ["rank", "grade", "name", "kind", "lat", "lng", "total", "demand", "pressure",
              "residential", "office", "coffee", "bank", "competitor", "reason"]
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(top)

    print(f"\n== 候选点位 Top {len(top)}（k={k} 分数为本批内相对值）==")
    print(f"{'#':>2} {'档':<2} {'名称':<20} {'类型':<6} {'需求':>5} {'竞争':>5} {'综合':>6}")
    for s in top[:15]:
        print(f"{s['rank']:>2} {s['grade']:<2} {s['name'][:20]:<20} {s['kind']:<6} "
              f"{s['demand']:>5} {s['pressure']:>5} {s['total']:>6}")
    if len(top) > 15:
        print(f"…（共 {len(top)} 个，见 CSV）")

    # 回写 registry
    try:
        spec = importlib.util.spec_from_file_location("gridreg", os.path.join(TOOLS, "grid-registry.py"))
        reg = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reg)
        data = reg.load()
        for s in top:
            reg.upsert(data, reg.grid_id(s["lat"], s["lng"]),
                       city=args.city, district=args.district or "",
                       status="已扫描", score=s["total"], tool="grid-scan",
                       event=f"扫描：{s['name']}（{s['grade']} 档）")
        reg.save(data)
        print(f"\nregistry 已更新：{len(top)} 个网格标记为「已扫描」")
    except Exception as exc:
        print(f"⚠️ registry 回写失败：{exc}")

    print(f"\n候选表：{out_path}")
    print('下一步：挑 A 档跑 `node tools/run-site.mjs --address="<名称>" --survey=...`')
    return top


# ────────────────────────── 主流程 ──────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--district")
    ap.add_argument("--bbox", help="lat1,lng1,lat2,lng2；不给就按锚点自动算")
    ap.add_argument("--format", default="餐饮")
    ap.add_argument("--competitor", default=DEFAULT_COMPETITORS)
    ap.add_argument("--radius", type=int, default=1000)
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--k", type=float, default=0.8, help="竞争惩罚系数：大店 0.8，小店 0.4")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--rescore", action="store_true", help="复用缓存重新打分（0 次调用）")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    os.makedirs(GRID_DIR, exist_ok=True)
    # --city / --district 直接拼文件名，传 ../x 会写到 GRID_DIR 之外
    def _safe(v):
        return "".join(c for c in str(v) if c.isalnum() or c in "-_\u4e00-\u9fa5") or "na"
    cache_path = os.path.join(GRID_DIR, f"_pool-{_safe(args.city)}-{_safe(args.district or 'all')}.json")

    # 复用缓存：改权重后重排，不重复花钱
    if args.rescore:
        if not os.path.exists(cache_path):
            sys.exit(f"没有缓存 {cache_path}，先跑一次 --execute")
        with open(cache_path, encoding="utf-8") as f:
            c = json.load(f)
        print(f"复用缓存：锚点 {len(c['anchors'])}｜底图 {sum(len(v) for v in c['pool'].values())} 条"
              f"｜竞品 {len(c['competitors'])} 家（0 次调用）")
        score_and_output(args, c["anchors"], c["pool"], c["competitors"])
        return

    if not args.dry_run and not args.execute:
        args.dry_run = True

    print(f"== 锚点采集（{args.city}{args.district or ''}）==")
    anchors = []
    for kw, kind in (("地铁站", "metro"), ("购物中心", "mall")):
        got = fetch_keyword(kw, args.city, args.district, max_pages=8)
        print(f"  {kw}: {len(got)} 个")
        anchors.extend({**p, "kind": kind} for p in got)

    merged = []
    for a in anchors:
        dup = next((m for m in merged
                    if haversine_m(a["lat"], a["lng"], m["lat"], m["lng"]) <= ANCHOR_MERGE_M), None)
        if dup is None:
            merged.append(a)
        elif dup["kind"] != "metro" and a["kind"] == "metro":
            dup["kind"], dup["name"] = "metro", a["name"]
    print(f"  合并后 {len(merged)} 个锚点（{ANCHOR_MERGE_M}m 内去重）")
    if not merged:
        sys.exit("没有锚点，检查城市名或改用 --bbox")

    if args.bbox:
        bbox = tuple(float(x) for x in args.bbox.split(","))
    else:
        pad = 0.01
        bbox = (min(a["lat"] for a in merged) - pad, min(a["lng"] for a in merged) - pad,
                max(a["lat"] for a in merged) + pad, max(a["lng"] for a in merged) + pad)
    cells = cells_for(bbox)
    print(f"  扫描范围 {bbox[0]:.3f},{bbox[1]:.3f} ~ {bbox[2]:.3f},{bbox[3]:.3f}｜切片 {len(cells)} 个")

    # 预估必须与实际采集一致（下方「底图 POI」+「竞品」两轮都是按格子全量翻页）：
    #   底图  len(cells) × len(CELLAR_KEYWORDS) × MAX_PAGES
    #   竞品  len(cells) × len(comp_kws) × MAX_PAGES     ← 原来完全没算，低估约 43%
    #   锚点  ANCHOR_CALLS
    # 已删除 min(args.top, len(merged)) * 2 —— 那是幽灵项，实际没有对应调用。
    comp_kws_est = [x.strip() for x in args.competitor.split(",") if x.strip()]
    ANCHOR_CALLS = 8
    per_cell = len(CELLAR_KEYWORDS) + len(comp_kws_est)
    est = ANCHOR_CALLS + len(cells) * per_cell * MAX_PAGES
    print("\n== 额度预估 ==")
    print(f"  锚点 {ANCHOR_CALLS} 次"
          f" ｜ 底图 {len(cells)}×{len(CELLAR_KEYWORDS)}×{MAX_PAGES} = {len(cells) * len(CELLAR_KEYWORDS) * MAX_PAGES} 次"
          f" ｜ 竞品 {len(cells)}×{len(comp_kws_est)}×{MAX_PAGES} = {len(cells) * len(comp_kws_est) * MAX_PAGES} 次"
          f" ｜ 合计约 {est} 次"
          f" ｜ 约 {est * MIN_INTERVAL_S / 60:.1f} 分钟 ｜ 占日配额 {est / DAILY_LIMIT * 100:.1f}%")

    if args.dry_run:
        print("\n（dry-run，未执行。确认后加 --execute）")
        return
    if est > 1500 and not args.yes:
        sys.exit(f"\n⛔ 预估 {est} 次 > 1500：请缩小范围（--district / --bbox / 减小 --top），"
                 f"或确认后加 --yes")
    if est > 500 and not args.yes:
        sys.exit(f"\n⚠️ 预估 {est} 次 > 500：确认无误后加 --yes")

    print("\n== 底图 POI ==")
    pool = {"residential": [], "office": [], "coffee": [], "bank": []}
    for clat, clng in cells:
        for key, kw in CELLAR_KEYWORDS.items():
            pool[key].extend(fetch_cell(kw, clat, clng))
    print("  " + "｜".join(f"{k}:{len(v)}" for k, v in pool.items()))

    comp_kws = [x.strip() for x in args.competitor.split(",") if x.strip()]
    comp_pool = []
    if comp_kws:
        for clat, clng in cells:
            for kw in comp_kws:
                comp_pool.extend(fetch_cell(kw, clat, clng))
        ded = []
        for p in comp_pool:
            if any(p["name"] == q["name"] and haversine_m(p["lat"], p["lng"], q["lat"], q["lng"]) <= 50
                   for q in ded):
                continue
            ded.append(p)
        comp_pool = ded
        print(f"  竞品：{len(comp_pool)} 家（{','.join(comp_kws)}）")

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump({"city": args.city, "district": args.district or "", "anchors": merged,
                   "pool": pool, "competitors": comp_pool, "comp_keywords": comp_kws},
                  f, ensure_ascii=False)
    print(f"  采集快照已存 {os.path.basename(cache_path)}（下次 --rescore 可复用）")

    score_and_output(args, merged, pool, comp_pool)
    print(f"接口调用 {CALLS['total']} 次（成功 {CALLS['ok']}，失败 {CALLS['failed']}）")


if __name__ == "__main__":
    main()
