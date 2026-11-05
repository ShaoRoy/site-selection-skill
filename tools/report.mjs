/**
 * report.mjs —— 从 probe/survey 结果生成选址报告（模板 B：专业表述 + 人话）
 *
 * CLI：node .\tools\report.mjs --in=out\xxx.json [--profile=slug]
 * 模块：buildReport(data, profile) / buildCompare(results, profile)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = (v, d = '—') => (typeof v === 'number' && Number.isFinite(v) ? String(v) : d)

/** 把分段 key（如 yuecai_large）翻译成人话 */
const CUISINE_LABEL = { yuecai: '粤菜', chaoshan: '潮汕', other: '其他菜系', snack: '小吃' }
const SCALE_LABEL = { small: '小吃快餐（人均<60）', mid: '中端（人均 60–120）', large: '高端（人均>120）' }
/**
 * 段名的「人均区间」是**推定**，不是实测。
 * 该段全部无人均数据时（有价率 0%），不能写成断言式「人均>120」——
 * 否则读者会以为这 15 家是实证出来的高端店。
 */
const scaleLabelBy = (seg) => {
  // 段名来自 seg.key（如 yuecai_large），先走 segLabel 拿到完整名，再按有价率降级
  const full = segLabel(seg.key)
  if (typeof seg.cost_coverage === 'number' && seg.cost_coverage < 30) {
    return full.replace(/（人均[^）]*）/, '（规模档推定，无人均实证）')
  }
  return full
}
const segLabel = (key) => {
  const parts = String(key).split('_')
  const scale = parts.length > 1 ? parts[parts.length - 1] : ''
  const cuisine = parts.length > 1 ? parts.slice(0, -1).join('_') : parts[0]
  const c = CUISINE_LABEL[cuisine] ?? cuisine
  const s = SCALE_LABEL[scale]
  return s ? `${c} · ${s}` : (CUISINE_LABEL[key] ?? key)
}

/** 一句话结论：专业表述 + 人话 */
function verdict(data) {
  const inner = data.rings?.[0] ?? {}
  const count = Number(inner.inside ?? 0)
  const sameType = data.dedupe?.same_type_count ?? data.dedupe?.effective ?? 0
  const otherType = data.dedupe?.other_type_count ?? 0
  const nearest = inner.nearest?.[0]
  // 圈层密度分级：标签自带白话，非行业读者也能读懂「红海」是什么意思
  const level = count > 30 ? '贴脸红海 —— 密度极高，客人随手一拉就是一家'
    : count >= 11 ? '很密集 —— 选择很多，得靠差异化'
      : count >= 4 ? '正常竞争 —— 有对手，但不至于抢破头'
        : '几乎空档 —— 先查是不是真没需求'
  const plain = count > 30
    ? '顾客根本不缺选择，新店要靠记忆点抢客，不靠位置'
    : count >= 11
      ? '翻台靠位置和复购，新店必须有一个记忆点'
      : count >= 4
        ? '顾客有得选，靠口味和品类赢'
        : '先确认为什么没人——可能没需求，不是机会'
  const line = `${inner.label ?? '内圈'}内 ${count} 家（${level}）`
    + `${nearest ? `，最近一家 ${nearest.distance_m} 米——门对门抢客` : ''}`
    + `——${plain}。`
  const split = sameType + otherType > 0
    ? `全扫描范围内同段直接竞品 ${sameType} 家、异段 ${otherType} 家（协同或弱竞争）；上句 ${count} 家为${inner.label ?? '内圈'}圈内数量，两者范围不同，不要相加。`
    : ''
  return { line, split, level }
}

function populationBlock(data) {
  const pop = data.population
  if (!pop || !pop.rings) {
    const sk = data.population_skip
    if (!sk) return []
    return ['**人口核对（本次未执行）**', '',
      `> ⚠️ 原因：${sk.reason}`,
      `> 补齐：\`${sk.fix}\``,
      '> 本次报告**缺少独立人口数据源**，上面的需求强度全部来自 POI 代理，请在结论里按「单源」看待。', '']
  }
  const cc = pop.cross_check
  const out = ['**人口核对（独立数据源交叉验证）**', '']
  out.push('> WorldPop 2020 常住人口栅格（约 93m），已从 GCJ-02 转 WGS84 后采样，偏移 ' +
    String(pop.crs_shift_m ?? '—') + 'm。该指标测「常住人口」，与上面的 POI 代理（测商务活跃度）**不是一回事**，两者要分开看。', '')
  out.push('| 圈层 | 常住人口 | 密度 |', '| --- | --- | --- |')
  for (const r of ['500', '1000', '3000']) {
    const x = pop.rings[r]
    if (x && x.in_raster !== false) {
      out.push(`| ${r}m | ${(x.population ?? 0).toLocaleString()} 人 | ${(x.density_per_km2 ?? 0).toLocaleString()} 人/km² |`)
    }
  }
  out.push('')
  if (cc) {
    out.push(`**交叉判定：${cc.verdict}**（WorldPop 人口${cc.worldpop_level} × POI 代理强度${cc.proxy_level ?? '未提供'}）`, '')
    if (cc.interpretation) out.push(`> ${cc.interpretation}`, '')
  }
  return out
}

function populationHtml(data) {
  const pop = data.population
  if (!pop || !pop.rings) {
    const sk = data.population_skip
    if (!sk) return ''
    return `<h3>4.1 人口核对（本次未执行）</h3>
<p style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px">⚠️ <b>原因</b>：${esc(sk.reason)}<br><b>补齐</b>：<code>${esc(sk.fix)}</code><br>本次报告<b>缺少独立人口数据源</b>，上面的需求强度全部来自 POI 代理，请在结论里按「单源」看待。</p>`
  }
  const cc = pop.cross_check
  const rows = ['500', '1000', '3000'].map((r) => {
    const x = pop.rings[r]
    if (!x || x.in_raster === false) return ''
    return `<tr><td>${r}m</td><td>${(x.population ?? 0).toLocaleString()} 人</td><td>${(x.density_per_km2 ?? 0).toLocaleString()} 人/km²</td></tr>`
  }).join('')
  if (!rows) return ''
  const verdict = cc
    ? `<p class="concl" style="font-size:15px">交叉判定：${esc(cc.verdict)}（WorldPop 人口${esc(cc.worldpop_level)} × POI 代理强度${esc(String(cc.proxy_level ?? '未提供'))}）${cc.interpretation ? '<br><span style="font-size:13px;color:#666">' + esc(cc.interpretation) + '</span>' : ''}</p>`
    : ''
  return `<h3>4.1 人口核对（独立数据源交叉验证）</h3>
<p style="color:#888">WorldPop 2020 常住人口栅格（约 93m），已从 GCJ-02 转 WGS84 后采样，偏移 ${esc(String(pop.crs_shift_m ?? '—'))}m。该指标测「常住人口」，与上面的 POI 代理（测商务活跃度）<b>不是一回事</b>，两者要分开看。</p>
<table><tr><th>圈层</th><th>常住人口</th><th>密度</th></tr>${rows}</table>${verdict}`
}

function demandSection(data) {
  const d = data.demand
  if (d && d.demand_score) {
    const p = d.proxies ?? {}
    // 密度分母必须写明实际半径：demand.inner_radius_m 与报告的「内圈·步行N分」不是同一个圈
    const innerR = d.inner_radius_m
    const innerLabel = typeof innerR === 'number' && innerR > 0
      ? `${innerR}m 圆（≈${(Math.PI * (innerR / 1000) ** 2).toFixed(2)} km²）`
      : '内圈面积'
    const out = ['## 4. 需求侧代理指标', '']
    out.push(`> 数据源：高德 POI 自动采集（${d.captured_at ?? '—'}）｜扫描半径 ${d.radius_m ?? '—'}m。**以下全部为代理指标，不是实测人口。**`, '')
    out.push('| 指标 | 值 | 怎么来的 |', '| --- | --- | --- |')
    out.push(`| 住宅密度 | ${p.residential_density_per_km2 ?? '—'} 个/km² | 住宅区 POI 数 ÷ 扫描面积 |`)
    out.push(`| 职住比 | ${p.job_housing_ratio ?? '—'} | 写字楼 POI ÷ 住宅区 POI（>1 偏就业型，<1 偏居住型）—— 这个数告诉你周围上班的人多还是住家的人多：上班的多－工作日午市好做；住家的多－晚市和周末好做 |`)
    out.push(`| 配套成熟度 | ${p.amenity_count ?? '—'} | 购物中心 + 学校 + 地铁站 数量 |`)
    out.push(`| 咖啡密度 | ${p.coffee_density_per_km2 ?? '—'} 个/km² | 精品咖啡品牌 POI ÷ ${innerLabel}（消费力代理） |`)
    out.push(`| 银行密度 | ${p.bank_density_per_km2 ?? '—'} 个/km² | 银行网点 POI ÷ ${innerLabel}（商务活动代理） |`)
    out.push(`| 高端餐饮密度 | ${p.premium_dining_density_per_km2 ?? '—'} 个/km² | 连锁高端餐饮 POI ÷ ${innerLabel} |`)
    if (d.nearest?.metro) out.push(`| 最近地铁 | ${d.nearest.metro.name} ${d.nearest.metro.distance_m}m | 高德最近站点检索 |`)
    if (d.density_basis && typeof d.density_basis === 'object') {
      const basis = Object.entries(d.density_basis).map(([k, v]) => `${k}：${v}`).join('；')
      out.push('')
      out.push(`> **统计半径（分母口径）**：${basis}。表内各指标半径不同，横向比较前先看这一行。`)
    }
    out.push('')
    const s = d.demand_score
    out.push(`**综合需求强度：${s.score}/100**（数据完整度 ${Math.round((d.data_completeness ?? 0) * 100)}%，置信度 ${d.confidence ?? '—'}）`, '')
    out.push(...populationBlock(data))
    if (Array.isArray(d.missing) && d.missing.length > 0) {
      out.push('缺失项（不影响上述结论，但需补）：', '')
      for (const x of d.missing) out.push(`- ${x}`)
      out.push('')
    }
    if (d.proxy_caveat && typeof d.proxy_caveat === 'object') {
      out.push('> **代理指标的已知偏差（读结论前必看）**：')
      for (const [k, v] of Object.entries(d.proxy_caveat)) out.push(`> - ${k}：${v}`)
      out.push('')
    }
    return out
  }

  // 没有代理数据时：先把「缺什么 + 怎么补」说在前面，再给已有的人口核对
  const p = undefined
  const out = ['## 4. 需求侧指标', '']

  out.push('> ⚠️ **本段 POI 代理指标未计算**：本点位尚未跑需求侧采集，下面只有独立人口源。', '')
  out.push('补齐方式：在 `scratch-plugin` 目录下运行', '')
  out.push('```')
  out.push('python tools/demand-fetch.py "地址" --radius 3000 --out survey/demand/<store_id>.json')
  out.push('```')
  out.push('')
  out.push(...populationBlock(data))
  out.push('_**禁止用竞品数量反推人口规模**——那是自我循环。_', '')
  return out
}

function vetoSection(md) {
  const v = md.veto
  if (!v) {
    return [
      '## 5. 场地核查（本段未执行）', '',
      '> 未提供调研表，**消防/排烟/电量/燃气/层高/门宽 等硬性条件未核查**。',
      '> 这不是「没问题」，是「还没查」。',
      '',
      '补齐：复制 `survey/_template.csv` 填好，跑 ',
      '',
      '```',
      'node tools/run-site.mjs --profile=<档案> --address="<地址>" --survey=survey/<你的表>.csv',
      '```',
      '',
    ]
  }
  const out = ['## 5. 场地核查（提醒，非否决）', '']
  // 全 0 不代表「没问题」，只代表「规则没触发」——必须写清楚，禁止让人误读为已核查通过
  const allZero = v.hard_reasons.length === 0 && v.major_risks.length === 0
    && v.missing_fields.length === 0
  out.push(`- 规则来源：${v.rule_source === 'custom' ? '用户自定义' : '内置示例'}（${v.rule_version}）`)
  out.push(
    `- 核查结果：**硬伤 ${v.hard_reasons.length} 项** ｜ 风险 ${v.major_risks.length} 项 ｜ **待核实字段 ${v.missing_fields.length} 项**`,
  )
  out.push('')
  out.push('> 本段是**备忘录，不是裁决**：缺什么就补什么，签约前补齐即可。系统不判"能不能开"——证照与合规由承租方办理，业务链条自己会卡。')
  if (allZero) {
    out.push('> ⚠️ **全部为 0 不等于「核查通过」**：只是内置规则没有一条被触发。')
    out.push('> 消防、排烟、电量、燃气、层高、门宽、产权、环评这些**必须现场看过**，本表没填就不会出现在上面。')
  }
  out.push('')
  for (const h of v.hard_reasons) out.push(`  - ${h.rule_id} ${h.rule_desc}｜字段 ${h.field_key}｜依据：${h.data_basis}`)
  if (v.major_risks.length > 0) {
    out.push(`- 重大风险：${v.major_risks.length} 项`)
    for (const r of v.major_risks) out.push(`  - ${r.rule_id} ${r.rule_desc}｜${r.field_key}｜依据：${r.data_basis}`)
  }
  if (v.missing_fields.length > 0) {
    out.push(`- 缺失字段：${v.missing_fields.length} 项（${v.missing_fields.map((m) => m.field_key).join('、')}）`)
  }
  out.push('')
  return out
}

/**
 * 截流阈值 —— 必须与 src/site-tools.ts 的 INTERCEPT_THRESHOLDS 保持一致。
 * report 层从 data.rings[].{nearest,top} 复算，是为了让历史 probe.json 也能出这条结论，
 * 不依赖重新跑采集。改动任一侧，另一侧必须同步。
 */
export const INTERCEPT = Object.freeze({
  heavy_distance_m: 300,
  light_distance_m: 800,
  heavy_top1_share_pct: 30,
  light_top1_share_pct: 15,
  heavy_top3_share_pct: 60,
  light_top3_share_pct: 40,
})

/** 三档截流定级：距离与份额任一触发即升级，理由逐条返回。 */
function gradeInterception(distanceM, top1Pct, top3Pct) {
  const reasons = []
  const heavy = []
  if (distanceM < INTERCEPT.heavy_distance_m) heavy.push(`最近竞品 ${distanceM}m < ${INTERCEPT.heavy_distance_m}m（贴脸）`)
  if (top1Pct >= INTERCEPT.heavy_top1_share_pct) heavy.push(`Top1 占 ${top1Pct}% ≥ ${INTERCEPT.heavy_top1_share_pct}%（单一强势玩家）`)
  if (top3Pct >= INTERCEPT.heavy_top3_share_pct) heavy.push(`Top3 合计 ${top3Pct}% ≥ ${INTERCEPT.heavy_top3_share_pct}%（头部包围）`)
  if (heavy.length > 0) return { level: 'heavy', label: '重度截流', reasons: heavy }

  const light = []
  if (distanceM < INTERCEPT.light_distance_m) light.push(`最近竞品 ${distanceM}m < ${INTERCEPT.light_distance_m}m（同街竞争）`)
  if (top1Pct >= INTERCEPT.light_top1_share_pct) light.push(`Top1 占 ${top1Pct}% ≥ ${INTERCEPT.light_top1_share_pct}%（有强势玩家但未垄断）`)
  if (top3Pct >= INTERCEPT.light_top3_share_pct) light.push(`Top3 合计 ${top3Pct}% ≥ ${INTERCEPT.light_top3_share_pct}%（头部集中）`)
  if (light.length > 0) return { level: 'light', label: '轻度分流', reasons: light }

  return { level: 'none', label: '无截流', reasons: ['竞品距离与份额均未触发截流阈值（竞争分散）'] }
}

/** 从内圈结果复算竞争格局；无竞品时返回 null。 */
function competitionOf(ring) {
  const nearest = Array.isArray(ring?.nearest) && ring.nearest.length > 0 ? ring.nearest[0] : null
  if (!nearest) return null
  const top = Array.isArray(ring?.top) ? ring.top : []
  const top1 = top[0] ?? { name: '', share_pct: 0 }
  const top3Pct = Number(top.slice(0, 3).reduce((sum, t) => sum + (t.share_pct ?? 0), 0).toFixed(1))
  const graded = gradeInterception(nearest.distance_m, top1.share_pct ?? 0, top3Pct)
  return {
    ...graded,
    nearestName: nearest.name,
    nearestM: nearest.distance_m,
    top1Name: top1.name,
    top1Pct: top1.share_pct ?? 0,
    top3Pct,
    centerCell: nearest.name,
    centerCellShare: top1.share_pct ?? 0,
  }
}

