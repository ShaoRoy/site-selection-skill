#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""report-html.py —— 选址分析报告的 HTML 渲染器（强制出口）

**规则（SKILL.md「报告交付」硬性要求）**：任何一次选址分析，最终交付物**必须**是
一个自包含单文件 HTML，并且在报告正文与终端输出里**明确写出该文件的绝对路径**。
Markdown / 控制台文字只作为中间产物，不作为交付。

用法：

    # 从一份评估结果 JSON 渲染（最少用法）
    python scripts/report-html.py --result out/site-xxx/finance-result.json

    # 带齐上下文（推荐）
    python scripts/report-html.py \
        --result   out/site-花城汇南区/finance-result.json \
        --site     "花城汇南区" \
        --address  "广州市天河区珠江新城 花城汇南区 1F" \
        --meta     out/site-花城汇南区/meta.json \
        --out      out/reports

输出：
    <out>/<slug>-<YYYYMMDD-HHMM>.html
    并在 stdout 打印 `REPORT_PATH=<绝对路径>`（便于脚本捕获）

设计约束：
  · 单文件自包含：CSS 内联，无外部字体/JS/CDN 依赖，断网可看
  · 不引入第二套数据口径：所有数字原样取自引擎输出，渲染层不做任何再计算
  · 缺失段落必须写明「未计算 / 缺什么 / 怎么补」，不允许留空或编造
