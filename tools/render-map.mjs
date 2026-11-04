/**
 * render-map.mjs —— 交互式选址地图（滚轮缩放 / 拖动平移 / 双向联动），零依赖
 *
 * 用法：
 *   node .\tools\render-map.mjs
 *   node .\tools\render-map.mjs --top-only
 *   node .\tools\render-map.mjs --no-basemap      # 不加载瓦片，只出几何
 *
 * 底图：out\tiles\{z}\{x}\{y}.png（先跑 tile-cache.mjs 预下载，13–17 级最顺）
 *       缺某一级时自动用上一级瓦片放大顶上，不会出现空白。
 * 交互：滚轮缩放、拖动平移、⌖ 回到候选点。（名单联动高亮在报告内嵌图中实现）
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const outDirUrl = new URL('../out/', import.meta.url)
const toPath = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')

function latestJson() {
  const files = readdirSync(outDirUrl)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: statSync(new URL(f, outDirUrl)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (files.length === 0) throw new Error('out/ 里没有 json，先跑 guangzhou-probe.mjs')
  return new URL(files[0].f, outDirUrl)
}

const args = process.argv.slice(2)
const noBaseMap = args.includes('--no-basemap')
const topOnly = args.includes('--top-only')
const offlineOnly = args.includes('--offline')
/** 默认不画车行圈虚线（商圈锁后边界意义不大，只保留右侧距离带表）；加 --show-outer 可恢复 */
const showOuter = args.includes('--show-outer')
const target = args.find((a) => !a.startsWith('--'))
  // 用 pathToFileURL + resolve：相对路径按 cwd 解析，不再假设是绝对路径
  ? pathToFileURL(resolve(args.find((a) => !a.startsWith('--'))))
  : latestJson()

const data = JSON.parse(readFileSync(target, 'utf8'))
const { center, address, scene, rings, pois, coverage, dedupe, transit } = data
if (!Array.isArray(pois) || pois.length === 0) throw new Error('数据里没有 POI')

const outer = rings[rings.length - 1]
const inner = rings[0]
const outerRadius = Number(outer.radius ?? outer.radius_m)
const innerRadius = Number(inner.radius ?? inner.radius_m)

const WARM = ['#e6194b', '#f58231', '#911eb4', '#f032e6', '#9a6324', '#800000', '#b03a2e', '#d35400']
const COOL = ['#4363d8', '#3cb44b', '#008080', '#000075', '#808000', '#469990', '#2980b9', '#27ae60']