function financeSection(md) {
  const f = md.finance
  if (!f) {
    return [
      '## 6. 财务测算（本段未执行）', '',
      '> 未提供财务参数，**回本周期 / 极限租金 / 租期现金流 / 敏感度 全部未计算**。',
      '> 选址的核心结论离不开这几个数——缺了它们，本报告只能回答「周边有多少对手」，回答不了「这个价能不能租」。',
      '',
      '需要 6 个数：`daily_revenue` `gross_margin` `monthly_rent` `monthly_labor` `monthly_other_fixed` `initial_investment`',
      '',
      '补齐：复制 `survey/_template.csv` 填好，跑 ',
      '',
      '```',
      'node tools/run-site.mjs --profile=<档案> --address="<地址>" --survey=survey/<你的表>.csv',
      '```',
      '',
    ]
  }
  const out = ['## 6. 财务测算', '']
  const sc = f.per_scenario ?? {}
  const order = ['base', 'pessimistic', 'optimistic'].filter((k) => sc[k])
  const label = { base: '基准', pessimistic: '保守', optimistic: '乐观' }
  const metric = {
    revenue: '月营业额（元）',
    net_profit: '月净利·会计口径（元） —— 扣掉装修设备折旧后的账面利润',
    monthly_cash_flow: '月现金净流（元） —— 实际进账的钱，不扣折旧',
    roi: '年化 ROI —— 一年赚的钱 ÷ 投进去的钱',
    breakeven_revenue_daily: '保本日营业额（元） —— 一天至少卖这么多才不亏',
    payback_static_months: '回本·现金口径（月） —— 按实进账算，多久把本钱挣回来',
    accounting_payback_months: '回本·会计口径（月） —— 把折旧摊进去算，账面多久回本（更保守）',
    max_rent_breakeven: '极限租金·保本（元/月） —— 租金涨到这个数就刚好不赚不亏',
    max_rent_target: '极限租金·目标回本（元/月） —— 租金到顶到多少，仍能在目标月数内回本',
    max_rent_ratio: '极限租金占营业额 —— 租金吃掉营业额几成',
  }
  // 只渲染标量指标；payback_verdict 这类对象字段单独成表，不能塞进三档表里显示「—」
  const keys = order.length > 0
    ? Object.keys(sc[order[0]] ?? {}).filter((k) => {
      const v = (sc[order[0]] ?? {})[k]
      return typeof v === 'number' || typeof v === 'string'
    })
    : []
  if (keys.length > 0) {
    // 三档情景参数必须披露：否则保守/乐观两档的保本额与极限租金无法按公式复算
    {
      const sf = f.scenario_factors
      if (sf) {
        out.push('**三档情景参数（报告据此可复算每一档）**', '')
        out.push('| 情景 | 营收乘数 | 成本乘数 | 说明 |', '| --- | --- | --- | --- |')
        for (const k of ['base', 'pessimistic', 'optimistic']) {
          const f = sf[k]
          if (!f) continue
          const note = k === 'base' ? '用户给定值直接测算'
            : k === 'pessimistic' ? '营收下调、成本上调（压力测算）'
              : '营收上调、成本下调（乐观假设）'
          out.push(`| ${f.label} | ×${f.revenue} | ×${f.cost} | ${note} |`)
        }
        out.push('')
        out.push('> 保本日营业额 = 固定成本 × 成本乘数 ÷ (毛利率 − 税费率) ÷ 30；三档保本额因此**不相同**，差异全部来自成本乘数。', '')
      }
    }
    // E3：params 目标回本（粤菜 36 月）与基准库的高端中餐中位（108.7，区间 90.7~131.1）差 3.0 倍，必须并列披露。
// 基准值一律从 probe.json 的 benchmark 节点取，禁止硬编码——51.7 那个数当时无法从交付物回溯，已删
    {
      const tgt = (f.rent_ceiling ?? {}).target_payback_months ?? (f.space_model ?? {}).target_payback_months
      // 基准值一律从 probe.json 取，禁止硬编码：payback_median/min/max 已在 benchmark 节点里
      const bmk = md.benchmark ?? {}
      const bmMed = typeof bmk.payback_median === 'number' ? bmk.payback_median : null
      const bmMin = typeof bmk.payback_min === 'number' ? bmk.payback_min : null
      const bmMax = typeof bmk.payback_max === 'number' ? bmk.payback_max : null
      const ratioTxt = (bmMed !== null && tgt > 0) ? (bmMed / tgt).toFixed(1) : '—'
      if (typeof tgt === 'number' && tgt > 0) {
        out.push(`> 📐 **两套标尺**：本报告用的「目标回本 ${tgt} 个月」来自业态参数库；`
          + `行业基准库里高端中餐酒楼的回本中位是 **${bmMed} 个月**`
          + (bmMin !== null && bmMax !== null ? `（区间 ${bmMin}~${bmMax}，19 城估算值）` : '（19 城估算值）')
          + `。两者差 **${ratioTxt} 倍**——**${tgt} 个月不是行业常态，是偏紧的要求**。`, '')
      }
    }
    out.push(`| 指标（基准＝常规经营预期） | ${order.map((k) => label[k]).join(' | ')} |`)
    out.push(`| --- | ${order.map(() => '---').join(' | ')} |`)
    for (const key of keys) {
      out.push(`| ${metric[key] ?? key} | ${order.map((k) => {
        const v = sc[k]?.[key]
        if (key === 'roi' && typeof v === 'number') return `${(v * 100).toFixed(1)}%`
        if (key === 'max_rent_ratio' && typeof v === 'number') return `${(v * 100).toFixed(1)}%`
        if (key === 'payback_static_months' && typeof v === 'number') return v > 0 ? `${v}` : '无法回本'
        return num(v)
      }).join(' | ')} |`)
    }
    out.push('')
  }
  const ceiling = f.rent_ceiling
  if (ceiling) {
    out.push(`**极限租金反推（${ceiling.scenario} 档｜目标回本 ${ceiling.target_payback_months} 个月）**`, '')
    out.push('| 项 | 值 |', '| --- | --- |')
    out.push(`| 净利=0 时的租金上限 | ${num(ceiling.rent_ceiling_breakeven)} 元/月 |`)
    out.push(`| 目标回本时的租金上限 | ${num(ceiling.rent_ceiling_at_target)} 元/月 |`)
    out.push(`| 当前租金 | ${num(ceiling.current_rent)} 元/月 |`)
    out.push(`| 按目标口径需降 | ${ceiling.above_ceiling_at_target > 0 ? `${num(ceiling.above_ceiling_at_target)} 元/月` : `无需降（空间 ${num(Math.abs(ceiling.above_ceiling_at_target))} 元/月）`} |`)
    out.push(`| 当前租金 vs 保本租金上限 | 当前 ${num(ceiling.current_rent)} 元/月，上限 ${num(ceiling.rent_ceiling_breakeven)} 元/月${ceiling.above_ceiling_at_breakeven > 0 ? `，**超出 ${num(ceiling.above_ceiling_at_breakeven)} 元/月 → 按现租金签订本项目为亏损**` : `，**距上限还有 ${num(Math.abs(ceiling.above_ceiling_at_breakeven))} 元/月空间**`} |`)
    out.push('')
    if (typeof ceiling.above_ceiling_at_breakeven === 'number' && ceiling.above_ceiling_at_breakeven > 0) {
      out.push('> 当前租金已高于保本上限：按现租金签订，项目本身为亏损。')
      out.push('')
    } else if (typeof ceiling.above_ceiling_at_target === 'number' && ceiling.above_ceiling_at_target > 0) {
      out.push('> 当前租金在保本线以内，但回本慢于目标周期：属「可做但偏紧」，压价空间见上表。')
      out.push('')
    }
  }

  // ── 回本周期判读（餐饮重资产大店民间实操标尺）──
  {
    const b = sc.base ?? {}
    const pv = b.payback_verdict
    const pvc = b.payback_verdict_cash
    if (pv) {
      const mark = {
        too_good: '🔍 快得不真实', excellent: '✅ 优秀', acceptable: '🟡 可接受上限', risky: '⚠️ 风险偏高',
        very_risky: '❌ 风险极高', no_value: '⛔ 基本没有投资价值', never: '⛔ 无法回本',
      }[pv.level] ?? pv.label
      out.push('**回本周期判读（餐饮重资产大店实操标尺）**', '')
      out.push('| 项 | 值 |', '| --- | --- |')
      out.push(`| 会计口径回本（基准档） | **${num(b.accounting_payback_months)} 个月** → ${mark} —— 扣掉装修折旧后，账面要这么多月才回本 |`)
      if (pvc) {
        const markC = {
          too_good: '🔍 快得不真实', excellent: '✅ 优秀', acceptable: '🟡 可接受上限', risky: '⚠️ 风险偏高',
          very_risky: '❌ 风险极高', no_value: '⛔ 基本没有投资价值', never: '⛔ 无法回本',
        }[pvc.level] ?? pvc.label
        out.push(`| 现金流口径回本（基准档） | ${num(b.payback_static_months)} 个月 → ${markC} —— 只算钱进出，账面数字会更好看 |`)
      }
      out.push(`| 判读依据 | ${pv.note} |`)
      out.push('')
      out.push('> **行业实操标尺**（装修投入几百万的重资产大店） —— 这个标尺回答「多久回本算正常」：')
      out.push('> · **24–36 个月（2–3 年）＝ 优秀门店**　· **≤48 个月（4 年）＝ 可勉强接受的上限**')
      out.push('> · 49–60 个月＝风险偏高　· 61–84 个月（5–7 年）＝风险极高　· **>84 个月（7–8 年）＝基本没有投资价值**')
      out.push('> 这是经验标尺，只用来给算出来的回本月数贴标签，不反过来影响测算结果。', '')
    }
  }

  const rec = f.recommendation
  if (rec) {
    const verdict = { healthy: '健康', watch: '偏高', breach: '超红线' }[rec.rent_ratio_verdict] ?? rec.rent_ratio_verdict
    out.push('**建议租金（供谈判使用）**', '')
      out.push('> 取值方式：**谈判锚点取基准档**。保守档不参与取锚点，'
        + '它只是压力测试下的下限，单独列出供风险参考——'
        + '拿压力测试值出价等于按最坏情况要价，谈不成。', '')
    out.push('| 项 | 值 |', '| --- | --- |')
    if (rec.anchor_unreachable) {
      out.push(`| 谈判锚点 | **不可达**（即便零租金，${rec.based_on_scenario} 档也达不到目标回本） |`)
    } else {
      out.push(`| 谈判锚点 | ${num(rec.target_rent)} 元/月（取自 ${rec.based_on_scenario} 档） |`)
    }
    out.push(`| 保本红线 | ${num(rec.ceiling_rent)} 元/月 |`)
    // 压力测试下限：保守档（营收↓15% 且 成本↑5%）两条线，只作风险提示，不作谈判出价
    if (typeof rec.target_rent_conservative === 'number') {
      out.push(`| 压力下限（保守档） | 锚点 ${num(rec.target_rent_conservative)} 元/月`
        + ` ｜ 保本 ${num(rec.ceiling_rent_conservative)} 元/月 — 「营收降 15% 且成本涨 5%」时的最坏情况，**不作为谈判出价** |`)
    }
    // 锚点不可达时，「需降 X 元」会自相矛盾（锚点是负的，降多少都没用）
    out.push(rec.anchor_unreachable
      ? '| 距锚点 | **不适用**——锚点不可达，说明问题不在租金，而在营收/成本结构 |'
      : `| 距锚点 | ${rec.gap_to_target > 0 ? `需降 ${num(rec.gap_to_target)} 元/月` : `**无需降**，尚有余量 ${num(Math.abs(rec.gap_to_target))} 元/月`} |`)
    out.push(`| 当前租售比 | ${(rec.current_rent_ratio * 100).toFixed(1)}%（${rec.rent_ratio_label}健康线 ${(rec.rent_ratio_healthy_max * 100).toFixed(0)}%，警戒线 ${(rec.rent_ratio_warning_max * 100).toFixed(0)}%）→ **${verdict}** |`)
    out.push('')
    if (rec.rent_ratio_hint) {
      out.push(`> 租售比判读：${rec.rent_ratio_hint}`)
      out.push('')
    }
    out.push('> 锚点不是「砍到这个价就签」，而是「高于这个价，按常规经营预期就回不了本（压力下限另列，不是出价依据）」。')
    const _curRent = rec.target_rent + rec.gap_to_target
    const _gapPct = _curRent > 0 ? rec.gap_to_target / _curRent : 0
    if (_gapPct > 0.3) {
      out.push(`> 需降幅度达当前租金的 ${Math.round(_gapPct * 100)}%：这通常不是「租金贵」，而是这笔交易结构不成立——应重核人力与投入，或改谈免租期、装修补贴、保底+抽成。`)
    } else if (_gapPct < -0.3) {
      out.push(`> 当前租金低于承受上限 ${Math.round(Math.abs(_gapPct) * 100)}%：价格层面很宽松，谈判重点应转向免租期、递增条款与装修补贴，而不是继续压价。`)
    }
    out.push('')
  }

  const lm = f.lease_model
  if (lm) {
    const verdict = { healthy: '回本充分', tight: '回本偏晚', fail: '租期内收不回投资' }[lm.verdict] ?? lm.verdict
    out.push(`**租期现金流（${lm.term_years} 年合同）**`, '')
    out.push('| 项 | 值 |', '| --- | --- |')
    out.push(`| 租金年递增 | ${(lm.rent_escalation_pct * 100).toFixed(1)}% |`)
    out.push(`| 目标回本 | ${lm.suggested_target_payback_months} 个月（${lm.suggested_target_label}${lm.target_explicit ? '，本次调用方指定' : '，业态默认'}） |`)
    out.push(`| 容纳目标回本所需租期 | ≥${lm.required_term_years} 年 |`)
    out.push(`| 翻新 | 每 ${lm.renovation_cycle_years} 年 ${num(lm.renovation_cost)} 元 |`)
    out.push(`| 租期内回本 | ${lm.payback_month > 0 ? `${lm.payback_month} 个月（${lm.payback_year} 年）` : '未回本'} → **${verdict}** |`)
    out.push(`| 累计付租 | ${num(lm.total_rent_paid)} 元 |`)
    out.push(`| 累计翻新 | ${num(lm.total_renovation)} 元 |`)
    out.push(`| 期末累计现金 | ${num(lm.ending_cumulative)} 元 |`)
    out.push('')
    if (lm.term_warning) out.push(`> ⚠️ ${lm.term_warning}`)
    if (lm.term_capacity_warning) out.push(`> ⚠️ ${lm.term_capacity_warning}`)
    if (lm.target_payback_mismatch) out.push(`> ⚠️ ${lm.target_payback_note}`)
    if (lm.term_warning || lm.term_capacity_warning || lm.target_payback_mismatch) out.push('')
    out.push('| 年 | 月租金 | 年度现金净流 | 翻新 | 累计现金 |', '| --- | --- | --- | --- | --- |')
    for (const y of lm.yearly) {
      out.push(`| ${y.year} | ${num(y.rent_monthly)} | ${num(y.net_profit)} | ${y.renovation ? num(y.renovation) : '—'} | ${num(y.cumulative)} |`)
    }
    out.push('')
  }

  const sp = f.space_model
  if (sp) {
    if (sp.available) {
      out.push('**空间容量（面积 ↔ 营收对账）**', '')
      out.push('| 项 | 值 |', '| --- | --- |')
      out.push(`| 建筑 / 厨房 / 营业 | ${num(sp.area_sqm)} / ${num(sp.kitchen_area_sqm)}（${(sp.kitchen_ratio * 100).toFixed(0)}%）/ ${num(sp.operating_area_sqm)} ㎡ |`)
      out.push(`| 座位数 | ${sp.seats}（${sp.seat_source === 'derived' ? '按每座面积推算' : sp.seat_source === 'input' ? '调用方提供' : '无法确定'}） |`)
      if (sp.turnover_per_day >= 0) {
        out.push(`| 翻台率 | 座口径 ${sp.turnover_per_day} 次/日（一个座位一天被坐几轮）｜ 桌口径 ${sp.turnover_tables_per_day} 次/日（${sp.tables} 桌 × ${sp.table_size} 人） ｜ 业态常规 ${sp.normal_turnover_per_day} ／ 上限 ${sp.turnover_cap_per_day} |`)
        out.push(`| 日均客流 / 容量利用率 | ${num(sp.daily_customers)} 人 / ${sp.utilization_pct}%（店里能坐的位子实际坐满了多少，高＝座位用得透，低＝空着也要付租） |`)
      }
      if (sp.implied_daily_revenue_normal > 0) {
        const ratioPct = (sp.revenue_vs_normal_ratio * 100).toFixed(1)
        out.push(`| 面积产能校验 | 该面积按常规翻台应做 ${num(sp.implied_daily_revenue_normal)} 元/日；当前假设为其 **${ratioPct}%**${sp.input_consistency === 'ok' ? '' : ' ⚠️ 不自洽'} |`)
      }
      if (sp.breakeven_turnover_per_day >= 0) {
        out.push(`| 建议翻台率 | 保本 ${sp.breakeven_turnover_per_day} 次/日 ｜ ${sp.target_payback_months} 个月回本需 ${sp.target_turnover_per_day} 次/日（会计口径） ｜ 业态上限 ${sp.turnover_cap_per_day} |`)
      }
      if (sp.typical_ticket_max > 0) {
        out.push(`| 客单价校验 | ${sp.avg_ticket >= 0 ? `${sp.avg_ticket} 元` : '未提供'} ｜ 该业态典型 ${sp.typical_ticket_min}~${sp.typical_ticket_max} 元 ｜ ${sp.ticket_matches_format ? '匹配' : '⚠️ 与业态标签不符'} |`)
      }
      if (sp.turnover_risk && sp.turnover_risk !== 'unknown') {
        const mark = {
          red: '⛔ 现实可行性低', yellow: '⚠️ 偏低薄利', green: '✅ 合理',
          high: '⚠️ 高于常态', impossible: '⛔ 超物理上限',
        }[sp.turnover_risk]
        out.push(`| 翻台风险判定 | **${mark}**：${sp.turnover_risk_note} |`)
        const tb = sp.turnover_band
        if (tb) {
          out.push(
            `| 翻台基准（座位翻台） | ${tb.label}：告警 <${tb.alert_below}`
            + ` ｜ 黄色 ${tb.warn_low}–${tb.warn_high} ｜ 绿色 ${tb.normal_low}–${tb.normal_high}`
            + ` ｜ 物理上限 ${tb.max_real}（**不用于财务测算**） |`,
          )
          out.push('| 口径提醒 | 本表是**座位翻台率**，不是桌翻台率；座位翻台受空座、拼台影响，同店同经营下低于桌翻台，两套口径不可混用 |')
        }
      }
      out.push(`| 坪效 | ${num(sp.revenue_per_sqm_month)} 元/㎡/月（每平米每月能做多少营业额，用来看地方有没有被浪费；按**建筑面积**算，不是营业面积；经验基准 ${sp.revenue_per_sqm_benchmark}） |`)
      out.push(`| 单方造价 | ${num(sp.investment_per_sqm)} 元/㎡（每平米投了多少钱：装修+设备+其他初始投入） |`)
      out.push(`| 盈亏平衡 | 日 ${num(Math.round(sp.breakeven_revenue_monthly / 30))} / 月 ${num(sp.breakeven_revenue_monthly)} 元 |`)
      if (sp.breakeven_customers_daily >= 0) {
        out.push(`| 保本客单量 | ${sp.breakeven_customers_daily} 单/日（一天至少接待多少单才不亏） |`)
      }
      out.push('')
      if (sp.defaults_used.length > 0) out.push(`> 空间模型缺省系数：${sp.defaults_used.join('、')}`)
      for (const w of sp.warnings) out.push(`> ⚠️ ${w}`)
      if (sp.defaults_used.length > 0 || sp.warnings.length > 0) out.push('')
    } else {
      out.push(`**空间容量**：未计算（${sp.note}）`, '')
      out.push(`**盈亏平衡**：日 ${num(Math.round(sp.breakeven_revenue_monthly / 30))} 元 / 月 ${num(sp.breakeven_revenue_monthly)} 元`, '')
    }
  }

  // 内部比值校验：不依赖任何外部抓取，用已录入参数互锁
  const ratioChecks = Array.isArray(f.ratio_checks) ? f.ratio_checks : []
  if (ratioChecks.length > 0) {
    out.push('**内部比值校验（不抓外部数据，靠参数互锁）**', '')
    out.push('| 指标 | 当前值 | 该业态常规 | 判定 | 说明 |', '| --- | --- | --- | --- | --- |')
    for (const c of ratioChecks) {
      const flag = c.status === 'ok' ? '✅ 正常' : c.status === 'low' ? '⚠️ 偏低' : '⚠️ 偏高'
      out.push(`| ${c.item} | ${c.value}${c.unit} | ${c.healthy_min}~${c.healthy_max}${c.unit} | ${flag} | ${c.note} |`)
    }
    out.push('')
  }

  // 假设台账：把「不是你亲口给的数」逐条摊开
  const ledger = Array.isArray(f.assumption_ledger) ? f.assumption_ledger : []
  const needCheck = ledger.filter((r) => r.action !== '可直接用' && r.action !== '已按覆盖值生效')
  if (needCheck.length > 0) {
    out.push('**待确认的假设（不是你亲口给的数）**', '')
    out.push('| 分类 | 参数 | 取值 | 来源 | 建议 |', '| --- | --- | --- | --- | --- |')
    for (const r of needCheck) {
      out.push(`| ${r.category} | ${r.item} | ${r.value} | ${r.source} | ${r.action} |`)
    }
    out.push('')
  }

  const sens = Array.isArray(f.sensitivity) ? f.sensitivity : []
  if (sens.length > 0) {
    out.push('**敏感度：各参数 ±20% 对谈判锚点的影响**', '')
    out.push('| 参数 | 锚点 −20% | 锚点 基准 | 锚点 +20% | 该参数是否影响结论 |', '| --- | --- | --- | --- | --- |')
    for (const s of sens) {
      out.push(`| ${s.param} | ${num(s.anchor_low)} | ${num(s.anchor_base)} | ${num(s.anchor_high)} | ${s.conclusion_flips ? '**会翻转** —— 这个数只要估错 20%，结论就从「能做」变「不能做」，必须实测' : '不变'} |`)
    }
    out.push('')
  }

  // 业态翻台风险：红色阈值下，财务结果只能当压力测算，必须显式警告
  const spRisk = f.space_model
  if (spRisk && spRisk.turnover_risk === 'red') {
    out.push('> ⛔ **本情景参数组合现实可行性低**：' + spRisk.turnover_risk_note + '。')
    out.push('> 下面的回本周期与 ROI **只用于压力测算，不代表项目正常经营预期**；')
    out.push('> 先修参数（客流/客单/面积/租金），把翻台做进合理区间，再看结论。', '')
  } else if (spRisk && spRisk.turnover_risk === 'yellow') {
    out.push('> ⚠️ ' + spRisk.turnover_risk_note + '。', '')
  } else if (spRisk && spRisk.turnover_risk === 'high') {
    out.push('> ⚠️ ' + spRisk.turnover_risk_note + '。', '')
  } else if (spRisk && spRisk.turnover_risk === 'impossible') {
    out.push('> ⛔ **参数超出物理上限**：' + spRisk.turnover_risk_note + '。', '')
  }

  const spaceSens = Array.isArray(f.space_sensitivity) ? f.space_sensitivity : []
  if (spaceSens.length > 0) {
    out.push('**空间侧敏感度：各系数 ±20% 对座位与产能的影响**', '')
    out.push('| 系数 | 座位 −20% | 座位 基准 | 座位 +20% | 应有日营收 −20% | 基准 | +20% | 结论 |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const s of spaceSens) {
      out.push(`| ${s.param} | ${s.seats_low} | ${s.seats_base} | ${s.seats_high} | ${num(s.implied_revenue_low)} | ${num(s.implied_revenue_base)} | ${num(s.implied_revenue_high)} | ${s.consistency_flips ? '**会翻转**' : '不变'} |`)
    }
    out.push('')
  }
  if (Array.isArray(f.low_confidence_params) && f.low_confidence_params.length > 0) {
    out.push(`> 低置信参数（结论须标【预估】）：${f.low_confidence_params.join('、')}`)
    out.push('')
  }
  return out
}