"""

import argparse
import html
import json
import os
import re
import sys
import unicodedata
from datetime import datetime

DEFAULT_OUT_DIR = "out/reports"


# ─────────────────────────── 工具 ───────────────────────────

def slugify(text, fallback="report"):
    """中文也能得到稳定文件名：保留中文与字母数字，其余转连字符"""
    if not text:
        return fallback
    s = unicodedata.normalize("NFKC", str(text)).strip()
    s = re.sub(r"[\\/:*?\"<>|\s]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s[:60] or fallback


def load_json(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def fmt_money(v, unit="元"):
    if v is None:
        return "—"
    try:
        n = float(v)
    except (TypeError, ValueError):
        return html.escape(str(v))
    if abs(n) >= 1e8:
        return f"{n/1e8:,.2f} 亿{unit}"
    if abs(n) >= 1e4:
        return f"{n/1e4:,.1f} 万{unit}"
    return f"{n:,.0f} {unit}"


def fmt_num(v, digits=0, suffix=""):
    if v is None:
        return "—"
    try:
        n = float(v)
    except (TypeError, ValueError):
        return html.escape(str(v))
    return f"{n:,.{digits}f}{suffix}"


def verdict_class(v):
    """把引擎的 verdict / label 映射成 CSS 类"""
    s = str(v or "").lower()
    if s in ("breach", "fail", "high", "low", "bad", "unreachable"):
        return "v-bad"
    if s in ("tight", "warning", "warn", "mid", "medium"):
        return "v-warn"
    if s in ("ok", "healthy", "good", "pass", "true"):
        return "v-ok"
    return ""


def badge(text, cls=""):
    return f'<span class="badge {cls}">{html.escape(str(text))}</span>'


# ─────────────────────────── 渲染 ───────────────────────────

CSS = """
:root{
  --bg:#fbfbfa; --card:#fff; --ink:#1a1a19; --muted:#6b6a68; --line:#e5e3df;
  --ok:#0f7b3f; --okbg:#e8f5ec; --bad:#b3261e; --badbg:#fdeceb;
  --warn:#8a5a00; --warnbg:#fdf3e0; --accent:#2f5d50;
}
*{box-sizing:border-box}
body{margin:0;padding:0;background:var(--bg);color:var(--ink);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:40px 28px 80px}
header{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:32px}
h1{margin:0 0 10px;font-size:28px;letter-spacing:-.3px;line-height:1.3}
.sub{color:var(--muted);font-size:13.5px;line-height:1.9}
.sub code{background:#f1efeb;padding:1px 6px;border-radius:3px;font-size:12.5px}
h2{font-size:19px;margin:38px 0 14px;padding-left:11px;border-left:4px solid var(--accent);line-height:1.4}
h3{font-size:15.5px;margin:24px 0 10px;color:#333}
table{width:100%;border-collapse:collapse;margin:12px 0 18px;font-size:14px;background:var(--card)}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#f4f2ee;font-weight:600;font-size:13px;color:#4a4947;white-space:nowrap}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;line-height:1.7}
.v-ok{background:var(--okbg);color:var(--ok)}
.v-bad{background:var(--badbg);color:var(--bad)}
.v-warn{background:var(--warnbg);color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin:14px 0}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:16px 0}
.kpi .box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.kpi .lab{font-size:12px;color:var(--muted);margin-bottom:6px}
.kpi .val{font-size:21px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.kpi .val.bad{color:var(--bad)}
.kpi .val.ok{color:var(--ok)}
.kpi .note{font-size:12px;color:var(--muted);margin-top:4px}
.callout{border-radius:8px;padding:14px 18px;margin:16px 0;font-size:14px;line-height:1.7}
.callout.bad{background:var(--badbg);border-left:4px solid var(--bad)}
.callout.warn{background:var(--warnbg);border-left:4px solid var(--warn)}
.callout.ok{background:var(--okbg);border-left:4px solid var(--ok)}
.callout.info{background:#eef3f1;border-left:4px solid var(--accent)}
.missing{color:var(--muted);font-style:italic}
ul,ol{margin:10px 0 14px;padding-left:22px}
li{margin:5px 0}
details{margin:12px 0;border:1px solid var(--line);border-radius:8px;background:var(--card)}
summary{cursor:pointer;padding:11px 16px;font-weight:600;font-size:14px;user-select:none}
details[open] summary{border-bottom:1px solid var(--line)}
details .inner{padding:14px 16px}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12.5px;line-height:1.9}
footer code{background:#f1efeb;padding:1px 6px;border-radius:3px;word-break:break-all}
.pathbox{background:#1f2421;color:#e8f0ec;border-radius:8px;padding:14px 18px;margin:16px 0;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.8;word-break:break-all}
.pathbox .k{color:#8fb3a6}
.tag{display:inline-block;background:#f1efeb;color:#55534f;padding:1px 7px;border-radius:3px;
  font-size:12px;margin-right:6px}
"""


def sec_missing(title, reason, how):
    return (f'<h2>{html.escape(title)}</h2>\n'
            f'<div class="callout warn"><strong>本段未计算。</strong>{html.escape(reason)}'
            f'<br>补齐方式：{html.escape(how)}</div>\n')


def render(result, site, address, meta, report_path):
    r = result or {}
    per = r.get("per_scenario", {}) or {}
    rec = r.get("recommendation", {}) or {}
    lease = r.get("lease_model", {}) or {}
    space = r.get("space_model")
    bench = (meta or {}).get("benchmark") or r.get("benchmark")
    comps = (meta or {}).get("competitors")
    demand = (meta or {}).get("demand")
    grid = (meta or {}).get("grid")
    veto = (meta or {}).get("veto")
    fields = (meta or {}).get("fields")
    ledger = r.get("assumption_ledger") or r.get("param_defaults_used") or []

    base = per.get("base", {}) or {}
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    out = []
    A = out.append

    A('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">')
    A('<meta name="viewport" content="width=device-width,initial-scale=1">')
    A(f'<title>{html.escape(site or "选址分析报告")} · 三筛评估</title>')
    A(f'<style>{CSS}</style></head><body><div class="wrap">')

    # ── 页头
    A('<header>')
    A(f'<h1>{html.escape(site or "选址分析报告")}</h1>')
    A('<div class="sub">')
    if address:
        A(f'点位：{html.escape(address)}<br>')
    A(f'生成时间：{now}　｜　引擎：<code>{html.escape(str(r.get("formula_version", "—")))}</code>'
      f'　｜　参数档：<code>{html.escape(str(r.get("param_version", "—")))}</code>')
    A('</div></header>')

    # ── 报告路径（硬性要求：必须写出）
    A('<div class="pathbox">')
    A('<span class="k">本报告已保存到：</span><br>')
    A(html.escape(report_path))
    A('</div>')

    # ── 结论
    A('<h2>结论</h2>')
    anchor_bad = rec.get("anchor_unreachable") is True
    cash = base.get("monthly_cash_flow")
    payback = base.get("payback_static_months")
    rr = rec.get("current_rent_ratio")
    rr_v = rec.get("rent_ratio_verdict")
    if cash is not None and float(cash) < 0:
        head = "按当前参数，该点位在财务上不成立——月现金净流为负，回本不可达。"
        cls = "bad"
    elif payback is not None and float(payback) > 0:
        head = f"按当前参数，该点位现金回本约 {float(payback):.1f} 个月。"
        cls = "ok"
    else:
        head = "按当前参数，结论无法判定（关键参数缺失）。"
        cls = "warn"
    A(f'<div class="callout {cls}">{html.escape(head)}</div>')

    A('<div class="kpi">')
    def kpi(lab, val, note="", bad=False, ok=False):
        c = "bad" if bad else ("ok" if ok else "")
        A(f'<div class="box"><div class="lab">{html.escape(lab)}</div>'
          f'<div class="val {c}">{html.escape(val)}</div>'
          f'<div class="note">{html.escape(note)}</div></div>')
    kpi("月现金净流（基准）", fmt_money(cash),
        "毛利 − 税费 − 固定成本", bad=(cash is not None and float(cash) < 0))
    kpi("回本（现金口径）", "不可达" if payback == -1 else fmt_num(payback, 1, " 个月"),
        "初始投入 ÷ 月现金净流", bad=(payback == -1))
    kpi("租售比", fmt_num(float(rr) * 100, 1, "%") if rr is not None else "—",
        f"健康 ≤10% / 警戒 ≤15%（{rec.get('rent_ratio_label', '')}）",
        bad=(rr_v == "breach"))
    kpi("极限租金（保本）", fmt_money(rec.get("ceiling_rent")),
        "超过此租金月现金即转负" if rec.get("ceiling_rent") is not None else "")
    A('</div>')

    if anchor_bad:
        A('<div class="callout bad"><strong>谈判锚点为负（anchor_unreachable = true）。</strong>'
          f'按当前营收模型，目标回本所需租金为 {fmt_money(rec.get("target_rent"))}——'
          '即使把租金谈到 0 也回不了本。这不是「租金贵」的问题，靠压租金解决不了。</div>')

    # ── 数据质量
    A('<h2>数据质量</h2>')
    dq = []
    if demand:
        dq.append(f"需求侧：需求强度 {fmt_num(demand.get('strength'), 1, '/100')}"
                  f"（完整度 {fmt_num(demand.get('completeness'), 0, '%')}，"
                  f"置信度 {demand.get('confidence', '—')}）")
    if comps:
        dq.append(f"竞品：3km 内 {comps.get('count', len(comps) if isinstance(comps, list) else '—')} 家")
    if not dq:
        dq.append("本次未附采集快照，数据来源见《口径》段")
    A('<ul>' + ''.join(f'<li>{html.escape(x)}</li>' for x in dq) + '</ul>')

    miss = []
    if not bench:
        miss.append("行业对标未执行")
    if not space:
        miss.append("空间容量未计算（缺 area_sqm 或座位参数）")
    if miss:
        A('<div class="callout warn">缺失项：' + html.escape('；'.join(miss)) +
          '。这些不影响已给出的财务结论，但会少一层交叉验证。</div>')

    # ── 竞品格局
    if comps and isinstance(comps, dict) and comps.get("top5"):
        A('<h2>竞品格局</h2>')
        A(f'<p>步行商圈半径 {fmt_num(comps.get("walk_radius_m"), 0, " m")}，'
          f'圈内竞品 {comps.get("inside", "—")} 家。份额前五：</p>')
        A('<table><thead><tr><th>竞品</th><th class="num">份额</th><th class="num">距离</th></tr></thead><tbody>')
        for c in comps["top5"]:
            A(f'<tr><td>{html.escape(str(c.get("name", "")))}</td>'
              f'<td class="num">{fmt_num(c.get("share_pct"), 1, "%")}</td>'
              f'<td class="num">{fmt_num(c.get("distance_m"), 0, " m")}</td></tr>')
        A('</tbody></table>')
    elif comps:
        A('<h2>竞品格局</h2>')
        if isinstance(comps, dict) and comps.get("nearest") is not None:
            A(f'<p>最近同业态竞品距离 <strong>{fmt_num(comps.get("nearest"), 0, " m")}</strong>，'
              f'3km 内共 {comps.get("count", "—")} 家。</p>')
        else:
            A('<p class="missing">竞品明细见数据文件，本报告未内联。</p>')
    else:
        A(sec_missing("竞品格局", "本次未提供竞品采集结果。",
                      "跑 `demand-fetch.py` 与 `geo` 后把结果写入 meta.json 的 competitors 字段"))

    # ── 需求侧
    if demand:
        A('<h2>需求侧</h2>')
        A('<div class="kpi">')
        kpi("需求强度", fmt_num(demand.get("strength"), 1, "/100"),
            demand.get("confidence", ""))
        kpi("住宅密度", fmt_num(demand.get("residential_density"), 1, " 个/km²"), "3000m 半径")
        kpi("职住比", fmt_num(demand.get("job_housing_ratio"), 2),
            ">1 表示办公人口多于居住人口")
        kpi("最近地铁", fmt_num(demand.get("nearest_metro_m"), 0, " m"),
            demand.get("nearest_metro_name", ""))
        A('</div>')
        A('<div class="callout info">以上为 <strong>POI 代理指标</strong>，不是实测人流。'
          '街道级真实人口无可用的免费来源，本系统一律用代理替代，引用时须保留「代理」标注。</div>')
    else:
        A(sec_missing("需求侧", "本次未提供需求采集结果。",
                      "跑 `python scripts/demand-fetch.py \"<地址>\" --radius 3000`"))

    # ── 场地
    A('<h2>场地：待核实清单</h2>')
    if veto:
        hf = veto.get("missing_fields") or []
        hr = veto.get("hard_reasons") or []
        A(f'<p>规则版本 <code>{html.escape(str(veto.get("rule_version", "—")))}</code>。'
          f'已触发硬伤 {len(hr)} 项，因缺输入未能判定 {len(hf)} 项。</p>')
        if hr:
            A('<div class="callout bad"><strong>已确认硬伤：</strong>'
              + html.escape('、'.join(str(x) for x in hr)) + '</div>')
        if hf:
            A('<div class="callout warn"><strong>以下条款缺输入，尚未判定</strong>'
              '——「未触发」不等于「已具备」，这是待确认，不是通过：</div>')
            A('<table><thead><tr><th>字段</th><th>影响规则</th><th>现场怎么核</th></tr></thead><tbody>')
            tips = {
                "exhaust": "有无独立油烟管道到屋顶；合同是否写明路由、净化标准、费用承担",
                "power_kw": "变压器余量是否满足厨房设备；增容费用谁出",
                "rent": "是否含物业、递增条款、免租期、押金",
                "frontage_m": "临街展示面宽度是否满足业态要求",
                "water_drain": "上下水与排污是否独立、能否过环评",
                "gas": "是否有燃气接入、容量是否够",
                "fire_approval": "消防验收资料是否可取得",
            }
            for m in hf:
                k = m.get("field_key", "")
                A(f'<tr><td><code>{html.escape(k)}</code></td>'
                  f'<td>{html.escape("、".join(m.get("required_for", [])))}</td>'
                  f'<td>{html.escape(tips.get(k, "现场核实"))}</td></tr>')
            A('</tbody></table>')
    else:
        A(sec_missing("场地", "本次未提供现场字段。",
                      "`python scripts/site_core.py veto --format <业态> --fields <字段文件>`"))

    # ── 财务
    A('<h2>财务</h2>')
    if per:
        A('<h3>三档测算</h3>')
        A('<table><thead><tr><th>指标</th><th class="num">保守</th>'
          '<th class="num">基准</th><th class="num">乐观</th></tr></thead><tbody>')
        rows = [
            ("月营收", "revenue", "money"),
            ("月净利（会计）", "net_profit", "money"),
            ("月现金净流", "monthly_cash_flow", "money"),
            ("ROI", "roi", "pct"),
            ("保本日营业额", "breakeven_revenue_daily", "money"),
            ("回本（现金·月）", "payback_static_months", "payback"),
            ("极限租金（保本）", "max_rent_breakeven", "money"),
            ("极限租金（目标回本）", "max_rent_target", "money"),
        ]
        for lab, key, kind in rows:
            A(f'<tr><td>{lab}</td>')
            for sc in ("pessimistic", "base", "optimistic"):
                v = (per.get(sc) or {}).get(key)
                if kind == "money":
                    cell = fmt_money(v)
                    isneg = v is not None and float(v) < 0
                    style = ' style="color:var(--bad)"' if isneg else ''
                elif kind == "pct":
                    cell = fmt_num(float(v) * 100, 1, "%") if v is not None else "—"
                    style = ' style="color:var(--bad)"' if v is not None and float(v) < 0 else ''
                elif kind == "payback":
                    cell = "不可达" if v == -1 else fmt_num(v, 1)
                    style = ' style="color:var(--bad)"' if v == -1 else ''
                else:
                    cell, style = fmt_num(v, 0), ""
                A(f'<td class="num"{style}>{html.escape(cell)}</td>')
            A('</tr>')
        A('</tbody></table>')
        A('<p class="missing">三档由引擎情景因子生成：保守 营收×0.85 / 成本×1.05，'
          '乐观 营收×1.15 / 成本×0.97。回本为 −1 表示「现金净流为负、数学上不可达」，'
          '不是「回本 1 个月」。</p>')
    else:
        A(sec_missing("财务", "本次未提供财务参数。",
                      "`python scripts/site_core.py finance --params p.json --lease lease.json`"))

    # ── 租期现金流
    if lease and lease.get("yearly"):
        A('<h3>租期现金流</h3>')
        A(f'<p>租期 {lease.get("term_years")} 年，年递增 '
          f'{fmt_num(float(lease.get("rent_escalation_pct", 0)) * 100, 1, "%")}，'
          f'翻新预留 {fmt_money(lease.get("renovation_cost"))}。'
          f'引擎判定 <strong>{badge(lease.get("verdict", "—"), verdict_class(lease.get("verdict")))}</strong>。</p>')
        A('<table><thead><tr><th>年</th><th class="num">月租</th>'
          '<th class="num">年净利</th><th class="num">翻新</th><th class="num">累计现金</th></tr></thead><tbody>')
        for y in lease["yearly"]:
            A(f'<tr><td>第 {y.get("year")} 年</td>'
              f'<td class="num">{fmt_money(y.get("rent_monthly"))}</td>'
              f'<td class="num" style="color:var(--bad)">{fmt_money(y.get("net_profit"))}</td>'
              f'<td class="num">{fmt_money(y.get("renovation"))}</td>'
              f'<td class="num" style="color:var(--bad)">{fmt_money(y.get("cumulative"))}</td></tr>')
        A('</tbody></table>')
        A(f'<div class="callout bad">期末累计现金 '
          f'<strong>{fmt_money(lease.get("ending_cumulative"))}</strong>，'
          f'{"未覆盖初始投入" if not lease.get("covers_investment") else "已覆盖初始投入"}。</div>')

    # ── 对标
    if bench:
        A('<h2>对标</h2>')
        A(f'<p>{html.escape(str(bench.get("city", "")))} · {html.escape(str(bench.get("format", "")))}'
          f'（样本 {bench.get("sample_size", "—")}）'
          + (f'，基准备注：<em>{html.escape(str(bench.get("note")))}</em>' if bench.get("note") else '')
          + '</p>')
        cmps = bench.get("compares") or []
        if cmps:
            A('<table><thead><tr><th>项</th><th class="num">基准</th>'
              '<th class="num">本项目</th><th class="num">偏离</th><th>判定</th></tr></thead><tbody>')
            for c in cmps:
                A(f'<tr><td>{html.escape(str(c.get("item")))}</td>'
                  f'<td class="num">{fmt_num(c.get("benchmark"), 1)} {html.escape(str(c.get("unit") or ""))}</td>'
                  f'<td class="num">{fmt_num(c.get("ours"), 1)} {html.escape(str(c.get("unit") or ""))}</td>'
                  f'<td class="num">{fmt_num(c.get("deviation_pct"), 1, "%")}</td>'
                  f'<td>{badge(c.get("verdict", "—"), verdict_class(c.get("verdict")))}'
                  f'{" " + html.escape(str(c.get("note") or "")) if c.get("note") else ""}</td></tr>')
            A('</tbody></table>')
    else:
        A(sec_missing("对标", "本次未执行行业对标。",
                      "`python scripts/site_core.py benchmark --city <城市> --format <业态> ...`"))

    # ── 口径
    A('<h2>口径</h2>')
    A('<p>每个数字都可回溯到公式与代入值。以下为本次生效的版本与假设：</p>')
    A('<table><thead><tr><th>项</th><th>值</th></tr></thead><tbody>')
    A(f'<tr><td>财务公式版本</td><td><code>{html.escape(str(r.get("formula_version", "—")))}</code></td></tr>')
    A(f'<tr><td>参数档版本</td><td><code>{html.escape(str(r.get("param_version", "—")))}</code></td></tr>')
    if r.get("rule_version") or (veto or {}).get("rule_version"):
        A(f'<tr><td>风控规则版本</td><td><code>'
          f'{html.escape(str(r.get("rule_version") or veto.get("rule_version")))}</code></td></tr>')
    if rr is not None:
        A(f'<tr><td>租售比口径</td><td>{fmt_num(float(rr)*100,1,"%")} = 月租 ÷ 月营收；'
          f'健康线 {fmt_num(float(rec.get("rent_ratio_healthy_max",0))*100,0,"%")}、'
          f'警戒线 {fmt_num(float(rec.get("rent_ratio_warning_max",0))*100,0,"%")}</td></tr>')
    A('</tbody></table>')
    if ledger:
        A('<details><summary>缺省参数台账（' + str(len(ledger)) + ' 条，未静默兜底）</summary><div class="inner">')
        A('<pre style="margin:0;font-size:12.5px;overflow:auto">'
          + html.escape(json.dumps(ledger, ensure_ascii=False, indent=2)) + '</pre>')
        A('</div></details>')

    # ── 下一步
    A('<h2>下一步</h2>')
    steps = []
    if veto and (veto.get("missing_fields") or []):
        steps.append(f'现场核实 {len(veto["missing_fields"])} 项待确认条件（见《场地》）')
    if anchor_bad:
        steps.append('重设「面积 × 客流 × 业客单」组合，而非压缩租金')
    if cash is not None and float(cash) < 0:
        bd = base.get("breakeven_revenue_daily")
        if bd:
            steps.append(f'验证营收能否达到保本日营业额 {fmt_money(bd)}')
    if not bench:
        steps.append('补跑行业对标')
    steps.append('判断权在客户：本报告只提供证据与缺口，不做「能不能开」的结论')
    A('<ol>' + ''.join(f'<li>{html.escape(s)}</li>' for s in steps) + '</ol>')

    # ── 页脚
    A('<footer>')
    A(f'本报告由 <code>report-html.py</code> 生成于 {now}，自包含单文件，断网可看。<br>')
    A(f'文件路径：<code>{html.escape(report_path)}</code><br>')
    A('所有数字取自引擎输出，渲染层不做任何再计算。'
      '若与引擎 JSON 不符，以引擎输出为准。')
    A('</footer>')

    A('</div></body></html>')
    return "\n".join(out)


# ─────────────────────────── 主流程 ───────────────────────────

def main():
    ap = argparse.ArgumentParser(description="选址分析报告 HTML 渲染器")
    ap.add_argument("--result", required=True, help="引擎输出 JSON（finance 结果，可含 veto/benchmark）")
    ap.add_argument("--site", default="", help="点位名称")
    ap.add_argument("--address", default="", help="详细地址")
    ap.add_argument("--meta", default="", help="额外上下文 JSON（competitors/demand/grid/veto/benchmark/fields）")
    ap.add_argument("--out", default=DEFAULT_OUT_DIR, help=f"输出目录（默认 {DEFAULT_OUT_DIR}）")
    ap.add_argument("--slug", default="", help="文件名主体（默认取 --site）")
    a = ap.parse_args()

    result = load_json(a.result)
    if result is None:
        print(f"ERROR: 读不到 --result {a.result}", file=sys.stderr)
        return 2
    meta = load_json(a.meta) or {}

    site = a.site or meta.get("site") or "选址分析报告"
    address = a.address or meta.get("address") or ""
    slug = a.slug or slugify(site)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")

    out_dir = a.out if os.path.isabs(a.out) else os.path.abspath(a.out)
    os.makedirs(out_dir, exist_ok=True)
    report_path = os.path.join(out_dir, f"{slug}-{stamp}.html")

    doc = render(result, site, address, meta, report_path)
    with open(report_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(doc)

    size = os.path.getsize(report_path)
    print(f"REPORT_PATH={report_path}")
    print(f"REPORT_SIZE={size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