const walkRank = new Map()
;(inner.top ?? []).forEach((c, i) => walkRank.set(c.name, i + 1))
const colorOf = (name) => {
  const w = walkRank.get(name)
  return w === undefined ? '#5b6670' : WARM[(w - 1) % WARM.length]
}
const isListed = (name) => walkRank.has(name)
const tagOf = (name) => {
  const w = walkRank.get(name)
  return w === undefined ? '' : `W${w}`
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 初始 zoom：让车行圈正好装进视口
const VIEW_W = 1000
const VIEW_H = 720
const cosLat = Math.cos((center.lat * Math.PI) / 180)
const initZoom = Math.max(10, Math.min(18, Math.round(Math.log2((156543.03392 * cosLat * VIEW_H) / (2 * outerRadius * 1.05)))))

const poiData = pois.filter((p) => !topOnly || isListed(p.name)).map((p) => ({
  n: p.name,
  lat: p.lat,
  lng: p.lng,
  tag: tagOf(p.name),
  c: colorOf(p.name),
  l: isListed(p.name) ? 1 : 0,
}))

const nearestOne = (inner.nearest ?? [])[0]
const ringCount = Number(inner.inside ?? 0)
const level = ringCount > 30 ? '贴脸红海' : ringCount >= 11 ? '很密集' : ringCount >= 4 ? '正常竞争' : '几乎空档'
const plain = ringCount > 30
  ? '顾客根本不缺选择，新店要靠记忆点抢客，不靠位置'
  : ringCount >= 11 ? '翻台靠位置和复购，新店必须有一个记忆点'
    : ringCount >= 4 ? '顾客有得选，靠口味和品类赢'
      : '先确认为什么没人——可能没需求，不是机会'
const headline = `步行圈内 ${ringCount} 家同类${nearestOne ? `，最近一家 ${nearestOne.distance_m} 米` : ''}（${level}）——${plain}。`

const bandsRows = (outer.distance_bands ?? [])
  .map((b) => `<tr><td>${b.label}</td><td style="text-align:right">${b.count} 家</td></tr>`)
  .join('')

const nearestMetroSt = (transit?.metro ?? [])[0]
const metroT = transit?.metro_threshold_m ?? 800
const parkT = transit?.parking_threshold_m ?? 300
const metroOk = nearestMetroSt ? nearestMetroSt.distance_m <= metroT : false
const parkM = transit?.nearest_parking_m ?? -1
const parkOk = parkM >= 0 && parkM <= parkT
const okTag = (b) => (b ? '<span style="color:#2e7d32;font-weight:700">✅</span>' : '<span style="color:#c62828;font-weight:700">❌</span>')
const transitRows = transit?.ok
  ? [
      `<tr><td>最近地铁站（≤${metroT}m）</td><td style="text-align:right">${nearestMetroSt ? `${esc(nearestMetroSt.name)} ${nearestMetroSt.distance_m} m` : '2km 内无'} ${okTag(metroOk)}</td></tr>`,
      `<tr><td>最近停车场（≤${parkT}m）</td><td style="text-align:right">${parkM >= 0 ? `${parkM} m` : '未取到'} ${okTag(parkOk)}</td></tr>`,
      `<tr><td>${parkT}m 内停车场</td><td style="text-align:right">${transit.parking_near ?? 0} 个</td></tr>`,
    ].join('')
  : '<tr><td colspan="2">未取到交通数据</td></tr>'

const rowsOf = (list, prefix) =>
  (list ?? []).map((cell, i) => `<tr data-name="${esc(cell.name)}" class="lnk"><td><b>${prefix}${i + 1}</b> <span class="sw" style="background:${colorOf(cell.name)}"></span>${esc(cell.name)}</td><td style="text-align:right">${cell.share_pct}%</td></tr>`).join('')
const nearestRows = (inner.nearest ?? [])
  .map((p) => `<tr data-name="${esc(p.name)}" class="lnk"><td>${esc(p.name)}</td><td style="text-align:right">${p.distance_m} m</td></tr>`).join('')

// 输出到与输入 json 同一目录；瓦片路径按所在层级算相对路径
const targetDirUrl = new URL('./', target)
const sameAsOut = decodeURIComponent(targetDirUrl.pathname) === decodeURIComponent(outDirUrl.pathname)
const tileBase = sameAsOut ? 'tiles' : '../tiles'

const payload = {
  center,
  zoom: initZoom,
  view: { w: VIEW_W, h: VIEW_H },
  rings: rings.map((r, i) => ({
    label: r.label,
    radius: Number(r.radius ?? r.radius_m),
    inside: r.inside,
    source: r.source ?? 'estimate',
    iso: Array.isArray(r.iso) ? r.iso : null,
    level: i,
  })),
  pois: poiData,
  useLocal: !noBaseMap,
  useOnline: !noBaseMap && !offlineOnly,
  tileBase,
  showOuter,
}
const payloadJs = JSON.stringify(payload).replace(/</g, '\\u003c')

const now = new Date().toLocaleString('zh-CN')
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(address)} · 选址竞争图</title>
<style>
 body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:18px;color:#222;background:#fafafa}
 h1{font-size:19px;margin:0 0 4px}
 .meta{color:#666;font-size:12.5px;margin-bottom:10px}
 .headline{font-size:15px;background:#fff8e1;border-left:4px solid #ffb300;padding:9px 13px;margin:0 0 10px;line-height:1.6}
 .legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:#333;margin-bottom:8px;align-items:center}
 .legend b{display:inline-block;width:14px;margin-right:5px;vertical-align:middle;border-top:3px dashed #d40000}
 .legend b.dot{width:9px;height:9px;border-radius:50%;border:none}
 .legend b.star{width:9px;height:9px;background:#d40000;transform:rotate(45deg);border:none}
 .wrap{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
 .mapbox{position:relative;border:1px solid #ddd;background:#eef2f5;box-shadow:0 1px 5px rgba(0,0,0,.1);width:${VIEW_W}px;height:${VIEW_H}px;overflow:hidden;cursor:grab}
 .mapbox.drag{cursor:grabbing}
 .mapbox svg{display:block;width:100%;height:100%;user-select:none}
 .tools{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:6px;z-index:5}
 .tools button{width:34px;height:34px;border:1px solid #ccc;background:#fff;border-radius:6px;font-size:17px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.12)}
 .tools button:hover{background:#f2f7ff}
 .hint{position:absolute;left:10px;top:10px;background:rgba(255,255,255,.92);border:1px solid #e0e0e0;border-radius:6px;padding:5px 9px;font-size:12px;color:#666;z-index:5}
 table{border-collapse:collapse;font-size:13px;min-width:310px} td{padding:5px 9px;border-bottom:1px solid #eee}
 tr[data-name]{cursor:pointer} tr[data-name]:hover td{background:#eef5ff}
 tr[data-name].active td{background:#fff3cd;font-weight:600}
 .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
 .sub{font-size:12px;color:#888;margin:0 0 5px;line-height:1.5}
 .note{font-size:11.5px;color:#999;margin-top:10px;max-width:330px;line-height:1.6}
</style></head><body>
<h1>${esc(address)}　<span style="font-weight:400;color:#666">${esc(scene)}</span></h1>
<div class="meta">有效竞品 ${dedupe.effective} 家（原始 ${dedupe.raw}）｜覆盖率 ${coverage.amap >= 0 ? `高德 ${coverage.amap}%` : '高德：多关键词扫描'} · 腾讯 ${coverage.tencent}%｜生成于 ${now}</div>
<div class="headline">${esc(headline)}</div>
<div class="legend">
 <span><b class="star"></b>候选点位</span>
 <span><b style="border-top:3px solid #ef6c00"></b>步行圈 ${Math.round(innerRadius)}m（橙实线）</span>
 ${showOuter ? `<span><b style="border-top:3px dashed #d40000"></b>车行圈 ${Math.round(outerRadius)}m（红虚线）</span>` : '<span style="color:#888">车行圈边界不显示，看右侧距离带</span>'}
 <span><b class="dot" style="background:#e6194b"></b>W = 步行圈份额名次</span>
 <span style="color:#888">外圈只报数量与距离带，不报份额</span>
 <span style="color:#888">滚轮缩放 · 拖动平移 · ⌖ 回到候选点</span>
</div>
<div class="wrap">
 <div class="mapbox" id="box">
  <div class="hint" id="hint"></div>
  <div class="tools">
   <button id="zin" title="放大">＋</button>
   <button id="zout" title="缩小">－</button>
   <button id="home" title="回到候选点位">⌖</button>
  </div>
  <svg id="map" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet"></svg>
 </div>
 <div>
  <h3 style="font-size:15px;margin:0 0 4px">步行圈份额 Top8（${esc(inner.label)}）</h3>
  <p class="sub">离候选点 ${Math.round(innerRadius)} 米内、抢日常客流；榜内名次 W1–W8</p>
  <table><tbody>${rowsOf(inner.top, 'W') || '<tr><td>无</td></tr>'}</tbody></table>
  <h3 style="font-size:15px;margin:18px 0 4px">交通可达</h3>
  <table><tbody>${transitRows}</tbody></table>
  <h3 style="font-size:15px;margin:18px 0 4px">车行圈竞品分布（${esc(outer.label)}）</h3>
  <p class="sub">⛔ 不报份额：${outer.area_km2 ?? '—'} km² 内含江面与非商圈，份额会误导 → 改看距离带</p>
  <table><tbody>${bandsRows || '<tr><td>无</td></tr>'}</tbody></table>
  <h3 style="font-size:15px;margin:18px 0 4px">距候选点最近的 5 家</h3>
  <p class="sub">只按直线距离排序，与份额、规模无关（看"门口有谁"）</p>
  <table><tbody>${nearestRows || '<tr><td>无</td></tr>'}</tbody></table>
  <p class="note">等时圈为本地路网计算（Valhalla/OSRM），已去除沿高速/主干道走廊的细长尖刺（中位半径 ×1.6 截断）。<br>
  份额 = 网格最近站归属，**仅步行圈统计**；车行圈范围过大（含江面/非商圈），不报份额。<br>
  底图 © 高德地图。</p>
 </div>
</div>
<script>
var D = ${payloadJs};
var NS = 'http://www.w3.org/2000/svg';
var XL = 'http://www.w3.org/1999/xlink';
var svg = document.getElementById('map');
var box = document.getElementById('box');
var hint = document.getElementById('hint');
var TILE = 256;
var st = { z: D.zoom, lat: D.center.lat, lng: D.center.lng };
var currentName = null;
var hlG, hlText, layers = {};

function lonToX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z) * TILE; }
function latToY(lat, z) {
  var s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z) * TILE;
}
function mpp() { return 156543.03392 * Math.cos(st.lat * Math.PI / 180) / Math.pow(2, st.z); }

function el(name, attrs) {
  var e = document.createElementNS(NS, name);
  for (var k in attrs) { if (k === 'href') { e.setAttributeNS(XL, 'xlink:href', attrs[k]); } else { e.setAttribute(k, attrs[k]); } }
  return e;
}

function tileSources(z, x, y) {
  var localPath = D.tileBase + '/' + z + '/' + x + '/' + y + '.png';
  var onlineUrl = 'https://webrd0' + ((Math.abs(x) + Math.abs(y)) % 4 + 1)
    + '.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=' + x + '&y=' + y + '&z=' + z;
  var list = [];
  if (D.useLocal) { list.push(localPath); }
  if (D.useOnline) { list.push(onlineUrl); }
  return list;
}

function placeTile(parent, z, x, y, sx, sy, size) {
  if (z < 6 || size > 4096) { return; }
  attempt(parent, tileSources(z, x, y), 0, z, x, y, sx, sy, size);
}

function attempt(parent, sources, i, z, x, y, sx, sy, size) {
  if (i >= sources.length) {
    placeTile(parent, z - 1, Math.floor(x / 2), Math.floor(y / 2), sx - (x % 2) * size / 2, sy - (y % 2) * size / 2, size * 2);
    return;
  }
  var img = new Image();
  img.onload = function () {
    parent.appendChild(el('image', { href: sources[i], x: sx, y: sy, width: size, height: size, preserveAspectRatio: 'none' }));
  };
  img.onerror = function () { attempt(parent, sources, i + 1, z, x, y, sx, sy, size); };
  img.src = sources[i];
}

function render() {
  while (svg.firstChild) { svg.removeChild(svg.firstChild); }
  var VW = D.view.w, VH = D.view.h;
  var cx = lonToX(st.lng, st.z), cy = latToY(st.lat, st.z);
  var left = cx - VW / 2, top = cy - VH / 2;

  var gTiles = el('g', {});
  svg.appendChild(gTiles);
  if (D.useLocal || D.useOnline) {
    var x0 = Math.floor(left / TILE), x1 = Math.floor((left + VW) / TILE);
    var y0 = Math.floor(top / TILE), y1 = Math.floor((top + VH) / TILE);
    for (var tx = x0; tx <= x1; tx += 1) {
      for (var ty = y0; ty <= y1; ty += 1) {
        placeTile(gTiles, st.z, tx, ty, tx * TILE - left, ty * TILE - top, TILE);
      }
    }
  }

  var gRing = el('g', {});
  svg.appendChild(gRing);
  var m = mpp();
  // 候选点位的真实屏幕坐标（不能写死屏幕中心，否则拖动后会错位）
  var candX = VW / 2 + (lonToX(D.center.lng, st.z) - cx);
  var candY = VH / 2 + (latToY(D.center.lat, st.z) - cy);

  var gRing = el('g', {});
  svg.appendChild(gRing);
  for (var i = 0; i < D.rings.length; i += 1) {
    var r = D.rings[i];
    if (r.level > 0 && !D.showOuter) { continue; }
    var rr = r.radius / m;
    var isInner = r.level === 0 && D.rings.length > 1;
    var stroke = isInner ? '#ef6c00' : '#d40000';
    var dash = isInner ? '' : '8 6';
    if (r.iso && r.iso.length > 2) {
      var pts = [];
      for (var q = 0; q < r.iso.length; q += 1) {
        pts.push((VW / 2 + (lonToX(r.iso[q][0], st.z) - cx)).toFixed(1) + ',' + (VH / 2 + (latToY(r.iso[q][1], st.z) - cy)).toFixed(1));
      }
      gRing.appendChild(el('polygon', { points: pts.join(' '), fill: stroke, 'fill-opacity': isInner ? 0.06 : 0.035, stroke: stroke, 'stroke-width': isInner ? 3 : 2.5, 'stroke-dasharray': dash, 'stroke-opacity': .95 }));
    } else {
      gRing.appendChild(el('circle', { cx: candX, cy: candY, r: rr, fill: 'none', stroke: stroke, 'stroke-width': isInner ? 3 : 2.5, 'stroke-dasharray': dash, 'stroke-opacity': .95 }));
    }
    var ty2 = candY - rr - 8;
    var t = el('text', { x: candX + 8, y: ty2 < 18 ? candY + rr + 18 : ty2, 'font-size': 14, 'font-weight': 700, fill: isInner ? '#bf5600' : '#b00000', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 4 });
    t.textContent = r.label + '（' + Math.round(r.radius) + 'm · ' + r.inside + ' 家）' + (r.source === 'valhalla' || r.source === 'osrm' ? '' : '【估算】');
    gRing.appendChild(t);
  }

  var gPoi = el('g', {});
  svg.appendChild(gPoi);
  for (var j = 0; j < D.pois.length; j += 1) {
    var p = D.pois[j];
    var px = VW / 2 + (lonToX(p.lng, st.z) - cx);
    var py = VH / 2 + (latToY(p.lat, st.z) - cy);
    if (px < -40 || px > VW + 40 || py < -40 || py > VH + 40) { continue; }
    var c = el('circle', { cx: px, cy: py, r: p.l ? 5.5 : 2.2, fill: p.c, 'fill-opacity': p.l ? .95 : .35, stroke: p.l ? '#fff' : 'none', 'stroke-width': 1.2, 'data-name': p.n, style: 'cursor:pointer' });
    c.addEventListener('click', function (ev) { ev.stopPropagation(); select(this.getAttribute('data-name'), true); });
    gPoi.appendChild(c);
    if (p.l && p.tag) {
      var lt = el('text', { x: px + 8, y: py - 7, 'font-size': 10.5, 'font-weight': 700, fill: p.c, 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3.5 });
      lt.textContent = p.tag;
      gPoi.appendChild(lt);
    }
  }

  var star = Array.from({ length: 10 }, function (_, i) {
    var a = Math.PI * 2 * i / 10 - Math.PI / 2, rr = i % 2 === 0 ? 15 : 6.5;
    return (candX + rr * Math.cos(a)).toFixed(1) + ',' + (candY + rr * Math.sin(a)).toFixed(1);
  }).join(' ');
  svg.appendChild(el('polygon', { points: star, fill: '#d40000', stroke: '#fff', 'stroke-width': 1.5 }));

  // 候选点不在视野内时，在边缘给出方向提示（否则拖走就找不到了）
  if (candX < 12 || candX > VW - 12 || candY < 12 || candY > VH - 12) {
    var ex = Math.max(16, Math.min(VW - 16, candX));
    var ey = Math.max(16, Math.min(VH - 16, candY));
    svg.appendChild(el('circle', { cx: ex, cy: ey, r: 8, fill: '#d40000', 'fill-opacity': .92, stroke: '#fff', 'stroke-width': 2 }));
    var et = el('text', { x: ex + 12, y: ey + 4, 'font-size': 12, 'font-weight': 700, fill: '#d40000', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 4 });
    et.textContent = '候选点位方向（点 ⌖ 回到这里）';
    svg.appendChild(et);
  }

  var sc = 500 / m;
  svg.appendChild(el('rect', { x: 20, y: VH - 44, width: sc + 18, height: 26, fill: '#fff', 'fill-opacity': .88, rx: 4 }));
  svg.appendChild(el('line', { x1: 28, y1: VH - 31, x2: 28 + sc, y2: VH - 31, stroke: '#333', 'stroke-width': 3 }));
  var sl = el('text', { x: 28, y: VH - 48, 'font-size': 12, fill: '#333' });
  sl.textContent = '500 米';
  svg.appendChild(sl);

  hlG = el('g', { style: 'opacity:0', 'pointer-events': 'none' });
  hlG.appendChild(el('circle', { r: 18, fill: 'none', stroke: '#111', 'stroke-width': 2.5, 'stroke-dasharray': '5 4' }));
  hlText = el('text', { 'font-size': 13, 'font-weight': 700, fill: '#111', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 4 });
  hlG.appendChild(hlText);
  svg.appendChild(hlG);

  placeHighlight();   // 缩放/平移后把已锁定的标记重新画上

  hint.textContent = 'zoom ' + st.z + ' · ' + m.toFixed(2) + ' 米/像素';
}

// 把当前选中的店画到它现在的位置（跟随缩放/平移）
function placeHighlight() {
  if (!currentName || !hlG) { return; }
  var t = null;
  for (var i = 0; i < D.pois.length; i += 1) { if (D.pois[i].n === currentName) { t = D.pois[i]; break; } }
  if (!t) { hlG.style.opacity = 0; return; }
  var VW = D.view.w, VH = D.view.h;
  var cx = lonToX(st.lng, st.z), cy = latToY(st.lat, st.z);
  var px = VW / 2 + (lonToX(t.lng, st.z) - cx);
  var py = VH / 2 + (latToY(t.lat, st.z) - cy);
  if (px < -60 || px > VW + 60 || py < -60 || py > VH + 60) { hlG.style.opacity = 0; return; }
  hlG.setAttribute('transform', 'translate(' + px + ' ' + py + ')');
  hlG.style.opacity = 1;
  var flip = px > VW - 260;
  hlText.setAttribute('x', flip ? -24 : 24);
  hlText.setAttribute('y', 5);
  hlText.setAttribute('text-anchor', flip ? 'end' : 'start');
  hlText.textContent = currentName;
}

function clearSelection() {
  currentName = null;
  if (hlG) { hlG.style.opacity = 0; }
  var rows = document.querySelectorAll('tr[data-name]');
  for (var i = 0; i < rows.length; i += 1) { rows[i].classList.remove('active'); }
}

function select(name, scroll) {
  currentName = name;
  var rows = document.querySelectorAll('tr[data-name]');
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].getAttribute('data-name') === name) { rows[i].classList.add('active'); } else { rows[i].classList.remove('active'); }
  }
  var target = null;
  for (var j = 0; j < D.pois.length; j += 1) { if (D.pois[j].n === name) { target = D.pois[j]; break; } }
  if (!target) { return; }
  var VW = D.view.w, VH = D.view.h;
  var cx = lonToX(st.lng, st.z), cy = latToY(st.lat, st.z);
  var px = VW / 2 + (lonToX(target.lng, st.z) - cx);
  var py = VH / 2 + (latToY(target.lat, st.z) - cy);
  if (px < 30 || px > VW - 30 || py < 30 || py > VH - 30) {
    st.lng = target.lng;
    st.lat = target.lat;
    render();
  } else {
    placeHighlight();
  }
  if (scroll) {
    for (var k = 0; k < rows.length; k += 1) {
      if (rows[k].getAttribute('data-name') === name && rows[k].scrollIntoView) { rows[k].scrollIntoView({ block: 'nearest' }); break; }
    }
  }
}

// 交互：滚轮缩放（以鼠标位置为中心）
svg.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  var dir = ev.deltaY > 0 ? -1 : 1;
  var next = Math.max(10, Math.min(19, st.z + dir));
  if (next === st.z) { return; }
  var rect = svg.getBoundingClientRect();
  var mx = (ev.clientX - rect.left) / rect.width * D.view.w;
  var my = (ev.clientY - rect.top) / rect.height * D.view.h;
  var cx = lonToX(st.lng, st.z), cy = latToY(st.lat, st.z);
  var wx = cx - D.view.w / 2 + mx;
  var wy = cy - D.view.h / 2 + my;
  var k = Math.pow(2, next - st.z);
  st.z = next;
  var ncx = wx * k, ncy = wy * k;
  st.lng = (ncx / (TILE * Math.pow(2, st.z))) * 360 - 180;
  var n = Math.PI - 2 * Math.PI * ncy / (TILE * Math.pow(2, st.z));
  st.lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  render();
}, { passive: false });

// 拖动平移
var drag = null;
var lastDragMoved = 0;
box.addEventListener('pointerdown', function (ev) {
  if (ev.target.tagName === 'BUTTON') { return; }
  drag = { x: ev.clientX, y: ev.clientY, lat: st.lat, lng: st.lng, moved: 0 };
  box.classList.add('drag');
});
window.addEventListener('pointermove', function (ev) {
  if (!drag) { return; }
  var rect = svg.getBoundingClientRect();
  var dx = (ev.clientX - drag.x) / rect.width * D.view.w;
  var dy = (ev.clientY - drag.y) / rect.height * D.view.h;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  var cx = lonToX(drag.lng, st.z), cy = latToY(drag.lat, st.z);
  var ncx = cx - dx, ncy = cy - dy;
  st.lng = (ncx / (TILE * Math.pow(2, st.z))) * 360 - 180;
  var n = Math.PI - 2 * Math.PI * ncy / (TILE * Math.pow(2, st.z));
  st.lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  render();
});
window.addEventListener('pointerup', function () {
  lastDragMoved = drag ? drag.moved : 0;
  drag = null;
  box.classList.remove('drag');
});

document.getElementById('zin').addEventListener('click', function () { st.z = Math.min(19, st.z + 1); render(); });
document.getElementById('zout').addEventListener('click', function () { st.z = Math.max(10, st.z - 1); render(); });
document.getElementById('home').addEventListener('click', function () {
  st.lat = D.center.lat;
  st.lng = D.center.lng;
  render();
});

document.querySelectorAll('tr[data-name]').forEach(function (row) {
  row.addEventListener('click', function () { select(row.getAttribute('data-name'), false); });
});

// 点空白处 = 取消锁定（拖动结束不算点击，避免平移时误清）
svg.addEventListener('click', function (ev) {
  var moved = lastDragMoved;
  lastDragMoved = 0;
  if (moved > 4) { return; }
  if (ev.target.tagName !== 'circle') { clearSelection(); }
});

render();
</script>
</body></html>`

mkdirSync(outDirUrl, { recursive: true })
const baseName = decodeURIComponent(target.pathname).split('/').pop().replace(/\.json$/, '')
const outFile = new URL(`${baseName}-map.html`, targetDirUrl)
writeFileSync(outFile, html, 'utf8')
console.log(`已出图：${toPath(outFile)}`)
console.log('交互：滚轮缩放（zoom 10–19）· 拖动平移 · 回到候选点')
console.log(`初始 zoom=${initZoom}｜POI ${poiData.length} 个${topOnly ? '（--top-only）' : ''}`)
console.log(`瓦片：${noBaseMap ? '关闭' : offlineOnly ? '仅本地（out/tiles）' : '本地优先 → 缺失自动在线取（高德）'}`)
