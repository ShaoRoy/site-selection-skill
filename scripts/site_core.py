#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
site_core.py —— 选址核心计算引擎（纯 Python，无第三方依赖）

移植自 DSH 插件 `site-tools.ts`，供任何 Agent / 本地环境直接调用。
命令行：
  python site_core.py finance --params params.json [--area 1200] [--catchment L2] [--out r.json]
  python site_core.py crs --points points.json
  python site_core.py veto --format large_yuecai --fields fields.json
  python site_core.py dedupe --pois pois.json --keyword 粤菜
  python site_core.py geo --center "23.1,113.2" --pois pois.json --minutes 10 --mode walk
  python site_core.py benchmark --city 广州 --format 粤式茶楼早茶 --area 1200 \
         --investment-wan 320 --rent-wan 12 --ticket 230 --revenue-wan 99 --payback 15.5 --margin 0.208
  python site_core.py selftest
"""
import argparse
import json
import math
import os
import sys
from datetime import datetime

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

FORMULA_VERSION = "fin-v4"
RULE_VERSION = "veto-2026.10.24"
PARAM_VERSION = "params-2026.10.24"

# ───────────────────────── 通用 ─────────────────────────
def r2(v, n=2):
    return round(float(v), n)

SCENARIOS = {"base": (1.0, 1.0), "pessimistic": (0.85, 1.05), "optimistic": (1.15, 0.97)}
PARAM_KEYS = ["daily_revenue", "gross_margin", "monthly_rent", "monthly_labor",
              "monthly_other_fixed", "initial_investment", "tax_rate", "amortization_months"]
POLICY_KEYS = {"tax_rate", "amortization_months"}
GENERIC_DEFAULTS = {"daily_revenue": 8000, "gross_margin": 0.25, "monthly_rent": 25000,
                    "monthly_labor": 18000, "monthly_other_fixed": 6000,
                    "initial_investment": 350000, "tax_rate": 0.045, "amortization_months": 60}

PAYBACK_BY_FORMAT = [
    (r"tea_drink|milk_tea|奶茶|茶饮|咖啡", 12, "茶饮/咖啡"),
    (r"tea_house|yumcha|早茶|茶楼|茶居|点心", 27, "全天茶楼"),
    (r"large_|大型|酒楼|宴会", 36, "大型正餐"),
    (r"mid_|中型", 24, "中型正餐"),
    (r"convenience|便利店", 18, "便利店"),
    (r"noodle|dumpling|面馆|饺子|包子|粉面|米线", 18, "面食/饺子"),
    (r"bbq|hotpot|烧烤|烤肉|火锅", 24, "烧烤/火锅"),
    (r"lu_cai|shandong|鲁菜|家常菜|东北菜|湘菜|川菜|徽菜|本帮菜", 24, "中式正餐"),
    (r"fast_food|快餐|粉面|小吃", 18, "快餐/粉面"),
]
RENT_RATIO_BY_FORMAT = [
    (r"tea_drink|milk_tea|奶茶|茶饮|咖啡", 0.15, 0.20, "茶饮/咖啡"),
    (r"convenience|便利店", 0.12, 0.18, "便利店"),
    (r"noodle|dumpling|面馆|饺子|包子|粉面|米线", 0.10, 0.15, "面食/饺子"),
    (r"bbq|hotpot|烧烤|烤肉|火锅", 0.10, 0.16, "烧烤/火锅"),
    (r"lu_cai|shandong|鲁菜|家常菜|东北菜|湘菜|川菜|徽菜|本帮菜", 0.11, 0.17, "中式正餐"),
    (r"fast_food|快餐|粉面|小吃", 0.12, 0.18, "快餐/粉面"),
    (r"tea_house|yumcha|早茶|茶楼|茶居|点心", 0.10, 0.15, "全天茶楼"),
    (r"large_|大型|酒楼|宴会", 0.10, 0.15, "大型正餐"),
    (r"mid_|中型", 0.12, 0.18, "中型正餐"),
]
RATIO_BENCH = [
    (r"tea_drink|milk_tea|奶茶|茶饮|咖啡", (0.55, 0.72), (0.15, 0.25), (3000, 6000)),
    (r"convenience|便利店", (0.20, 0.32), (0.08, 0.15), (2000, 4000)),
    (r"fast_food|快餐|粉面|小吃", (0.55, 0.68), (0.15, 0.22), (2500, 4500)),
    (r"tea_house|yumcha|早茶|茶楼|茶居|点心", (0.58, 0.70), (0.22, 0.30), (3500, 5500)),
    (r"large_|大型|酒楼|宴会", (0.55, 0.65), (0.22, 0.30), (3500, 5000)),
    (r"mid_|中型", (0.55, 0.65), (0.20, 0.28), (3000, 4500)),
]
RATIO_FALLBACK = ((0.50, 0.70), (0.18, 0.28), (3000, 5000))
CATCHMENT = {
    "L1": ("顶级截流（千分点）", 1.30, "1.25~1.40"), "L2": ("强截流（A 类点）", 1.10, "1.00~1.20"),
    "L3": ("中等截流（B 类·基准）", 1.00, "1.00"), "L4": ("弱截流（C 类点）", 0.65, "0.60~0.70"),
    "L5": ("极低截流（D 类·慎选）", 0.15, "0.10~0.20"),
}
SPACE_BY_FORMAT = [(r"large_|大型|酒楼", dict(kitchen=0.35, seat=2.8, turn=2.0, cap=3.0, rps=700, tmin=150, tmax=400)),
                   (r"tea_house|茶楼", dict(kitchen=0.32, seat=2.6, turn=2.5, cap=3.5, rps=600, tmin=50, tmax=110)),
                   (r"tea_drink|茶饮|咖啡", dict(kitchen=0.25, seat=1.6, turn=4.0, cap=6.0, rps=2000, tmin=10, tmax=40)),
                   (r"convenience|便利店", dict(kitchen=0.10, seat=0.0, turn=0, cap=0, rps=1500, tmin=8, tmax=30))]
SPACE_FALLBACK = dict(kitchen=0.30, seat=2.4, turn=2.5, cap=3.5, rps=900, tmin=40, tmax=200)
LEASE_DEFAULTS = dict(term_years=5, rent_escalation_pct=0.03, renovation_cycle_years=5, renovation_cost_ratio=0.25)
MIN_TERM_BY_AREA = [(1000, 7), (300, 5), (0, 2)]


# ───────────────────────── 外部业态规则（可替换） ─────────────────────────
FORMATS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "data", "formats.json")
# 用户业态名 -> 基准库业态名（来自 data/formats.json 的 benchmark_format 字段）
FORMAT_ALIASES = {}


def resolve_alias(fmt):
    """用户传「鲁菜」，若 formats.json 配了 benchmark_format，则映射到库里的业态名"""
    import re as _re
    for pat, target in FORMAT_ALIASES.items():
        try:
            if _re.search(pat, fmt or ""):
                return target
        except _re.error:
            continue
    return None


def load_format_rules(path=None):
    """读取 data/formats.json，用户自定义规则排在内置表之前（优先级更高）。
    返回生效的外部规则条数。"""
    global PAYBACK_BY_FORMAT, RENT_RATIO_BY_FORMAT, RATIO_BENCH, SPACE_BY_FORMAT
    p = path or FORMATS_FILE
    if not os.path.exists(p):
        return 0
    try:
        with open(p, encoding="utf-8-sig") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return 0
    pay, rent, ratio, space = [], [], [], []
    global FORMAT_ALIASES
    for f in d.get("formats") or []:
        if f.get("pattern") and f.get("benchmark_format"):
            FORMAT_ALIASES[f["pattern"]] = f["benchmark_format"]
        pat = f.get("pattern")
        if not pat:
            continue
        label = f.get("label") or pat
        if f.get("payback_months") is not None:
            pay.append((pat, int(f["payback_months"]), label))
        rr = f.get("rent_ratio")
        if isinstance(rr, (list, tuple)) and len(rr) == 2:
            rent.append((pat, float(rr[0]), float(rr[1]), label))
        rs = f.get("ratios") or {}
        if rs:
            gm = tuple(rs["gross_margin"]) if rs.get("gross_margin") else RATIO_FALLBACK[0]
            lr = tuple(rs["labor_ratio"]) if rs.get("labor_ratio") else RATIO_FALLBACK[1]
            ip = tuple(rs["investment_per_sqm"]) if rs.get("investment_per_sqm") else RATIO_FALLBACK[2]
            ratio.append((pat, gm, lr, ip))
        sp = f.get("space")
        if sp:
            space.append((pat, {**SPACE_FALLBACK, **sp}))
    # 外部规则前置 = 优先命中
    PAYBACK_BY_FORMAT = pay + PAYBACK_BY_FORMAT
    RENT_RATIO_BY_FORMAT = rent + RENT_RATIO_BY_FORMAT
    RATIO_BENCH = ratio + RATIO_BENCH
    SPACE_BY_FORMAT = space + SPACE_BY_FORMAT
    return len(d.get("formats") or [])


FORMAT_RULE_COUNT = load_format_rules()


def list_formats():
    """列出当前生效的业态规则（外部 + 内置）"""
    out = []
    for pat, months, label in PAYBACK_BY_FORMAT:
        h, w, _ = next(((a, b, c) for p2, a, b, c in RENT_RATIO_BY_FORMAT if p2 == pat),
                       (None, None, None))
        out.append({"pattern": pat, "label": label, "payback_months": months,
                    "rent_ratio": [h, w] if h is not None else None})
    return out


def _match(table, code, default):
    import re
    for row in table:
        if re.search(row[0], code or ""):
            return row[1:]
    return default


def payback_for(code):
    hit = _match(PAYBACK_BY_FORMAT, code, (24, "中型正餐"))
    return hit[0], hit[1]


def rent_line(code):
    hit = _match(RENT_RATIO_BY_FORMAT, code, (0.12, 0.18, "中型正餐"))
    return hit


def space_preset(code):
    import re
    for pat, cfg in SPACE_BY_FORMAT:
        if re.search(pat, code or ""):
            return cfg
    return SPACE_FALLBACK


def ratio_bench(code):
    import re
    for row in RATIO_BENCH:
        if re.search(row[0], code or ""):
            return row[1], row[2], row[3]
    return RATIO_FALLBACK


# ───────────────────────── 1. 财务测算 ─────────────────────────
def compute_scenario(p, key, target):
    fr, fc = SCENARIOS[key]
    revenue = p["daily_revenue"] * 30 * fr
    tax = revenue * p["tax_rate"]
    amort = p["initial_investment"] / p["amortization_months"] if p["amortization_months"] > 0 else 0
    fixed = (p["monthly_rent"] + p["monthly_labor"] + p["monthly_other_fixed"]) * fc
    gross = revenue * p["gross_margin"]
    cash = gross - tax - fixed
    net = cash - amort
    contrib = p["gross_margin"] - p["tax_rate"]
    be_rev = fixed / contrib if contrib > 0 else 0
    payback = p["initial_investment"] / cash if cash > 0 else -1
    acc_payback = p["initial_investment"] / net if net > 0 else -1
    roi = (net * 12) / p["initial_investment"] if p["initial_investment"] > 0 else 0
    cf = fc if fc > 0 else 1
    var = p["monthly_labor"] + p["monthly_other_fixed"]
    return {
        "revenue": r2(revenue), "net_profit": r2(net), "monthly_cash_flow": r2(cash),
        "roi": r2(roi, 4), "breakeven_revenue_daily": r2(be_rev / 30),
        "payback_static_months": r2(payback, 1), "accounting_payback_months": r2(acc_payback, 1),
        "max_rent_breakeven": r2((gross - tax) / cf - var),
        "max_rent_target": r2((gross - tax - p["initial_investment"] / target) / cf - var),
        "max_rent_ratio": r2(((gross - tax) / cf - var) / revenue, 4) if revenue > 0 else 0,
    }


def simulate_lease(p, area, lease, target, code, target_explicit):
    term = int(lease.get("term_years") or LEASE_DEFAULTS["term_years"])
    esc = lease.get("rent_escalation_pct")
    esc = LEASE_DEFAULTS["rent_escalation_pct"] if esc is None else esc
    if esc > 1:
        esc /= 100
    cycle = lease.get("renovation_cycle_years")
    cycle = LEASE_DEFAULTS["renovation_cycle_years"] if cycle is None else int(cycle)
    reno = lease.get("renovation_cost")
    reno_ratio = lease.get("renovation_cost_ratio") or LEASE_DEFAULTS["renovation_cost_ratio"]
    if reno is None:
        reno = p["initial_investment"] * reno_ratio

    rev = p["daily_revenue"] * 30
    gross = rev * p["gross_margin"]
    tax = rev * p["tax_rate"]
    fixed_no_rent = p["monthly_labor"] + p["monthly_other_fixed"] + tax
    base_rent = p["monthly_rent"]

    cum = -p["initial_investment"]
    payback_month = -1
    yearly = []
    for y in range(1, term + 1):
        rent_m = base_rent * (1 + esc) ** (y - 1)
        net_m = gross - (rent_m + fixed_no_rent)
        renovation = reno if (cycle > 0 and y % cycle == 0) else 0
        for m in range(1, 13):
            cum += net_m
            if payback_month < 0 and cum >= 0:
                payback_month = (y - 1) * 12 + m
        cum -= renovation
        yearly.append({"year": y, "rent_monthly": r2(rent_m), "net_profit": r2(net_m * 12),
                       "renovation": r2(renovation), "cumulative": r2(cum)})
    months = term * 12
    covers = cum >= 0
    ratio = payback_month / months if payback_month > 0 else 1
    verdict = "fail" if not covers else ("tight" if ratio > 0.6 else "healthy")
    min_years = next((v for a, v in MIN_TERM_BY_AREA if area >= a), 2) if area else None
    req = r2(target * 2 / 12, 1)
    return {
        "term_years": term, "rent_escalation_pct": r2(esc, 4), "renovation_cycle_years": cycle,
        "renovation_cost": r2(reno), "base_rent": r2(base_rent),
        "monthly_net_year1": r2(gross - (base_rent + fixed_no_rent)),
        "payback_month": payback_month, "payback_year": r2(payback_month / 12, 1) if payback_month > 0 else -1,
        "ending_cumulative": r2(cum), "covers_investment": covers, "verdict": verdict,
        "term_warning": (f"租期 {term} 年短于该面积的建议下限 {min_years} 年" if min_years and term < min_years else ""),
        "required_term_years": req,
        "term_capacity_warning": (f"租期 {term} 年不足以容纳「{target} 个月回本 + 等长赚钱期」，建议 ≥{req} 年" if term < req else ""),
        "yearly": yearly,
    }


def build_space(p, code, area, space, be_daily, target, overrides):
    cfg = dict(space_preset(code))
    for k, src in (("kitchen_ratio", "kitchen"), ("seat_area_sqm", "seat"),
                   ("normal_turnover", "turn"), ("turnover_cap", "cap")):
        if overrides.get(k) is not None:
            cfg[src] = float(overrides[k])
    if space.get("kitchen_ratio") is not None:
        cfg["kitchen"] = float(space["kitchen_ratio"])
    if space.get("seat_area_sqm") is not None:
        cfg["seat"] = float(space["seat_area_sqm"])
    if space.get("normal_turnover") is not None:
        cfg["turn"] = float(space["normal_turnover"])

    ticket = float(space.get("avg_ticket") or 0)
    note = ""
    if ticket <= 0:
        ticket = 0
    if not area or area <= 0:
        return {"available": False, "note": "未提供建筑面积，空间容量未计算",
                "breakeven_revenue_monthly": r2(be_daily * 30), "turnover_per_day": -1}

    kitchen = area * cfg["kitchen"]
    operating = area - kitchen
    seats = int(operating // cfg["seat"]) if cfg["seat"] > 0 else 0
    customers = (p["daily_revenue"] / ticket) if ticket > 0 else 0
    turnover = (customers / seats) if seats > 0 else 0
    implied = seats * cfg["turn"] * ticket
    ratio = (p["daily_revenue"] / implied) if implied > 0 else 0
    be_turn = (be_daily / ticket / seats) if (ticket > 0 and seats > 0) else 0
    tgt_rev = (p["initial_investment"] / target) / max(1e-9, (p["gross_margin"] - p["tax_rate"])) / 30
    tgt_turn = (tgt_rev / ticket / seats) if (ticket > 0 and seats > 0) else 0
    rps = (p["daily_revenue"] * 30) / area
    inps = p["initial_investment"] / area

    consistency = "ok"
    if ratio > 0 and ratio < 0.4:
        consistency = "revenue_too_low"
    elif ratio > 1.3:
        consistency = "capacity_too_small"
    tmin, tmax = cfg["tmin"], cfg["tmax"]
    ticket_ok = (tmin <= ticket <= tmax) if ticket > 0 else False
    if ticket > 0 and not ticket_ok:
        note = f"客单价 {ticket} 不在该业态常规区间 {tmin}~{tmax}，确认业态标签是否贴错"

    warns = []
    if consistency == "revenue_too_low":
        warns.append(f"营收假设 {r2(p['daily_revenue'],0)} 元/日，仅为该面积常规产能（{r2(implied,0)} 元/日）的 "
                     f"{r2(ratio*100,0)}% —— 面积与营收严重不匹配：要么营收估低了，要么面积选大了")
    if consistency == "capacity_too_small":
        warns.append(f"营收是应有产能的 {r2(ratio*100,0)}%，超出该业态常规翻台上限，核实座位数与翻台假设")

    return {
        "available": True, "note": note, "area_sqm": r2(area), "kitchen_ratio": cfg["kitchen"],
        "kitchen_area_sqm": r2(kitchen), "operating_area_sqm": r2(operating),
        "seats": seats, "seat_source": "derived", "seat_area_sqm": cfg["seat"],
        "avg_ticket": ticket, "daily_customers": r2(customers, 1),
        "turnover_per_day": r2(turnover, 2), "breakeven_turnover_per_day": r2(be_turn, 2),
        "target_turnover_per_day": r2(tgt_turn, 2), "target_daily_revenue": r2(tgt_rev),
        "normal_turnover_per_day": cfg["turn"], "turnover_cap_per_day": cfg["cap"],
        "implied_daily_revenue_normal": r2(implied), "revenue_vs_normal_ratio": r2(ratio, 4),
        "input_consistency": consistency, "typical_ticket_min": tmin, "typical_ticket_max": tmax,
        "ticket_matches_format": ticket_ok,
        "revenue_per_sqm_month": r2(rps), "revenue_per_sqm_benchmark": cfg["rps"],
        "breakeven_revenue_monthly": r2(be_daily * 30), "investment_per_sqm": r2(inps),
        "warnings": warns,
    }


def build_ratio_checks(p, code, area, overrides):
    gm_r, lr_r, ip_r = ratio_bench(code)
    pick = lambda k, d: float(overrides[k]) if overrides.get(k) is not None else d
    gm_lo, gm_hi = pick("gross_margin_min", gm_r[0]), pick("gross_margin_max", gm_r[1])
    lr_lo, lr_hi = pick("labor_ratio_min", lr_r[0]), pick("labor_ratio_max", lr_r[1])
    ip_lo, ip_hi = pick("investment_per_sqm_min", ip_r[0]), pick("investment_per_sqm_max", ip_r[1])
    rev = p["daily_revenue"] * 30
    out = []
    j = lambda v, lo, hi: "ok" if lo <= v <= hi else ("low" if v < lo else "high")
    st = j(p["gross_margin"], gm_lo, gm_hi)
    out.append({"item": "毛利率", "value": r2(p["gross_margin"] * 100, 1), "unit": "%",
                "healthy_min": r2(gm_lo * 100, 1), "healthy_max": r2(gm_hi * 100, 1), "status": st,
                "note": "在常规区间内" if st == "ok" else ("高于该业态常规：可能没扣折扣/损耗" if st == "high" else "低于该业态常规：成本结构偏重或客单偏低")})
    lr = p["monthly_labor"] / rev if rev > 0 else 0
    st = j(lr, lr_lo, lr_hi)
    out.append({"item": "人力占营收", "value": r2(lr * 100, 1), "unit": "%",
                "healthy_min": r2(lr_lo * 100, 1), "healthy_max": r2(lr_hi * 100, 1), "status": st,
                "note": (f"低于该业态常规：人力大概率估少了——按 {r2(lr_lo*100,0)}% 反推应为 {round(rev*lr_lo/10000)} 万/月"
                         if st == "low" else ("高于该业态常规：人效偏低或营收估高" if st == "high" else "在常规区间内"))})
    h, w, label = rent_line(code)
    rr = p["monthly_rent"] / rev if rev > 0 else 0
    # 三档：健康线 h 以内 ok；h~w 偏高；超 w 破线（与 recommendation 判定口径一致）
    if rr <= h:
        st_rent, note_rent = "ok", f"未超健康线 {r2(h*100,1)}%"
    elif rr <= w:
        st_rent, note_rent = "watch", f"超健康线 {r2(h*100,1)}%，未破警戒线 {r2(w*100,1)}%"
    else:
        st_rent, note_rent = "breach", f"已破警戒线 {r2(w*100,1)}%"
    out.append({"item": "租售比", "value": r2(rr * 100, 1), "unit": "%",
                "healthy_min": 0, "healthy_max": r2(h * 100, 1),
                "warning_max": r2(w * 100, 1), "status": st_rent, "note": note_rent})
    if area and area > 0:
        ips = p["initial_investment"] / area
        st = j(ips, ip_lo, ip_hi)
        out.append({"item": "单方造价", "value": r2(ips, 0), "unit": "元/㎡", "healthy_min": ip_lo,
                    "healthy_max": ip_hi, "status": st,
                    "note": (f"低于该业态常规：初始投入大概率漏项——按 {round(ip_lo)} 元/㎡ 反推应为 {round(area*ip_lo/10000)} 万"
                             if st == "low" else ("高于该业态常规：确认是否含转让费/押金" if st == "high" else "在常规区间内"))})
    return out


def finance(params_raw, area=None, lease=None, space=None, target=None, catchment=None, overrides=None, code=""):
    overrides = overrides or {}
    lease = lease or {}
    space = space or {}
    p = dict(GENERIC_DEFAULTS)
    defaulted = []
    for k in PARAM_KEYS:
        v = params_raw.get(k)
        if isinstance(v, dict):
            v = v.get("value")
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = None
        if v is None:
            defaulted.append(k)
        else:
            p[k] = v
    if overrides.get("tax_rate") is not None:
        p["tax_rate"] = float(overrides["tax_rate"])
    if overrides.get("amortization_months") is not None:
        p["amortization_months"] = float(overrides["amortization_months"])

    raw_daily = p["daily_revenue"]
    cap = CATCHMENT.get((catchment or "").upper())
    if cap and cap[1] != 1:
        p["daily_revenue"] = r2(p["daily_revenue"] * cap[1])
    target = int(target or overrides.get("payback_months") or payback_for(code)[0])

    per = {k: compute_scenario(p, k, target) for k in SCENARIOS}
    base = per["base"]

    # 建议锚点：跨档取最保守
    tgt_rents = {k: per[k]["max_rent_target"] for k in SCENARIOS}
    anchor_key = min(tgt_rents, key=tgt_rents.get)
    target_rent = tgt_rents[anchor_key]
    ceiling = min(per[k]["max_rent_breakeven"] for k in SCENARIOS)
    h, w, label = rent_line(code)
    cur_ratio = p["monthly_rent"] / base["revenue"] if base["revenue"] > 0 else 0
    verdict = "ok" if cur_ratio <= h else ("watch" if cur_ratio <= w else "breach")

    space_model = build_space(p, code or "mid_dining", area, space, base["breakeven_revenue_daily"], target, overrides)
    lease_model = simulate_lease(p, area, lease, target, code, target is not None)
    checks = build_ratio_checks(p, code, area, overrides)

    ledger = []
    for k in PARAM_KEYS:
        prov = k not in defaulted
        policy = k in POLICY_KEYS
        ledger.append({"category": "口径" if policy else "财务参数", "item": k,
                       "value": str(r2(p[k], 4)),
                       "source": ("调用方提供" if prov else ("内置口径（政策默认）" if policy else "业态默认（未提供）")),
                       "action": ("可按实际校准" if policy else ("可直接用" if prov else "必须补实际值，否则结论无意义"))})
    if cap:
        ledger.append({"category": "口径", "item": "点位截流力", "value": f"{catchment.upper()} {cap[0]}",
                       "source": "现场判定", "action": f"客流 ×{cap[1]}（常规 {raw_daily} → {p['daily_revenue']}）"})

    trace = []
    if cap:
        trace.append({"group": "口径", "metric": "客流乘数",
                      "formula": f"点位截流力 {catchment.upper()}（{cap[0]}，区间 {cap[2]}）",
                      "substituted": f"常规日营业额 {raw_daily} × {cap[1]}", "result": str(p["daily_revenue"])})
    rev = p["daily_revenue"] * 30
    trace += [
        {"group": "财务", "metric": "月营业额", "formula": "日营业额 × 30", "substituted": f"{p['daily_revenue']} × 30", "result": str(r2(rev))},
        {"group": "财务", "metric": "月毛利", "formula": "月营业额 × 毛利率", "substituted": f"{r2(rev)} × {p['gross_margin']}", "result": str(r2(rev * p['gross_margin']))},
        {"group": "财务", "metric": "月税费", "formula": "月营业额 × 税费率", "substituted": f"{r2(rev)} × {p['tax_rate']}", "result": str(r2(rev * p['tax_rate']))},
        {"group": "财务", "metric": "月摊销", "formula": "初始投入 ÷ 摊销月数", "substituted": f"{p['initial_investment']} ÷ {p['amortization_months']}", "result": str(r2(p['initial_investment'] / max(1, p['amortization_months'])))},
        {"group": "财务", "metric": "月现金净流", "formula": "毛利 − 税费 − 固定成本（不含摊销）", "substituted": "见上", "result": str(base["monthly_cash_flow"])},
        {"group": "财务", "metric": "月净利（会计）", "formula": "现金净流 − 摊销", "substituted": "见上", "result": str(base["net_profit"])},
        {"group": "财务", "metric": "保本日营业额", "formula": "月固定 ÷ (毛利率 − 税费率) ÷ 30", "substituted": "见上", "result": str(base["breakeven_revenue_daily"])},
        {"group": "财务", "metric": "回本（现金·月）", "formula": "初始投入 ÷ 现金净流", "substituted": f"{p['initial_investment']} ÷ {base['monthly_cash_flow']}", "result": str(base["payback_static_months"])},
        {"group": "财务", "metric": "回本（会计·月）", "formula": "初始投入 ÷ 会计净利", "substituted": f"{p['initial_investment']} ÷ {base['net_profit']}", "result": str(base["accounting_payback_months"])},
        {"group": "租金", "metric": "极限租金·保本", "formula": "(毛利 − 税费) ÷ 成本因子 − 人力 − 其他", "substituted": "见上", "result": str(base["max_rent_breakeven"])},
        {"group": "租金", "metric": "极限租金·目标回本", "formula": "(毛利 − 税费 − 投入÷目标月数) ÷ 成本因子 − 人力 − 其他", "substituted": f"目标 {target} 月", "result": str(base["max_rent_target"])},
        {"group": "租金", "metric": "建议锚点", "formula": "min(各档极限租金·目标回本)", "substituted": f"base={tgt_rents['base']}，pess={tgt_rents['pessimistic']}，opt={tgt_rents['optimistic']}", "result": str(target_rent)},
        {"group": "租金", "metric": "租售比", "formula": "月租金 ÷ 月营业额", "substituted": f"{p['monthly_rent']} ÷ {r2(rev)}", "result": f"{r2(cur_ratio*100,1)}%"},
    ]

    sens = []
    for key, label_cn in (("daily_revenue", "日营业额"), ("gross_margin", "毛利率"),
                          ("monthly_labor", "人力成本"), ("initial_investment", "初始投入")):
        lo = dict(p); hi = dict(p)
        lo[key] = p[key] * 0.8
        hi[key] = p[key] * 1.2
        a_lo = compute_scenario(lo, "pessimistic", target)["max_rent_target"]
        a_hi = compute_scenario(hi, "pessimistic", target)["max_rent_target"]
        base_sign = target_rent - p["monthly_rent"]
        sens.append({"param": label_cn, "delta_pct": 20, "anchor_low": a_lo, "anchor_base": target_rent,
                     "anchor_high": a_hi, "gap_base": r2(p["monthly_rent"] - target_rent),
                     "conclusion_flips": (a_lo - p["monthly_rent"]) * base_sign < 0 or (a_hi - p["monthly_rent"]) * base_sign < 0})

    return {
        "per_scenario": per, "formula_version": FORMULA_VERSION, "param_version": PARAM_VERSION,
        "low_confidence_params": [], "param_defaults_used": defaulted,
        "recommendation": {
            "target_rent": target_rent, "ceiling_rent": r2(ceiling), "based_on_scenario": anchor_key,
            "gap_to_target": r2(p["monthly_rent"] - target_rent),
            "gap_to_ceiling": r2(p["monthly_rent"] - ceiling),
            "current_rent_ratio": r2(cur_ratio, 4),
            "rent_ratio_healthy_max": h, "rent_ratio_warning_max": w, "rent_ratio_label": label,
            "rent_ratio_verdict": verdict, "anchor_unreachable": target_rent < 0,
        },
        "lease_model": lease_model, "space_model": space_model,
        "ratio_checks": checks, "assumption_ledger": ledger, "sensitivity": sens,
        "formula_trace": trace,
        "catchment_code": catchment.upper() if cap else "", "catchment_label": cap[0] if cap else "",
        "catchment_multiplier": cap[1] if cap else 1,
    }


# ───────────────────────── 2. 坐标系 ─────────────────────────
_A = 6378245.0
_EE = 0.00669342162296594323


def _out_of_china(lat, lng):
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(x, y):
    ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    ret += (20 * math.sin(y * math.pi) + 40 * math.sin(y / 3 * math.pi)) * 2 / 3
    ret += (160 * math.sin(y / 12 * math.pi) + 320 * math.sin(y * math.pi / 30)) * 2 / 3
    return ret


def _transform_lng(x, y):
    ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    ret += (20 * math.sin(x * math.pi) + 40 * math.sin(x / 3 * math.pi)) * 2 / 3
    ret += (150 * math.sin(x / 12 * math.pi) + 300 * math.sin(x / 30 * math.pi)) * 2 / 3
    return ret


def wgs84_to_gcj02(lat, lng):
    if _out_of_china(lat, lng):
        return lat, lng
    dlat = _transform_lat(lng - 105, lat - 35)
    dlng = _transform_lng(lng - 105, lat - 35)
    rad = lat / 180 * math.pi
    magic = 1 - _EE * math.sin(rad) ** 2
    sqrt_magic = math.sqrt(magic)
    dlat = (dlat * 180) / ((_A * (1 - _EE)) / (magic * sqrt_magic) * math.pi)
    dlng = (dlng * 180) / (_A / sqrt_magic * math.cos(rad) * math.pi)
    return lat + dlat, lng + dlng


def haversine_m(a1, o1, a2, o2):
    R = 6371000.0
    p1, p2 = math.radians(a1), math.radians(a2)
    dp, dl = p2 - p1, math.radians(o2 - o1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def crs_guard(points, crs="gcj02"):
    out, conv = [], 0
    for p in points:
        lat, lng = float(p["lat"]), float(p["lng"])
        if crs.lower() == "wgs84":
            nlat, nlng = wgs84_to_gcj02(lat, lng)
            conv += 1
            shift = haversine_m(lat, lng, nlat, nlng)
            out.append({"name": p.get("name", ""), "lat": r2(nlat, 6), "lng": r2(nlng, 6),
                        "converted": True, "shift_m": r2(shift, 1)})
        else:
            out.append({"name": p.get("name", ""), "lat": lat, "lng": lng,
                        "converted": False, "shift_m": 0})
    return {"input_crs": crs, "converted": conv, "points": out,
            "warnings": ([] if crs.lower() == "gcj02" else [f"已把 {conv} 个 WGS84 点转成 GCJ-02"])}


# ───────────────────────── 3. 场地核查 ─────────────────────────
VETO_RULES = [
    {"id": "R001", "field": "exhaust", "level": "hard", "desc": "无排烟条件",
     "test": lambda v: v is False or (isinstance(v, str) and v.strip().lower() in ("false", "no", "0", "否"))},
    {"id": "R002", "field": "power_kw", "level": "hard", "desc": "电力容量 < 30kW",
     "test": lambda v: _num(v) is not None and _num(v) < 30},
    {"id": "R003", "field": "rent", "level": "hard", "desc": "租金占比 > 25%",
     "test": lambda v: _num(v) is not None and _num(v) > 0.25},
    {"id": "R004", "field": "frontage_m", "level": "risk", "desc": "门面宽度 < 2.4m",
     "test": lambda v: _num(v) is not None and _num(v) < 2.4},
    {"id": "R005", "field": "area_sqm", "level": "risk", "desc": "营业面积 < 30㎡（仅便利店）",
     "test": lambda v: _num(v) is not None and _num(v) < 30, "formats": r"convenience|便利店"},
]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def veto_check(fmt, fields):
    hard, risk, missing = [], [], []
    for rule in VETO_RULES:
        import re
        if rule.get("formats") and not re.search(rule["formats"], fmt or ""):
            continue
        raw = fields.get(rule["field"])
        v = raw.get("value") if isinstance(raw, dict) else raw
        if v is None or (isinstance(v, str) and v.strip() == ""):
            missing.append({"field_key": rule["field"], "required_for": [rule["id"]]})
            continue
        if rule["test"](v):
            item = {"rule_id": rule["id"], "rule_desc": rule["desc"], "field_key": rule["field"],
                    "data_basis": str(v)}
            (hard if rule["level"] == "hard" else risk).append(item)
    return {"hard_reasons": hard, "major_risks": risk, "missing_fields": missing,
            "rule_version": RULE_VERSION, "rule_source": "builtin"}


# ───────────────────────── 4. POI 去重与分段 ─────────────────────────
def _dice(a, b):
    a, b = a or "", b or ""
    if not a or not b:
        return 0.0
    sa = {a[i:i + 2] for i in range(max(1, len(a) - 1))}
    sb = {b[i:i + 2] for i in range(max(1, len(b) - 1))}
    inter = len(sa & sb)
    return 2 * inter / (len(sa) + len(sb)) if (len(sa) + len(sb)) else 0.0


def dedupe(pois, keyword="", whitelist=None):
    import re
    kept, dropped, merged = [], [], []
    def name_of(p):
        return str(p.get("name") or p.get("title") or "")
    def cat_of(p):
        return str(p.get("type") or p.get("category") or "")
    for p in pois:
        lat = _num(p.get("lat")); lng = _num(p.get("lng"))
        if lat is None or lng is None:
            loc = p.get("location")
            if isinstance(loc, dict):
                lat, lng = _num(loc.get("lat")), _num(loc.get("lng"))
        if lat is None or lng is None:
            dropped.append({"name": name_of(p), "reason": "无坐标"})
            continue
        if whitelist:
            blob = f"{name_of(p)} {cat_of(p)}"
            if not re.search(whitelist, blob):
                dropped.append({"name": name_of(p), "reason": "类目不在白名单"})
                continue
        dup = None
        for q in kept:
            d = haversine_m(lat, lng, q["lat"], q["lng"])
            same = name_of(p) == name_of(q)
            if same and d <= 50:
                dup = q; break
            # q["name"] 是字符串，name_of() 要 dict —— 传 q["name"] 会 AttributeError
            # （只有「两个不同名、距离≤30m、dice≥0.6」时才触发，selftest 恰好绕过）
            if d <= 30 and _dice(name_of(p), name_of(q)) >= 0.6:
                dup = q; break
        rec = {"name": name_of(p), "lat": lat, "lng": lng, "type": cat_of(p)}
        if dup:
            merged.append({"name": rec["name"], "into": dup["name"]})
        else:
            kept.append(rec)
    return {"raw": len(pois), "effective": len(kept), "dropped": dropped, "merged": merged, "pois": kept}


# ───────────────────────── 5. 空间分析 ─────────────────────────
TRAVEL = {"walk": (80.0, 1.35), "bike": (250.0, 1.3), "car": (537.0, 1.45)}  # 速度 m/min，绕行系数
INTERCEPT = {"heavy_distance_m": 300, "light_distance_m": 800,
             "heavy_top1_share_pct": 30, "light_top1_share_pct": 15,
             "heavy_top3_share_pct": 60, "light_top3_share_pct": 40}


def geo_analyze(clat, clng, pois, mode="walk", minutes=10, grid=100):
    speed, detour = TRAVEL.get(mode, TRAVEL["walk"])
    radius = round(speed * minutes / detour)
    inside = []
    for p in pois:
        d = haversine_m(clat, clng, p["lat"], p["lng"])
        if d <= radius:
            inside.append({**p, "distance_m": round(d)})
    inside.sort(key=lambda x: x["distance_m"])

    # 网格 Voronoi 份额
    cells = max(1, int(2 * radius / grid))
    owner = {}
    for i in range(cells):
        for j in range(cells):
            x = -radius + (i + 0.5) * (2 * radius / cells)
            y = -radius + (j + 0.5) * (2 * radius / cells)
            if math.hypot(x, y) > radius:
                continue
            dlat = y / 111320.0
            dlng = x / (111320.0 * math.cos(math.radians(clat)))
            best, bd = None, 1e18
            for p in inside:
                d = haversine_m(clat + dlat, clng + dlng, p["lat"], p["lng"])
                if d < bd:
                    bd, best = d, p
            owner[best["name"] if best else "未覆盖"] = owner.get(best["name"] if best else "未覆盖", 0) + 1
    total = sum(owner.values()) or 1
    top = sorted(({"name": k, "share_pct": r2(v / total * 100, 1)} for k, v in owner.items()),
                 key=lambda x: -x["share_pct"])

    comp = {"level": "none", "label": "无截流", "reasons": []}
    if inside:
        nearest = inside[0]
        t1 = top[0]["share_pct"] if top else 0
        t3 = round(sum(x["share_pct"] for x in top[:3]), 1)
        reasons = []
        lv = "none"
        if nearest["distance_m"] < INTERCEPT["heavy_distance_m"]:
            reasons.append(f"最近竞品 {nearest['distance_m']}m < 300m（贴脸）"); lv = "heavy"
        if t1 >= INTERCEPT["heavy_top1_share_pct"]:
            reasons.append(f"Top1 占 {t1}% ≥ 30%（单一强势玩家）"); lv = "heavy"
        if t3 >= INTERCEPT["heavy_top3_share_pct"]:
            reasons.append(f"Top3 合计 {t3}% ≥ 60%（头部包围）"); lv = "heavy"
        if lv != "heavy":
            if nearest["distance_m"] < INTERCEPT["light_distance_m"]:
                reasons.append(f"最近竞品 {nearest['distance_m']}m < 800m（同街竞争）"); lv = "light"
            if t1 >= INTERCEPT["light_top1_share_pct"]:
                reasons.append(f"Top1 占 {t1}% ≥ 15%"); lv = "light"
            if t3 >= INTERCEPT["light_top3_share_pct"]:
                reasons.append(f"Top3 合计 {t3}% ≥ 40%"); lv = "light"
        if lv == "none":
            reasons.append("竞品距离与份额均未触发截流阈值（竞争分散）")
        comp = {"level": lv, "label": {"none": "无截流", "light": "轻度分流", "heavy": "重度截流"}[lv],
                "reasons": reasons,
                "nearest": nearest["name"], "nearest_m": nearest["distance_m"],
                "top1": top[0]["name"] if top else "", "top1_pct": t1, "top3_pct": t3}
    return {"radius_m": radius, "inside": len(inside), "top": top[:8],
            "nearest": inside[:3], "competition": comp, "thresholds": INTERCEPT}


# ───────────────────────── 6. 行业基准 ─────────────────────────
def benchmark(city, fmt, **kw):
    here = os.path.dirname(os.path.abspath(__file__))
    path = kw.get("benchmarks_path") or os.path.join(here, "..", "data", "benchmarks.json")
    if not os.path.exists(path):
        return {"matched": False, "note": "未找到 data/benchmarks.json，先跑 import-benchmarks.py 生成"}
    with open(path, encoding="utf-8-sig") as f:
        rows = json.load(f)["rows"]
    _alias = resolve_alias(fmt)
    if _alias:
        fmt = _alias
    cands = {r["format"] for r in rows if r.get("format")}
    def score(f):
        if f == fmt:
            return 100
        s = 0
        if fmt and (fmt in f or f in fmt):
            s += 20
        for tok in [t for t in (fmt or "").replace("(", " ").replace(")", " ").split() if len(t) >= 2]:
            if tok in f:
                s += 10
        return s
    best = max(cands, key=score, default=None)
    if not best or score(best) == 0:
        avail = sorted(cands)
        return {"matched": False,
                "note": (f"未匹配到业态「{fmt}」。`--format` 要传基准库里的业态名，"
                         f"或先在 data/formats.json 里给该业态配 benchmark_format 别名。"),
                "available_formats": avail,
                "available_count": len(avail),
                "hint": "python -c \"import json;d=json.load(open('data/benchmarks.json',encoding='utf-8'));print(chr(10).join(sorted({r['format'] for r in d['rows']})))\""}
    allrows = [r for r in rows if r["format"] == best]
    pbs = sorted([r["payback_months"] for r in allrows if r.get("payback_months")])
    med = pbs[len(pbs) // 2] if pbs else 0
    same = next((r for r in allrows if r["city"] == city), None)
    if same is None:
        avail = sorted({r["city"] for r in allrows})
        return {"matched": True, "city": city, "city_in_benchmark": False,
                "matched_format": best, "sample_size": len(allrows),
                "available_cities": avail,
                "note": (f"基准库没有「{city}」的数据，已覆盖城市：{'、'.join(avail)}。"
                         f"为避免误导，不自动套用其他城市——请补录该城市基准，"
                         f"或改用邻近城市并在此处写明来源。")}
    compares = []
    def add(item, ours, bench, unit):
        if ours is None or not bench:
            return
        dev = r2((ours - bench) / abs(bench) * 100, 1)
        verdict = "ok" if abs(dev) <= 30 else ("high" if dev > 0 else "low")
        compares.append({"item": item, "ours": ours, "benchmark": bench, "deviation_pct": dev,
                         "unit": unit, "verdict": verdict,
                         "note": "在基准 ±30% 内" if verdict == "ok" else ("高于行业基准 30% 以上" if dev > 0 else "低于行业基准 30% 以上")})
    add("营业面积", kw.get("area"), same.get("area_sqm"), "㎡")
    add("初始投资", kw.get("investment_wan"), same.get("investment_wan"), "万元")
    add("月租金", kw.get("rent_wan"), same.get("rent_wan"), "万元")
    add("客单价", kw.get("ticket"), same.get("avg_ticket"), "元")
    add("月营业额", kw.get("revenue_wan"), same.get("revenue_wan"), "万元")
    add("会计口径回本", kw.get("payback"), same.get("payback_months"), "月")
    add("净利率", r2(kw["margin"] * 100, 1) if kw.get("margin") is not None else None,
        r2(same["net_margin"] * 100, 1) if same.get("net_margin") else None, "%")
    flagged = [c for c in compares if c["verdict"] != "ok"]
    return {"matched": True, "city": city, "matched_format": best, "sample_size": len(allrows),
            "payback_median": med, "payback_min": pbs[0] if pbs else 0, "payback_max": pbs[-1] if pbs else 0,
            "benchmark": same, "compares": compares,
            "note": (f"各项均在基准 ±30% 内" if not flagged else
                     f"有 {len(flagged)} 项偏离基准超过 30%：" + "、".join(f"{c['item']} {c['deviation_pct']:+.1f}%" for c in flagged))}


# ───────────────────────── 自测 ─────────────────────────
def selftest():
    ok = fail = 0
    def chk(label, cond):
        nonlocal ok, fail
        if cond:
            ok += 1; print(f"PASS  {label}")
        else:
            fail += 1; print(f"FAIL  {label}")

    P = {"daily_revenue": 30000, "gross_margin": 0.62, "monthly_rent": 120000,
         "monthly_labor": 150000, "monthly_other_fixed": 40000, "initial_investment": 3200000}
    r = finance(P, area=1200, space={"avg_ticket": 230}, catchment="L2", code="large_yuecai")
    b = r["per_scenario"]["base"]
    chk("L2 乘数 1.10 生效（营收 990000）", abs(b["revenue"] - 990000) < 1)
    chk("现金净流 259250", abs(b["monthly_cash_flow"] - 259250) < 1)
    chk("会计净利 205916.67", abs(b["net_profit"] - 205916.67) < 1)
    chk("现金回本 12.3", abs(b["payback_static_months"] - 12.3) < 0.05)
    chk("会计回本 15.5", abs(b["accounting_payback_months"] - 15.5) < 0.05)
    chk("极限租金保本 379250", abs(b["max_rent_breakeven"] - 379250) < 1)
    chk("锚点取保守档 186165.34", abs(r["recommendation"]["target_rent"] - 186165.34) < 1)
    chk("距锚点为负（无需降）", r["recommendation"]["gap_to_target"] < 0)
    chk("座位数 278", r["space_model"]["seats"] == 278)
    chk("面积产能校验触发 revenue_too_low", r["space_model"]["input_consistency"] == "revenue_too_low")
    chk("比值校验 4 项", len(r["ratio_checks"]) == 4)
    chk("台账含截流力一行", any(x["item"] == "点位截流力" for x in r["assumption_ledger"]))
    chk("口径台账 ≥ 13 行", len(r["formula_trace"]) >= 13)

    c = crs_guard([{"name": "t", "lat": 23.1035, "lng": 113.2361}], "wgs84")
    chk("WGS84→GCJ02 偏移 100~800m", 100 < c["points"][0]["shift_m"] < 800)
    chk("GCJ02 输入不转换", crs_guard([{"lat": 23.1, "lng": 113.2}], "gcj02")["converted"] == 0)

    v = veto_check("large_yuecai", {"exhaust": False, "power_kw": 10})
    chk("排烟缺失 + 电力不足 → 2 条硬伤", len(v["hard_reasons"]) == 2)
    chk("未提供字段进 missing", len(v["missing_fields"]) > 0)

    pois = [{"name": "粤菜A", "lat": 23.1035, "lng": 113.2361},
            {"name": "粤菜A", "lat": 23.1035, "lng": 113.2362},
            {"name": "粤菜B", "lat": 23.11, "lng": 113.24}]
    d = dedupe(pois)
    chk("同名近距合并", d["effective"] == 2 and len(d["merged"]) == 1)

    g = geo_analyze(23.1035, 113.2361, [{"name": "x", "lat": 23.1036, "lng": 113.2362}], "walk", 10)
    chk("步行 10 分半径 ≈ 593m", abs(g["radius_m"] - 593) <= 2)
    chk("截流定级有结果", g["competition"]["level"] in ("none", "light", "heavy"))

    print(f"\n{ok}/{ok + fail} 通过")
    return 0 if fail == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["finance", "crs", "veto", "dedupe", "geo", "benchmark", "formats", "selftest"])
    ap.add_argument("--params"); ap.add_argument("--area", type=float); ap.add_argument("--catchment")
    ap.add_argument("--target", type=int); ap.add_argument("--lease"); ap.add_argument("--space")
    ap.add_argument("--overrides"); ap.add_argument("--points"); ap.add_argument("--crs", default="gcj02")
    ap.add_argument("--format"); ap.add_argument("--fields"); ap.add_argument("--pois"); ap.add_argument("--keyword")
    ap.add_argument("--whitelist"); ap.add_argument("--center"); ap.add_argument("--minutes", type=int, default=10)
    ap.add_argument("--mode", default="walk"); ap.add_argument("--grid", type=int, default=100)
    ap.add_argument("--city"); ap.add_argument("--investment-wan", type=float); ap.add_argument("--rent-wan", type=float)
    ap.add_argument("--ticket", type=float); ap.add_argument("--revenue-wan", type=float)
    ap.add_argument("--payback", type=float); ap.add_argument("--margin", type=float)
    ap.add_argument("--out")
    ap.add_argument("--benchmarks", help="自定义基准库路径（默认 data/benchmarks.json）")
    ap.add_argument("--formats", help="自定义业态规则路径（默认 data/formats.json）")
    a = ap.parse_args()
    j = lambda p: json.load(open(p, encoding="utf-8-sig")) if p and os.path.exists(p) else {}

    if a.cmd == "selftest":
        sys.exit(selftest())
    if a.cmd == "finance":
        raw = j(a.params)
        raw = raw.get("params", raw)
        res = finance(raw, a.area, j(a.lease), j(a.space), a.target, a.catchment, j(a.overrides), a.format or "")
    elif a.cmd == "crs":
        res = crs_guard(j(a.points), a.crs)
    elif a.cmd == "veto":
        res = veto_check(a.format or "", j(a.fields))
    elif a.cmd == "dedupe":
        res = dedupe(j(a.pois), a.keyword or "", a.whitelist)
    elif a.cmd == "geo":
        lat, lng = (float(x) for x in a.center.split(","))
        res = geo_analyze(lat, lng, j(a.pois), a.mode, a.minutes, a.grid)
    elif a.cmd == "formats":
        n_ext = load_format_rules(a.formats) if a.formats else FORMAT_RULE_COUNT
        res = {"source": a.formats or FORMATS_FILE,
               "external_rules": n_ext,
               "total_rules": len(PAYBACK_BY_FORMAT),
               "rules": list_formats()}
    else:
        if a.formats:
            load_format_rules(a.formats)
        res = benchmark(a.city or "", a.format or "", benchmarks_path=a.benchmarks,
                        area=a.area, investment_wan=a.investment_wan,
                        rent_wan=a.rent_wan, ticket=a.ticket, revenue_wan=a.revenue_wan,
                        payback=a.payback, margin=a.margin)

    text = json.dumps(res, ensure_ascii=False, indent=2)
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        open(a.out, "w", encoding="utf-8").write(text)
        print(f"已写入 {a.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
