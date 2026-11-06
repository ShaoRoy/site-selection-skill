#!/usr/bin/env python3
"""
grid-scan.py —— 城市网格扫描：锚点（地铁站 + 商场）→ 候选点位排序

回答「不给具体商圈时，先去哪几个地方找铺」。
只回答「人多不多、竞争挤不挤」；铺位、租金、层高、排烟属第 2、3 筛。

评分口径（FORMULA_VERSION = grid-v1）：
  双口径并存，各有各的边界，不可混用：
  · 绝对口径 d_abs / p_abs —— 四项统一为密度（个/km²）后加权求和。只依赖
    「本锚点原始计数 + 参数」，不含任何批次统计量，因此可跨批次、跨城市比较。
  · 相对口径 demand_rel / pressure_rel / rank_score —— 本批内 min-max 到 0~100，
    只用于本批排名，不可跨批次比较（同一锚点换一批邻居，相对分会变）。
  每个候选的逐项原始计数、密度值、加权贡献、归一化基准、实际生效参数都会落盘
  （CSV 列 + sidecar JSON），可纸上复算还原 rank_score。

额度策略：
  默认 --dry-run，只估算不执行。--execute 才真跑。
  预估 > warn_threshold 要 --yes；> hard_limit 直接拒绝。
  --rescore 复用上次采集缓存，0 次调用重新打分。

参数来源（优先级由高到低）：CLI 显式传值 → --params 指向的配置文件。
参数文件缺失、字段缺失或取值不合法，一律报错退出（exit 1），不静默回退脚本常量。

用法：
  python scripts/grid-scan.py --city 广州 --district 天河 --dry-run
  python scripts/grid-scan.py --city 广州 --district 天河 --execute
  python scripts/grid-scan.py --city 广州 --district 天河 --rescore    # 改权重后重排，0 次调用
  python scripts/grid-scan.py --self-test                             # 纯函数自检，不联网
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

# ── 版本标识：公式或参数结构一改就必须升 ─────────────────────────────
# FIN 侧 FORMULA_VERSION = fin-v2（references/02-formulas.md §8），本文件只动 grid-v1。
FORMULA_VERSION = "grid-v1"
PARAMS_SCHEMA_VERSION = 2
DEFAULT_PARAMS = os.path.join(ROOT, "params", "grid.json")

# ── 采集侧常量（与评分参数无关，属工具物理属性，故意不进 params）────────
CELL_DEG = 0.05
CELL_RADIUS_M = 4000
MAX_PAGES = 3
ANCHOR_MERGE_M = 300
CELLAR_KEYWORDS = {"residential": "住宅区", "office": "写字楼", "coffee": "星巴克", "bank": "银行"}
DEFAULT_COMPETITORS = "粤菜,茶楼,烧腊"

# 权重键名即密度项键名，顺序固定，用于 CSV / sidecar 的可复算展开
WEIGHT_KEYS = ("residential_density", "office_density", "coffee_density", "amenity_density")
QUOTA_KEYS = ("daily_limit", "warn_threshold", "hard_limit", "min_interval_s")

CALLS = {"total": 0, "ok": 0, "failed": 0}
# 由 params/grid.json 填充，main() 之前保持空 dict，避免"看起来有默认值"
QUOTA = {}


# ────────────────────────── 参数加载 ──────────────────────────
def _die(msg):
    sys.exit(f"⛔ {msg}")


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def load_params(path):
    """读取并严格校验 params/grid.json。

    任何一处不合规都 exit 1 —— 需求明确禁止「静默回退硬编码」，
    否则改配置不生效又看起来没问题，正是这次要修的根因。
    """
    if not os.path.isfile(path):
        _die(
            f"参数文件不存在：{path}\n"
            f"   用 --params 指定路径，或从仓库 params/grid.json 复制一份。\n"
            f"   拒绝静默回退脚本内硬编码常量。"
        )
    try:
        with open(path, encoding="utf-8-sig") as f:
            raw = json.load(f)
    except json.JSONDecodeError as exc:
        _die(f"参数文件不是合法 JSON：{path}（{exc}）")
    except OSError as exc:
        _die(f"参数文件读取失败：{path}（{exc}）")
    if not isinstance(raw, dict):
        _die(f"参数文件顶层必须是对象：{path}")

    def need(key):
        if key not in raw:
            _die(f"参数文件缺字段 `{key}`：{path}")
        return raw[key]

    schema = need("schema_version")
    if not _is_num(schema) or int(schema) != PARAMS_SCHEMA_VERSION:
        _die(
            f"参数文件 schema_version 必须是 {PARAMS_SCHEMA_VERSION}，实际 {schema!r}：{path}\n"
            f"   v2 起 weights 四项改为密度口径（个/km²），"
            f"旧版 job_housing_ratio 已降级为报告参考字段。"
        )

    p = {"schema_version": PARAMS_SCHEMA_VERSION}

    radius = need("anchor_radius_m")
    if not _is_num(radius) or radius <= 0:
        _die(f"`anchor_radius_m` 必须是正数：{path}（实际 {radius!r}）")
    p["anchor_radius_m"] = radius

    top_n = need("top_n")
    if not _is_num(top_n) or int(top_n) <= 0:
        _die(f"`top_n` 必须是正整数：{path}（实际 {top_n!r}）")
    p["top_n"] = int(top_n)

    k = need("competition_k")
    if not _is_num(k) or k < 0:
        _die(f"`competition_k` 必须是非负数：{path}（实际 {k!r}）")
    p["competition_k"] = k

    weights = need("weights")
    if not isinstance(weights, dict):
        _die(f"`weights` 必须是对象：{path}")
    for key in WEIGHT_KEYS:
        if key not in weights:
            _die(f"`weights` 缺字段 `{key}`：{path}（需要 {', '.join(WEIGHT_KEYS)}）")
        if not _is_num(weights[key]) or weights[key] < 0:
            _die(f"`weights.{key}` 必须是非负数：{path}（实际 {weights[key]!r}）")
    total_w = math.fsum(weights[key] for key in WEIGHT_KEYS)
    if abs(total_w - 1.0) > 1e-6:
        _die(f"`weights` 四项之和必须为 1，实际 {total_w:.6f}：{path}")
    p["weights"] = {key: weights[key] for key in WEIGHT_KEYS}

    kws = need("competitor_keywords")
    if not isinstance(kws, str) or not kws.strip():
        _die(f"`competitor_keywords` 必须是非空字符串：{path}")
    p["competitor_keywords"] = kws

    quota = need("quota")
    if not isinstance(quota, dict):
        _die(f"`quota` 必须是对象：{path}")
    for key in QUOTA_KEYS:
        if key not in quota:
            _die(f"`quota` 缺字段 `{key}`：{path}（需要 {', '.join(QUOTA_KEYS)}）")
        if not _is_num(quota[key]) or quota[key] <= 0:
            _die(f"`quota.{key}` 必须是正数：{path}（实际 {quota[key]!r}）")
    p["quota"] = {key: quota[key] for key in QUOTA_KEYS}

    p["_path"] = path
    return p


def _rel_to_root(path):
    """落盘用相对 ROOT 的路径：交付物里不该出现某台机器的绝对路径。"""
    try:
        rel = os.path.relpath(os.path.abspath(path), ROOT)
    except ValueError:
        return os.path.basename(path)
    return rel.replace(os.sep, "/")


def resolve(cli_value, cfg_value, cli_label, cfg_label):
    """CLI 显式传值优先于配置；两者都返回生效值与来源标签，供输出/落盘。"""
    if cli_value is not None:
        return cli_value, cli_label
    return cfg_value, cfg_label


def apply_runtime_params(params):
    """把 quota 写进模块级 QUOTA —— 采集期节流与额度门都读它。"""
    QUOTA.update(params["quota"])


# ────────────────────────── 基础工具 ──────────────────────────
def read_key():
    key = os.environ.get("AMAP_API_KEY")
    if key:
        return key.strip()
    if not os.path.isfile(KEY_FILE):
        _die(f"未找到高德 Key：既没有环境变量 AMAP_API_KEY，也没有 {KEY_FILE}")
    with open(KEY_FILE, encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                return line.strip()
    _die(f"Key 文件为空：{KEY_FILE}")


def api_get(path, params):
    params = dict(params)
    params["key"] = read_key()
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(4):
        time.sleep(QUOTA["min_interval_s"])
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


# ────────────────────────── 打分（纯函数，可单测）──────────────────────────
def to100(vals):
    """本批内 min-max 归一化到 0~100。

    退化分支（全场同值）返回 0 而不是 50：
    需求/压力无批次内差异，就不该发一个「中位分」再拿它去扣分。
    旧版返回 50 会让「零竞争」变成 pressure=50 → 统一扣 0.8×50=40 分，
    等于零竞争反被罚，属明确的符号错误。
    """
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return [0.0 for _ in vals]
    return [(v - lo) / (hi - lo) * 100 for v in vals]


def density_row(raw, radius_m, weights):
    """单个锚点的密度分解。纯函数：只依赖原始计数与参数，不含批次统计量。"""
    area_km2 = math.pi * (radius_m / 1000.0) ** 2
    density = {
        "residential_density": raw["residential"] / area_km2,
        "office_density": raw["office"] / area_km2,
        "coffee_density": raw["coffee"] / area_km2,
        "amenity_density": (raw["coffee"] + raw["bank"]) / area_km2,
    }
    contrib = {key: density[key] * weights[key] for key in WEIGHT_KEYS}
    return {
        "area_km2": area_km2,
        "density": density,
        "contrib": contrib,
        "d_abs": math.fsum(contrib[key] for key in WEIGHT_KEYS),
        "competitor_density": raw["competitor"] / area_km2,
        "p_abs": raw["competitor"] / area_km2,
        # 职住比保留为参考字段：它是无量纲比值，与密度不同量纲，
        # 从 grid-v1 起不再参与加权（旧版把它当需求项直接加进密度和，属量纲混用）。
        "job_housing_ratio": (raw["office"] / raw["residential"]) if raw["residential"] > 0 else 0.0,
    }


def score_candidates(rows, radius_m, k, weights):
    """纯函数：原始计数 → 双口径分数 + 归一化基准。

    返回 (scored, meta)。scored 每项含 d_abs / p_abs / demand_rel / pressure_rel /
    rank_score 与完整分解；meta 含本批 min/max，供纸上复算。
    """
    if not rows:
        raise ValueError("候选集为空，无法打分")

    detailed = []
    for r in rows:
        d = density_row(r, radius_m, weights)
        detailed.append({**r, **d})

    d_vals = [x["d_abs"] for x in detailed]
    p_vals = [x["p_abs"] for x in detailed]
    d_min, d_max = min(d_vals), max(d_vals)
    p_min, p_max = min(p_vals), max(p_vals)
    d_rel = to100(d_vals)
    p_rel = to100(p_vals)

    scored = []
    for i, x in enumerate(detailed):
        rank_score = d_rel[i] - p_rel[i] * k
        scored.append({
            **x,
            "demand_rel": round(d_rel[i], 4),
            "pressure_rel": round(p_rel[i], 4),
            "rank_score": round(rank_score, 4),
        })

    meta = {
        "formula_version": FORMULA_VERSION,
        "radius_m": radius_m,
        "k": k,
        "weights": dict(weights),
        "area_km2": round(math.pi * (radius_m / 1000.0) ** 2, 6),
        "normalization": {
            "method": "min-max",
            "scope": "本批（不可跨批次比较）",
            "d_abs": {"min": round(d_min, 6), "max": round(d_max, 6)},
            "p_abs": {"min": round(p_min, 6), "max": round(p_max, 6)},
        },
        "formulas": {
            "density_i": "count_i / (π × (radius_m/1000)²)",
            "d_abs": "Σ(weights_i × density_i)",
            "demand_rel": "(d_abs - min(d_abs)) / (max(d_abs) - min(d_abs)) × 100；全相等时为 0",
            "pressure_rel": "(p_abs - min(p_abs)) / (max(p_abs) - min(p_abs)) × 100；全相等时为 0",
            "rank_score": "demand_rel - pressure_rel × k",
        },
        "provenance": "POI 密度为代理指标（PROXY），不是实测人流；密度分母固定为打分半径对应的圆面积。",
    }
    return scored, meta


def explain(rank_score, demand_rel, pressure_rel):
    d, p = demand_rel, pressure_rel
    if d >= 70 and p >= 70:
        return "需求强但竞争激烈，得靠差异化或错位竞争"
    if d >= 70 and p < 70:
        return "需求强且竞争温和，优先考察"
    if d < 40 and p < 30:
        return "竞争温和但需求一般，适合细分业态或差异化打法"
    if d < 40 and p >= 70:
        return "需求一般还竞争激烈，除非租金极低否则不建议"
    return "需求与竞争均属中位，看具体铺位条件"


# ────────────────────────── 输出 ──────────────────────────
def write_outputs(args, top, meta, param_sources):
    os.makedirs(GRID_DIR, exist_ok=True)
    out_path = args.out or os.path.join(GRID_DIR, f"candidates-{args.city}-{args.district or 'all'}.csv")
    sidecar_path = os.path.splitext(out_path)[0] + ".score.json"

    fields = [
        "rank", "grade", "name", "kind", "lat", "lng",
        "rank_score", "demand_rel", "pressure_rel",
        "d_abs", "p_abs",
        "residential", "office", "coffee", "bank", "competitor",
        "residential_density", "office_density", "coffee_density", "amenity_density",
        "competitor_density", "job_housing_ratio",
        "score_formula_version", "reason",
    ]
    rows = []
    for s in top:
        rows.append({
            "rank": s["rank"], "grade": s["grade"], "name": s["name"], "kind": s["kind"],
            "lat": s["lat"], "lng": s["lng"],
            "rank_score": s["rank_score"],
            "demand_rel": s["demand_rel"], "pressure_rel": s["pressure_rel"],
            "d_abs": round(s["d_abs"], 6), "p_abs": round(s["p_abs"], 6),
            "residential": s["residential"], "office": s["office"],
            "coffee": s["coffee"], "bank": s["bank"], "competitor": s["competitor"],
            "residential_density": round(s["density"]["residential_density"], 6),
            "office_density": round(s["density"]["office_density"], 6),
            "coffee_density": round(s["density"]["coffee_density"], 6),
            "amenity_density": round(s["density"]["amenity_density"], 6),
            "competitor_density": round(s["competitor_density"], 6),
            "job_housing_ratio": round(s["job_housing_ratio"], 4),
            "score_formula_version": FORMULA_VERSION,
            "reason": s["reason"],
        })
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    sidecar = {
        "score_formula_version": FORMULA_VERSION,
        "params_schema_version": PARAMS_SCHEMA_VERSION,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "city": args.city,
        "district": args.district or "",
        "param_sources": param_sources,
        **meta,
        "candidates": [
            {
                "rank": s["rank"], "grade": s["grade"], "name": s["name"], "kind": s["kind"],
                "lat": s["lat"], "lng": s["lng"],
                "area_km2": round(s["area_km2"], 6),
                "raw_counts": {
                    "residential": s["residential"], "office": s["office"],
                    "coffee": s["coffee"], "bank": s["bank"], "competitor": s["competitor"],
                },
                "density": {k: round(v, 6) for k, v in s["density"].items()},
                "contrib": {k: round(v, 6) for k, v in s["contrib"].items()},
                "d_abs": round(s["d_abs"], 6),
                "p_abs": round(s["p_abs"], 6),
                "competitor_density": round(s["competitor_density"], 6),
                "job_housing_ratio": round(s["job_housing_ratio"], 4),
                "demand_rel": s["demand_rel"],
                "pressure_rel": s["pressure_rel"],
                "rank_score": s["rank_score"],
            }
            for s in top
        ],
    }
    with open(sidecar_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(sidecar, f, ensure_ascii=False, indent=2)
    return out_path, sidecar_path


def score_and_output(args, merged, pool, comp_pool, cfg):
    radius, radius_src = resolve(args.radius, cfg["anchor_radius_m"], "CLI --radius",
                                 f"params[{os.path.basename(cfg['_path'])}].anchor_radius_m")
    k, k_src = resolve(args.k, cfg["competition_k"], "CLI --k",
                       f"params[{os.path.basename(cfg['_path'])}].competition_k")
    top_n, top_src = resolve(args.top, cfg["top_n"], "CLI --top",
                             f"params[{os.path.basename(cfg['_path'])}].top_n")
    weights = cfg["weights"]
    param_sources = {
        "radius_m": radius_src,
        "k": k_src,
        "top_n": top_src,
        "weights": f"params[{os.path.basename(cfg['_path'])}].weights（四项固定取配置，CLI 不覆盖）",
        "params_file": _rel_to_root(cfg["_path"]),
        "params_schema_version": cfg["schema_version"],
    }

    print("\n== 本次生效参数 ==")
    print(f"  半径 radius_m = {radius}（来源：{radius_src}）")
    print(f"  竞争系数 k   = {k}（来源：{k_src}）")
    print(f"  候选数 top_n = {top_n}（来源：{top_src}）")
    print(f"  权重 weights = " + "｜".join(f"{key}={weights[key]}" for key in WEIGHT_KEYS))
    print(f"             （来源：{param_sources['weights']}）")

    def near(rows, a, r):
        return sum(1 for p in rows if haversine_m(a["lat"], a["lng"], p["lat"], p["lng"]) <= r)

    raw_rows = []
    for a in merged:
        raw_rows.append({
            "name": a["name"], "kind": a["kind"],
            "lat": round(a["lat"], 6), "lng": round(a["lng"], 6),
            "residential": near(pool["residential"], a, radius),
            "office": near(pool["office"], a, radius),
            "coffee": near(pool["coffee"], a, radius),
            "bank": near(pool["bank"], a, radius),
            "competitor": near(comp_pool, a, radius) if comp_pool else 0,
        })

    scored, meta = score_candidates(raw_rows, radius, k, weights)

    scored.sort(key=lambda x: -x["rank_score"])
    top = scored[: top_n]
    n = len(top)
    for i, s in enumerate(top, 1):
        s["rank"] = i
        s["grade"] = "A" if i <= max(1, round(n * 0.1)) else "B" if i <= max(2, round(n * 0.33)) else "C"
        s["reason"] = explain(s["rank_score"], s["demand_rel"], s["pressure_rel"])

    out_path, sidecar_path = write_outputs(args, top, meta, param_sources)

    norm = meta["normalization"]
    print(f"\n== 候选点位 Top {len(top)} ==")
    print(f"  绝对口径可跨批次比较：d_abs ∈ [{norm['d_abs']['min']}, {norm['d_abs']['max']}]"
          f"（加权密度，权重和=1，量纲沿用 个/km²）")
    print(f"  相对口径仅供本批排名：demand_rel / pressure_rel 为 min-max 到 0~100，换批即变")
    print(f"  代理标注：POI 密度是 PROXY 代理指标，不是实测人流")
    print(f"{'#':>2} {'档':<2} {'名称':<20} {'类型':<6} {'需求rel':>7} {'竞争rel':>7} {'rank':>7} {'d_abs':>9} {'p_abs':>8}")
    for s in top[:15]:
        print(f"{s['rank']:>2} {s['grade']:<2} {s['name'][:20]:<20} {s['kind']:<6} "
              f"{s['demand_rel']:>7.1f} {s['pressure_rel']:>7.1f} {s['rank_score']:>7.1f} "
              f"{s['d_abs']:>9.3f} {s['p_abs']:>8.3f}")
    if len(top) > 15:
        print(f"…（共 {len(top)} 个，见 CSV）")

    # 回写 registry（覆盖台账是副作用；失败不影响分数正确性，但必须显式说出原因）
    try:
        spec = importlib.util.spec_from_file_location("gridreg", os.path.join(TOOLS, "grid-registry.py"))
        reg = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reg)
        data = reg.load()
        for s in top:
            reg.upsert(data, reg.grid_id(s["lat"], s["lng"]),
                       city=args.city, district=args.district or "",
                       status="已扫描", score=s["rank_score"], tool="grid-scan",
                       event=f"扫描：{s['name']}（{s['grade']} 档）")
        reg.save(data)
        print(f"\nregistry 已更新：{len(top)} 个网格标记为「已扫描」（分数写的是 rank_score，仅本批可比）")
    except Exception as exc:
        print(f"\n⚠️ registry 回写未完成：{exc}")
        print("   影响范围：仅 out/grid/registry.json 的「已扫描」标记，候选表与 sidecar 已正常写出。")

    print(f"\n候选表：{out_path}")
    print(f"分数明细（可复算）：{sidecar_path}")
    print('下一步：挑 A 档跑 `node tools/run-site.mjs --address="<名称>" --survey=...`')
    return top


# ────────────────────────── 自检（纯函数，不联网）──────────────────────────
def self_test():
    checks = []

    def ck(label, ok):
        checks.append((label, bool(ok)))

    # B. to100 退化
    ck("to100 全相等（全 0）→ 0", to100([0, 0, 0]) == [0.0, 0.0, 0.0])
    ck("to100 全相等（全 7）→ 0", to100([7, 7, 7]) == [0.0, 0.0, 0.0])
    ck("to100 单值 → 0", to100([42]) == [0.0])
    norm = to100([10, 20, 30, 40, 50])
    ck("to100 正常分布 min=0 max=100", abs(norm[0]) < 1e-9 and abs(norm[-1] - 100) < 1e-9)
    ck("to100 正常分布单调", all(norm[i] < norm[i + 1] for i in range(len(norm) - 1)))

    # A. 量纲统一：改半径不改变各项贡献占比
    w = {"residential_density": 0.3, "office_density": 0.2, "coffee_density": 0.25, "amenity_density": 0.25}
    raw = {"residential": 100, "office": 50, "coffee": 10, "bank": 10, "competitor": 10}
    ratio_sets = []
    for radius in (800, 1000, 2000):
        d = density_row(raw, radius, w)
        share = {k: d["contrib"][k] / d["d_abs"] for k in WEIGHT_KEYS}
        ratio_sets.append(share)
    ck("半径 800/1000/2000 下四项贡献占比不漂移",
       all(abs(ratio_sets[0][k] - s[k]) < 1e-9 for s in ratio_sets[1:] for k in WEIGHT_KEYS))

    # 绝对分只依赖本锚点，与同批其它候选无关
    single, _ = score_candidates([
        {"name": "A", "kind": "metro", "lat": 0, "lng": 0, **raw},
    ], 1000, 0.8, w)
    mixed, _ = score_candidates([
        {"name": "A", "kind": "metro", "lat": 0, "lng": 0, **raw},
        {"name": "B", "kind": "mall", "lat": 0, "lng": 0,
         "residential": 5, "office": 5, "coffee": 5, "bank": 5, "competitor": 500},
    ], 1000, 0.8, w)
    ck("d_abs 跨批次恒定（不含批次统计量）",
       abs(single[0]["d_abs"] - mixed[0]["d_abs"]) < 1e-9)
    ck("p_abs 跨批次恒定",
       abs(single[0]["p_abs"] - mixed[0]["p_abs"]) < 1e-9)

    # 零竞争不再被罚
    zero = [{"name": f"Z{i}", "kind": "metro", "lat": 0, "lng": 0,
             "residential": 10 * i, "office": 5, "coffee": 1, "bank": 1, "competitor": 0}
            for i in (1, 2, 3)]
    zero_scored, _ = score_candidates(zero, 1000, 0.8, w)
    ck("零竞争 pressure_rel 全为 0", all(s["pressure_rel"] == 0.0 for s in zero_scored))
    ck("零竞争 rank_score = demand_rel（无扣分）",
       all(abs(s["rank_score"] - s["demand_rel"]) < 1e-9 for s in zero_scored))

    # D. sidecar 可复算
    sc, meta = score_candidates([
        {"name": "R1", "kind": "metro", "lat": 0, "lng": 0,
         "residential": 120, "office": 80, "coffee": 12, "bank": 9, "competitor": 30},
        {"name": "R2", "kind": "mall", "lat": 0, "lng": 0,
         "residential": 60, "office": 200, "coffee": 30, "bank": 20, "competitor": 80},
    ], 1000, 0.8, w)
    ok_recalc = True
    for s in sc:
        d_abs = math.fsum(s["contrib"][k] for k in WEIGHT_KEYS)
        n = meta["normalization"]

        def rel(v, lo, hi):
            return 0.0 if hi - lo < 1e-9 else (v - lo) / (hi - lo) * 100

        dr = rel(s["d_abs"], n["d_abs"]["min"], n["d_abs"]["max"])
        pr = rel(s["p_abs"], n["p_abs"]["min"], n["p_abs"]["max"])
        rs = dr - pr * 0.8
        # 纸笔复算：Σ(w_i×密度_i) 还原 d_abs；再按 min-max 基准还原 rank_score。
        # 基准值落盘时 round 到 6 位，故容差给 1e-3 而非机器精度。
        ok_recalc &= abs(d_abs - s["d_abs"]) < 1e-9 and abs(round(rs, 4) - s["rank_score"]) < 1e-3
    ck("sidecar 分解可纸上复算还原 rank_score", ok_recalc)

    # C. 参数来源优先级
    ck("CLI 显式值优先于配置", resolve(5, 9, "CLI", "cfg") == (5, "CLI"))
    ck("未传时回落到配置", resolve(None, 9, "CLI", "cfg") == (9, "cfg"))

    # C. 旧缓存兼容：必需字段缺失必须报错，不能静默填默认
    def cache_ok(cache):
        for key in ("anchors", "pool", "competitors"):
            if key not in cache:
                return False
        return all(k in cache["pool"] for k in CELLAR_KEYWORDS)

    ck("完整缓存可读", cache_ok({"anchors": [], "pool": {k: [] for k in CELLAR_KEYWORDS}, "competitors": []}))
    ck("缺 competitors 的缓存判为不可读", not cache_ok({"anchors": [], "pool": {k: [] for k in CELLAR_KEYWORDS}}))
    ck("pool 缺 key 的缓存判为不可读", not cache_ok({"anchors": [], "pool": {"residential": []}, "competitors": []}))

    # 权重和校验
    ck("权重四项之和为 1", abs(math.fsum(w[k] for k in WEIGHT_KEYS) - 1.0) < 1e-9)

    print("\n=== grid-scan.py --self-test ===")
    passed = 0
    for label, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {label}")
        passed += 1 if ok else 0
    print(f"\n{passed}/{len(checks)} 通过   （FORMULA_VERSION={FORMULA_VERSION}）")
    return 0 if passed == len(checks) else 1


# ────────────────────────── 主流程 ──────────────────────────
def load_cache(path):
    if not os.path.isfile(path):
        _die(f"没有缓存 {path}，先跑一次 --execute")
    try:
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
    except json.JSONDecodeError as exc:
        _die(f"缓存不是合法 JSON：{path}（{exc}）")
    missing = [k for k in ("anchors", "pool", "competitors") if k not in cache]
    if missing:
        _die(
            f"缓存缺字段 {', '.join(missing)}：{path}\n"
            f"   旧缓存必须可读，但缺关键字段时不填默认值——请重跑一次 --execute 重新采集。"
        )
    lacking = [k for k in CELLAR_KEYWORDS if k not in cache["pool"]]
    if lacking:
        _die(f"缓存 pool 缺 {', '.join(lacking)}：{path}\n   请重跑一次 --execute。")
    return cache


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city")
    ap.add_argument("--district")
    ap.add_argument("--bbox", help="lat1,lng1,lat2,lng2；不给就按锚点自动算")
    ap.add_argument("--format", default="餐饮")
    ap.add_argument("--competitor", default=None,
                    help="竞品关键词，逗号分隔；缺省取 params 的 competitor_keywords")
    ap.add_argument("--radius", type=int, default=None,
                    help="统计半径（米）；缺省取 params 的 anchor_radius_m")
    ap.add_argument("--top", type=int, default=None,
                    help="输出候选数；缺省取 params 的 top_n")
    ap.add_argument("--k", type=float, default=None,
                    help="竞争惩罚系数（大店 0.8 / 小店 0.4）；缺省取 params 的 competition_k")
    ap.add_argument("--params", default=DEFAULT_PARAMS,
                    help=f"参数文件路径，默认 {DEFAULT_PARAMS}")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--rescore", action="store_true", help="复用缓存重新打分（0 次调用）")
    ap.add_argument("--out", default="")
    ap.add_argument("--self-test", dest="self_test", action="store_true",
                    help="纯函数自检（不联网、不需要 Key）")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(self_test())

    if not args.city:
        _die("缺少 --city（或改用 --self-test 跑纯函数自检）")

    cfg = load_params(args.params)
    apply_runtime_params(cfg)

    os.makedirs(GRID_DIR, exist_ok=True)

    def _safe(v):
        return "".join(c for c in str(v) if c.isalnum() or c in "-_\u4e00-\u9fa5") or "na"

    cache_path = os.path.join(GRID_DIR, f"_pool-{_safe(args.city)}-{_safe(args.district or 'all')}.json")

    # 复用缓存：改权重后重排，不重复花钱
    if args.rescore:
        c = load_cache(cache_path)
        print(f"复用缓存：锚点 {len(c['anchors'])}｜底图 {sum(len(v) for v in c['pool'].values())} 条"
              f"｜竞品 {len(c['competitors'])} 家（0 次调用）")
        score_and_output(args, c["anchors"], c["pool"], c["competitors"], cfg)
        return

    if not args.dry_run and not args.execute:
        args.dry_run = True

    comp_kws = [x.strip() for x in (args.competitor or cfg["competitor_keywords"]).split(",") if x.strip()]
    comp_src = "CLI --competitor" if args.competitor else f"params[{os.path.basename(cfg['_path'])}].competitor_keywords"

    print(f"== 锚点采集（{args.city}{args.district or ''}）==")
    print(f"  竞品关键词：{','.join(comp_kws)}（来源：{comp_src}）")
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
        _die("没有锚点，检查城市名或改用 --bbox")

    if args.bbox:
        bbox = tuple(float(x) for x in args.bbox.split(","))
    else:
        pad = 0.01
        bbox = (min(a["lat"] for a in merged) - pad, min(a["lng"] for a in merged) - pad,
                max(a["lat"] for a in merged) + pad, max(a["lng"] for a in merged) + pad)
    cells = cells_for(bbox)
    print(f"  扫描范围 {bbox[0]:.3f},{bbox[1]:.3f} ~ {bbox[2]:.3f},{bbox[3]:.3f}｜切片 {len(cells)} 个")

    # 预估必须与实际采集一致：
    #   底图  len(cells) × len(CELLAR_KEYWORDS) × MAX_PAGES
    #   竞品  len(cells) × len(comp_kws) × MAX_PAGES
    #   锚点  ANCHOR_CALLS
    ANCHOR_CALLS = 8
    per_cell = len(CELLAR_KEYWORDS) + len(comp_kws)
    est = ANCHOR_CALLS + len(cells) * per_cell * MAX_PAGES
    daily_limit = QUOTA["daily_limit"]
    warn = QUOTA["warn_threshold"]
    hard = QUOTA["hard_limit"]
    print("\n== 额度预估 ==")
    print(f"  锚点 {ANCHOR_CALLS} 次"
          f" ｜ 底图 {len(cells)}×{len(CELLAR_KEYWORDS)}×{MAX_PAGES} = {len(cells) * len(CELLAR_KEYWORDS) * MAX_PAGES} 次"
          f" ｜ 竞品 {len(cells)}×{len(comp_kws)}×{MAX_PAGES} = {len(cells) * len(comp_kws) * MAX_PAGES} 次"
          f" ｜ 合计约 {est} 次"
          f" ｜ 约 {est * QUOTA['min_interval_s'] / 60:.1f} 分钟"
          f" ｜ 占日配额 {est / daily_limit * 100:.1f}%")
    print(f"  额度门来自 params[{os.path.basename(cfg['_path'])}].quota："
          f"warn={warn}｜hard={hard}｜daily={daily_limit}｜interval={QUOTA['min_interval_s']}s")

    if args.dry_run:
        print("\n（dry-run，未执行。确认后加 --execute）")
        return
    if est > hard and not args.yes:
        _die(f"预估 {est} 次 > hard_limit {hard}：请缩小范围（--district / --bbox / 减小 --top），"
             f"或确认后加 --yes")
    if est > warn and not args.yes:
        _die(f"预估 {est} 次 > warn_threshold {warn}：确认无误后加 --yes")

    print("\n== 底图 POI ==")
    pool = {"residential": [], "office": [], "coffee": [], "bank": []}
    for clat, clng in cells:
        for key, kw in CELLAR_KEYWORDS.items():
            pool[key].extend(fetch_cell(kw, clat, clng))
    print("  " + "｜".join(f"{k}:{len(v)}" for k, v in pool.items()))

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

    with open(cache_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({
            "city": args.city, "district": args.district or "",
            "anchors": merged, "pool": pool,
            "competitors": comp_pool, "comp_keywords": comp_kws,
            # v2 起新增：记录本次采集用的节流与额度，旧缓存没有这些字段也能读
            "scan_context": {"cell_deg": CELL_DEG, "cell_radius_m": CELL_RADIUS_M,
                             "max_pages": MAX_PAGES, "quota": QUOTA},
        }, f, ensure_ascii=False)
    print(f"  采集快照已存 {os.path.basename(cache_path)}（下次 --rescore 可复用）")

    score_and_output(args, merged, pool, comp_pool, cfg)
    print(f"接口调用 {CALLS['total']} 次（成功 {CALLS['ok']}，失败 {CALLS['failed']}）")


if __name__ == "__main__":
    main()
