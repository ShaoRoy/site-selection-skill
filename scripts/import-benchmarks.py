#!/usr/bin/env python3
"""
import-benchmarks.py —— 把《餐饮业态分城市GIS数据底稿.xlsx》转成机器可读 JSON 并做质检

产出：
  tools/base-data/cities.json    城市基准（19 城：人口/租金/客单/增速/商圈）
  tools/base-data/formats.json   城市×业态矩阵（912 行）
  tools/base-data/density.json   本地业态密度
  tools/base-data/README.md      口径与质检结论

质检内容：空值统计、公式自洽性（营收=客单×客流×30、净利=营收×净利率、回本=投资/净利）、
         异常区间（面积为 0、客单为 0、回本为负等）。

用法：
  python tools/import-benchmarks.py --src "F:\\Claude Roy\\餐饮业态分城市GIS数据底稿.xlsx"
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

try:
    import openpyxl
except ImportError:
    sys.exit("需要 openpyxl：pip install openpyxl")

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "base-data")


def norm(v):
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return v


def num(v):
    """从单元格里抠数字；'约5500'、'7500+' 之类返回 None（不是可比数值）。"""
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        try:
            return float(s)
        except ValueError:
            return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--check", action="store_true",
                    help="dry-run：只解析与统计，不覆盖 src/benchmark-data.ts")
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.src, data_only=True)

    # ── Sheet2：城市×业态矩阵
    ws2 = wb["2-城市×业态回本矩阵"]
    hdr = [norm(c.value) for c in ws2[1]]
    idx = {name: i for i, name in enumerate(hdr) if name}

    def cell(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    formats = []
    issues = defaultdict(list)
    for row in ws2.iter_rows(min_row=2, values_only=True):
        if not norm(row[0]):
            continue
        rec = {
            "city": norm(cell(row, "城市")),
            "city_level": norm(cell(row, "城市级别")),
            "category": norm(cell(row, "业态大类")),
            "format": norm(cell(row, "具体业态")),
            "area_sqm": num(cell(row, "典型面积(㎡)")),
            "investment_wan": num(cell(row, "初始投资(万)")),
            "rent_wan": num(cell(row, "月租金(万)")),
            "avg_ticket": num(cell(row, "客单价(元)")),
            "daily_customers": num(cell(row, "日均客流(人)")),
            "revenue_wan": num(cell(row, "月营收(万)")),
            "net_margin": num(cell(row, "净利率")),
            "net_profit_wan": num(cell(row, "月净利(万)")),
            "payback_months": num(cell(row, "回本月数")),
            "note": norm(cell(row, "数据口径/备注")),
        }
        # 三个公式列在源文件里没有缓存值，按《口径说明》自行推导（并在下面交叉校验）
        rt, rc = rec["avg_ticket"], rec["daily_customers"]
        if rec["revenue_wan"] is None and rt and rc:
            rec["revenue_wan"] = round(rt * rc * 30 / 10000, 2)
        if rec["net_profit_wan"] is None and rec["revenue_wan"] and rec["net_margin"] is not None:
            nm = rec["net_margin"]
            if nm > 1:          # 源表可能写成 15 而不是 0.15
                nm = nm / 100
            rec["net_margin"] = nm
            rec["net_profit_wan"] = round(rec["revenue_wan"] * nm, 2)
        if rec["payback_months"] is None and rec["investment_wan"] and rec["net_profit_wan"]:
            if rec["net_profit_wan"] > 0:
                rec["payback_months"] = round(rec["investment_wan"] / rec["net_profit_wan"], 1)

        # 公式自洽性
        t, c, r = rec["avg_ticket"], rec["daily_customers"], rec["revenue_wan"]
        if t and c and r and abs(t * c * 30 / 10000 - r) / max(r, 1e-6) > 0.05:
            issues["营收与公式不符(>5%)"].append(f"{rec['city']}/{rec['format']} 表内{r} 算得{t * c * 30 / 10000:.2f}")
        if r and rec["net_margin"] and rec["net_profit_wan"] is not None:
            calc = r * rec["net_margin"]
            if abs(calc - rec["net_profit_wan"]) > 0.05:
                issues["净利与公式不符"].append(f"{rec['city']}/{rec['format']} 表内{rec['net_profit_wan']} 算得{calc:.2f}")
        if rec["investment_wan"] and rec["net_profit_wan"]:
            calc = rec["investment_wan"] / rec["net_profit_wan"]
            if abs(calc - (rec["payback_months"] or 0)) > 1:
                issues["回本与公式不符"].append(f"{rec['city']}/{rec['format']} 表内{rec['payback_months']} 算得{calc:.1f}")
        # 空值
        for k, v in rec.items():
            if v is None and k not in ("note",):
                issues[f"空值:{k}"].append(f"{rec['city']}/{rec['format']}")
        # 异常区间
        if rec["area_sqm"] is not None and rec["area_sqm"] <= 0:
            issues["面积<=0"].append(f"{rec['city']}/{rec['format']}")
        if rec["avg_ticket"] is not None and rec["avg_ticket"] <= 0:
            issues["客单<=0"].append(f"{rec['city']}/{rec['format']}")
        if rec["payback_months"] is not None and rec["payback_months"] <= 0:
            issues["回本<=0"].append(f"{rec['city']}/{rec['format']}")
        formats.append(rec)

    # ── Sheet1：城市基准
    ws1 = wb["1-城市基础参数"]
    h1 = [norm(c.value) for c in ws1[1]]
    i1 = {n: i for i, n in enumerate(h1) if n}
    cities = []
    for row in ws1.iter_rows(min_row=2, values_only=True):
        if not norm(row[0]):
            continue
        g = lambda n: norm(row[i1[n]]) if n in i1 and i1[n] < len(row) else None
        cities.append({
            "city": g("城市"),
            "city_level": g("城市级别"),
            "population_wan": num(g("常住人口(万)")),
            "restaurant_count_raw": g("餐饮门店总数(估)"),
            "mall_gf_rent_per_sqm": num(g("购物中心首层租金(元/㎡/月)")),
            "street_shop_rent_per_sqm_day": num(g("社区街铺租金(元/㎡/天)")),
            "avg_ticket": num(g("餐饮人均客单价(元)")),
            "growth_2025": g("2025餐饮大盘增速"),
            "key_districts": g("重点商圈参考"),
            "source": g("数据来源"),
        })

    # ── Sheet3：业态密度
    ws3 = wb["3-本地业态密度"]
    h3 = [norm(c.value) for c in ws3[1]]
    i3 = {n: i for i, n in enumerate(h3) if n}
    density = []
    for row in ws3.iter_rows(min_row=2, values_only=True):
        if not norm(row[0]):
            continue
        g = lambda n: norm(row[i3[n]]) if n in i3 and i3[n] < len(row) else None
        density.append({
            "city": g("城市"),
            "category": g("品类/业态"),
            "count_raw": g("门店数量"),
            "count": num(g("门店数量")),
            "year": g("统计年份"),
            "source": g("数据来源"),
            "note": g("备注"),
        })

    # ── Sheet4：口径
    ws4 = wb["4-口径说明"]
    meta = [(norm(r[0]), norm(r[1])) for r in ws4.iter_rows(min_row=2, values_only=True) if norm(r[0])]

    os.makedirs(OUT_DIR, exist_ok=True)

    def dump(name, obj):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        return path

    dump("cities.json", {"meta": meta, "cities": cities})
    dump("formats.json", {"source": os.path.basename(args.src), "rows": formats})
    dump("density.json", {"rows": density})

    # ── 同时生成 TypeScript 数据模块：插件运行时零文件 IO，也不需要 @types/node
    def num_or(v, default=-1):
        return v if v is not None else default

    city_names = sorted({c["city"] for c in cities if c["city"]})
    format_names = sorted({r["format"] for r in formats if r["format"]})
    cat_names = sorted({r["category"] for r in formats if r["category"]})
    ci = {n: i for i, n in enumerate(city_names)}
    fi = {n: i for i, n in enumerate(format_names)}
    ki = {n: i for i, n in enumerate(cat_names)}

    ts = [
        "/* 自动生成，请勿手改。来源：tools/import-benchmarks.py */",
        "/* 数据出处见 docs/行业基准-口径说明.md 与 base-data/ */",
        "",
        f"export const BENCH_SOURCE = {json.dumps(os.path.basename(args.src), ensure_ascii=False)}",
        f"export const BENCH_CITIES: readonly string[] = {json.dumps(city_names, ensure_ascii=False)}",
        f"export const BENCH_FORMATS: readonly string[] = {json.dumps(format_names, ensure_ascii=False)}",
        f"export const BENCH_CATEGORIES: readonly string[] = {json.dumps(cat_names, ensure_ascii=False)}",
        "",
        "/** [城市idx, 业态idx, 大类idx, 面积㎡, 投资万, 租金万, 客单, 日客流, 月营收万, 净利率, 月净利万, 回本月] */",
        "export const BENCH_ROWS: readonly (readonly number[])[] = [",
    ]
    for r in formats:
        ts.append(
            "  [%d, %d, %d, %s, %s, %s, %s, %s, %s, %s, %s, %s],"
            % (
                ci.get(r["city"], -1), fi.get(r["format"], -1), ki.get(r["category"], -1),
                num_or(r["area_sqm"]), num_or(r["investment_wan"]), num_or(r["rent_wan"]),
                num_or(r["avg_ticket"]), num_or(r["daily_customers"]), num_or(r["revenue_wan"]),
                num_or(r["net_margin"]), num_or(r["net_profit_wan"]), num_or(r["payback_months"]),
            )
        )
    ts.append("]")
    ts.append("")
    ts.append("/** 城市基准：名称、级别、人口万、购物中心首层租金、街铺租金/天、客单 */")
    ts.append("export const CITY_BASELINES: readonly (readonly [string, string, number, number, number, number])[] = [")
    for c in cities:
        if not c["city"]:
            continue
        ts.append(
            "  [%s, %s, %s, %s, %s, %s],"
            % (
                json.dumps(c["city"], ensure_ascii=False),
                json.dumps(c["city_level"] or "", ensure_ascii=False),
                num_or(c["population_wan"], 0), num_or(c["mall_gf_rent_per_sqm"], 0),
                num_or(c["street_shop_rent_per_sqm_day"], 0), num_or(c["avg_ticket"], 0),
            )
        )
    ts.append("]")
    ts.append("")

    ts_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "benchmark-data.ts")
    if args.check:
        # dry-run：直接覆盖源码风险太大，先让人看一眼统计
        print(f"[check] 将生成 {len(ts)} 行，目标文件 {os.path.normpath(ts_path)}（未写入）")
        print("[check] 确认无误后去掉 --check 再跑一次")
    else:
        with open(ts_path, "w", encoding="utf-8") as f:
            f.write("\n".join(ts))
        print(f"已生成 TS 数据模块：{os.path.normpath(ts_path)}")

    # ── 质检报告
    print(f"矩阵：{len(formats)} 行｜城市 {len({r['city'] for r in formats})}｜业态 {len({r['format'] for r in formats})}")
    print(f"城市基准：{len(cities)} 城｜业态密度：{len(density)} 条")
    print("\n=== 质检 ===")
    if not issues:
        print("  ✅ 无异常")
    for k, v in sorted(issues.items(), key=lambda kv: -len(kv[1])):
        print(f"  {k}: {len(v)} 条｜例：{v[0]}")
    print(f"\n已写入 {OUT_DIR}")


if __name__ == "__main__":
    main()
