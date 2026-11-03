#!/usr/bin/env python3
"""
grid-registry.py —— 城市网格编号与调研状态存档（唯一真相源）

设计要点：
  · 网格编号按经纬度算，**不按城市切**：城市边界会变，经纬度不会
      网格大小 0.005° ≈ 500m × 450m（广州）
      grid_id = G{floor((lat+90)/0.005)}_{floor((lng+180)/0.005)}
  · 状态机：未扫描 → 已扫描 → 已评估 → 已现场 → 候选池 / 已否决 / 已签约
  · history 只追加不覆盖，半年后能回看每个网格发生过什么

用法：
  python tools/grid-registry.py --city 广州 --summary
  python tools/grid-registry.py --city 广州 --status 未扫描
  python tools/grid-registry.py --grid-id G22623_58667 --show
  python tools/grid-registry.py --status-file out/xxx/status.json      # 由 run-site 调用
  python tools/grid-registry.py --city 广州 --map                      # 生成覆盖地图
  python tools/grid-registry.py --create --city 广州 --status 未扫描 --bbox 23.0,113.2,23.3,113.5
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REG_PATH = os.path.join(ROOT, "out", "grid", "registry.json")
MAP_PATH = os.path.join(ROOT, "out", "grid", "grid-map.html")
GRID_DEG = 0.005
STATUSES = ["未扫描", "已扫描", "已评估", "已现场", "候选池", "已否决", "已签约"]
BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


# ────────────────────────────── 编号 ──────────────────────────────
def grid_id(lat, lng, size=GRID_DEG):
    return f"G{math.floor((lat + 90) / size)}_{math.floor((lng + 180) / size)}"


def grid_center(gid, size=GRID_DEG):
    try:
        lat_i, lng_i = gid.lstrip("G").split("_")
        lat = (int(lat_i) + 0.5) * size - 90
        lng = (int(lng_i) + 0.5) * size - 180
        return round(lat, 6), round(lng, 6)
    except (ValueError, AttributeError):
        return None


def geohash(lat, lng, precision=6):
    lat_r, lng_r = [-90.0, 90.0], [-180.0, 180.0]
    bits, ch, even, out = 0, 0, True, []
    while len(out) < precision:
        if even:
            mid = (lng_r[0] + lng_r[1]) / 2
            if lng > mid:
                ch = ch * 2 + 1
                lng_r[0] = mid
            else:
                ch = ch * 2
                lng_r[1] = mid
        else:
            mid = (lat_r[0] + lat_r[1]) / 2
            if lat > mid:
                ch = ch * 2 + 1
                lat_r[0] = mid
            else:
                ch = ch * 2
                lat_r[1] = mid
        even = not even
        bits += 1
        if bits == 5:
            out.append(BASE32[ch])
            bits, ch = 0, 0
    return "".join(out)


# ────────────────────────────── 存档 ──────────────────────────────
def load():
    if not os.path.exists(REG_PATH):
        return {"version": 1, "updated_at": "", "grids": {}}
    with open(REG_PATH, encoding="utf-8-sig") as f:
        data = json.load(f)
    data.setdefault("grids", {})
    return data


def save(data):
    os.makedirs(os.path.dirname(REG_PATH), exist_ok=True)
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(REG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def upsert(data, gid, **fields):
    g = data["grids"].get(gid)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    if g is None:
        center = grid_center(gid)
        g = {
            "grid_id": gid,
            "city": fields.get("city", ""),
            "district": fields.get("district", ""),
            "center": {"lat": center[0], "lng": center[1]} if center else {"lat": 0, "lng": 0},
            "size_deg": GRID_DEG,
            "geohash": geohash(center[0], center[1]) if center else "",
            "status": "未扫描",
            "score": None,
            "store_id": "",
            "report": "",
            "note": "",
            "history": [],
        }
        data["grids"][gid] = g

    new_status = fields.get("status")
    event = fields.get("event") or (
        f"→ {new_status}" if new_status else ("备注" if fields.get("note") else "")
    )
    if new_status:
        g["status"] = new_status
    for key in ("city", "district", "score", "store_id", "report", "note"):
        if fields.get(key) not in (None, ""):
            g[key] = fields[key]
    if event:
        entry = {"at": now, "event": event, "tool": fields.get("tool", "")}
        if fields.get("note"):
            entry["note"] = fields["note"]
        g["history"].append(entry)
    return g


# ────────────────────────────── 输出 ──────────────────────────────
def cmd_summary(data, city):
    rows = [g for g in data["grids"].values() if not city or g.get("city") == city]
    if not rows:
        print(f"{city or '全部'}：暂无网格记录（先跑 grid-scan 或 --create）")
        return
    total = len(rows)
    counts = {s: 0 for s in STATUSES}
    for g in rows:
        counts[g.get("status", "未扫描")] = counts.get(g.get("status", "未扫描"), 0) + 1
    print(f"{city or '全部'}：网格 {total} 个")
    for s in STATUSES:
        if counts.get(s):
            print(f"  {s:<6} {counts[s]:>4}  ({counts[s] / total * 100:.0f}%)")
    done = total - counts.get("未扫描", 0)
    print(f"  覆盖率 {done / total * 100:.1f}%（已接触过的网格）")


def cmd_list(data, city, status):
    rows = [g for g in data["grids"].values()
            if (not city or g.get("city") == city) and (not status or g.get("status") == status)]
    if not rows:
        print("无匹配网格")
        return
    print(f"| 网格 | 城市 | 区 | 状态 | 分数 | 点位 | 最近更新 |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for g in sorted(rows, key=lambda x: x["grid_id"])[:80]:
        last = g["history"][-1]["at"] if g["history"] else ""
        print(f"| {g['grid_id']} | {g.get('city','')} | {g.get('district','')} | {g.get('status','')} "
              f"| {g.get('score') or '—'} | {g.get('store_id') or '—'} | {last} |")
    if len(rows) > 80:
        print(f"（共 {len(rows)} 个，仅列前 80）")


def cmd_show(data, gid):
    g = data["grids"].get(gid)
    if g is None:
        print(f"未找到网格 {gid}")
        return
    print(json.dumps(g, ensure_ascii=False, indent=2))


def cmd_map(data, city):
    rows = [g for g in data["grids"].values() if not city or g.get("city") == city]
    if not rows:
        print("无数据可画")
        return
    color = {"未扫描": "#cfcfcf", "已扫描": "#ffd54f", "已评估": "#66bb6a",
             "已现场": "#26a69a", "候选池": "#42a5f5", "已否决": "#ef5350", "已签约": "#7e57c2"}
    pts = []
    for g in rows:
        c = g["center"]
        pts.append(
            '{"lat":%s,"lng":%s,"id":"%s","s":"%s","c":"%s"}'
            % (c["lat"], c["lng"], g["grid_id"], g.get("status", ""), color.get(g.get("status", ""), "#999"))
        )
    html = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>网格覆盖图</title><style>
body{margin:0;font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#eee}
#bar{padding:10px 16px;background:#1b1b1b;font-size:13px}
.lg{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px}
canvas{display:block}
</style></head><body>
<div id="bar">网格覆盖图 <span id="stat"></span></div>
<canvas id="cv"></canvas>
<script>
const P=%s;
const c=document.getElementById('cv'),x=c.getContext('2d');
function draw(){c.width=innerWidth;c.height=innerHeight-42;
if(!P.length)return;
let la=P.map(p=>p.lat),ln=P.map(p=>p.lng);
const n=Math.min(...la),s=Math.max(...la),w=Math.min(...ln),e=Math.max(...ln);
const pad=(e-w)*0.08||0.01,pad2=(s-n)*0.08||0.01;
const X=v=>(v-(w-pad))/((e+pad)-(w-pad))*c.width;
const Y=v=>(1-(v-(n-pad2))/((s+pad2)-(n-pad2)))*c.height;
P.forEach(p=>{x.fillStyle=p.c;x.fillRect(X(p.lng)-9,Y(p.lat)-9,18,18);
x.fillStyle='#000';x.font='9px sans-serif';x.fillText(p.id.slice(-6),X(p.lng)-9,Y(p.lat)+16);});
const cnt={};P.forEach(p=>cnt[p.s]=(cnt[p.s]||0)+1);
document.getElementById('stat').innerHTML=Object.entries(cnt).map(([k,v])=>
`<span class="lg" style="background:${{'未扫描':'#cfcfcf','已扫描':'#ffd54f','已评估':'#66bb6a','已现场':'#26a69a','候选池':'#42a5f5','已否决':'#ef5350','已签约':'#7e57c2'}[k]||'#999'}"></span>${k} ${v}`).join('');
}
draw();addEventListener('resize',draw);
</script></body></html>""" % "[" + ",".join(pts) + "]"
    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已生成覆盖地图：{os.path.normpath(MAP_PATH)}（{len(rows)} 个网格）")