export function buildReport(data, profile) {
  const v = verdict(data)
  const d = data.dedupe ?? {}
  const cov = data.coverage ?? {}
  const inner = data.rings?.[0] ?? {}
  const outer = data.rings?.[data.rings.length - 1] ?? {}
  const transit = data.transit ?? {}
  const now = new Date().toLocaleString('zh-CN')
  const m = (transit.metro ?? [])[0]

  const md = []
  md.push(`# 选址评估报告：${data.address}`, '')
  md.push(`- 业态档案：**${profile?.name ?? '未指定'}**`)
  md.push(`- 坐标（GCJ-02）：${data.center?.lat?.toFixed(6)}, ${data.center?.lng?.toFixed(6)}`)
  md.push(`- 生成时间：${now}`)
  md.push(`- 等时圈来源：${inner.source === 'valhalla' ? '本地 Valhalla 路网' : inner.source === 'osrm' ? '本地 OSRM 路网' : '直线估算【估算】'}（行走范围按真实道路路径算出来的，不是在地图上画个圆；导航引擎名字不影响结论）`)
  const isoN = data.isochrone_notice
  if (isoN) {
    md.push('')
    md.push(`> ⚠️ **等时圈引擎未启用**（${isoN.reason}）`)
    md.push(`> 本次圈层为【直线估算】：${isoN.impact}。`)
    md.push(`> 启动：\`${isoN.fix}\`（首次：\`${isoN.first_time}\`）`)
  }
  md.push('')
  md.push('## 0. 结论', '')
  md.push(`**${v.line}**`, '')
  if (v.split) md.push(v.split, '')
  if (data.data_quality && data.data_quality.verdict !== 'ok') {
    const dq = data.data_quality
    md.push(`> ${dq.verdict === 'suspicious' ? '⛔' : '⚠️'} **采集数据可疑（${dq.verdict}）**：${dq.note}`)
    for (const w of dq.warnings ?? []) md.push(`> - ${w}`)
    md.push('')
  }

  // 指引：白话表排在最下方，必须让读者在开头就知道它存在
  md.push('> 看不惯行业黑话的话，**文末《附：白话版》**有 24 条术语对照表；'
    + '内文重要行也已就地注成「原说法 —— 大白话」。', '')

  md.push('## 1. 数据质量', '', '| 项 | 值 |', '| --- | --- |')
  md.push(`| 原始 POI | ${num(d.raw)} |`)
  md.push(`| 去重后有效 | ${num(d.effective)} |`)
  md.push(`| 剔除 / 合并 | ${num(d.dropped)} / ${num(d.merged)} |`)
  md.push(`| 同段竞品 / 异段 | ${num(d.same_type_count)} / ${num(d.other_type_count)} |`)
  if (Array.isArray(d.segments) && d.segments.length > 0) {
    md.push(`| 竞争分段（★=你所在段） | ${d.segments.map((s) => `${scaleLabelBy(s)}${s.is_self ? '★' : ''} ${s.count} 家${s.avg_cost > 0 ? `（人均 ${s.avg_cost} 元）` : ''}`).join(' ｜ ')} |`)
    const selfSeg = d.segments.find((s) => s.is_self)
    if (selfSeg) {
      md.push(`| 直接对手 | ${scaleLabelBy(selfSeg)}：${selfSeg.count} 家${selfSeg.avg_cost > 0 ? `，人均 ${selfSeg.avg_cost} 元` : ''} |`)
    }
  }
  md.push(`| 高德覆盖率 | ${cov.amap >= 0 ? `${cov.amap}%` : '多关键词扫描'} |`)
  md.push(`| 腾讯覆盖率 | ${num(cov.tencent)}% |`)
  // 数据源模式必须写明：单源不许声称「双源交叉验证」
  const sourceMode = cov.source_mode ?? data.data_quality?.source_mode
  if (sourceMode === 'dual') {
    md.push('| 数据源模式 | **双源交叉**（高德 + 腾讯）：第 2 筛，已检出真实租金 |')
  } else if (sourceMode === 'single') {
    md.push('| 数据源模式 | **单源**（仅高德）：未检出真实租金，腾讯交叉校验未启用。'
      + '本报告**不含**双源交叉验证，竞品数只有高德一个来源 |')
  } else {
    md.push('| 数据源模式 | 未标注（旧版 probe 输出），按单源看待 |')
  }
  md.push('')
  const dq = data.data_quality
  if (dq) {
    const mark = dq.verdict === 'ok' ? '✅ 正常' : dq.verdict === 'partial' ? '⚠️ 打折' : '⛔ 可疑'
    md.push(`| 采集可信度 | ${mark}（${dq.verdict}）${dq.warnings?.length ? `：${dq.warnings.join('；')}` : ''} |`, '')
  }

  md.push('## 2. 竞品分布', '')
  // 20.5 竞争集中度：一眼看出这块地是「有头部」还是「一堆碎片」
  {
    const _t = inner.top ?? []
    if (_t.length > 0) {
      const _sum = (n) => Number(_t.slice(0, n).reduce((a, x) => a + (Number(x.share_pct) || 0), 0).toFixed(1))
      const _t3 = _sum(3)
      const _t10 = _sum(10)
      const _n = Number(inner.inside ?? 0)
      const _restN = Math.max(0, _n - Math.min(10, _t.length))
      const _verdict = _t3 >= 50 ? '高度集中：头部两三家吃掉一半以上，新店要靠正面抢客'
        : _t3 >= 30 ? '中度集中：有头部但没垄断，还有切入口'
          : _t3 >= 15 ? '较分散：头部优势弱，靠差异化就能站住'
            : '极度分散：没有真正的头部，谁都能切一块，但也谁都不占优'
      md.push('**竞争集中度**', '', '| 指标 | 值 |', '| --- | --- |')
      md.push(`| 圈内竞品（主圈） | ${_n} 家 —— 你正常做生意的那个范围里有多少家竞品 |`)
      md.push(`| Top1 势力份额 | ${_t[0].share_pct}%（${_t[0].name}） |`)
      md.push(`| Top3 合计 | ${_t3}% |`)
      md.push(`| Top10 合计 | ${_t10}% |`)
      if (_restN > 0) md.push(`| Top20 之外 ${_restN} 家瓜分 | ${Number((100 - _t10).toFixed(1))}% |`)
      md.push(`| 集中度判读 | **${_verdict}** |`)
      md.push('', '> 势力份额＝圈内网格中该店为最近店的比例，不是营业额份额。占比高只说明「离得近」，不代表「卖得多」。', '')
    }
  }
  // 章节号按实际存在的段落顺延：只配一个圈层时不会出现 2.1 → 2.3 跳号
  let _sec = 0
  const secNo = () => `2.${++_sec}`
  const _topList = inner.top ?? []
  const _tieMark = () => ""
  md.push(`### ${secNo()} ${inner.label ?? '内圈'}（势力份额 Top20）`, '')
  md.push('> **「份额」是本系统自算的势力覆盖占比**：把圈内切成网格，每格归给最近的一家店，该店分到的格子数 ÷ 总格子数。')
  md.push('> 它衡量「这块地方谁离得最近」——**不是营业额份额，也不是市占率**。', '')
  // 左右两栏：Top1–10 ｜ Top11–20
  const _l = _topList.slice(0, 10)
  const _r = _topList.slice(10, 20)
  const _cell = (t, idx) => (t
    ? `Top${idx + 1}${_tieMark(idx)} | ${String(t.name).replace(/\|/g, '\\|')} | ${t.share_pct}%`
    : ' |  | ')
  md.push('| # | 竞品 | 份额 | # | 竞品 | 份额 |', '| --- | --- | --- | --- | --- | --- |')
  for (let k = 0; k < Math.max(_l.length, _r.length); k += 1) {
    md.push(`| ${_cell(_l[k], k)} | ${_cell(_r[k], k + 10)} |`)
  }
  md.push('')
  if (outer.distance_bands?.length) {
    md.push(`### ${secNo()} ${outer.label ?? '外圈'}（不报份额，只报距离带）`, '', '| 距离带 | 家数 |', '| --- | --- |')
    outer.distance_bands.forEach((b) => md.push(`| ${b.label} | ${b.count} |`))
    md.push('')
  }

  // 2.4 竞品三级分层：直接（同品类同价位）/ 替代（同品类不同价位）/ 间接（不同品类）
  // 分类依据 = 竞争分段的机器键，格式 `<品类>_<价位段>`，如 yuecai_large / chaoshan_small
  const segs = Array.isArray(d.segments) ? d.segments : []
  const selfSegKey = d.self_segment ?? segs.find((s) => s.is_self)?.key
  const tier = (() => {
    if (segs.length === 0 || !selfSegKey) return null
    const splitKey = (k) => {
      const i = String(k).lastIndexOf('_')
      return i > 0 ? { cat: String(k).slice(0, i), band: String(k).slice(i + 1) } : { cat: String(k), band: '' }
    }
    const selfParts = splitKey(selfSegKey)
    let directCount = 0
    let substituteCount = 0
    let indirectCount = 0
    const subList = []
    for (const s of segs) {
      const p = splitKey(s.key)
      if (s.key === selfSegKey) directCount += s.count
      else if (p.cat === selfParts.cat) { substituteCount += s.count; subList.push(s) }
      else indirectCount += s.count
    }
    return { selfSegKey, directCount, substituteCount, indirectCount, subList }
  })()
  // 2.4 的正文延后到 2.3 之后输出（编号与阅读顺序要保持一致）
  const tierLines = []
  if (tier !== null) {
    tierLines.push('### __TIER_NO__ 竞品三级分层', '')
    tierLines.push('> **分类规则**：按「菜系 × 价位段」切分。同价位段且目标客群高度重叠的，即使菜系不同也按**直接竞品**对待；'
      + '只有客群明显不同的才算间接。', '')
    tierLines.push('| 层级 | 划分依据 | 家数 | 对选址的含义 |', '| --- | --- | --- | --- |')
    tierLines.push(`| 直接竞品 | 同品类 + 同价位段（\`${tier.selfSegKey}\`） | **${tier.directCount}** | 真正的对手，决定你能拿多少份额 |`)
    tierLines.push(`| 替代竞品 | 同品类、不同价位段 | ${tier.substituteCount} | 客群会互相流动（聚餐/宴请档期最明显） |`)
    tierLines.push(`| 间接竞品 | 不同品类 | ${tier.indirectCount} | 抢同一笔餐饮预算，但不是同一场景 |`)
    if (tier.subList.length > 0) {
      tierLines.push('', `替代层明细（同类不同价，平时不抢、办宴席时会流动）：${tier.subList.map((s) => `${s.key} ${s.count} 家${s.avg_cost > 0 ? `（人均 ${s.avg_cost}）` : ''}`).join('；')}`)
    }
    tierLines.push('')
  }

  const comp = competitionOf(inner)
  if (comp) {
    md.push(`### ${secNo()} 截流判定（两轴）`, '')
    // 第一轴：点位截流力。优先取财务结果，其次取现场判定（不依赖财务参数）
    const CAP = {
      L1: ['顶级截流（千分点）', 1.3], L2: ['强截流（A 类点）', 1.1], L3: ['中等截流（B 类·基准）', 1.0],
      L4: ['弱截流（C 类点）', 0.65], L5: ['极低截流（D 类·慎选）', 0.15],
    }
    const capCode = data.finance?.catchment_code || data.catchment?.code || ''
    const capInfo = CAP[capCode]
    const capApplied = data.finance?.catchment_code ? true : false
    const capCell = capInfo
      ? `| 第一轴·点位截流力 | **${capCode} ${capInfo[0]}**（客流 ×${capInfo[1]}${capApplied ? '，已计入财务' : '，待财务参数到位后计入'}） |`
      : '| 第一轴·点位截流力 | 未判定 —— 要去现场看铺位在动线的什么位置、显不显眼、在几楼，再按 L1–L5 打级（L1 最好：临主街、一眼看见、一楼；L5 最差：藏在深处、背街、高层） |'
    md.push('| 项 | 值 |', '| --- | --- |')
    md.push(capCell)
    md.push(`| 第二轴·竞争截流压力 | **${comp.label}**（${comp.level}）—— ${
      comp.level === 'heavy' ? '抢客的店太多，客人还没走到你门口就被别人截走了'
        : comp.level === 'moderate' || comp.level === 'medium' ? '周围有对手，但还没到抢客的程度'
          : '附近没什么人跟你抢同一批客人'} |`)
    md.push(`| 圈内最近竞品 | ${comp.nearestName} ${comp.nearestM} m —— 你开业第一天就要跟它分客 |`)
    md.push(`| Top1 势力份额 | ${comp.top1Name} ${comp.top1Pct}% —— 这块地盘它占了 ${comp.top1Pct}%（按"谁离得近"算，不是营业额） |`)
    md.push(`| Top3 合计势力份额 | ${comp.top3Pct}% —— 前三名加起来占了 ${comp.top3Pct}% 的地盘，剩下的人分剩下的 |`)
    md.push(`| Voronoi 归属 | 本点位落在「${comp.centerCell}」的势力范围内 —— 就是说这块地"归"它，你开门等于直接跟它抢同一批人 |`, '')
    md.push('触发理由：', '')
    for (const r of comp.reasons) md.push(`- ${r}`)
    md.push('')
    md.push('> **两轴不能互相替代** —— 第一轴看「这个铺位能截多少路过客流」（场地属性，现场判），')
    md.push('> 第二轴看「对手抢走多少」（竞争属性，POI 推算）。')
    md.push('> 前者调客流，后者调风险，报告里必须分开写。', '')
  }

  if (tierLines.length > 0) {
    tierLines[0] = tierLines[0].replace('__TIER_NO__', secNo())
  }
  md.push(...tierLines)

  // 2.5 动线阻断（现场实测，优先于路网估算）
  const barriers = Array.isArray(data.barriers) ? data.barriers : []
  const blockedGoals = barriers.filter((b) => String(b.barrier_type ?? '') !== '')
  if (barriers.length > 0) {
    md.push(`### ${secNo()} 动线阻断（现场实测）`, '')
    md.push('| 目标 | 类型 | 直线 | 实际步行 | 绕行倍数 | 阻断 |', '| --- | --- | --- | --- | --- | --- |')
    for (const b of barriers) {
      const ratio = String(b.detour_ratio ?? '') !== '' ? `${b.detour_ratio}×` : '—'
      const walk = String(b.walk_m ?? '') !== '' && Number(b.walk_m) > 0 ? `${b.walk_m}m / ${b.walk_min}分` : '无步行路径'
      md.push(`| ${b.to_name ?? ''} | ${b.kind ?? ''} | ${b.straight_m ?? '—'}m | ${walk} | ${ratio} | ${b.barrier_type || '通'} |`)
    }
    md.push('')
    if (blockedGoals.length > 0) {
      md.push(`**修正结论**：${blockedGoals.length} 个目标实际不可直达——${blockedGoals.map((b) => `${b.to_name}（绕行 ${b.detour_ratio ?? '—'} 倍）`).join('、')}。`, '')

      // 二筛核心：把被阻断的竞品从「可步行到达」里剔除，重算可达竞品数
      const norm = (s) => String(s ?? '').replace(/[（(].*?[)）]/g, '').replace(/\s/g, '').trim()
      const kept = Array.isArray(data.pois) ? data.pois : Array.isArray(data.dedupe?.kept) ? data.dedupe.kept : []
      const blockedSet = new Set(blockedGoals.map((b) => norm(b.to_name)).filter((n) => n !== ''))
      const unreachable = kept.filter((p) => {
        const pn = norm(p.name)
        if (pn === '') return false
        return [...blockedSet].some((bn) => {
          if (pn === bn) return true
          // 互相包含时要求长度接近，避免「莲香楼」误配「莲香楼·品苑」
          if (!pn.includes(bn) && !bn.includes(pn)) return false
          const short = Math.min(pn.length, bn.length)
          const long = Math.max(pn.length, bn.length)
          return long > 0 && short / long >= 0.6
        })
      })
      const effective = Number(data.dedupe?.effective ?? kept.length)
      if (unreachable.length > 0) {
        md.push(
          `**可达竞品修正**：去重后有效竞品 ${effective} 家 → 其中 ${unreachable.length} 家实测不可步行到达`
          + `（${unreachable.slice(0, 8).map((p) => p.name).join('、')}${unreachable.length > 8 ? ' 等' : ''}）`
          + ` → **实际可步行到达的有效竞品 ${effective - unreachable.length} 家**（全部品类合计；同段直接竞品见「竞品三级分层」）。`,
          '',
        )
        const nearest = comp?.nearestName ?? ''
        if (nearest !== '' && unreachable.some((p) => norm(p.name) === norm(nearest))) {
          md.push(`> ⚠️ 圈内最近竞品「${nearest}」被实测判定为不可直达：**截流定级应下调一级**，以下方「动线阻断」表为准。`, '')
        }
      } else {
        md.push('> 被阻断目标中未匹配到竞品（多为地铁口/小区/标的建筑），本次不影响竞品口径，只修正交通可达。', '')
      }
      md.push('> 该方向应视为「不可步行到达」；份额与截流以本表为准，不以路网估算为准。', '')
    }
  }

  md.push('## 3. 交通可达', '', '| 项 | 值 |', '| --- | --- |')
  // 若有实测步行数据，地铁行要注明真实步行距离——直线距离会骗人
  const metroBarrier = (Array.isArray(data.barriers) ? data.barriers : [])
    .filter((b) => String(b.kind ?? '') === 'metro' && Number(b.walk_m) > 0)
    .sort((a, b) => Number(a.walk_m) - Number(b.walk_m))[0]
  const metroWalkNote = metroBarrier
    ? `（**实测步行**：${metroBarrier.to_name} ${metroBarrier.walk_m}m / ${metroBarrier.walk_min}分，见 2.5）`
    : ''
  md.push(`| 最近地铁站（≤${transit.metro_threshold_m ?? 800}m） | ${m ? `${m.name} ${m.distance_m} m` : '2km 内无'}${metroWalkNote} |`)
  md.push(`| 最近停车场（≤${transit.parking_threshold_m ?? 300}m） | ${transit.nearest_parking_m >= 0 ? `${transit.nearest_parking_m} m` : '未取到'} |`)
  md.push(`| ${transit.parking_threshold_m ?? 300}m 内停车场 | ${num(transit.parking_near, '0')} 个 |`, '')

  md.push(...demandSection(data))
  md.push(...vetoSection(data))
  md.push(...financeSection(data))

  // 行业基准对标（19 城 × 48 业态库）
  const bm = data.benchmark
  if (bm && bm.matched) {
    md.push('**行业基准对标（19 城 × 48 业态库）**', '')
  md.push('> ⚠️ **数据性质**：本库不是 19 城实测样本——同业态跨城的净利率、面积、备注完全相同，'
    + '实质是「1 列行业基数 × 城市系数缩放」的估算值。对标结论只能看**偏离方向**，'
    + '不能当作该城市实测水位（审计 E4）。', '')
    md.push(
      `对标业态：**${bm.matched_format}**（${bm.category}）｜样本 ${bm.sample_size} 城`
      + `｜该业态回本中位 ${bm.payback_median} 月（区间 ${bm.payback_min}~${bm.payback_max}）`,
      '',
    )
    md.push('| 指标 | 本项目 | 行业基准 | 偏离 | 判定 |', '| --- | --- | --- | --- | --- |')
    for (const c of bm.compares) {
      const flag = c.verdict === 'ok' ? '✅ 正常' : c.verdict === 'high' ? '⚠️ 偏高' : '⚠️ 偏低'
      md.push(`| ${c.item} | ${c.ours}${c.unit} | ${c.benchmark}${c.unit} | ${c.deviation_pct > 0 ? '+' : ''}${c.deviation_pct}% | ${flag} |`)
    }
    md.push('')
    const flagged = bm.compares.filter((c) => c.verdict !== 'ok')
    if (flagged.length > 0) {
      md.push('偏离说明：', '')
      for (const c of flagged) md.push(`- **${c.item}**：${c.note}`)
      md.push('')
    }
    md.push('> 基准为行业估算区间（单店实际 ±30%），**只作现实性校验，不替代单店实测**。', '')
  } else if (bm) {
    md.push('**行业基准对标**', '', `> 未匹配：${bm.note}`, '')
  }

  const trace = Array.isArray(data.finance?.formula_trace) ? data.finance.formula_trace : []
  if (trace.length > 0) {
    md.push('## 附录：计算口径（每个数字怎么来的）', '')
    md.push('> 参数搞错时，看这张表最快——每行都给了公式和本次代入的数值。', '')
  md.push('> 表里的术语：**成本因子**＝保守/乐观档对成本的缩放倍数（基准档就是 1，不放不缩）；'
    + '**为何锚点用基准档**＝三档各算一遍，但谈判只能拿基准档出价；保守档是风险提醒，'
    + '宁可按最差情况准备。', '')
    md.push('| 组 | 指标 | 计算口径 | 本次代入 | 结果 |', '| --- | --- | --- | --- | --- |')
    for (const r of trace) {
      md.push(`| ${r.group} | ${r.metric} | ${r.formula} | ${r.substituted} | **${r.result}** |`)
    }
    md.push('')
  }

  // 白话速查：本报告大量使用行业口径，不看这节会读不懂
  md.push('## 附：看不懂的话先看这里（白话版）', '')
  md.push('> 这节不用记，遇到不懂的词回来查一眼就行。', '')
  md.push('| 报告里的说法 | 大白话 |', '| --- | --- |')
  md.push('| **截流 / 截流定级** | 你的店能"拦下"多少本来要路过的人。'
    + '**重度截流**＝这条街上抢客的店太多，客人还没走到你门口就被别人截走了 |')
  md.push('| **截流两轴** | 第一轴看**这个铺位本身**（位置显不显眼、好不好进、在几楼）；'
    + '第二轴看**周围对手**（多少家在抢同一批人）。一个管"人流进不进得来"，一个管"进来后会不会被抢走"，两回事 |')
  md.push('| **势力份额 / Voronoi 归属** | 把这块地切成小格子，每格算给离它最近的那家店。'
    + '某店分到的格子越多＝它的"地盘"越大。**这不是营业额，也不是市占率**，只说明"谁离得近" |')
  md.push('| **Top3 集中度** | 前 3 名加起来占多少地盘。占比高＝头部几家把客抓得牢，新店难插进去；'
    + '占比低＝碎片化，靠差异化就能站住 |')
  md.push('| **同段 / 异段** | 「段」是按"菜系 × 价位"分的类。同段＝跟你同类同价，是真正抢客的人；'
    + '异段＝不同类或不同价，多数是互补不是对手 |')
  md.push('| **直接 / 替代 / 间接竞品** | 直接＝同类同价，客人只能二选一；'
    + '替代＝同类不同价，平时不抢、办宴席时会流动；间接＝不同品类，抢的是同一笔"吃饭预算" |')
  md.push('| **翻台率** | 一个座位一天被坐了几轮。1.998 次 ≈ 每座一天接待两拨客人。'
    + '**座位翻台 ≠ 桌翻台**：一桌 4 人，空 1 个座就拉低座位翻台 |')
  md.push('| **坪效** | 每平方米每个月能做多少营业额。用来看"这块地方有没有被浪费" |')
  md.push('| **保本日营业额** | 一天至少卖多少钱才不亏。低于这个数就是在赔钱 |')
  md.push('| **极限租金** | **保本那档**＝租金再高一分钱就开始亏；'
    + '**目标回本那档**＝租金到这个数，就没法在目标月数内回本 |')
  md.push('| **谈判锚点** | 谈租金的参考上限，**不是"砍到这个价就签"**——高于它，按常规经营预期就回不了本（压力下限另列，不是出价依据） |')
  md.push('| **租售比** | 月租金 ÷ 月营业额。租金占营业额几成。餐饮大店经验：10% 以内健康，15% 以上警戒 |')
  md.push('| **现金口径 / 会计口径** | 现金口径＝只算钱进出，回本快，看"多久能周转开"；'
    + '会计口径＝把装修设备的折旧摊进去，回本慢，看"这笔投资账面划不划算"。两个都要看 |')
  md.push('| **摊销** | 装修和设备的一次性投入，按月摊到成本里。450 万 ÷ 60 个月＝每月 7.5 万 |')
  md.push('| **容量利用率** | 店里能坐的位子实际坐满了多少。66.6% ≈ 每 3 个位子有 1 个空着 |')
  md.push('| **职住比** | 写字楼数量 ÷ 住宅数量。>1 上班的人多（工作日午市好做），<1 住家的人多（晚市和周末好做） |')
  md.push('| **等时圈 / 圈层** | 从点位出发走 N 分钟能到的范围，按真实路网算，不是画个圆 |')
  md.push('| **单方造价** | 每平方米投了多少钱（装修＋设备＋其他初始投入） |')
  md.push('| **保本客单量** | 一天至少接待多少单才不亏 |')
  md.push('| **敏感度「会翻转」** | 这个参数只要估错 20%，结论就从"能做"变"不能做"——'
    + '所以它必须实测，不能拍脑袋估 |')
  md.push('| **截流系数** | 算营业额时乘的一个折扣：路过的人里有多少比例真会进你的店 |')
  md.push('| **硬伤 / 待核实** | 硬伤＝明确不满足的硬条件；'
    + '待核实＝还没拿到数据、需要现场确认的项——**是待办清单，不是否决** |')
  md.push('| **规模档推定，无人均实证** | 这家店人均多少我们没拿到真实数据，是按店名和规模"猜"的档位，别太当真 |')
  md.push('| **ROI** | 年化投资回报率：一年赚的钱 ÷ 投进去的钱 |')
  md.push('')

  md.push('---', '')
  md.push(inner.source === 'valhalla' || inner.source === 'osrm'
    ? '> 等时圈为本地路网计算，已去除沿主干道走廊的细长尖刺；外圈因范围过大不报份额。'
    : '> 等时圈为直线估算【估算】，遇江面/快速路会高估可达范围；外圈因范围过大不报份额。')
  md.push('> 数据来源：高德/腾讯 POI、本地路网引擎、用户录入调研表。'
    + '—— 竞品和配套是从地图公司的商家库抓的，距离和走路时间是用本地导航引擎按真实道路算的，'
    + '财务参数是你自己填的。建议拿这份跟现场实测对一遍再拍板。')

  const markdown = md.join('\n')

  const segSelf = Array.isArray(d.segments) ? d.segments.find((s) => s.is_self) : null
  const segTotal = Array.isArray(d.segments) ? d.segments.reduce((a, s) => a + s.count, 0) : 0
  const segPlain = segSelf
    ? `你的直接对手是「${scaleLabelBy(segSelf)}」：${segSelf.count} 家${segSelf.avg_cost > 0 ? `，平均人均 ${segSelf.avg_cost} 元` : '，<b>该段全部无高德人均数据</b>，分段依据是店名与品类而非人均实证'}。其余 ${segTotal - segSelf.count} 家属于别的段——同品类不同规模、或不同菜系，是<b>协同或弱竞争</b>，不是直接对手。`
    : ''

  const segRows = Array.isArray(d.segments) && d.segments.length > 0
    ? `<h2>竞争分段（品类 × 规模）</h2>
<p style="color:#555">同一家餐厅，<b>品类相同但规模不同就不是竞品</b>：人均 28 元的粿条店和人均 252 元的粤菜馆，客群完全不重叠。
下表按「菜系 + 规模」把人分成几段，<b>★ = 你所在的段（直接竞品）</b>，其余段是协同或弱竞争。</p>
${segPlain ? `<div class="concl" style="font-size:14px">${esc(segPlain)}</div>` : ''}
<table><tr><th>分段</th><th>家数</th><th>人均</th><th>评分</th><th>有价率</th><th>机器键</th></tr>
${d.segments.map((s) => `<tr><td>${esc(scaleLabelBy(s))}${s.is_self ? ' ★' : ''}</td><td>${s.count}</td><td>${s.avg_cost > 0 ? `${s.avg_cost} 元` : '—'}</td><td>${s.avg_rating > 0 ? s.avg_rating : '—'}</td><td>${s.cost_coverage ?? 0}%</td><td style="color:#aaa;font-size:12px">${esc(s.key)}</td></tr>`).join('')}</table>`
    : ''

  const vetoHtml = data.veto
    ? `<h2>5. 场地核查（提醒，非否决）</h2><p>规则来源：${esc(data.veto.rule_source === 'custom' ? '用户自定义' : '内置示例')}（${esc(data.veto.rule_version)}）</p>
<p style="background:#f5f5f5;border-left:4px solid #999;padding:10px 14px;color:#555">本段是<b>备忘录，不是裁决</b>：缺什么就补什么，签约前补齐即可。证照与合规由承租方办理，系统不判「能不能开」。</p>
<table><tr><th>项</th><th>内容</th></tr>
<tr><td>硬伤</td><td><b>${data.veto.hard_reasons.length} 项</b></td></tr>
<tr><td>风险</td><td>${data.veto.major_risks.length} 项</td></tr>
<tr><td>待核实字段</td><td><b>${data.veto.missing_fields.length} 项</b>${data.veto.missing_fields.length > 0 ? `：${esc(data.veto.missing_fields.map((x) => x.field_key).join('、'))}` : ''}</td></tr>
${data.veto.hard_reasons.map((h) => `<tr><td>硬伤 ${esc(h.rule_id)}</td><td>${esc(h.rule_desc)}（${esc(h.field_key)}｜${esc(h.data_basis)}）</td></tr>`).join('')}
${data.veto.major_risks.map((r) => `<tr><td>风险 ${esc(r.rule_id)}</td><td>${esc(r.rule_desc)}（${esc(r.field_key)}）</td></tr>`).join('')}
</table>`
    : `<h2>5. 场地核查（本段未执行）</h2>
<p style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px;margin:12px 0">
未提供调研表，<b>消防 / 排烟 / 电量 / 燃气 / 层高 / 门宽 等硬性条件未核查</b>。<br>
这不是「没问题」，是「还没查」。<br>
补齐：复制 <code>survey/_template.csv</code> 填好，跑
<code>node tools/run-site.mjs --profile=&lt;档案&gt; --address="&lt;地址&gt;" --survey=survey/&lt;你的表&gt;.csv</code>
</p>`

  const finHtml = data.finance
    ? (() => {
        const sc = data.finance.per_scenario ?? {}
        const order = ['base', 'pessimistic', 'optimistic'].filter((k) => sc[k])
        const keys = order.length > 0
          ? Object.keys(sc[order[0]] ?? {}).filter((k) => {
            const v = (sc[order[0]] ?? {})[k]
            return typeof v === 'number' || typeof v === 'string'
          })
          : []
        const label = { base: '基准', pessimistic: '保守', optimistic: '乐观' }
        const metric = {
          revenue: '月营业额（元）', net_profit: '月净利·会计口径（元）', monthly_cash_flow: '月现金净流（元）',
          roi: '年化 ROI',
          breakeven_revenue_daily: '保本日营业额（元）', payback_static_months: '回本·现金口径（月）',
          accounting_payback_months: '回本·会计口径（月）',
          max_rent_breakeven: '极限租金·保本（元/月）', max_rent_target: '极限租金·目标回本（元/月）',
          max_rent_ratio: '极限租金占营业额',
        }
        const sfHtml = data.finance.scenario_factors
        const sfTableHtml = !sfHtml ? '' : `<h3 style="font-size:15px;margin:18px 0 6px">三档情景参数（报告据此可复算每一档）</h3>
<table><tr><th>情景</th><th>营收乘数</th><th>成本乘数</th><th>说明</th></tr>
${['base', 'pessimistic', 'optimistic'].map((k) => {
          const x = sfHtml[k]
          if (!x) return ''
          const note = k === 'base' ? '用户给定值直接测算'
            : k === 'pessimistic' ? '营收下调、成本上调（压力测算）'
              : '营收上调、成本下调（乐观假设）'
          return `<tr><td>${esc(x.label ?? k)}</td><td>×${x.revenue}</td><td>×${x.cost}</td><td>${note}</td></tr>`
        }).join('')}</table>
<p style="color:#666;font-size:13px">保本日营业额 = 固定成本 × 成本乘数 ÷ (毛利率 − 税费率) ÷ 30；三档保本额因此<b>不相同</b>，差异全部来自成本乘数。</p>`
        return `<h2>6. 财务测算</h2>${sfTableHtml}<table><tr><th>指标</th>${order.map((k) => `<th>${label[k]}</th>`).join('')}</tr>
${keys.map((key) => `<tr><td>${esc(metric[key] ?? key)}</td>${order.map((k) => {
          const v = sc[k]?.[key]
          if (key === 'roi' && typeof v === 'number') return `<td>${(v * 100).toFixed(1)}%</td>`
          if (key === 'max_rent_ratio' && typeof v === 'number') return `<td>${(v * 100).toFixed(1)}%</td>`
          if (key === 'payback_static_months' && typeof v === 'number') return `<td>${v > 0 ? v : '无法回本'}</td>`
          return `<td>${num(v)}</td>`
        }).join('')}</tr>`).join('')}</table>
${Array.isArray(data.finance.low_confidence_params) && data.finance.low_confidence_params.length > 0 ? `<p style="color:#c62828">低置信参数（须标【预估】）：${esc(data.finance.low_confidence_params.join('、'))}</p>` : ''}
${data.finance.rent_ceiling ? `<h3 style="font-size:15px;margin:18px 0 6px">极限租金反推（${esc(data.finance.rent_ceiling.scenario)} 档｜目标回本 ${data.finance.rent_ceiling.target_payback_months} 个月）</h3>
<table><tr><th>项</th><th>值</th></tr>
<tr><td>净利=0 时的租金上限</td><td>${num(data.finance.rent_ceiling.rent_ceiling_breakeven)} 元/月</td></tr>
<tr><td>目标回本时的租金上限</td><td>${num(data.finance.rent_ceiling.rent_ceiling_at_target)} 元/月</td></tr>
<tr><td>当前租金</td><td>${num(data.finance.rent_ceiling.current_rent)} 元/月</td></tr>
<tr><td>按目标口径需降</td><td>${data.finance.rent_ceiling.above_ceiling_at_target > 0 ? `${num(data.finance.rent_ceiling.above_ceiling_at_target)} 元/月` : `无需降（空间 ${num(Math.abs(data.finance.rent_ceiling.above_ceiling_at_target))} 元/月）`}</td></tr>
<tr><td>当前租金 vs 保本租金上限</td><td>当前 ${num(data.finance.rent_ceiling.current_rent)} 元/月，上限 ${num(data.finance.rent_ceiling.rent_ceiling_breakeven)} 元/月${data.finance.rent_ceiling.above_ceiling_at_breakeven > 0 ? `，<b>超出 ${num(data.finance.rent_ceiling.above_ceiling_at_breakeven)} 元/月 → 按现租金签订本项目为亏损</b>` : `，<b>距上限还有 ${num(Math.abs(data.finance.rent_ceiling.above_ceiling_at_breakeven))} 元/月空间</b>`}</td></tr></table>` : ''}
${(() => {
  const b = (data.finance.per_scenario ?? {}).base ?? {}
  const pv = b.payback_verdict
  if (!pv) return ''
  const mk = (lv, lb) => ({
    too_good: '🔍 快得不真实', excellent: '✅ 优秀', acceptable: '🟡 可接受上限', risky: '⚠️ 风险偏高',
    very_risky: '❌ 风险极高', no_value: '⛔ 基本没有投资价值', never: '⛔ 无法回本',
  }[lv] ?? lb)
  const pvc = b.payback_verdict_cash
  return `<h3 style="font-size:15px;margin:18px 0 6px">回本周期判读（餐饮重资产大店实操标尺）</h3>
${(() => {
  const tgt = data.finance?.rent_ceiling?.target_payback_months ?? data.finance?.space_model?.target_payback_months
  const bmkH = data.benchmark ?? {}
  const bmMed = typeof bmkH.payback_median === 'number' ? bmkH.payback_median : null
  const bmMin = typeof bmkH.payback_min === 'number' ? bmkH.payback_min : null
  const bmMax = typeof bmkH.payback_max === 'number' ? bmkH.payback_max : null
  const ratioTxt = (bmMed !== null && tgt > 0) ? (bmMed / tgt).toFixed(1) : '—'
  if (typeof tgt !== 'number' || tgt <= 0) return ''
  return `<p style="color:#555;background:#f5f5f5;padding:8px 10px;border-left:3px solid #999;font-size:13px">`
    + `📐 <b>两套标尺</b>：本报告用的「目标回本 ${tgt} 个月」来自业态参数库；`
    + `而行业基准库里高端中餐酒楼的回本中位是 <b>${bmMed} 个月</b>`
    + (bmMin !== null && bmMax !== null ? `（区间 ${bmMin}~${bmMax}，19 城估算值）` : '（19 城估算值）')
    + `。两者差 <b>${ratioTxt} 倍</b>——<b>${tgt} 个月不是行业常态，是偏紧的要求</b>。</p>`
})()}
<table><tr><th>项</th><th>值</th></tr>
<tr><td>会计口径回本（基准档）</td><td><b>${num(b.accounting_payback_months)} 个月</b> → <b>${mk(pv.level, pv.label)}</b></td></tr>
${pvc ? `<tr><td>现金流口径回本（基准档）</td><td>${num(b.payback_static_months)} 个月 → ${mk(pvc.level, pvc.label)}</td></tr>` : ''}
<tr><td>判读依据</td><td>${esc(pv.note)}</td></tr></table>
<p style="background:#f5f5f5;border-left:4px solid #999;padding:10px 14px;color:#555;margin:10px 0">
<b>行业实操标尺</b>（装修投入几百万的重资产大店）<br>
✅ <b>24–36 个月（2–3 年）＝ 优秀门店</b>　🟡 <b>≤48 个月（4 年）＝ 可勉强接受的上限</b><br>
⚠️ 49–60 个月＝风险偏高　❌ 61–84 个月（5–7 年）＝风险极高　⛔ <b>&gt;84 个月（7–8 年）＝基本没有投资价值</b><br>
<span style="color:#888">经验标尺，只用来给算出来的回本月数贴标签，不反过来影响测算结果。</span>
</p>`
})()}
${data.finance.recommendation ? (() => {
  const rec = data.finance.recommendation
  const gapCell = rec.anchor_unreachable
    ? '<b>不可达</b>（零租金也达不到目标回本）'
    : rec.gap_to_target > 0
      ? `需降 ${num(rec.gap_to_target)} 元/月`
      : `<b>无需降</b>，尚有余量 ${num(Math.abs(rec.gap_to_target))} 元/月`
        + (typeof rec.rent_headroom_pct === 'number' && rec.rent_headroom_pct !== 0
          ? `（当前租金 ${num(data.finance.rent_ceiling.current_rent)} 元/月，锚点 ${num(rec.target_rent)} 元/月，`
            + `安全余量占锚点 ${(Math.abs(rec.rent_headroom_pct) * 100).toFixed(0)}%）`
          : '')
  return `<h3 style="font-size:15px;margin:18px 0 6px">建议租金（锚点取基准档，保守档仅作压力下限）</h3>
<table><tr><th>项</th><th>值</th></tr>
<tr><td>谈判锚点</td><td>${rec.anchor_unreachable ? '<b>不可达</b>（即便零租金，压力测试档也达不到目标回本）' : `<b>${num(rec.target_rent)}</b> 元/月（取自 ${rec.based_on_scenario} 档）`}</td></tr>
<tr><td>保本红线</td><td>${num(rec.ceiling_rent)} 元/月</td></tr>
${typeof rec.target_rent_conservative === 'number' ? `<tr><td>压力下限（保守档）</td><td>锚点 ${num(rec.target_rent_conservative)} 元/月 ｜ 保本 ${num(rec.ceiling_rent_conservative)} 元/月 —— 「营收降 15% 且成本涨 5%」时的最坏情况，<b>不作为谈判出价</b></td></tr>` : ''}
<tr><td>距锚点</td><td>${gapCell}</td></tr>
<tr><td>当前租售比</td><td>${(rec.current_rent_ratio * 100).toFixed(1)}%（${esc(rec.rent_ratio_label)}健康线 ${(rec.rent_ratio_healthy_max * 100).toFixed(0)}%，警戒线 ${(rec.rent_ratio_warning_max * 100).toFixed(0)}%）→ <b>${esc({ healthy: '健康', watch: '偏高', breach: '超红线' }[rec.rent_ratio_verdict] ?? rec.rent_ratio_verdict)}</b></td></tr>
</table>
<p style="color:#666">${esc(rec.rent_ratio_hint)}</p>
<p style="color:#666"><b>取值方式</b>：谈判锚点取<b>基准档</b>。保守档不参与取锚点，它只是压力测试下的下限，单独列出供风险参考——拿压力测试值出价等于按最坏情况要价，谈不成。</p>
<p style="background:#f5f5f5;border-left:4px solid #999;padding:10px 14px;color:#555">锚点不是「砍到这个价就签」，而是「高于这个价，按常规经营预期就回不了本（压力下限另列，不是出价依据）」。${(() => {
      const cur = rec.target_rent + rec.gap_to_target
      const pct = cur > 0 ? rec.gap_to_target / cur : 0
      if (pct > 0.3) return `需降幅度达当前租金的 ${Math.round(pct * 100)}%：这通常不是「租金贵」，而是这笔交易结构不成立——应重核人力与投入，或改谈免租期、装修补贴、保底+抽成。`
      if (pct < -0.3) return `当前租金低于承受上限 ${Math.round(Math.abs(pct) * 100)}%：价格层面很宽松，谈判重点应转向免租期、递增条款与装修补贴，而不是继续压价。`
      return '锚点与当前租金差距在 30% 以内，属正常议价区间。'
    })()}</p>`
})() : ''}`
      })()
    : `<h2>6. 财务测算（本段未执行）</h2>
<p style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px;margin:12px 0">
未提供财务参数，<b>回本周期 / 极限租金 / 租期现金流 / 敏感度 全部未计算</b>。<br>
缺了这几个数，报告只能回答「周边有多少对手」，回答不了「这个价能不能租」。<br>
需要 6 个数：<code>daily_revenue</code> <code>gross_margin</code> <code>monthly_rent</code>
<code>monthly_labor</code> <code>monthly_other_fixed</code> <code>initial_investment</code><br>
补齐：复制 <code>survey/_template.csv</code> 填好，跑
<code>node tools/run-site.mjs --profile=&lt;档案&gt; --address="&lt;地址&gt;" --survey=survey/&lt;你的表&gt;.csv</code>
</p>`

  const popHtml = (() => {
    const d = data.demand
    if (d && d.demand_score) {
      const p = d.proxies ?? {}
  // 密度分母写明实际半径（与「内圈·步行N分」不是同一个圈）
  const _innerR = d.demand?.inner_radius_m
  const innerLabel = typeof _innerR === 'number' && _innerR > 0
    ? `${_innerR}m 圆（≈${(Math.PI * (_innerR / 1000) ** 2).toFixed(2)} km²）`
    : '内圈面积'
      const rows = [
        `<tr><td>住宅密度</td><td>${p.residential_density_per_km2 ?? '—'} 个/km²</td><td>住宅区 POI ÷ 扫描面积</td></tr>`,
        `<tr><td>职住比</td><td>${p.job_housing_ratio ?? '—'}</td><td>写字楼 POI ÷ 住宅区 POI（&gt;1 偏就业型）</td></tr>`,
        `<tr><td>配套成熟度</td><td>${p.amenity_count ?? '—'}</td><td>购物中心 + 学校 + 地铁站</td></tr>`,
        `<tr><td>咖啡密度</td><td>${p.coffee_density_per_km2 ?? '—'} 个/km²</td><td>精品咖啡 POI ÷ ${innerLabel}（消费力代理）</td></tr>`,
        `<tr><td>银行密度</td><td>${p.bank_density_per_km2 ?? '—'} 个/km²</td><td>银行网点 POI ÷ ${innerLabel}</td></tr>`,
        `<tr><td>高端餐饮密度</td><td>${p.premium_dining_density_per_km2 ?? '—'} 个/km²</td><td>连锁高端餐饮 POI ÷ ${innerLabel}</td></tr>`,
      ]
      if (d.nearest?.metro) rows.push(`<tr><td>最近地铁</td><td>${esc(d.nearest.metro.name)} ${d.nearest.metro.distance_m}m</td><td>高德最近站点检索</td></tr>`)
      const caveat = d.proxy_caveat && typeof d.proxy_caveat === 'object'
        ? `<p style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px;color:#555"><b>代理指标的已知偏差：</b><br>${Object.entries(d.proxy_caveat).map(([k, v]) => `· ${esc(k)}：${esc(v)}`).join('<br>')}</p>`
        : ''
      return `<h2>4. 需求侧代理指标</h2>
<p style="color:#888">数据源：高德 POI 自动采集（${esc(d.captured_at ?? '—')}）｜扫描半径 ${d.radius_m ?? '—'}m。以下全部为<b>代理指标，不是实测人口</b>。</p>
<table><tr><th>指标</th><th>值</th><th>怎么来的</th></tr>${rows.join('')}</table>
<p class="concl" style="font-size:15px">综合需求强度：${d.demand_score.score}/100（数据完整度 ${Math.round((d.data_completeness ?? 0) * 100)}%，置信度 ${esc(d.confidence ?? '—')}）</p>
${caveat}${populationHtml(data)}`
    }
    return `<h2>4. 需求侧指标</h2>${populationHtml(data)}<p style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px">⚠️ <b>POI 代理指标未计算</b>：本点位尚未跑需求侧采集。<br>补齐：<code>python tools/demand-fetch.py "地址" --radius 3000 --out survey/demand/&lt;store_id&gt;.json</code><br><b>禁止用竞品数量反推人口规模。</b></p>`
  })()

  // HTML 侧章节号按**输出顺序**预先分配（const 构造顺序 ≠ 输出顺序，用计数器会错位）
  const _hasOuter = Boolean(outer.distance_bands?.length)
  const _base = _hasOuter ? 1 : 0
  const secOuter = `2.1`
  const secCap = `2.${_base + 1}`
  const secTier = `2.${_base + 2}`
  const tierHtml = tier === null ? '' : `<h3>${secTier} 竞品三级分层</h3><table><tr><th>层级</th><th>划分依据</th><th>家数</th><th>对选址的含义</th></tr>
<tr><td>直接竞品</td><td>同品类 + 同价位段（<code>${esc(tier.selfSegKey)}</code>）</td><td><b>${tier.directCount}</b></td><td>真正的对手，决定你能拿多少份额</td></tr>
<tr><td>替代竞品</td><td>同品类、不同价位段</td><td>${tier.substituteCount}</td><td>客群会互相流动（聚餐/宴请档期最明显）</td></tr>
<tr><td>间接竞品</td><td>不同品类</td><td>${tier.indirectCount}</td><td>抢同一笔餐饮预算，但不是同一场景</td></tr></table>
${tier.subList.length > 0 ? `<p style="color:#666">替代层明细：${esc(tier.subList.map((s) => `${s.key} ${s.count} 家${s.avg_cost > 0 ? `（人均 ${s.avg_cost}）` : ''}`).join('；'))}</p>` : ''}`

  const compHtml = comp
    ? `<h2>${secCap} 截流定级与势力归属</h2><table>
<tr><td>截流定级</td><td><b>${esc(comp.label)}</b>（${esc(comp.level)}）</td></tr>
<tr><td>圈内最近竞品</td><td>${esc(comp.nearestName)} ${comp.nearestM} m</td></tr>
<tr><td>Top1 势力份额</td><td>${esc(comp.top1Name)} ${comp.top1Pct}%</td></tr>
<tr><td>Top3 合计势力份额</td><td>${comp.top3Pct}%</td></tr>
<tr><td>Voronoi 归属</td><td>本点位落在「${esc(comp.centerCell)}」的势力范围内</td></tr></table>
<p style="color:#555">${comp.reasons.map((r) => esc(r)).join('；')}</p>`
    : ''

  const leaseLm = data.finance?.lease_model
  const leaseHtml = leaseLm
    ? (() => {
        const verdict = { healthy: '回本充分', tight: '回本偏晚', fail: '租期内收不回投资' }[leaseLm.verdict] ?? leaseLm.verdict
        return `<h3 style="font-size:15px;margin:18px 0 6px">租期现金流（${leaseLm.term_years} 年合同）</h3>
<table><tr><th>项</th><th>值</th></tr>
<tr><td>租金年递增</td><td>${(leaseLm.rent_escalation_pct * 100).toFixed(1)}%</td></tr>
<tr><td>翻新</td><td>每 ${leaseLm.renovation_cycle_years} 年 ${num(leaseLm.renovation_cost)} 元</td></tr>
<tr><td>租期内回本</td><td><b>${leaseLm.payback_month > 0 ? `${leaseLm.payback_month} 个月（${leaseLm.payback_year} 年）` : '未回本'}</b> → ${esc(verdict)}</td></tr>
<tr><td>累计付租</td><td>${num(leaseLm.total_rent_paid)} 元</td></tr>
<tr><td>累计翻新</td><td>${num(leaseLm.total_renovation)} 元</td></tr>
<tr><td>期末累计现金</td><td>${num(leaseLm.ending_cumulative)} 元</td></tr></table>
${leaseLm.term_warning ? `<p style="color:#c62828">⚠️ ${esc(leaseLm.term_warning)}</p>` : ''}
${leaseLm.term_capacity_warning ? `<p style="color:#c62828">⚠️ ${esc(leaseLm.term_capacity_warning)}</p>` : ''}
${leaseLm.target_payback_mismatch ? `<p style="color:#c62828">⚠️ ${esc(leaseLm.target_payback_note)}</p>` : ''}
<table><tr><th>年</th><th>月租金</th><th>年度现金净流</th><th>翻新</th><th>累计现金</th></tr>
${leaseLm.yearly.map((y) => `<tr><td>${y.year}</td><td>${num(y.rent_monthly)}</td><td>${num(y.net_profit)}</td><td>${y.renovation ? num(y.renovation) : '—'}</td><td>${num(y.cumulative)}</td></tr>`).join('')}</table>`
      })()
    : ''

  const spLm = data.finance?.space_model
  const spaceHtml = spLm && spLm.available
    ? `<h3 style="font-size:15px;margin:18px 0 6px">空间容量（面积 ↔ 营收对账）</h3>
<table><tr><th>项</th><th>值</th></tr>
<tr><td>建筑 / 厨房 / 营业</td><td>${num(spLm.area_sqm)} / ${num(spLm.kitchen_area_sqm)}（${(spLm.kitchen_ratio * 100).toFixed(0)}%）/ ${num(spLm.operating_area_sqm)} ㎡</td></tr>
<tr><td>座位数</td><td>${spLm.seats}（${spLm.seat_source === 'derived' ? '按每座面积推算' : spLm.seat_source === 'input' ? '调用方提供' : '无法确定'}）</td></tr>
${spLm.turnover_per_day >= 0 ? `<tr><td>翻台率</td><td>座口径 ${spLm.turnover_per_day} 次/日 ｜ 桌口径 ${spLm.turnover_tables_per_day} 次/日（${spLm.tables} 桌 × ${spLm.table_size} 人） ｜ 业态常规 ${spLm.normal_turnover_per_day} ／ 上限 ${spLm.turnover_cap_per_day}</td></tr>
<tr><td>日均客流 / 容量利用率</td><td>${num(spLm.daily_customers)} 人 / ${spLm.utilization_pct}%</td></tr>` : ''}
${spLm.implied_daily_revenue_normal > 0 ? `<tr><td>面积产能校验</td><td>该面积按常规翻台应做 ${num(spLm.implied_daily_revenue_normal)} 元/日；当前假设为其 <b>${(spLm.revenue_vs_normal_ratio * 100).toFixed(1)}%</b>${spLm.input_consistency === 'ok' ? '' : ' ⚠️ 不自洽'}</td></tr>` : ''}
${spLm.breakeven_turnover_per_day >= 0 ? `<tr><td>建议翻台率</td><td>保本 ${spLm.breakeven_turnover_per_day} 次/日（会计口径） ｜ ${spLm.target_payback_months} 个月回本需 ${spLm.target_turnover_per_day} 次/日 ｜ 业态上限 ${spLm.turnover_cap_per_day}</td></tr>` : ''}
${spLm.ticket_matches_format === false ? `<tr><td>客单价校验</td><td style="color:#c62828">${spLm.avg_ticket} 元 ｜ 该业态典型 ${spLm.typical_ticket_min}~${spLm.typical_ticket_max} 元 ｜ ⚠️ 与业态标签不符</td></tr>` : ''}
${spLm.turnover_risk && spLm.turnover_risk !== "unknown" ? (() => {
  const mk = {
    red: "⛔ 现实可行性低", yellow: "⚠️ 偏低薄利", green: "✅ 合理",
    high: "⚠️ 高于常态", impossible: "⛔ 超物理上限",
  }[spLm.turnover_risk]
  const tb = spLm.turnover_band
  const bandRow = tb
    ? `<tr><td>翻台基准（座位翻台）</td><td>${esc(tb.label)}：告警 &lt;${tb.alert_below}`
      + ` ｜ 黄色 ${tb.warn_low}–${tb.warn_high} ｜ 绿色 ${tb.normal_low}–${tb.normal_high}`
      + ` ｜ 物理上限 ${tb.max_real}（<b>不用于财务测算</b>）</td></tr>`
      + `<tr><td>口径提醒</td><td>本表是<b>座位翻台率</b>，不是桌翻台率；座位翻台受空座、拼台影响，同店同经营下低于桌翻台，两套口径不可混用</td></tr>`
    : ""
  return `<tr><td>翻台风险判定</td><td><b>${mk}</b>：${esc(spLm.turnover_risk_note)}</td></tr>` + bandRow
})() : ""}
<tr><td>坪效</td><td>${num(spLm.revenue_per_sqm_month)} 元/㎡/月（按<b>建筑面积</b>，非营业面积；经验基准 ${spLm.revenue_per_sqm_benchmark}）</td></tr>
<tr><td>单方造价</td><td>${num(spLm.investment_per_sqm)} 元/㎡</td></tr>
<tr><td>盈亏平衡</td><td>日 ${num(Math.round(spLm.breakeven_revenue_monthly / 30))} / 月 ${num(spLm.breakeven_revenue_monthly)} 元</td></tr>
${spLm.breakeven_customers_daily >= 0 ? `<tr><td>保本客单量</td><td>${spLm.breakeven_customers_daily} 单/日</td></tr>` : ''}</table>
${spLm.defaults_used.length > 0 ? `<p style="color:#888">空间模型缺省系数：${esc(spLm.defaults_used.join('、'))}</p>` : ''}
${spLm.warnings.map((w) => `<p style="color:#c62828">⚠️ ${esc(w)}</p>`).join('')}`
    : (spLm ? `<h3 style="font-size:15px;margin:18px 0 6px">空间容量</h3><p style="color:#999">未计算（${esc(spLm.note)}）</p>` : '')

  const bmRows = data.benchmark?.matched ? data.benchmark : null
  const bmHtml = bmRows
    ? `<h3>行业基准对标（19 城 × 48 业态库）</h3>
<p style="color:#a15c00;background:#fff8e1;padding:8px 10px;border-left:3px solid #ffb300;font-size:13px">
⚠️ <b>数据性质</b>：本库不是 19 城实测样本——同业态跨城的净利率、面积、备注完全相同，实质是「1 列行业基数 × 城市系数缩放」的估算值。对标结论只能看<b>偏离方向</b>，不能当作该城市实测水位。</p>
<p>对标业态：<b>${esc(bmRows.matched_format)}</b>（${esc(bmRows.category)}）｜样本 ${bmRows.sample_size} 城｜该业态回本中位 ${bmRows.payback_median} 月（区间 ${bmRows.payback_min}~${bmRows.payback_max}）</p>
<table><tr><th>指标</th><th>本项目</th><th>行业基准</th><th>偏离</th><th>判定</th></tr>
${bmRows.compares.map((c) => `<tr><td>${esc(c.item)}</td><td>${c.ours}${esc(c.unit)}</td><td>${c.benchmark}${esc(c.unit)}</td><td>${c.deviation_pct > 0 ? '+' : ''}${c.deviation_pct}%</td><td>${c.verdict === 'ok' ? '✅ 正常' : c.verdict === 'high' ? '⚠️ 偏高' : '⚠️ 偏低'}</td></tr>`).join('')}</table>
<p style="color:#666">基准为行业估算区间（单店实际 ±30%），<b>只作现实性校验，不替代单店实测</b>。</p>`
    : ''

  const traceRows = Array.isArray(data.finance?.formula_trace) ? data.finance.formula_trace : []
  const traceHtml = traceRows.length > 0
    ? `<h2>附录：计算口径（每个数字怎么来的）</h2>
<p style="color:#555">参数搞错时看这张表最快——每行都给了公式和本次代入的数值。</p>
<table><tr><th>组</th><th>指标</th><th>计算口径</th><th>本次代入</th><th>结果</th></tr>
${traceRows.map((r) => `<tr><td>${esc(r.group)}</td><td>${esc(r.metric)}</td><td>${esc(r.formula)}</td><td style="color:#666">${esc(r.substituted)}</td><td><b>${esc(r.result)}</b></td></tr>`).join('')}</table>`
    : ''

  const ledgerRows = Array.isArray(data.finance?.assumption_ledger)
    ? data.finance.assumption_ledger.filter((r) => r.action !== '可直接用' && r.action !== '已按覆盖值生效')
    : []
  const sensRows = Array.isArray(data.finance?.sensitivity) ? data.finance.sensitivity : []
  const spaceSensRows = Array.isArray(data.finance?.space_sensitivity) ? data.finance.space_sensitivity : []
  const ratioRows = Array.isArray(data.finance?.ratio_checks) ? data.finance.ratio_checks : []
  const ratioHtml = ratioRows.length > 0
    ? `<h3 style="font-size:15px;margin:18px 0 6px">内部比值校验（不抓外部数据，靠参数互锁）</h3>
<table><tr><th>指标</th><th>当前值</th><th>该业态常规</th><th>判定</th><th>说明</th></tr>
${ratioRows.map((c) => `<tr><td>${esc(c.item)}</td><td>${c.value}${esc(c.unit)}</td><td>${c.healthy_min}~${c.healthy_max}${esc(c.unit)}</td><td>${c.status === 'ok' ? '✅ 正常' : c.status === 'low' ? '⚠️ 偏低' : '⚠️ 偏高'}</td><td>${esc(c.note)}</td></tr>`).join('')}</table>`
    : ''
  const auditHtml = (ledgerRows.length > 0 || sensRows.length > 0 || spaceSensRows.length > 0 || ratioRows.length > 0)
    ? `${ratioHtml}
${ledgerRows.length > 0 ? `<h3 style="font-size:15px;margin:18px 0 6px">待确认的假设（不是你亲口给的数）</h3>
<table><tr><th>分类</th><th>参数</th><th>取值</th><th>来源</th><th>建议</th></tr>
${ledgerRows.map((r) => `<tr><td>${esc(r.category)}</td><td>${esc(r.item)}</td><td>${esc(r.value)}</td><td>${esc(r.source)}</td><td>${esc(r.action)}</td></tr>`).join('')}</table>` : ''}
${sensRows.length > 0 ? `<h3 style="font-size:15px;margin:18px 0 6px">敏感度：各参数 ±20% 对谈判锚点的影响</h3>
<table><tr><th>参数</th><th>锚点 −20%</th><th>锚点 基准</th><th>锚点 +20%</th><th>结论</th></tr>
${sensRows.map((s) => `<tr><td>${esc(s.param)}</td><td>${num(s.anchor_low)}</td><td>${num(s.anchor_base)}</td><td>${num(s.anchor_high)}</td><td>${s.conclusion_flips ? '<b style="color:#c62828">会翻转</b>' : '不变'}</td></tr>`).join('')}</table>` : ''}
${spaceSensRows.length > 0 ? `<h3 style="font-size:15px;margin:18px 0 6px">空间侧敏感度：各系数 ±20% 对座位与产能的影响</h3>
<table><tr><th>系数</th><th>座位 −20%</th><th>座位 基准</th><th>座位 +20%</th><th>应有日营收 −20%</th><th>基准</th><th>+20%</th><th>结论</th></tr>
${spaceSensRows.map((s) => `<tr><td>${esc(s.param)}</td><td>${s.seats_low}</td><td>${s.seats_base}</td><td>${s.seats_high}</td><td>${num(s.implied_revenue_low)}</td><td>${num(s.implied_revenue_base)}</td><td>${num(s.implied_revenue_high)}</td><td>${s.consistency_flips ? '<b style="color:#c62828">会翻转</b>' : '不变'}</td></tr>`).join('')}</table>` : ''}`
    : ''

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>选址报告 · ${esc(data.address)}</title>
<style>
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1100px;margin:28px auto;padding:0 20px;color:#222;line-height:1.75}
h1{font-size:22px;border-bottom:2px solid #eee;padding-bottom:10px}
h2{font-size:17px;margin-top:28px;color:#b00000;border-left:4px solid #b00000;padding-left:8px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}
td,th{border:1px solid #eee;padding:7px 10px;text-align:left}
blockquote{background:#fff8e1;border-left:4px solid #ffb300;margin:14px 0;padding:10px 14px;color:#555}
.concl{background:#fff3f3;border-left:4px solid #d40000;padding:12px 16px;font-size:15px;font-weight:600;margin:12px 0}
iframe{width:100%;height:520px;border:1px solid #ddd;margin:10px 0}
.toolbar{position:fixed;right:18px;top:18px;display:flex;gap:8px;align-items:center;z-index:99}
.toolbar button{border:1px solid #1565c0;background:#1565c0;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px}
.toolbar button.ghost{background:#fff;color:#1565c0}
.toolbar button:hover{opacity:.88}
.savehint{position:fixed;right:18px;top:58px;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:12px 14px;max-width:320px;font-size:12.5px;color:#444;line-height:1.6;display:none;z-index:99}
.savehint b{color:#1565c0}
.savehint code{background:#f2f4f7;padding:1px 5px;border-radius:3px;font-size:12px}
button{padding:7px 14px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer}
/* ───────── 地图 + 竞品排名布局（屏幕与打印通用） ───────── */
.maprow{display:flex;gap:16px;align-items:flex-start}
.staticmap{position:relative;overflow:hidden;border:1px solid #ddd;flex:1 1 auto;min-width:0;background:#eef2f5}
.staticmap svg{width:100%;height:auto;display:block;pointer-events:none;user-select:none}
.mapinner{transform-origin:center center;transition:transform .16s ease-out;will-change:transform}
.mapzoom{position:absolute;right:10px;top:10px;z-index:6;display:flex;flex-direction:column;gap:4px;align-items:center}
.mapzoom button{width:30px;height:30px;padding:0;font-size:15px;line-height:1;border:1px solid #cfd8dc;background:rgba(255,255,255,.96);border-radius:6px;cursor:pointer;color:#37474f;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.mapzoom button:hover{background:#fff;border-color:#90a4ae;color:#0277bd}
.mapzoom button:active{transform:translateY(1px)}
#mapzoomlv{font-size:10.5px;color:#546e7a;background:rgba(255,255,255,.9);padding:1px 4px;border-radius:3px;font-variant-numeric:tabular-nums}
.shareside{flex:0 0 520px;max-width:520px}
.sharecols{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;align-items:start}
.tienote{margin:8px 0 0;font-size:11.5px;color:#78909c;line-height:1.5;border-top:1px dashed #e0e0e0;padding-top:6px}

.sharetable{font-size:11.5px;border-collapse:collapse;table-layout:fixed;width:100%}
.sharetable col.c-rk{width:44px}
.sharetable col.c-pc{width:46px}
.sharetable td{border:none;padding:2px 3px;line-height:1.35;border-bottom:1px solid #f2f2f2}
.sharetable td.rk{text-align:left;padding-right:0;color:#78909c;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11.5px}
.sharetable td.nm{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sharetable td.pc{text-align:right;padding-left:2px;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600;color:#37474f}
.sharetable tr.poirow:nth-child(even){background:#fafafa}
.sharetable tr.poirow:hover{background:#fff3e0;cursor:pointer}
.sharetable tr.poirow.on{background:#ffe0b2;font-weight:600}
.pinhint{color:#888;font-size:11.5px;margin:8px 0 0;line-height:1.5}

/* ───────── 打印专用 ───────── */
@media print{
  .toolbar{display:none}
  .savehint{display:none !important}
  iframe{height:420px;page-break-inside:avoid}
  h2{page-break-after:avoid}
  .maprow{display:flex;gap:10px}
  .shareside{flex:0 0 300px;max-width:300px}
  .sharecols{display:grid;grid-template-columns:1fr 1fr}
  .staticmap svg{max-height:150mm}
  .mapinner{transform:none !important}
  .mapzoom{display:none}
}

/* ───────── 窄屏 ───────── */
@media (max-width:900px){
  .maprow{display:block}
  .shareside{max-width:none;margin-top:14px}
  .sharecols{grid-template-columns:1fr 1fr}
}
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()">🖨 存为 PDF</button>
  <button class="ghost" onclick="__saveHtml()">💾 下载这份报告</button>
  <button class="ghost" onclick="document.getElementById('savehint').style.display='block'">? 怎么发</button>
</div>
<div class="savehint" id="savehint">
  <b>怎么把报告发出去</b><br>
  1. 点「💾 下载这份报告」→ 得到一个单独的 .html 文件<br>
  2. 把这个文件发微信 / 邮件即可，对方双击就能看<br>
  <span style="color:#777">底图已内嵌，不联网也能显示；点击排名联动也在里面。</span><br><br>
  <b>要 PDF</b>：先点排名固定标识，再点「🖨 存为 PDF」<br><br>
  <b>浏览器自带另存</b>：<code>Ctrl+S</code> 选「网页，仅 HTML」效果一样<br>
  <span style="color:#c62828">别选「网页，全部」——会多出一个文件夹，发出去容易漏图。</span>
</div>
<h1>选址评估报告：${esc(data.address)}</h1>
<p>业态档案：<b>${esc(profile?.name ?? '未指定')}</b>｜坐标 ${data.center?.lat?.toFixed(6)}, ${data.center?.lng?.toFixed(6)}｜${esc(now)}</p>
${data.isochrone_notice ? `<div style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px;margin:12px 0;font-size:13px">
<b>⚠️ 等时圈引擎未启用</b>（${esc(data.isochrone_notice.reason)}）<br>
本次圈层为<b>直线估算</b>：${esc(data.isochrone_notice.impact)}。<br>
启动：<code>${esc(data.isochrone_notice.fix)}</code>　首次：<code>${esc(data.isochrone_notice.first_time)}</code>
</div>` : ''}
<div class="concl">${esc(v.line)}</div>
${v.split ? `<p>${esc(v.split)}</p>` : ''}
<h2>地图与竞品排名</h2>
${data._staticMapSvg
  ? `<div class="maprow">
  <div class="staticmap">
    <div class="mapzoom" role="group" aria-label="地图缩放">
      <button type="button" onclick="__mapZoom(1.3)" title="放大">＋</button>
      <button type="button" onclick="__mapZoom(-1.3)" title="缩小">－</button>
      <button type="button" onclick="__mapZoom(0)" title="回到适应宽度">⌖</button>
      <span id="mapzoomlv" title="当前缩放">100%</span>
    </div>
    <div class="mapinner">${data._staticMapSvg}</div>
  </div>
  <div class="shareside">
    <div style="font-weight:600;font-size:13px;margin:0 0 4px">${esc((data.rings?.[0]?.label) ?? '内圈')} · 势力份额 Top20</div>
    <div style="font-size:11px;color:#888;margin:0 0 8px;line-height:1.5">份额＝圈内网格中该店为最近店的比例，<b>不是营业额份额</b>。</div>
    ${(() => {
      const top = ((data.rings?.[0]?.top) ?? [])
      if (top.length === 0) return '<p style="color:#999">无份额数据</p>'
      const rows = top.map((t, i) => ({
        ...t,
        no: i + 1,
        tie: i > 0 && Number(t.share_pct) === Number(top[i - 1].share_pct),
      }))
      // 只取 20 条，左右各 10
      // colgroup 固定列宽：左右两栏列宽完全一致，名次/份额各自对齐
      const COLS = '<colgroup><col class="c-rk"><col class="c-nm"><col class="c-pc"></colgroup>'
      const col = (list) => `<table class="sharetable">${COLS}
        ${list.map((t) => `<tr class="poirow" data-poi="${esc(t.name)}"`
          + `><td class="rk">Top${t.no}</td>`
          + `<td class="nm" title="${esc(t.name)}">${esc(t.name)}</td>`
          + `<td class="pc">${t.share_pct}%</td></tr>`).join('')}
      </table>`
      const left = rows.slice(0, 10)
      const right = rows.slice(10, 20)
      // 并列说明：找「最长的一簇连续并列」，不把不同份额的并列头尾相接
      let tieNote = ''
      {
        let best = null
        let runStart = 0
        for (let k = 0; k <= rows.length; k += 1) {
          const same = k < rows.length && k > 0
            && Number(rows[k].share_pct) === Number(rows[runStart].share_pct)
          if (k === rows.length || !same) {
            const len = k - runStart
            if (len >= 2 && (!best || len > best.len)) {
              best = { from: runStart, len, val: rows[runStart].share_pct }
            }
            runStart = k
          }
        }
        if (best) {
          tieNote = `<div class="tienote">Top${best.from + 1}–Top${best.from + best.len} 共 ${best.len} 家份额同为 ${best.val}%：名次只表示排序先后，不代表强弱差别。</div>`
        }
      }
      return `<div class="sharecols">${col(left)}${right.length > 0 ? col(right) : ''}</div>${tieNote}`
    })()}
    <p class="pinhint"><b>点一行</b>固定标识到左侧地图（再点取消）——打印 / 存 PDF 会保留标识与门店名。<span id="pin-note" style="color:#c62828"></span></p>
  </div>
</div>`
  : data._mapTilesMissing
    ? `<div style="background:#fff8e1;border-left:4px solid #ffb300;padding:10px 14px;margin:14px 0">
<b>⚠️ 本报告不含地图底图</b>（${esc(data._mapTilesMissing.reason)}）<br>
补齐：<code>${esc(data._mapTilesMissing.fix)}</code><br>
<span style="color:#777;font-size:12px">底图按点位单独缓存，每张瓦片约 13 KB，1.5 km 半径约 20~60 张。</span>
</div>`
    : '<p style="color:#999">未生成静态地图（缺 map-static.svg，跑 <code>node tools/render-static-map.mjs --probe=probe.json</code>）</p>'}
${data._staticMapSvg ? '<p style="color:#777;font-size:12px;margin:6px 0 0">地图已内嵌瓦片，<b>打印 / 存 PDF 会一并保留</b>；圈层按主圈绘制。</p>' : ''}


<p style="color:#666;font-size:13px;margin:10px 0 0">看不惯行业黑话的话，<b>文末《附：白话版》</b>有 24 条术语对照表；内文重要行也已就地注成「原说法 —— 大白话」。</p>

<h2>1. 数据质量</h2><table>
<tr><td>原始 POI</td><td>${num(d.raw)}</td></tr>
<tr><td>去重后有效</td><td>${num(d.effective)}</td></tr>
<tr><td>剔除 / 合并</td><td>${num(d.dropped)} / ${num(d.merged)}</td></tr>
<tr><td>同段竞品 / 异段</td><td>${num(d.same_type_count)} / ${num(d.other_type_count)}</td></tr>
<tr><td>高德覆盖率</td><td>${cov.amap >= 0 ? `${cov.amap}%` : '多关键词扫描'}</td></tr>
<tr><td>腾讯覆盖率</td><td>${num(cov.tencent)}%</td></tr>
${(() => {
  const sm = cov.source_mode ?? data.data_quality?.source_mode
  if (sm === 'dual') return '<tr><td>数据源模式</td><td><b>双源交叉</b>（高德 + 腾讯）：第 2 筛，已检出真实租金</td></tr>'
  if (sm === 'single') return '<tr><td>数据源模式</td><td><b>单源</b>（仅高德）：未检出真实租金，腾讯交叉校验未启用。本报告<b>不含</b>双源交叉验证，竞品数只有高德一个来源</td></tr>'
  return '<tr><td>数据源模式</td><td>未标注（旧版 probe 输出），按单源看待</td></tr>'
})()}
${data.data_quality ? `<tr><td>采集可信度</td><td>${data.data_quality.verdict === 'ok' ? '✅ 正常' : data.data_quality.verdict === 'partial' ? '⚠️ 打折' : '⛔ 可疑'}（${esc(data.data_quality.verdict)}）${data.data_quality.warnings?.length ? `：${esc(data.data_quality.warnings.join('；'))}` : ''}</td></tr>` : ''}</table>
${segRows}
<h2>2. 竞品分布</h2>
<p style="color:#888;font-size:13px">逐家名单见上方「地图与竞品排名」；此处给竞争<b>集中度</b>与距离带。</p>
${(() => {
  const top = ((data.rings?.[0]?.top) ?? [])
  if (top.length === 0) return ''
  const sum = (n) => Number(top.slice(0, n).reduce((a, t) => a + (Number(t.share_pct) || 0), 0).toFixed(1))
  const insideN = Number(data.rings?.[0]?.inside ?? 0)
  const top10 = sum(10)
  const restShare = Number((100 - top10).toFixed(1))
  const restN = Math.max(0, insideN - Math.min(10, top.length))
  // 集中度判读：看 Top3 与 Top10 占比
  const t3 = sum(3)
  let verdict = ''
  if (t3 >= 50) verdict = '高度集中：头部两三家就吃掉一半以上，新店要靠正面抢客'
  else if (t3 >= 30) verdict = '中度集中：有头部但没垄断，还有切入口'
  else if (t3 >= 15) verdict = '较分散：头部优势弱，靠差异化就能站住'
  else verdict = '极度分散：没有真正的头部，谁都能切一块，但也谁都不占优'
  const rows = [
    ['圈内竞品（主圈）', `${insideN} 家`],
    ['Top1 势力份额', `${top[0].share_pct}%（${esc(top[0].name)}）`],
    ['Top3 合计', `${t3}%`],
    ['Top10 合计', `${top10}%`],
    restN > 0 ? [`Top20 之外 ${restN} 家瓜分`, `${restShare}%`] : null,
    ['集中度判读', `<b>${verdict}</b>`],
  ].filter(Boolean)
  return `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
<p style="color:#777;font-size:12px;margin:6px 0 0">势力份额＝圈内网格中该店为最近店的比例，不是营业额份额。占比高只说明「离得近」，不代表「卖得多」。</p>`
})()}
${outer.distance_bands?.length ? `<h3>${secOuter} ${esc(outer.label ?? '外圈')}（不报份额，只报距离带）</h3><table><tr><th>距离带</th><th>家数</th></tr>${outer.distance_bands.map((b) => `<tr><td>${esc(b.label)}</td><td>${b.count}</td></tr>`).join('')}</table>` : ''}
${compHtml}
${tierHtml}
<h2>3. 交通可达</h2><table>
<tr><td>最近地铁站（≤${transit.metro_threshold_m ?? 800}m）</td><td>${esc(m ? `${m.name} ${m.distance_m} m` : '2km 内无')}</td></tr>
<tr><td>最近停车场（≤${transit.parking_threshold_m ?? 300}m）</td><td>${transit.nearest_parking_m >= 0 ? `${transit.nearest_parking_m} m` : '未取到'}</td></tr>
<tr><td>${transit.parking_threshold_m ?? 300}m 内停车场</td><td>${num(transit.parking_near, '0')} 个</td></tr></table>
${popHtml}
${vetoHtml}
${finHtml}
${leaseHtml}
${spaceHtml}
${auditHtml}
${bmHtml}
${traceHtml}
<blockquote>${(inner.source === 'valhalla' || inner.source === 'osrm') ? '等时圈为本地路网计算，已去除沿主干道走廊的细长尖刺' : '等时圈为直线估算【估算】，遇江面/快速路会高估可达范围'}；外圈因范围过大不报份额。<br>

<p style="color:#666;font-size:13px">表里的术语：<b>成本因子</b>＝保守/乐观档对成本的缩放倍数（基准档就是 1，不放不缩）；<b>为何锚点用基准档</b>＝三档各算一遍，但谈判只能拿基准档出价；保守档是风险提醒，不是出价依据。</p>

<h2>附：看不懂的话先看这里（白话版）</h2>
<p style="color:#666;font-size:13px;margin:6px 0 10px">这节不用记，遇到不懂的词回来查一眼就行。</p>
<table>
<tr><th style="width:26%">报告里的说法</th><th>大白话</th></tr>
<tr><td><b>截流 / 截流定级</b></td><td>你的店能"拦下"多少本来要路过的人。<b>重度截流</b>＝这条街上抢客的店太多，客人还没走到你门口就被别人截走了</td></tr>
<tr><td><b>截流两轴</b></td><td>第一轴看<b>这个铺位本身</b>（位置显不显眼、好不好进、在几楼）；第二轴看<b>周围对手</b>（多少家在抢同一批人）。一个管"人流进不进得来"，一个管"进来后会不会被抢走"，两回事</td></tr>
<tr><td><b>势力份额 / Voronoi 归属</b></td><td>把这块地切成小格子，每格算给离它最近的那家店。某店分到的格子越多＝它的"地盘"越大。<b>这不是营业额，也不是市占率</b>，只说明"谁离得近"</td></tr>
<tr><td><b>Top3 集中度</b></td><td>前 3 名加起来占多少地盘。占比高＝头部几家把客抓得牢，新店难插进去；占比低＝碎片化，靠差异化就能站住</td></tr>
<tr><td><b>同段 / 异段</b></td><td>「段」是按"菜系 × 价位"分的类。同段＝跟你同类同价，是真正抢客的人；异段＝不同类或不同价，多数是互补不是对手</td></tr>
<tr><td><b>直接 / 替代 / 间接竞品</b></td><td>直接＝同类同价，客人只能二选一；替代＝同类不同价，平时不抢、办宴席时会流动；间接＝不同品类，抢的是同一笔"吃饭预算"</td></tr>
<tr><td><b>翻台率</b></td><td>一个座位一天被坐了几轮。1.998 次 ≈ 每座一天接待两拨客人。<b>座位翻台 ≠ 桌翻台</b>：一桌 4 人，空 1 个座就拉低座位翻台</td></tr>
<tr><td><b>坪效</b></td><td>每平方米每个月能做多少营业额。用来看"这块地方有没有被浪费"</td></tr>
<tr><td><b>保本日营业额</b></td><td>一天至少卖多少钱才不亏。低于这个数就是在赔钱</td></tr>
<tr><td><b>极限租金</b></td><td><b>保本那档</b>＝租金再高一分钱就开始亏；<b>目标回本那档</b>＝租金到这个数，就没法在目标月数内回本</td></tr>
<tr><td><b>谈判锚点</b></td><td>谈租金的参考上限，<b>不是"砍到这个价就签"</b>——高于它，按常规经营预期就回不了本（压力下限另列，不是出价依据）</td></tr>
<tr><td><b>租售比</b></td><td>月租金 ÷ 月营业额。租金占营业额几成。餐饮大店经验：10% 以内健康，15% 以上警戒</td></tr>
<tr><td><b>现金口径 / 会计口径</b></td><td>现金口径＝只算钱进出，回本快，看"多久能周转开"；会计口径＝把装修设备的折旧摊进去，回本慢，看"这笔投资账面划不划算"。两个都要看</td></tr>
<tr><td><b>摊销</b></td><td>装修和设备的一次性投入，按月摊到成本里。450 万 ÷ 60 个月＝每月 7.5 万</td></tr>
<tr><td><b>容量利用率</b></td><td>店里能坐的位子实际坐满了多少。66.6% ≈ 每 3 个位子有 1 个空着</td></tr>
<tr><td><b>职住比</b></td><td>写字楼数量 ÷ 住宅数量。&gt;1 上班的人多（工作日午市好做），&lt;1 住家的人多（晚市和周末好做）</td></tr>
<tr><td><b>等时圈 / 圈层</b></td><td>从点位出发走 N 分钟能到的范围，按真实路网算，不是画个圆</td></tr>
<tr><td><b>单方造价</b></td><td>每平方米投了多少钱（装修＋设备＋其他初始投入）</td></tr>
<tr><td><b>保本客单量</b></td><td>一天至少接待多少单才不亏</td></tr>
<tr><td><b>敏感度「会翻转」</b></td><td>这个参数只要估错 20%，结论就从"能做"变"不能做"——所以它必须实测，不能拍脑袋估</td></tr>
<tr><td><b>截流系数</b></td><td>算营业额时乘的一个折扣：路过的人里有多少比例真会进你的店</td></tr>
<tr><td><b>硬伤 / 待核实</b></td><td>硬伤＝明确不满足的硬条件；待核实＝还没拿到数据、需要现场确认的项——<b>是待办清单，不是否决</b></td></tr>
<tr><td><b>规模档推定，无人均实证</b></td><td>这家店人均多少我们没拿到真实数据，是按店名和规模"猜"的档位，别太当真</td></tr>
<tr><td><b>ROI</b></td><td>年化投资回报率：一年赚的钱 ÷ 投进去的钱</td></tr>
</table>

数据来源：高德/腾讯 POI、本地路网引擎、用户录入调研表。—— 竞品和配套是从地图公司的商家库抓的，距离和走路时间是用本地导航引擎按真实道路算的，财务参数是你自己填的。建议拿这份跟现场实测对一遍再拍板。</blockquote>
<style>
tr.poirow{cursor:pointer}
tr.poirow:hover{background:#f5f5f5}
tr.poirow.on{background:#fff3e0;font-weight:600}
.staticmap svg .poi{transition:r .12s, stroke .12s}
@media print{ tr.poirow.on{background:#fff3e0 !important} }
</style>
<script>
/* 地图缩放：只响应按钮；SVG 已设 pointer-events:none，拖拽与滚轮改图一律无效 */
var __mapScale = 1
function __mapZoom(factor){
  if (factor === 0) __mapScale = 1
  else __mapScale = Math.min(2.4, Math.max(1, __mapScale * factor))
  var el = document.querySelector('.mapinner')
  if (el) el.style.transform = 'scale(' + __mapScale.toFixed(3) + ')'
  var lv = document.getElementById('mapzoomlv')
  if (lv) lv.textContent = Math.round(__mapScale * 100) + '%'
}
function __saveHtml(){
  try{
    var clone = document.documentElement.cloneNode(true);
    var hint = clone.querySelector('#savehint');
    if(hint) hint.style.display = 'none';
    var html = '<!DOCTYPE html>' + clone.outerHTML;
    var blob = new Blob([html], {type:'text/html;charset=utf-8'});
    var a = document.createElement('a');
    var name = (document.title || '选址评估报告').replace(/[\\/:*?"<>|]/g,'_');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
  }catch(e){ alert('下载失败：' + e.message + '；可改用 Ctrl+S 另存为'); }
}
(function(){
  var svg = document.querySelector('.staticmap svg');
  if(!svg) return;
  var layer = document.createElementNS('http://www.w3.org/2000/svg','g');
  layer.setAttribute('class','pin-layer');
  svg.appendChild(layer);
  var pinned = null;
  var dots = Array.prototype.slice.call(svg.querySelectorAll('circle.poi'));
  function find(name){
    return dots.filter(function(c){ return c.getAttribute('data-name') === name; });
  }
  function clearPin(){
    pinned = null;
    layer.innerHTML = '';
    Array.prototype.forEach.call(document.querySelectorAll('tr.poirow'), function(r){ r.classList.remove('on'); });
    dots.forEach(function(c){
      if(c.dataset.r0) c.setAttribute('r', c.dataset.r0);
      c.setAttribute('stroke','#fff');
      c.setAttribute('stroke-width','0.8');
    });
  }
  function pin(name, hits){
    clearPin();
    pinned = name;
    var row = document.querySelector('tr.poirow[data-poi="' + name.replace(/"/g,'\\"') + '"]');
    if(row) row.classList.add('on');
    hits.forEach(function(c){
      if(!c.dataset.r0) c.dataset.r0 = c.getAttribute('r');
      var r0 = Number(c.dataset.r0);
      c.setAttribute('r', String(r0 * 1.9 + 4));
      c.setAttribute('stroke','#d40000');
      c.setAttribute('stroke-width','2.4');
      svg.appendChild(c);
      // 名牌：白底描边黑字，打印也清晰
      var cx = Number(c.getAttribute('cx')), cy = Number(c.getAttribute('cy'));
      var t = document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('x', String(cx + 12));
      t.setAttribute('y', String(cy - 8));
      t.setAttribute('font-size','13');
      t.setAttribute('font-weight','600');
      t.setAttribute('fill','#b71c1c');
      t.setAttribute('stroke','#fff');
      t.setAttribute('stroke-width','4');
      t.setAttribute('paint-order','stroke');
      t.setAttribute('pointer-events','none');
      t.textContent = name;
      layer.appendChild(t);
      var line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', String(cx + 10));
      line.setAttribute('y2', String(cy - 12));
      line.setAttribute('stroke','#b71c1c');
      line.setAttribute('stroke-width','1.2');
      layer.appendChild(line);
    });
    if(!hits.length){
      var note = document.getElementById('pin-note');
      if(note) note.textContent = '（该门店在步行圈外，地图上不显示）';
    } else {
      var note2 = document.getElementById('pin-note');
      if(note2) note2.textContent = '';
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('tr.poirow'), function(row){
    var name = row.getAttribute('data-poi');
    var hits = find(name);
    row.addEventListener('click', function(){
      if(pinned === name) clearPin(); else pin(name, hits);
    });
    row.addEventListener('mouseenter', function(){
      if(pinned) return;   // 已固定的不受悬停影响
      hits.forEach(function(c){
        c.dataset.r0h = c.getAttribute('r');
        c.setAttribute('r', String(Number(c.getAttribute('r')) * 1.6 + 2));
        c.setAttribute('stroke','#e65100');
        c.setAttribute('stroke-width','1.6');
      });
    });
    row.addEventListener('mouseleave', function(){
      if(pinned) return;
      hits.forEach(function(c){
        if(c.dataset.r0h) c.setAttribute('r', c.dataset.r0h);
        c.setAttribute('stroke','#fff');
        c.setAttribute('stroke-width','0.8');
      });
    });
  });
  // 打印前固定当前选择，确保进入 PDF
  window.addEventListener('beforeprint', function(){ /* 状态已在 DOM 中，无需额外处理 */ });
})();
</script>
</body></html>`

  return { markdown, html }
}

/** 多方案对比 */
export function buildCompare(results, profile) {
  const rows = results.map((r) => {
    const d = r.json?.dedupe ?? {}
    const inner = r.json?.rings?.[0] ?? {}
    const transit = r.json?.transit ?? {}
    const bands = r.json?.rings?.[r.json.rings.length - 1]?.distance_bands ?? []
    const peak = bands.reduce((a, b) => (b.count > (a?.count ?? -1) ? b : a), null)
    return {
      address: r.address,
      same: d.same_type_count ?? 0,
      other: d.other_type_count ?? 0,
      innerCount: inner.inside ?? 0,
      top1: inner.top?.[0]?.share_pct ?? 0,
      top1name: inner.top?.[0]?.name ?? '—',
      nearest: inner.nearest?.[0]?.distance_m ?? -1,
      metro: (transit.metro ?? [])[0]?.distance_m ?? -1,
      parking: transit.nearest_parking_m ?? -1,
      peakLabel: peak?.label ?? '—',
      peakCount: peak?.count ?? 0,
    }
  })
  // 排序：同段竞品少 → 最近距离远 → 地铁近
  const score = (r) => r.same * 100 - r.nearest - r.metro * 0.1
  const ranked = [...rows].sort((a, b) => score(a) - score(b))

  const md = ['# 多方案对比', '', `- 业态档案：**${profile?.name ?? '未指定'}**`, `- 方案数：${rows.length}`, '']
  md.push('| 排名 | 地址 | 同段竞品 | 最近(m) | 内圈家数 | 内圈Top1 | 地铁(m) | 停车(m) | 竞品峰值距离带 |')
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  ranked.forEach((r, i) => {
    md.push(`| ${i + 1} | ${r.address} | ${r.same} | ${r.nearest} | ${r.innerCount} | ${r.top1}%（${r.top1name}） | ${r.metro} | ${r.parking} | ${r.peakLabel}（${r.peakCount} 家） |`)
  })
  md.push('')
  md.push('> 排序逻辑：同段竞品越少越靠前；同分时比较最近竞品距离与地铁距离。仅为初筛排序，最终决策需结合租金与硬件条件。')

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>多方案对比</title>
<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1100px;margin:28px auto;padding:0 20px}
h1{font-size:22px}table{border-collapse:collapse;width:100%;font-size:14px;margin-top:12px}
td,th{border:1px solid #eee;padding:8px 10px;text-align:left}th{background:#fafafa}
tr:first-child td{font-weight:600}.rank{color:#b00000;font-weight:700}</style></head><body>
<h1>多方案对比 · ${esc(profile?.name ?? '')}</h1>
<table><tr><th>排名</th><th>地址</th><th>同段竞品</th><th>最近(m)</th><th>内圈家数</th><th>内圈Top1</th><th>地铁(m)</th><th>停车(m)</th><th>竞品峰值距离带</th></tr>
${ranked.map((r, i) => `<tr><td class="rank">${i + 1}</td><td>${esc(r.address)}</td><td>${r.same}</td><td>${r.nearest}</td><td>${r.innerCount}</td><td>${r.top1}%（${esc(r.top1name)}）</td><td>${r.metro}</td><td>${r.parking}</td><td>${esc(r.peakLabel)}（${r.peakCount} 家）</td></tr>`).join('')}
</table>
<blockquote>排序逻辑：同段竞品越少越靠前；同分时比较最近竞品距离与地铁距离。仅为初筛排序，最终决策需结合租金与硬件条件。</blockquote>
</body></html>`

  return { markdown: md.join('\n'), html }
}

// CLI
// 路径比较必须归一化：Windows 下 argv[1] 是反斜杠（C:\a\b.mjs），
// 而 URL.pathname 解码后是正斜杠（C:/a/b.mjs），直接字符串比较永远不等，
// 会让「node tools/report.mjs」静默不执行（退出码仍是 0）。
const _selfPath = (() => {
  const fromUrl = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  try {
    return resolve(fromUrl)
  } catch {
    return fromUrl
  }
})()
const _argvPath = process.argv[1] ? resolve(process.argv[1]) : ''
const invokedDirectly = _argvPath !== ''
  && (_selfPath === _argvPath
    || _selfPath.toLowerCase() === _argvPath.toLowerCase())
if (invokedDirectly) {
  const args = new Map()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw)
    if (m) args.set(m[1], m[2])
  }
  const inFile = args.get('in')
  if (!inFile) {
    console.error('用法：node .\\tools\\report.mjs --in=out\\xxx.json [--profile=slug]')
    process.exit(1)
  }
  const data = JSON.parse(readFileSync(inFile, 'utf8'))
  let profile = null
  if (args.get('profile')) {
    try {
      profile = JSON.parse(readFileSync(new URL(`../profiles/${args.get('profile')}.json`, import.meta.url), 'utf8'))
    } catch {
      profile = null
    }
  }
  // 独立运行时 probe.json 可能没有内嵌地图（只有 run-site 会预注入）。
  // 这里自动补：调 render-static-map.mjs 生成 SVG 再读回来，
  // 否则单跑 report.mjs 会得到「未生成静态地图」的占位提示。
  if (!data._staticMapSvg) {
    try {
      const { execFileSync } = await import('node:child_process')
      const { existsSync: ex } = await import('node:fs')
      const selfDir = dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'))
      const renderScript = join(selfDir, 'render-static-map.mjs')
      const svgOut = `${inFile.replace(/\.json$/, '')}-static.svg`
      const tilesArg = args.get('tiles')
      const cmdArgs = [renderScript, `--probe=${inFile}`, `--out=${svgOut}`]
      if (tilesArg !== undefined) cmdArgs.push(`--tiles=${tilesArg}`)
      execFileSync(process.execPath, cmdArgs, { stdio: 'ignore' })
      if (ex(svgOut)) {
        data._staticMapSvg = readFileSync(svgOut, 'utf8')
        console.log(`地图：已生成 ${svgOut}`)
      }
    } catch (error) {
      console.warn(`⚠️ 静态地图生成失败：${error.message}（报告仍会输出，只是没有底图）`)
    }
  }

  const { markdown, html } = buildReport(data, profile)
  const base = inFile.replace(/\.json$/, '')
  writeFileSync(`${base}.md`, markdown, 'utf8')
  writeFileSync(`${base}.html`, html, 'utf8')
  console.log(`已生成：${base}.md / ${base}.html`)
}