# ────────────────────────────── 自测 ──────────────────────────────
def self_test():
    ok = 0
    fail = 0

    def check(label, cond):
        nonlocal ok, fail
        if cond:
            ok += 1
            print(f"PASS  {label}")
        else:
            fail += 1
            print(f"FAIL  {label}")

    lat, lng = 23.119825, 113.333776
    g1 = grid_id(lat, lng)
    check("编号稳定（同坐标两次一致）", g1 == grid_id(lat, lng))
    # 取格心做邻域测试，避免正好压在格边界上
    clat, clng = grid_center(g1)
    check("格内微移仍同格", grid_id(clat - 0.0005, clng) == g1 == grid_id(clat + 0.0005, clng))
    check("跨格坐标不同", grid_id(lat, lng) != grid_id(lat + 0.01, lng + 0.01))
    check("编号格式 G<lat>_<lng>", g1.startswith("G") and "_" in g1)
    c = grid_center(g1)
    check("中心点可反解", c is not None and abs(c[0] - lat) < GRID_DEG and abs(c[1] - lng) < GRID_DEG)
    check("geohash 6 位", len(geohash(lat, lng)) == 6)

    data = {"version": 1, "updated_at": "", "grids": {}}
    upsert(data, g1, city="广州", status="已扫描", score=78, tool="grid-scan")
    upsert(data, g1, status="已评估", store_id="T1", report="r.md", tool="run-site")
    g = data["grids"][g1]
    check("状态推进到已评估", g["status"] == "已评估")
    check("history 追加两条", len(g["history"]) == 2)
    check("分数保留", g["score"] == 78)
    check("store_id 写入", g["store_id"] == "T1")
    upsert(data, g1, note="现场南侧高架阻断")
    check("note 不覆盖 history", len(data["grids"][g1]["history"]) == 3)

    check("状态枚举完整", set(STATUSES) >= {"未扫描", "已扫描", "已评估", "已现场"})
    print(f"\n{ok}/{ok + fail} 通过")
    return 0 if fail == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city")
    ap.add_argument("--district")
    ap.add_argument("--status")
    ap.add_argument("--grid-id")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--map", action="store_true")
    ap.add_argument("--create", action="store_true", help="用 bbox 批量创建未扫描网格")
    ap.add_argument("--bbox", help="lat1,lng1,lat2,lng2")
    ap.add_argument("--status-file", help="从 run-site 写出的 status.json 回写")
    ap.add_argument("--store-id")
    ap.add_argument("--report")
    ap.add_argument("--score", type=float)
    ap.add_argument("--note")
    ap.add_argument("--event")
    ap.add_argument("--tool")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--id-of", help="输入 lat,lng，只打印网格编号（供其他脚本/测试对齐公式）")
    args = ap.parse_args()

    if args.id_of:
        la, ln = (float(x) for x in args.id_of.split(","))
        print(grid_id(la, ln))
        return

    if args.self_test:
        sys.exit(self_test())

    data = load()

    if args.status_file:
        with open(args.status_file, encoding="utf-8-sig") as f:
            st = json.load(f)
        gid = st.get("grid_id") or grid_id(st["center"]["lat"], st["center"]["lng"])
        upsert(data, gid, city=st.get("city", ""), district=st.get("district", ""),
               status=st.get("status", "已评估"), store_id=st.get("store_id", ""),
               report=st.get("report", ""), note=st.get("note", ""), tool="run-site",
               event=st.get("event") or "")
        save(data)
        print(f"registry 已更新：{gid} → {data['grids'][gid]['status']}")
        return

    if args.create:
        if not args.bbox:
            sys.exit("--create 需要 --bbox lat1,lng1,lat2,lng2")
        la1, ln1, la2, ln2 = (float(x) for x in args.bbox.split(","))
        n = 0
        la = min(la1, la2)
        while la < max(la1, la2):
            ln = min(ln1, ln2)
            while ln < max(ln1, ln2):
                gid = grid_id(la + GRID_DEG / 2, ln + GRID_DEG / 2)
                if gid not in data["grids"]:
                    upsert(data, gid, city=args.city or "", district=args.district or "",
                           status="未扫描", tool="grid-registry")
                    n += 1
                ln += GRID_DEG
            la += GRID_DEG
        save(data)
        print(f"新建网格 {n} 个（已存在的不重复建）")
        return

    if args.grid_id and not args.show and (args.status or args.store_id or args.report):
        upsert(data, args.grid_id, city=args.city or "", status=args.status,
               store_id=args.store_id or "", report=args.report or "",
               score=args.score, note=args.note or "", tool=args.tool or "cli",
               event=args.event or "")
        save(data)
        print(f"已更新 {args.grid_id} → {data['grids'][args.grid_id]['status']}")
        return

    if args.show and args.grid_id:
        cmd_show(data, args.grid_id)
        return
    if args.map:
        cmd_map(data, args.city)
        return
    if args.status:
        cmd_list(data, args.city, args.status)
        return
    cmd_summary(data, args.city)


if __name__ == "__main__":
    main()
