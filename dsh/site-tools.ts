/**
 * site-tools —— 连锁实体商业选址业务工具集
 *
 * 本文件是一个 DSH 插件模块（cordis plugin）：
 *   - `name` / `inject` 声明插件身份与依赖的服务；
 *   - `apply(ctx)` 在插件加载时把工具注册进 `ctx.tools`，插件卸载时自动注销。
 *
 * 当前包含：
 *   - `veto_check`（一票否决检查）
 *   - `financial_calc`（保本线 / 回本周期测算，纯确定性计算）
 *
 * 规则表与参数库暂为内置样例，后续可替换为配置/数据库驱动。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BENCH_CATEGORIES, BENCH_CITIES, BENCH_FORMATS, BENCH_ROWS, CITY_BASELINES } from './benchmark-data.ts'

export const name = 'site-tools'

/** 依赖 `tools` 服务：cordis 会等工具注册表就绪后再调用 `apply`。 */
export const inject = ['tools']

/** 规则表版本，随每次检查结果返回，用于审计与结果回溯。 */
export const RULE_VERSION = 'veto-2026.10.24'

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

/** 单个调研字段的实测值。结构化值（对象/数组）不参与规则判定。 */
type FieldValue = string | number | boolean | null

/** 一条调研记录：值 + 数据来源 + 置信度。 */
interface FieldObservation {
  value: FieldValue
  source: string
  confidence: number
}

/** 否决规则：命中 `severity` 决定落入 `hard_reasons` 还是 `major_risks`。 */
interface VetoRule {
  /** 规则编号，如 R001。 */
  readonly id: string
  /** 规则描述，直接回传给模型与报告。 */
  readonly desc: string
  /** 该规则依赖的调研字段代号。 */
  readonly fieldKey: string
  readonly severity: 'hard' | 'major'
  /** 适用业态；'all' 表示所有业态。 */
  readonly formats: readonly string[] | 'all'
  /** 判定函数：返回 true 表示命中该规则。 */
  readonly violated: (observation: FieldObservation) => boolean
}

/** 命中明细（硬性否决与重大风险共用同一形状）。 */
export interface RuleHit {
  rule_id: string
  rule_desc: string
  field_key: string
  data_basis: string
}

/** 缺失字段：某字段缺失会影响哪些规则。 */
export interface MissingField {
  field_key: string
  required_for: string[]
}

/** `veto_check` 的规范返回值（与 output.schema 严格一致）。 */
export interface VetoCheckResult {
  hard_vetoed: boolean
  /** 定位声明：本工具只提醒，不裁决 */
  positioning: 'advisory'
  /** 是否阻断分析流程：恒为 false（硬伤不中断流程） */
  blocks_pipeline: false
  hard_reasons: RuleHit[]
  major_risks: RuleHit[]
  missing_fields: MissingField[]
  rule_version: string
  /** 本次判定用的是调用方自定义规则，还是内置示例规则 */
  rule_source: 'builtin' | 'custom'
}

// ---------------------------------------------------------------------------
// 规则表（样例）
// ---------------------------------------------------------------------------

const ALL_FORMATS = 'all' as const

/** 把字段值规整成可比较的小写字符串。 */
const normalize = (value: FieldValue): string => String(value).trim().toLowerCase()

/** “没有 / 不具备”类取值的统一判定。 */
const isAbsent = (observation: FieldObservation): boolean =>
  ['false', 'no', 'none', 'n/a', '无', '0', ''].includes(normalize(observation.value))

/** 取数值字段；缺失或非数值时退回到给定的兜底值（兜底值决定不误杀）。 */
const numberOf = (observation: FieldObservation, fallback: number): number =>
  typeof observation.value === 'number' && Number.isFinite(observation.value)
    ? observation.value
    : fallback

/**
 * 样例规则表。
 * 注意：R003 的 `rent` 是“月租金 / 预估月营业额”的比值（0–1），而非绝对租金。
 */
export const VETO_RULES: readonly VetoRule[] = [
  {
    id: 'R001',
    desc: '无排烟条件',
    fieldKey: 'exhaust',
    severity: 'hard',
    formats: ALL_FORMATS,
    violated: isAbsent,
  },
  {
    id: 'R002',
    desc: '电力容量不足（< 30kW）',
    fieldKey: 'power_kw',
    severity: 'hard',
    formats: ALL_FORMATS,
    violated: (observation) => numberOf(observation, Number.POSITIVE_INFINITY) < 30,
  },
  {
    id: 'R003',
    desc: '租金占比超红线（> 25%）',
    fieldKey: 'rent',
    severity: 'hard',
    formats: ALL_FORMATS,
    violated: (observation) => numberOf(observation, 0) > 0.25,
  },
  {
    id: 'R004',
    desc: '门面宽度不足（< 2.4m）',
    fieldKey: 'frontage_m',
    severity: 'major',
    formats: ALL_FORMATS,
    violated: (observation) => numberOf(observation, Number.POSITIVE_INFINITY) < 2.4,
  },
  {
    id: 'R005',
    desc: '营业面积不足（< 30㎡）',
    fieldKey: 'area_sqm',
    severity: 'major',
    formats: ['convenience_store'],
    violated: (observation) => numberOf(observation, Number.POSITIVE_INFINITY) < 30,
  },
]

// ---------------------------------------------------------------------------
// 纯函数：入参归一化 + 规则判定 + 渲染
// ---------------------------------------------------------------------------

/** 判断一个未知值能否作为规则判定的标量输入。 */
function isFieldValue(value: unknown): value is FieldValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  )
}

/** 把一条原始字段记录收窄成 {@link FieldObservation}；格式不合法则丢弃。 */
function toObservation(entry: unknown): FieldObservation | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const { value, source, confidence } = record
  if (!isFieldValue(value) || typeof source !== 'string') return undefined
  return {
    value,
    source,
    confidence: typeof confidence === 'number' ? confidence : 0,
  }
}

/**
 * 归一化模型传入的 `fields`。
 * 结构不合法的字段会被丢弃，从而在结果里以 `missing_fields` 暴露，而不是静默通过。
 */
function normalizeFields(raw: Record<string, unknown>): Map<string, FieldObservation> {
  const observations = new Map<string, FieldObservation>()
  for (const [fieldKey, entry] of Object.entries(raw)) {
    const observation = toObservation(entry)
    if (observation !== undefined) observations.set(fieldKey, observation)
  }
  return observations
}

// ---------------------------------------------------------------------------
// 否决规则 DSL（可外置）：内置表仅作示例，调用方传 rules 即覆盖
// ---------------------------------------------------------------------------

type RuleOp = 'absent' | 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'contains'

/** 调用方传入的规则：纯声明，不含可执行代码（开源安全）。 */
interface RuleSpec {
  id: string
  desc: string
  field_key: string
  severity: 'hard' | 'major'
  op: RuleOp
  /** 阈值：lt/gt/lte/gte 用数字，eq/contains 用标量，absent 不需要 */
  value?: unknown
  /** 适用业态；空/缺省 = 所有业态 */
  formats?: readonly string[]
}

/** 单条规则判定。数值比较遇到非数值一律视为「未命中」，避免误杀。 */
function ruleViolated(op: RuleOp, threshold: unknown, observation: FieldObservation): boolean {
  if (op === 'absent') return isAbsent(observation)
  if (op === 'contains') {
    if (typeof threshold !== 'string' || threshold.trim() === '') return false
    return normalize(observation.value).includes(threshold.trim().toLowerCase())
  }
  if (op === 'eq') return threshold !== undefined && String(observation.value) === String(threshold)
  const actual = typeof observation.value === 'number' ? observation.value : Number(observation.value)
  const limit = typeof threshold === 'number' ? threshold : Number(threshold)
  if (!Number.isFinite(actual) || !Number.isFinite(limit)) return false
  if (op === 'lt') return actual < limit
  if (op === 'gt') return actual > limit
  if (op === 'lte') return actual <= limit
  return actual >= limit
}

/** 声明式规则 → 内部规则。 */
function specToRule(spec: RuleSpec): VetoRule {
  return {
    id: spec.id,
    desc: spec.desc,
    fieldKey: spec.field_key,
    severity: spec.severity,
    formats: spec.formats !== undefined && spec.formats.length > 0 ? spec.formats : ALL_FORMATS,
    violated: (observation) => ruleViolated(spec.op, spec.value, observation),
  }
}

/** 按规则表判定；规则来源与版本由调用方决定。 */
function evaluate(
  formatCode: string,
  observations: ReadonlyMap<string, FieldObservation>,
  rules: readonly VetoRule[],
  ruleVersion: string,
  ruleSource: 'builtin' | 'custom',
): VetoCheckResult {
  const hardReasons: RuleHit[] = []
  const majorRisks: RuleHit[] = []
  const missing = new Map<string, string[]>()

  for (const rule of rules) {
    if (rule.formats !== ALL_FORMATS && !rule.formats.includes(formatCode)) continue

    const observation = observations.get(rule.fieldKey)
    if (observation === undefined) {
      missing.set(rule.fieldKey, [...(missing.get(rule.fieldKey) ?? []), rule.id])
      continue
    }
    if (!rule.violated(observation)) continue

    const hit: RuleHit = {
      rule_id: rule.id,
      rule_desc: rule.desc,
      field_key: rule.fieldKey,
      data_basis: observation.source,
    }
    if (rule.severity === 'hard') hardReasons.push(hit)
    else majorRisks.push(hit)
  }

  return {
    positioning: 'advisory' as const,
    blocks_pipeline: false as const,
    // 字段名沿用 hard_vetoed 是为了兼容旧调用方；
    // 语义已明确：它表示「命中硬伤规则」，**不代表不能开、也不中断流程**
    hard_vetoed: hardReasons.length > 0,
    hard_reasons: hardReasons,
    major_risks: majorRisks,
    missing_fields: [...missing].map(([field_key, required_for]) => ({ field_key, required_for })),
    rule_version: ruleVersion,
    rule_source: ruleSource,
  }
}

/** 请求上下文中渲染所需的字段。 */
interface ReportHeader {
  store_id: string
  format_code: string
}

/** 把规范结果渲染成模型可见的文本（面向人读，不承载机读字段）。 */
function formatReport(header: ReportHeader, result: VetoCheckResult): string {
  const lines = [
    `门店 ${header.store_id}｜业态 ${header.format_code}｜规则版本 ${result.rule_version}`
    + `（${result.rule_source === 'custom' ? '自定义规则' : '内置示例规则'}）`,
    `硬性否决：${result.hard_vetoed ? '是' : '否'}（${result.hard_reasons.length} 项）`,
  ]
  for (const hit of result.hard_reasons) {
    lines.push(`- ${hit.rule_id} ${hit.rule_desc}｜字段 ${hit.field_key}｜依据：${hit.data_basis}`)
  }
  lines.push(`重大风险：${result.major_risks.length} 项`)
  for (const hit of result.major_risks) {
    lines.push(`- ${hit.rule_id} ${hit.rule_desc}｜字段 ${hit.field_key}｜依据：${hit.data_basis}`)
  }
  lines.push(`缺失字段：${result.missing_fields.length} 项`)
  for (const field of result.missing_fields) {
    lines.push(`- ${field.field_key}（影响 ${field.required_for.join('、')}）`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** 命中明细的 schema（硬性否决与重大风险共用）。 */
const ruleHitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule_id: { type: 'string', required: true, description: '规则编号' },
    rule_desc: { type: 'string', required: true, description: '规则描述' },
    field_key: { type: 'string', required: true, description: '触发规则的调研字段' },
    data_basis: { type: 'string', required: true, description: '数据依据（来源）' },
  },
} as const

export const vetoCheckTool = defineTool({
  name: 'veto_check',
  description:
    '对单个实体门店执行硬性条件核查：按业态匹配规则表，返回硬性缺口、重大风险与缺失字段。'
    + '**只提醒，不裁决**——本工具不判断「能不能开」，也不中断分析流程；'
    + '证照与合规由承租方办理，硬伤只作为签约前必须补齐的清单。',
  parameters: {
    store_id: {
      type: 'string',
      required: true,
      description: '门店编号，如 S-0001',
    },
    format_code: {
      type: 'string',
      required: true,
      description: '业态编码，如 convenience_store',
    },
    fields: {
      type: 'object',
      additionalProperties: true,
      description:
        '调研字段表（可省略，缺省视为空对象）。键为字段代号（exhaust / power_kw / rent / frontage_m / area_sqm …），'
        + '值为 { value, source, confidence }：value 为实测值（布尔、数字或文字），'
        + 'source 为数据来源（如“现场照片”），confidence 为 0–1 的置信度。',
    },
    rules: {
      type: 'array',
      description:
        '自定义否决规则（可选，声明式）。不传 = 使用内置示例规则 R001–R005。'
        + '每条：{ id, desc, field_key, severity: hard|major, op: absent|lt|gt|lte|gte|eq|contains, value?, formats? }',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: '规则号，如 T001' },
          desc: { type: 'string', required: true, description: '规则描述（进报告）' },
          field_key: { type: 'string', required: true, description: '依赖的调研字段代号' },
          severity: { type: 'string', required: true, enum: ['hard', 'major'], description: 'hard=硬性否决，major=重大风险' },
          op: {
            type: 'string',
            required: true,
            enum: ['absent', 'lt', 'gt', 'lte', 'gte', 'eq', 'contains'],
            description: '判定算子：absent=为空/无；lt/gt/lte/gte=数值比较；eq=相等；contains=包含',
          },
          value: { type: 'json', description: '阈值（数值或字符串）；absent 不需要' },
          formats: { type: 'array', description: '适用业态；空或省略 = 全部业态', items: { type: 'string' } },
        },
      },
    },
    rules_version: { type: 'string', description: '自定义规则版本号；缺省记为 custom-<规则数>rules' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        positioning: {
          type: 'string', required: true, enum: ['advisory'],
          description: '定位声明：advisory = 只提醒，不裁决',
        },
        blocks_pipeline: {
          type: 'boolean', required: true, const: false,
          description: '是否阻断分析流程；恒为 false',
        },
        hard_vetoed: {
          type: 'boolean',
          required: true,
          description: '是否命中硬伤规则。注意：只表示「有硬伤要补」，不代表不能开，也不中断流程',
        },
        hard_reasons: {
          type: 'array',
          required: true,
          description: '硬伤明细（签约前必须补齐的清单）',
          items: ruleHitSchema,
        },
        major_risks: {
          type: 'array',
          required: true,
          description: '重大风险明细',
          items: ruleHitSchema,
        },
        missing_fields: {
          type: 'array',
          required: true,
          description: '缺失字段及受影响的规则编号',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field_key: { type: 'string', required: true, description: '缺失的字段代号' },
              required_for: {
                type: 'array',
                required: true,
                description: '需要该字段的规则编号',
                items: { type: 'string' },
              },
            },
          },
        },
        rule_version: { type: 'string', required: true, description: '规则表版本' },
        rule_source: {
          type: 'string',
          required: true,
          enum: ['builtin', 'custom'],
          description: '规则来源：builtin=内置示例，custom=调用方传入',
        },
      },
    },
    render: (args, value) => [{ type: 'text', text: formatReport(args, value) }],
  },
  async execute(args) {
    const specs = args.rules ?? []
    const custom = specs.length > 0
    const rules: readonly VetoRule[] = custom ? specs.map((spec: RuleSpec) => specToRule(spec)) : VETO_RULES
    const version = custom ? (args.rules_version ?? `custom-${specs.length}rules`) : RULE_VERSION
    return evaluate(
      args.format_code,
      normalizeFields(args.fields ?? {}),
      rules,
      version,
      custom ? 'custom' : 'builtin',
    )
  },
})

// ---------------------------------------------------------------------------
// financial_calc —— 保本线 / 回本周期（纯确定性计算，不调用大模型）
// ---------------------------------------------------------------------------

/** 参数库版本：财务口径独立演进，与规则表解耦。 */
export const PARAM_VERSION = 'params-2026.10.24'

/** 公式版本：口径变更必须升版，保证历史报告可复现。fin-v3 新增税费与折旧摊销。 */
export const FORMULA_VERSION = 'fin-v4'

/**
 * 点位截流力分级（行业通用 5 级）——**场地属性，与竞争压力是两个维度**。
 *
 * 这一维衡量「这个铺位能自然截住多少路过客流」，取决于动线位置、可视度、楼层、
 * 前置门店数量，**必须现场判定**，POI 数据推不出来。
 *
 * 乘数用于把「行业常规客流」调成「这个点位实际能拿到的客流」。
 * 若客户已给出实测日营业额，不要再乘一次（会重复调整）。
 */
export const CATCHMENT_LEVELS = [
  {
    code: 'L1',
    label: '顶级截流（千分点）',
    multiplier: 1.3,
    range: '1.25~1.40',
    scene: '地铁直出口第一铺、商场主入口第一卡位、步行街十字路口转角铺、车库上来首铺',
    fit: '刚需快餐、茶饮、小吃；高端酒楼拿到 L1 极稀缺',
  },
  {
    code: 'L2',
    label: '强截流（A 类点）',
    multiplier: 1.1,
    range: '1.00~1.20',
    scene: '商场主通道中段、临街无隔离栏一楼铺、美食街主街中段',
    fit: '大部分成熟品牌优选；大众茶楼、正餐的舒服区间',
  },
  {
    code: 'L3',
    label: '中等截流（B 类点·行业基准）',
    multiplier: 1.0,
    range: '1.00',
    scene: '商场餐饮区内侧铺、社区街铺非转角、主干道辅路铺、二楼临街铺',
    fit: 'GIS 基准样本默认；绝大多数粤式茶楼、正餐落在这一级',
  },
  {
    code: 'L4',
    label: '弱截流（C 类点）',
    multiplier: 0.65,
    range: '0.60~0.70',
    scene: '商场高区末端、内街深处、隔护栏临街铺、同层同类店排在前面的',
    fit: '只适合强 IP、宴会、老客为主的高端酒楼，非常考验口碑',
  },
  {
    code: 'L5',
    label: '极低截流（D 类点·慎选）',
    multiplier: 0.15,
    range: '0.10~0.20',
    scene: '负一层死角、独立独栋远离动线、园区深处、商圈背街',
    fit: '过路客流几乎为 0，全靠预约/私域/宴会/定向引流',
  },
] as const

type CatchmentCode = (typeof CATCHMENT_LEVELS)[number]['code']

/** 按编号取截流力分级；非法编号返回 undefined。 */
function catchmentOf(code: string | undefined): (typeof CATCHMENT_LEVELS)[number] | undefined {
  if (code === undefined) return undefined
  return CATCHMENT_LEVELS.find((item) => item.code === code.toUpperCase())
}

/** 极限租金反推的默认目标回本周期（月）；调用方可用 target_payback_months 覆盖。 */
export const DEFAULT_TARGET_PAYBACK_MONTHS = 24

/** 模型可调用的情景名，同时用于参数 schema 的 enum 与固定返回顺序。 */
const SCENARIO_CODES = ['base', 'pessimistic', 'optimistic'] as const

type ScenarioKey = (typeof SCENARIO_CODES)[number]

/** 三档情景的固定顺序，也是缺省返回顺序。 */
const SCENARIO_KEYS: readonly ScenarioKey[] = SCENARIO_CODES

/** 测算参数键；顺序即报告中的展示顺序。 */
const PARAM_KEYS = [
  'daily_revenue',
  'gross_margin',
  'monthly_rent',
  'monthly_labor',
  'monthly_other_fixed',
  'initial_investment',
  'tax_rate',
  'amortization_months',
] as const

type ParamKey = (typeof PARAM_KEYS)[number]

/**
 * 属于「口径参数」而非「业务参数」的键：缺省时是政策默认值，不是漏填。
 * 台账里不应标「必须补实际值」，而应标「可按实际校准」。
 */
const POLICY_PARAM_KEYS: readonly string[] = ['tax_rate', 'amortization_months']

/** 财务测算所需的全部参数（已归一化为数值）。 */
type FinancialParams = Record<ParamKey, number>

/** 一条参数库记录：值 + 来源 + 置信度，便于回溯。 */
interface ParamEntry {
  value: FieldValue
  source: string
  /** 'high' | 'medium' | 'low'，或 0–1 的数值置信度。 */
  confidence: FieldValue
}

/** 单情景测算结果。 */
interface ScenarioResult {
  /** 月营业额（元） */
  revenue: number
  /** 月净利（会计口径：已扣税费与折旧摊销，元） */
  net_profit: number
  /** 月现金净流（不含摊销，元）：回本按这个算 */
  monthly_cash_flow: number
  /** 年化投资回报率 = 年净利 ÷ 初始投入；初始投入 ≤ 0 时记为 0 */
  roi: number
  /** 保本所需的日营业额（元）：现金净流 = 0 的底线 */
  breakeven_revenue_daily: number
  /** 现金口径静态回本周期（月）；-1 表示按此情景无法回本 */
  payback_static_months: number
  /** 会计口径回本周期（月）= 初始投入 ÷ 会计净利；与行业基准表可比 */
  accounting_payback_months: number
  /** 回本判读（按行业实操标尺）：对会计口径回本贴标签 */
  payback_verdict: { level: PaybackLevel; label: string; note: string }
  /** 回本判读（现金流口径） */
  payback_verdict_cash: { level: PaybackLevel; label: string; note: string }
  /** 极限租金（现金净流 = 0 时的租金上限，元/月）；负值表示即便零租金也亏损 */
  max_rent_breakeven: number
  /** 极限租金（现金回本周期恰好等于目标月数时的租金上限，元/月） */
  max_rent_target: number
  /** 极限租金（净利=0 口径）占月营业额的比例，用于和租售比红线比对 */
  max_rent_ratio: number
}

/** 极限租金反推的汇总口径（取基准情景，供谈判直接引用）。 */
export interface RentCeiling {
  /** 该汇总基于哪个情景 */
  scenario: string
  /** 目标回本周期（月） */
  target_payback_months: number
  /** 净利 = 0 时的租金上限（元/月） */
  rent_ceiling_breakeven: number
  /** 回本恰好等于目标月数时的租金上限（元/月） */
  rent_ceiling_at_target: number
  /** 参数里的当前月租金（元/月） */
  current_rent: number
  /** 当前租金 − 目标口径上限；正数 = 当前租金偏高，需要压到这个幅度以下 */
  above_ceiling_at_target: number
  /** 当前租金 − 保本口径上限；正数 = 当前租金已让项目亏损 */
  above_ceiling_at_breakeven: number
}

/** 建议租金：**谈判锚点取基准档**（不是跨档最保守）；保守档仅作压力下限并列展示；保本红线取全档最保守。 */
export interface RentRecommendation {
  /** 谈判锚点：**基准档**的目标回本租金上限（常规经营预期下可接受的价格上限） */
  target_rent: number
  /**
   * 压力测试下限：所有情景里最低的目标回本租金上限（保守档 = 营收↓15% 且 成本↑5%）。
   * 只作风险提示，不作为谈判出价——拿它出价等于按最坏情况要价，谈不成。
   */
  target_rent_conservative: number
  /** 保守档锚点取自哪个情景 */
  conservative_scenario: string
  /** 红线：**基准档**的保本租金上限；越过即亏损（常规经营预期口径） */
  ceiling_rent: number
  /** 压力红线：所有情景里最低的保本租金上限（保守档），仅作最坏情况提示 */
  ceiling_rent_conservative: number
  /** 当前租金 − 锚点；正数 = 需要下调的幅度 */
  gap_to_target: number
  /** 租金安全余量（元/月）= 锚点 − 当前租金；负数表示需下调。**这才是「余量」的绝对值** */
  rent_headroom: number
  /** 安全余量占锚点的比例（0–1）：当前租金比承受上限低多少个百分点 */
  rent_headroom_pct: number
  /** 当前租金占锚点的比例（0–1） */
  rent_vs_anchor_pct: number
  /** 当前租金 − 红线；正数 = 已越过保本线 */
  gap_to_ceiling: number
  /** 锚点取自哪个情景（当前固定为 base；保守档不参与取锚点） */
  based_on_scenario: string
  /** 当前租售比 = 当前租金 ÷ 基准档月营业额 */
  current_rent_ratio: number
  /** 该业态的租售比健康线（低于此值为健康） */
  rent_ratio_healthy_max: number
  /** 该业态的租售比警戒线（高于此值为超红线） */
  rent_ratio_warning_max: number
  /** 经验线来源业态标签 */
  rent_ratio_label: string
  /** 租售比判语：healthy / watch / breach */
  rent_ratio_verdict: 'healthy' | 'watch' | 'breach'
  /** 一句话定位（含当前值与健康线，可直接进报告） */
  rent_ratio_hint: string
  /**
   * 锚点不可达：target_rent < 0 时为 true。
   * 含义是「即便租金为零，也达不到目标回本周期」——问题不在租金，在营收或投入结构。
   * 此时 target_rent 不得当作谈判价使用。
   */
  anchor_unreachable: boolean
}

/** `financial_calc` 的规范返回值（与 output.schema 严格一致）。 */
export interface FinancialCalcResult {
  /** 三档情景的营收/成本乘数——报告必须披露，否则保守/乐观两档无法复算 */
  scenario_factors: Readonly<Record<ScenarioKey, { revenue: number; cost: number; label: string }>>
  per_scenario: Partial<Record<ScenarioKey, ScenarioResult>>
  low_confidence_params: string[]
  param_version: string
  formula_version: string
  rent_ceiling: RentCeiling
  recommendation: RentRecommendation
  /** 租期内现金流模拟（含租金递增与装修翻新） */
  lease_model: LeaseModel
  /** 空间容量模型：面积↔营收对账（厨房/营业面积、座位、翻台率、坪效） */
  space_model: SpaceModel
  /** 本次实际生效的系数覆盖键（用于审计：哪些经验值被人为改过） */
  param_overrides_applied: string[]
  /** 参数文件的版本号；未提供时为空串 */
  param_version_source: string
  /** 本次因缺参数而回落到业态默认的参数（必须补，否则结论无意义） */
  param_defaults_used: string[]
  /** 假设台账：本次测算里所有「不是调用方亲口给的数」，供人工逐条修正 */
  assumption_ledger: LedgerRow[]
  /** 敏感度：各关键参数 ±20% 时谈判锚点的变化，以及结论是否翻转 */
  sensitivity: SensitivityRow[]
  /** 空间侧敏感度：座位面积/厨房占比/翻台基准 ±20% 时，座位数与应有产能怎么变 */
  space_sensitivity: SpaceSensitivityRow[]
  /** 内部比值校验：毛利率/人力占营收/租售比/单方造价 与业态区间的对比 */
  ratio_checks: RatioCheck[]
  /** 计算口径台账：每条关键指标的公式 + 代入值 + 结果，供人工核对参数是否搞错 */
  formula_trace: FormulaRow[]
  /** 点位截流力等级（未提供时为空串，系数 1） */
  catchment_code: string
  /** 等级名称 */
  catchment_label: string
  /** 客流乘数（1 = 未调整） */
  catchment_multiplier: number
}

/** 未提供参数时的兜底口径（样例 mock，非真实业务数据）。 */
const GENERIC_DEFAULTS: FinancialParams = {
  daily_revenue: 8000,
  gross_margin: 0.25,
  monthly_rent: 25000,
  monthly_labor: 18000,
  monthly_other_fixed: 6000,
  initial_investment: 350000,
  tax_rate: 0.045,
  amortization_months: 60,
}

/** 按业态覆盖默认口径；缺省回落到 GENERIC_DEFAULTS。 */
const DEFAULT_PARAMS_BY_FORMAT: Readonly<Record<string, FinancialParams>> = {
  convenience_store: GENERIC_DEFAULTS,
}

/** 情景因子：营收侧与成本侧的确定性缩放。 */
const SCENARIO_FACTORS: Readonly<Record<ScenarioKey, { revenue: number; cost: number }>> = {
  base: { revenue: 1, cost: 1 },
  optimistic: { revenue: 1.15, cost: 0.97 },
  pessimistic: { revenue: 0.85, cost: 1.05 },
}

/** 带人话标签的情景乘数，直接进报告披露表 */
const SCENARIO_FACTORS_WITH_LABEL: Readonly<Record<ScenarioKey, { revenue: number; cost: number; label: string }>> = {
  base: { ...SCENARIO_FACTORS.base, label: '基准' },
  pessimistic: { ...SCENARIO_FACTORS.pessimistic, label: '保守' },
  optimistic: { ...SCENARIO_FACTORS.optimistic, label: '乐观' },
}

/** 保留固定小数位并回到 number，避免浮点尾巴进入 JSON。 */
const roundTo = (value: number, digits: number): number => Number(value.toFixed(digits))

const defaultsFor = (formatCode: string): FinancialParams =>
  DEFAULT_PARAMS_BY_FORMAT[formatCode] ?? GENERIC_DEFAULTS

/** 把参数值转成有限数值；数字字符串可用，其余一律视为不可用。 */
function toFiniteNumber(value: FieldValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 置信度是否属于 low：支持 'low' 标签与 0–1 数值两种写法。 */
function isLowConfidence(entry: ParamEntry): boolean {
  const { confidence } = entry
  if (typeof confidence === 'number') return confidence < 0.5
  if (typeof confidence === 'string') return confidence.trim().toLowerCase() === 'low'
  return false
}

/** 把一条原始参数记录收窄成 {@link ParamEntry}；结构不合法则丢弃。 */
function toParamEntry(entry: unknown): ParamEntry | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const { value, source, confidence } = record
  if (!isFieldValue(value)) return undefined
  return {
    value,
    source: typeof source === 'string' ? source : '未标注来源',
    confidence: isFieldValue(confidence) ? confidence : 'unknown',
  }
}

/** 归一化模型传入的参数库。 */
function normalizeParams(raw: Record<string, unknown>): Map<string, ParamEntry> {
  const params = new Map<string, ParamEntry>()
  for (const [paramKey, entry] of Object.entries(raw)) {
    const parsed = toParamEntry(entry)
    if (parsed !== undefined) params.set(paramKey, parsed)
  }
  return params
}

interface ResolvedParams {
  values: FinancialParams
  /** 未提供（或值不可用）而回落到业态默认口径的参数名。 */
  defaulted: ParamKey[]
  /** 调用方提供但置信度为 low 的参数名。 */
  lowConfidence: string[]
}

/** 合并参数库与业态默认值，并记录缺省与低置信项。 */
function resolveParams(formatCode: string, raw: Record<string, unknown>): ResolvedParams {
  const provided = normalizeParams(raw)
  const values: FinancialParams = { ...defaultsFor(formatCode) }
  const defaulted: ParamKey[] = []

  for (const paramKey of PARAM_KEYS) {
    const entry = provided.get(paramKey)
    const numericValue = entry === undefined ? undefined : toFiniteNumber(entry.value)
    if (numericValue === undefined) {
      defaulted.push(paramKey)
      continue
    }
    values[paramKey] = numericValue
  }

  const lowConfidence = [...provided]
    .filter(([, entry]) => isLowConfidence(entry))
    .map(([paramKey]) => paramKey)

  return { values, defaulted, lowConfidence }
}

/** 归一化情景列表：非法/重复项被过滤，空列表回落到三档全算。 */
function normalizeScenarios(input: readonly ScenarioKey[] | undefined): ScenarioKey[] {
  const requested: readonly ScenarioKey[] = input ?? SCENARIO_CODES
  const picked = SCENARIO_KEYS.filter((key) => requested.includes(key))
  return picked.length > 0 ? picked : [...SCENARIO_KEYS]
}

/**
 * 单情景确定性测算。**现金口径与会计口径分开**：
 *
 *   现金口径（决定「多久收回投资」「保本线」「极限租金」）
 *     tax          = revenue × 税费率（增值税及附加，真实现金支出）
 *     fixed_cost   = (租金 + 人力 + 其他固定) × 情景成本因子
 *     cash_flow    = revenue × 毛利率 − tax − fixed_cost
 *     breakeven    = fixed_cost ÷ (毛利率 − 税费率) ÷ 30        （令 cash_flow = 0）
 *     回本(月)      = 初始投入 ÷ cash_flow
 *
 *   会计口径（决定「净利率」「ROI」，用于和行业基准对标）
 *     amortization = 初始投入 ÷ 摊销月数（装修与设备按年限摊，非现金）
 *     net_profit   = cash_flow − amortization
 *     ROI          = net_profit × 12 ÷ 初始投入
 *     会计回本(月)  = 初始投入 ÷ net_profit
 *
 * 为什么要分开：折旧摊销不是现金支出，拿它算「多久回本」会虚长；
 * 但算净利率又必须扣掉它，否则和行业口径对不上。两个数都给，不混用。
 *
 * 极限租金反推（同样走现金口径）：
 *   max_rent_breakeven = (revenue×毛利率 − tax) ÷ 成本因子 − 人力 − 其他固定
 *   max_rent_target    = (revenue×毛利率 − tax − 初始投入÷目标月数) ÷ 成本因子 − 人力 − 其他固定
 *
 * 两个值都可能为负：负值不是错误，是结论——说明即便零租金也达不到该口径，
 * 该点位的问题不在租金，而在营收或投入。报告必须原样呈现，不得归零。
 */
function computeScenario(
  params: FinancialParams,
  key: ScenarioKey,
  targetPaybackMonths: number,
): ScenarioResult {
  const factor = SCENARIO_FACTORS[key]
  const monthlyRevenue = params.daily_revenue * 30 * factor.revenue
  const tax = monthlyRevenue * params.tax_rate
  const amortization =
    params.amortization_months > 0 ? params.initial_investment / params.amortization_months : 0
  const fixedCost =
    (params.monthly_rent + params.monthly_labor + params.monthly_other_fixed) * factor.cost
  const grossProfit = monthlyRevenue * params.gross_margin

  const cashFlow = grossProfit - tax - fixedCost
  const netProfit = cashFlow - amortization

  // 保本：grossProfit − tax = fixed  →  revenue × (gm − tax_rate) = fixed
  const contributionRate = params.gross_margin - params.tax_rate
  const breakevenRevenue = contributionRate > 0 ? fixedCost / contributionRate : 0
  const breakevenDaily = breakevenRevenue / 30

  // 初始投入 ≤ 0 属于参数缺失，返回 -1（哨兵）而不是 0——
  // 0 在报告里会被读成「当月就回本」
  const payback = cashFlow > 0 && params.initial_investment > 0
    ? params.initial_investment / cashFlow
    : -1
  const accountingPayback = netProfit > 0 ? params.initial_investment / netProfit : -1
  const roi = params.initial_investment > 0 ? (netProfit * 12) / params.initial_investment : 0

  const costFactor = factor.cost > 0 ? factor.cost : 1
  const variableCost = params.monthly_labor + params.monthly_other_fixed
  const maxRentBreakeven = (grossProfit - tax) / costFactor - variableCost
  const target = targetPaybackMonths > 0 ? targetPaybackMonths : DEFAULT_TARGET_PAYBACK_MONTHS
  const maxRentTarget =
    (grossProfit - tax - params.initial_investment / target) / costFactor - variableCost
  const maxRentRatio = monthlyRevenue > 0 ? maxRentBreakeven / monthlyRevenue : 0

  return {
    revenue: roundTo(monthlyRevenue, 2),
    net_profit: roundTo(netProfit, 2),
    monthly_cash_flow: roundTo(cashFlow, 2),
    roi: roundTo(roi, 4),
    breakeven_revenue_daily: roundTo(breakevenDaily, 2),
    payback_static_months: roundTo(payback, 1),
    accounting_payback_months: roundTo(accountingPayback, 1),
    // 判定必须与展示同源：回本是「贴标尺」场景，展示 36.0 就该判「优秀」。
    // 直接用未舍入值会让 36.000000000000004 掉到「可接受上限」，读者看到 36 却被告知 48 档。
    payback_verdict: gradePayback(roundTo(accountingPayback, 1)),
    payback_verdict_cash: gradePayback(roundTo(payback, 1)),
    max_rent_breakeven: roundTo(maxRentBreakeven, 2),
    max_rent_target: roundTo(maxRentTarget, 2),
    max_rent_ratio: roundTo(maxRentRatio, 4),
  }
}

/**
 * 租售比经验线（租金 ÷ 月营业额）。按业态分档，不设单一全局阈值。
 *
 * 逻辑：大店营业额基数大，租金占比应当更低；小店坪效高，可承受更高占比。
 * 行业经验：餐饮整体 10%~15% 为健康，超过 20% 基本难做。
 * 表内数值为经验中位，必须按客户实际业态与城市能级校准。
 *
 *   healthy_max —— 低于此值为健康
 *   warning_max —— 高于此值即「超红线」，中间区间为「偏高」
 */
export const RENT_RATIO_BY_FORMAT: ReadonlyArray<{
  match: RegExp
  healthy_max: number
  warning_max: number
  label: string
}> = [
  { match: /tea_drink|milk_tea|奶茶|茶饮|咖啡|coffee/, healthy_max: 0.15, warning_max: 0.2, label: '茶饮/咖啡' },
  { match: /convenience|便利店/, healthy_max: 0.12, warning_max: 0.18, label: '便利店' },
  { match: /fast_food|fastfood|快餐|粉面|小吃/, healthy_max: 0.12, warning_max: 0.18, label: '快餐/粉面' },
  { match: /tea_house|yumcha|早茶|茶楼|茶居|点心/, healthy_max: 0.1, warning_max: 0.15, label: '全天茶楼' },
  { match: /large_dining|large_yuecai|large_|酒楼|正餐大店|宴会/, healthy_max: 0.1, warning_max: 0.15, label: '大型正餐' },
  { match: /mid_dining|dinner|正餐|餐厅/, healthy_max: 0.12, warning_max: 0.18, label: '中型正餐' },
]

/** 未匹配业态时的兜底健康线。 */
export const DEFAULT_RENT_RATIO_LINE = { healthy_max: 0.12, warning_max: 0.18, label: '通用' } as const

/** 按业态取租售比经验线。 */
export function rentRatioLineFor(formatCode: string): {
  healthyMax: number
  warningMax: number
  label: string
  matched: boolean
} {
  const hit = RENT_RATIO_BY_FORMAT.find((item) => item.match.test(formatCode))
  return hit === undefined
    ? {
        healthyMax: DEFAULT_RENT_RATIO_LINE.healthy_max,
        warningMax: DEFAULT_RENT_RATIO_LINE.warning_max,
        label: DEFAULT_RENT_RATIO_LINE.label,
        matched: false,
      }
    : { healthyMax: hit.healthy_max, warningMax: hit.warning_max, label: hit.label, matched: true }
}

// ---------------------------------------------------------------------------
// 租期 / 租金递增 / 装修翻新 —— 把静态回本扩展成租期内现金流
// ---------------------------------------------------------------------------

/** 租期模型缺省值；调用方未传时按此口径并在结果里披露。 */
export const LEASE_DEFAULTS = {
  term_years: 5,
  rent_escalation_pct: 0.03,
  renovation_cycle_years: 5,
} as const

/** 翻新成本占初始投入的经验比例（4~5 年一次重装修，通常为初装的 20%~30%）。 */
export const RENOVATION_COST_RATIO = 0.25

/** 按面积给出的最短租期建议（年）。大面积重装修业态必须靠长租摊薄。 */
export const MIN_TERM_BY_AREA: ReadonlyArray<{ min_area: number; min_years: number; label: string }> = [
  { min_area: 1000, min_years: 7, label: '大面积重装修业态' },
  { min_area: 300, min_years: 5, label: '中型业态' },
  { min_area: 0, min_years: 2, label: '小店' },
]

/**
 * 目标回本周期由**业态**决定，不由租期决定。
 *
 * 租期长 ≠ 可以慢回本：回本慢就是少赚钱，合同长只是「给得起这个时间」，
 * 不是「允许你更慢赚回来」。所以正确的关系是——
 *   ① 业态决定目标回本期 P；
 *   ② 租期负责容纳 P：合同至少要长到「回本之后还有等长的赚钱期」（见 TERM_CAPACITY_MULTIPLIER）。
 *
 * 表内为经验中位数，必须按客户实际业态校准。
 * 用户提供的锚点：茶饮/奶茶约 12 个月；全天茶楼 24~30 个月。
 */
export const PAYBACK_BY_FORMAT: ReadonlyArray<{ match: RegExp; months: number; label: string }> = [
  { match: /tea_drink|milk_tea|奶茶|茶饮|咖啡|coffee/, months: 12, label: '茶饮/咖啡' },
  { match: /tea_house|yumcha|早茶|茶楼|茶居|点心/, months: 27, label: '全天茶楼（24~30 取中位）' },
  { match: /large_dining|large_yuecai|large_|酒楼|正餐大店|宴会/, months: 36, label: '大型正餐' },
  { match: /mid_dining|dinner|正餐|餐厅/, months: 24, label: '中型正餐' },
  { match: /convenience|便利店/, months: 18, label: '便利店' },
  { match: /fast_food|fastfood|快餐|粉面|小吃/, months: 18, label: '快餐/粉面' },
]

/** 未匹配到业态时的兜底目标回本周期（月）。 */
/** 未匹配业态时的兜底回本目标：与 DEFAULT_TARGET_PAYBACK_MONTHS 同值，
 *  保留独立导出是为了让调用方语义清楚，但不再各自维护一个数字 */
export const DEFAULT_TARGET_PAYBACK_MONTHS_FALLBACK = DEFAULT_TARGET_PAYBACK_MONTHS

/** 按业态推荐目标回本周期（月）。 */
export function suggestTargetPayback(formatCode: string): { months: number; label: string; matched: boolean } {
  const hit = PAYBACK_BY_FORMAT.find((item) => item.match.test(formatCode))
  return hit === undefined
    ? { months: DEFAULT_TARGET_PAYBACK_MONTHS_FALLBACK, label: '未匹配业态，按通用 24 个月', matched: false }
    : { months: hit.months, label: hit.label, matched: true }
}

/**
 * 租期容纳系数：回本之后至少还要有等长的赚钱期，合同才算划算。
 * 例：目标回本 27 个月的茶楼，租期至少要 54 个月（4.5 年）才不至于「刚回本就要续约」。
 */
export const TERM_CAPACITY_MULTIPLIER = 2

/** 单年现金流行。 */
export interface LeaseYearRow {
  year: number
  rent_monthly: number
  revenue: number
  rent_total: number
  net_profit: number
  renovation: number
  cumulative: number
}

/** 租期模型的规范结果。 */
export interface LeaseModel {
  term_years: number
  rent_escalation_pct: number
  renovation_cycle_years: number
  renovation_cost: number
  base_rent: number
  monthly_net_year1: number
  /** 考虑递增与翻新后的回本月序；-1 表示租期内未回本 */
  payback_month: number
  /** 回本年数（保留 1 位小数）；-1 表示未回本 */
  payback_year: number
  total_net_profit: number
  total_rent_paid: number
  total_renovation: number
  /** 租期结束时累计现金（= 净利 − 初始投入 − 翻新），负值表示租期内没赚回投资 */
  ending_cumulative: number
  covers_investment: boolean
  /** healthy=回本充分｜tight=回本偏晚（>60% 租期）｜fail=租期内收不回投资 */
  verdict: 'healthy' | 'tight' | 'fail'
  /** 按面积给出的租期建议 */
  term_advice: string
  /** 租期短于该面积建议时给出警告；空串表示无警告 */
  term_warning: string
  /** 本次新增的缺省项披露 */
  defaults_used: string[]
  /** 该业态建议的目标回本周期（月） */
  suggested_target_payback_months: number
  /** 业态建议的来源说明 */
  suggested_target_label: string
  /** 调用方是否显式传了 target_payback_months */
  target_explicit: boolean
  /** 目标与业态建议偏离超过 25% */
  target_payback_mismatch: boolean
  /** 偏离说明；空串表示匹配 */
  target_payback_note: string
  /** 容纳该回本期加等长赚钱期所需的最短租期（年） */
  required_term_years: number
  /** 租期不足以容纳「回本 + 赚钱期」时的警告；空串表示够 */
  term_capacity_warning: string
  yearly: LeaseYearRow[]
}

/** 租期建议：大面积靠长租摊薄装修，小店合同短也可行。 */
function termAdviceFor(area: number | undefined): { advice: string; minYears?: number } {
  if (area === undefined) {
    return { advice: '未提供面积：大面积（≥1000㎡）建议 ≥7 年，中型（300~1000㎡）≥5 年，小店 2~3 年' }
  }
  const rule = MIN_TERM_BY_AREA.find((item) => area >= item.min_area)!
  return {
    advice: `${area}㎡ 属${rule.label}：租期建议 ≥${rule.min_years} 年`
      + (rule.min_years >= 7 ? '（长租才能摊薄重装修；3 年合同摊不平）' : ''),
    minYears: rule.min_years,
  }
}

/**
 * 租期内现金流模拟。
 *   rent_monthly(y) = base_rent × (1 + g)^(y−1)
 *   net_month(y)    = 月营收×毛利率 − (rent_monthly(y) + 人力 + 其他固定)
 *   翻新           = 每逢 renovation_cycle_years 的整数倍年，年末一次性扣 renovation_cost
 *   回本           = 累计现金（含初始投入为负起点）首次 ≥ 0 的月份
 *
 * 口径基于**基准情景**（不减不增），因为租期模型对比的是「长期承诺」，
 * 用悲观档会与上面的三档测算重复惩罚；三档已单独披露。
 */
function simulateLease(
  values: FinancialParams,
  area: number | undefined,
  raw: Record<string, unknown> | undefined,
  targetPaybackMonths: number,
  formatCode: string,
  targetExplicit: boolean,
): LeaseModel {
  const defaultsUsed: string[] = []
  const readNum = (key: string): number | undefined => {
    const entry = raw?.[key]
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry
    if (typeof entry === 'string' && entry.trim() !== '' && Number.isFinite(Number(entry))) return Number(entry)
    return undefined
  }

  let termYears = readNum('term_years')
  if (termYears === undefined || termYears <= 0) {
    termYears = LEASE_DEFAULTS.term_years
    defaultsUsed.push(`term_years=${LEASE_DEFAULTS.term_years}`)
  }
  let escalation = readNum('rent_escalation_pct')
  if (escalation === undefined || escalation < 0) {
    escalation = LEASE_DEFAULTS.rent_escalation_pct
    defaultsUsed.push(`rent_escalation_pct=${LEASE_DEFAULTS.rent_escalation_pct}`)
  }
  // 允许传百分数（如 3）或小数（如 0.03）
  if (escalation > 1) escalation = escalation / 100

  let cycle = readNum('renovation_cycle_years')
  if (cycle === undefined || cycle < 0) {
    cycle = LEASE_DEFAULTS.renovation_cycle_years
    defaultsUsed.push(`renovation_cycle_years=${LEASE_DEFAULTS.renovation_cycle_years}`)
  }
  let renovationCost = readNum('renovation_cost')
  const renoRatio = readNum('renovation_cost_ratio') ?? RENOVATION_COST_RATIO
  if (renovationCost === undefined) {
    renovationCost = roundTo(values.initial_investment * renoRatio, 2)
    defaultsUsed.push(`renovation_cost=initial_investment×${renoRatio}`)
  }

  const monthlyRevenue = values.daily_revenue * 30
  const monthlyGross = monthlyRevenue * values.gross_margin
  // 现金流口径：税费是真实支出，折旧摊销不是 → 这里只扣税费
  const monthlyTax = monthlyRevenue * values.tax_rate
  const fixedWithoutRent = values.monthly_labor + values.monthly_other_fixed + monthlyTax
  const baseRent = values.monthly_rent

  let cumulative = -values.initial_investment
  let paybackMonth = -1
  let totalNet = 0
  let totalRent = 0
  let totalRenovation = 0
  const yearly: LeaseYearRow[] = []

  for (let year = 1; year <= termYears; year += 1) {
    const rentMonthly = baseRent * (1 + escalation) ** (year - 1)
    const netMonthly = monthlyGross - (rentMonthly + fixedWithoutRent)
    const renovation = cycle > 0 && year % cycle === 0 ? renovationCost : 0
    const yearNet = netMonthly * 12

    for (let month = 1; month <= 12; month += 1) {
      cumulative += netMonthly
      // 翻新在年末（第 12 个月）支出，必须**先扣再判**，
      // 否则会出现「本月刚过零记为已回本，年末翻新又砸回负值」的自相矛盾
      if (month === 12) cumulative -= renovation
      if (paybackMonth < 0 && cumulative >= 0) paybackMonth = (year - 1) * 12 + month
    }

    totalNet += yearNet
    totalRent += rentMonthly * 12
    totalRenovation += renovation
    yearly.push({
      year,
      rent_monthly: roundTo(rentMonthly, 2),
      revenue: roundTo(monthlyRevenue * 12, 2),
      rent_total: roundTo(rentMonthly * 12, 2),
      net_profit: roundTo(yearNet, 2),
      renovation: roundTo(renovation, 2),
      cumulative: roundTo(cumulative, 2),
    })
  }

  const months = termYears * 12
  const covers = cumulative >= 0
  // 中途过零但期末转负：翻新把利润吃回去了。
  // 这种情况不能说「已回本」，也不能简单说「未回本」——两件事都要讲清楚。
  const paybackOvertaken = paybackMonth > 0 && !covers
  const ratio = paybackMonth > 0 ? paybackMonth / months : 1
  const verdict: LeaseModel['verdict'] = !covers ? 'fail' : ratio > 0.6 ? 'tight' : 'healthy'
  const { advice, minYears } = termAdviceFor(area)
  const termWarning = minYears !== undefined && termYears < minYears
    ? `租期 ${termYears} 年短于该面积的建议下限 ${minYears} 年：装修成本摊不平，续约风险高`
    : ''

  const suggestion = suggestTargetPayback(formatCode)
  const mismatch =
    targetExplicit
    && suggestion.months > 0
    && Math.abs(targetPaybackMonths - suggestion.months) / suggestion.months > 0.25
  const targetNote = !mismatch
    ? ''
    : targetPaybackMonths > suggestion.months
      ? `目标回本 ${targetPaybackMonths} 个月高于${suggestion.label}常规 ${suggestion.months} 个月：要求偏松，等于主动延长回本期`
      : `目标回本 ${targetPaybackMonths} 个月低于${suggestion.label}常规 ${suggestion.months} 个月：要求偏紧，锚点会偏保守`

  // 租期只负责「容纳」：回本之后至少还要有等长的赚钱期，否则等于刚回本就要续约
  const requiredTermYears = roundTo((targetPaybackMonths * TERM_CAPACITY_MULTIPLIER) / 12, 1)
  const capacityWarning = termYears < requiredTermYears
    ? `租期 ${termYears} 年不足以容纳「${targetPaybackMonths} 个月回本 + 等长赚钱期」，建议 ≥${requiredTermYears} 年`
    : ''

  return {
    term_years: termYears,
    rent_escalation_pct: escalation,
    renovation_cycle_years: cycle,
    renovation_cost: roundTo(renovationCost, 2),
    base_rent: roundTo(baseRent, 2),
    monthly_net_year1: roundTo(monthlyGross - (baseRent + fixedWithoutRent), 2),
    payback_month: paybackMonth,
    payback_year: paybackMonth > 0 ? roundTo(paybackMonth / 12, 1) : -1,
    total_net_profit: roundTo(totalNet, 2),
    total_rent_paid: roundTo(totalRent, 2),
    total_renovation: roundTo(totalRenovation, 2),
    ending_cumulative: roundTo(cumulative, 2),
    covers_investment: covers,
    verdict,
    term_advice: advice,
    term_warning: termWarning,
    defaults_used: defaultsUsed,
    suggested_target_payback_months: suggestion.months,
    suggested_target_label: suggestion.label,
    target_explicit: targetExplicit,
    target_payback_mismatch: mismatch,
    target_payback_note: targetNote,
    required_term_years: requiredTermYears,
    term_capacity_warning: capacityWarning,
    yearly,
  }
}

/**
 * 空间容量模型：把「面积」和「营收」对账。
 *
 * 原则：**参数不全就不算**。任何需要假设的地方都在 defaults_used 里披露，
 * 拿不到的（例如座位数）宁可留空，也不编。
 *
 * 业态缺省系数仅为经验起点，必须由客户实际业态校准。
 */
/**
 * 业态翻台风险阈值（业务口径）。
 * red   = 现实可行性低，**禁止**作为基准情景，财务结果只能当压力测算；
 * yellow= 偏低，报告须标注；
 * green = 合理区间；
 * high  = 只有节假日高峰才可能出现，不宜按全年稳态测算。
 */
/**
 * 餐饮行业民间实操标尺 —— 重资产大店（装修投入几百万级）。
 *
 *   24–36 个月（2–3 年）：优秀门店
 *   ≤ 48 个月（4 年）   ：可勉强接受的上限
 *   49–60 个月（>4 年）  ：风险偏高，需要非常硬的非财务理由
 *   61–84 个月（5–7 年） ：风险极高，多数老板不该投
 *   > 84 个月（7–8 年）  ：基本没有投资价值
 *
 * 这是经验标尺，不是公式。报告里只用来给算出来的回本月数贴标签，
 * 不反过来影响测算结果。
 */
const PAYBACK_SCALE: ReadonlyArray<{
  max: number
  level: 'too_good' | 'excellent' | 'acceptable' | 'risky' | 'very_risky' | 'no_value'
  label: string
  note: string
}> = [
  {
    max: 18, level: 'too_good', label: '快得不真实，先核参数',
    note: '低于 18 个月通常不是好生意，而是营业额估高了、投入漏项了，或把一次性收入当成了常态',
  },
  { max: 36, level: 'excellent', label: '优秀', note: '2–3 年回本，餐饮实操里的好店' },
  { max: 48, level: 'acceptable', label: '可接受上限', note: '接近 4 年，行业勉强能接受的上限' },
  { max: 60, level: 'risky', label: '风险偏高', note: '超过 4 年，要有很硬的理由才投' },
  { max: 84, level: 'very_risky', label: '风险极高', note: '5 年以上，多数老板不该投' },
  { max: Infinity, level: 'no_value', label: '基本没有投资价值', note: '7–8 年回本，除非有非财务目的' },
]

/** 按行业标尺给回本月数贴标签。无法回本（-1）单列。 */
type PaybackLevel = 'too_good' | 'excellent' | 'acceptable' | 'risky' | 'very_risky' | 'no_value' | 'never'

function gradePayback(months: number): { level: PaybackLevel; label: string; note: string } {
  if (!Number.isFinite(months) || months <= 0) {
    return { level: 'never', label: '按此情景无法回本', note: '现金流或净利为负，回本周期不存在' }
  }
  const band = PAYBACK_SCALE.find((b) => months <= b.max)
  return band === undefined
    ? { level: 'no_value', label: '基本没有投资价值', note: '回本周期过长' }
    : { level: band.level, label: band.label, note: band.note }
}

/**
 * 座位翻台基准（次/日）：按细分业态给五档 + 客单价配对区间。
 *
 * 口径说明：
 *  · 本表是**座位翻台率**，不是桌翻台率。座位翻台受空座、拼台影响，
 *    同店同经营下座位翻台低于桌翻台，两套口径不可混用。
 *  · 全部为**日均稳态值**，非节假日峰值、非新店爆火期。
 *  · maxReal 是物理天花板（极端火爆短期可达），**不用于财务测算**，
 *    财务基准只能取绿色或黄色区间。
 *  · 面积修正：>800㎡ 重资产大店的翻台普遍比小店低 0.2–0.4，
 *    本表已按大店口径给值；小店场景请用对应子类型而非通用档。
 */
export interface TurnoverBand {
  /** 低于此值 → 红色告警：现实可行性低，只作压力测算 */
  alertBelow: number
  /** 黄色区间下界（通常 === alertBelow） */
  warnLow: number
  /** 黄色区间上界（通常 === normalLow） */
  warnHigh: number
  /** 绿色合理区间下界 */
  normalLow: number
  /** 绿色合理区间上界 */
  normalHigh: number
  /** 物理上限：超过即参数可疑，非日常预期 */
  maxReal: number
  /** 典型客单价下限（元/人） */
  ticketMin: number
  /** 典型客单价上限（元/人） */
  ticketMax: number
  label: string
}

/** 顺序敏感：更具体的子类型必须排在通用档之前。 */
const TURNOVER_RISK_BANDS: ReadonlyArray<{ match: RegExp; band: TurnoverBand }> = [
  // ── 粤式 ──
  {
    match: /yue_grand|grand_banquet|粤式大酒楼|大酒楼|large_yuecai|large_dining|large_|酒楼|宴会/i,
    band: { alertBelow: 1.5, warnLow: 1.5, warnHigh: 1.8, normalLow: 1.8, normalHigh: 2.2, maxReal: 2.6, ticketMin: 150, ticketMax: 400, label: '粤式大酒楼（正餐宴请 >1000㎡）' },
  },
  {
    match: /yumcha_day|tea_house_day|全天茶楼|早茶|yumcha/i,
    band: { alertBelow: 1.4, warnLow: 1.4, warnHigh: 1.7, normalLow: 1.7, normalHigh: 2.2, maxReal: 2.7, ticketMin: 60, ticketMax: 130, label: '粤式全天茶楼（早茶+午晚市，非 24h）' },
  },
  {
    match: /tea_house|24h|纯茶市|茶楼|茶居|点心/,
    band: { alertBelow: 1.3, warnLow: 1.3, warnHigh: 1.6, normalLow: 1.6, normalHigh: 2.1, maxReal: 2.6, ticketMin: 60, ticketMax: 120, label: '24h 纯茶市茶楼' },
  },
  {
    match: /cha_chaan|chachaan|茶餐厅|冰室/,
    band: { alertBelow: 2.5, warnLow: 2.5, warnHigh: 3.0, normalLow: 3.0, normalHigh: 4.0, maxReal: 5.0, ticketMin: 40, ticketMax: 75, label: '茶餐厅（简餐粤式）' },
  },
  // ── 火锅 ──
  {
    match: /hotpot_mini|小火锅|一人食/,
    band: { alertBelow: 2.4, warnLow: 2.4, warnHigh: 2.8, normalLow: 2.8, normalHigh: 3.5, maxReal: 4.2, ticketMin: 70, ticketMax: 110, label: '精品小火锅 / 一人食火锅' },
  },
  {
    match: /hotpot|火锅|海底捞/i,
    band: { alertBelow: 2.0, warnLow: 2.0, warnHigh: 2.4, normalLow: 2.4, normalHigh: 3.0, maxReal: 3.8, ticketMin: 100, ticketMax: 160, label: '大众连锁火锅（>800㎡）' },
  },
  // ── 烧烤 ──
  {
    match: /bbq|烧烤|烤肉|grill/i,
    band: { alertBelow: 1.8, warnLow: 1.8, warnHigh: 2.2, normalLow: 2.2, normalHigh: 2.8, maxReal: 3.4, ticketMin: 90, ticketMax: 140, label: '大众烧烤（夜间为主）' },
  },
  // ── 中式正餐 ──
  {
    match: /fine_private|私房菜|高端宴请/,
    band: { alertBelow: 1.0, warnLow: 1.0, warnHigh: 1.3, normalLow: 1.3, normalHigh: 1.8, maxReal: 2.0, ticketMin: 260, ticketMax: 600, label: '高端私房菜 / 宴请正餐' },
  },
  {
    match: /single_dish|酸菜鱼|太二|单品正餐/,
    band: { alertBelow: 2.0, warnLow: 2.0, warnHigh: 2.4, normalLow: 2.4, normalHigh: 3.1, maxReal: 3.8, ticketMin: 85, ticketMax: 130, label: '特色单品正餐（酸菜鱼类）' },
  },
  {
    match: /sichuan|hunan|川湘|家常菜|湘菜|川菜/i,
    band: { alertBelow: 1.8, warnLow: 1.8, warnHigh: 2.1, normalLow: 2.1, normalHigh: 2.7, maxReal: 3.2, ticketMin: 90, ticketMax: 160, label: '川湘家常菜大店（>800㎡）' },
  },
  // ── 快餐简餐 ──
  {
    match: /noodle|粉面|面馆|粉店/,
    band: { alertBelow: 4.0, warnLow: 4.0, warnHigh: 5.0, normalLow: 5.0, normalHigh: 7.0, maxReal: 8.5, ticketMin: 22, ticketMax: 38, label: '粉面门店（堂食为主）' },
  },
  {
    match: /chinese_fast|中式快餐|老乡鸡|快餐|fast_food|fastfood|小吃/,
    band: { alertBelow: 3.5, warnLow: 3.5, warnHigh: 4.2, normalLow: 4.2, normalHigh: 6.0, maxReal: 7.5, ticketMin: 28, ticketMax: 45, label: '中式快餐（老乡鸡模式）' },
  },
  // ── 日料西餐 ──
  {
    match: /fine_dining|法餐|高端日料|米其林/i,
    band: { alertBelow: 0.9, warnLow: 0.9, warnHigh: 1.1, normalLow: 1.1, normalHigh: 1.5, maxReal: 1.8, ticketMin: 400, ticketMax: 1000, label: '高端日料 / 法餐 fine-dining' },
  },
  {
    match: /izakaya|居酒屋|酒馆|烧鸟/,
    band: { alertBelow: 1.4, warnLow: 1.4, warnHigh: 1.7, normalLow: 1.7, normalHigh: 2.3, maxReal: 2.8, ticketMin: 120, ticketMax: 200, label: '居酒屋（夜间）' },
  },
  // ── 咖啡茶饮 ──
  {
    match: /cafe|coffee|咖啡/i,
    band: { alertBelow: 2.2, warnLow: 2.2, warnHigh: 2.8, normalLow: 2.8, normalHigh: 4.0, maxReal: 5.5, ticketMin: 40, ticketMax: 65, label: '精品咖啡馆（堂食占比高）' },
  },
]

/** 按业态码找翻台基准；未配置返回 undefined（不臆造结论）。 */
function findTurnoverBand(formatCode: string): TurnoverBand | undefined {
  return TURNOVER_RISK_BANDS.find((x) => x.match.test(formatCode))?.band
}

/** 客单价区间：翻台基准表优先，未匹配业态回落到面积预设。 */
function bandTicketRange(
  formatCode: string,
  fallbackMin: number,
  fallbackMax: number,
): { min: number; max: number } {
  const b = findTurnoverBand(formatCode)
  return b === undefined ? { min: fallbackMin, max: fallbackMax } : { min: b.ticketMin, max: b.ticketMax }
}

export type TurnoverRisk = 'red' | 'yellow' | 'green' | 'high' | 'impossible' | 'unknown'

/**
 * 按业态判定座位翻台风险（五档）。
 *
 * 判定用**未舍入原值**，note 里统一展示 3 位小数——
 * 避免出现「显示 1.50 却判 1.499 < 1.5」这种视觉矛盾。
 */
function gradeTurnoverRisk(
  formatCode: string,
  turnover: number | undefined,
  override?: TurnoverBand,
): { risk: TurnoverRisk; note: string; band: TurnoverBand | null } {
  if (turnover === undefined || !Number.isFinite(turnover) || turnover <= 0) {
    return { risk: 'unknown', note: '翻台率无法计算', band: null }
  }
  const band = override ?? findTurnoverBand(formatCode)
  if (band === undefined) return { risk: 'unknown', note: '该业态未配置翻台阈值', band: null }

  const t = turnover.toFixed(3)
  const nearTip = Math.abs(turnover - band.alertBelow) < 0.01
    ? `（贴线：与下限只差 ${Math.abs(turnover - band.alertBelow).toFixed(4)}，营收或客流稍微一改就会翻档）`
    : ''
  const range = `${band.normalLow.toFixed(2)}–${band.normalHigh.toFixed(2)}`

  if (turnover < band.alertBelow) {
    return {
      risk: 'red', band,
      note: `翻台 ${t} 次/日（座位翻台·未舍入值）低于 ${band.label} 告警线 ${band.alertBelow}：`
        + '这个参数组合现实可行性低，财务结果只能做压力测算，不代表正常经营预期' + nearTip,
    }
  }
  if (turnover < band.normalLow) {
    return {
      risk: 'yellow', band,
      note: `翻台 ${t} 次/日（座位翻台·未舍入值）落在黄色提示区间（${band.label} 合理区间 ${range}）：`
        + '薄利，需要较好的运营把客流做起来才算稳',
    }
  }
  if (turnover <= band.normalHigh) {
    return {
      risk: 'green', band,
      note: `翻台 ${t} 次/日（座位翻台·未舍入值）落在 ${band.label} 合理区间 ${range}`,
    }
  }
  if (turnover <= band.maxReal) {
    return {
      risk: 'high', band,
      note: `翻台 ${t} 次/日（座位翻台·未舍入值）高于 ${band.label} 常态上限 ${band.normalHigh}：`
        + `通常只在节假日或爆火期出现，物理天花板约 ${band.maxReal}，不宜按全年稳态测算`,
    }
  }
  return {
    risk: 'impossible', band,
    note: `翻台 ${t} 次/日（座位翻台·未舍入值）已超过 ${band.label} 的物理上限 ${band.maxReal}：`
      + '这个数字现实中做不出来，大概率是营收或座位数录错了，请先核参数',
  }
}

const SPACE_DEFAULTS_BY_FORMAT: ReadonlyArray<{
  match: RegExp
  kitchenRatio: number
  seatAreaSqm: number
  /** 业态常规翻台（次/日，按座位计）——用于判断输入营收是否与面积自洽 */
  normalTurnover: number
  /** 产能上限（次/日）——超过即物理不可能 */
  turnoverCap: number
  revenuePerSqmBenchmark: number
  /** 典型客单价区间（元/人），用于校验业态标签是否被贴错 */
  ticketMin: number
  ticketMax: number
}> = [
  { match: /tea_drink|milk_tea|奶茶|茶饮|咖啡/, kitchenRatio: 0.18, seatAreaSqm: 1.2, normalTurnover: 6, turnoverCap: 10, revenuePerSqmBenchmark: 2500, ticketMin: 10, ticketMax: 35 },
  { match: /convenience|便利店/, kitchenRatio: 0.1, seatAreaSqm: 0, normalTurnover: 0, turnoverCap: 0, revenuePerSqmBenchmark: 3000, ticketMin: 5, ticketMax: 25 },
  { match: /fast_food|fastfood|快餐|粉面|小吃/, kitchenRatio: 0.25, seatAreaSqm: 1.5, normalTurnover: 4, turnoverCap: 6, revenuePerSqmBenchmark: 1500, ticketMin: 15, ticketMax: 45 },
  // 全天茶楼：只喝茶吃点心，没有正餐 → 客单低、翻台高、占座时间长
  { match: /tea_house|yumcha|早茶|茶楼|茶居|点心/, kitchenRatio: 0.32, seatAreaSqm: 3.2, normalTurnover: 2.5, turnoverCap: 3.5, revenuePerSqmBenchmark: 800, ticketMin: 60, ticketMax: 130 },
  // 大型正餐/粤菜酒楼：有正餐，客单高、翻台低
  { match: /large_dining|large_yuecai|large_|酒楼|正餐大店|宴会/, kitchenRatio: 0.35, seatAreaSqm: 2.8, normalTurnover: 2, turnoverCap: 3, revenuePerSqmBenchmark: 700, ticketMin: 150, ticketMax: 400 },
  { match: /mid_dining|dinner|正餐|餐厅/, kitchenRatio: 0.3, seatAreaSqm: 2.2, normalTurnover: 2.5, turnoverCap: 3.5, revenuePerSqmBenchmark: 900, ticketMin: 60, ticketMax: 150 },
]

const SPACE_DEFAULTS_FALLBACK = {
  kitchenRatio: 0.3,
  seatAreaSqm: 2.4,
  normalTurnover: 2.5,
  turnoverCap: 3.5,
  revenuePerSqmBenchmark: 900,
  ticketMin: 40,
  ticketMax: 200,
} as const

/** 桌均人数缺省值：只用于把「座翻台」换算成行业口语的「桌翻台」。 */
export const DEFAULT_TABLE_SIZE = 4

/** 空间容量模型结果。available=false 时各数值为 0，note 说明缺什么。 */
export interface SpaceModel {
  available: boolean
  note: string
  area_sqm: number
  kitchen_ratio: number
  kitchen_area_sqm: number
  operating_area_sqm: number
  /** 座位数；无法推算时为 -1 */
  seats: number
  seat_source: 'input' | 'derived' | 'missing'
  /** 每座占用营业面积（㎡）的实际取值；直接给座位数且未指定时为 -1 */
  seat_area_sqm: number
  /** 客单价；未提供时为 -1 */
  avg_ticket: number
  /** 日均客流；无法推算时为 -1 */
  daily_customers: number
  /** 翻台率（次/日）；无法计算时为 -1 */
  turnover_per_day: number
  /** 保本所需翻台率（次/日）：低于它必亏；无法计算时为 -1 */
  breakeven_turnover_per_day: number
  /** 达到目标回本周期所需翻台率（次/日）；无法计算时为 -1 */
  target_turnover_per_day: number
  /** 目标回本口径下所需的日营业额；无法计算时为 -1 */
  target_daily_revenue: number
  /** 目标翻台率是否超出该业态产能上限（超出=这个面积+租金组合做不出来） */
  target_within_capacity: boolean
  /** 计算目标翻台率时使用的目标回本月数 */
  target_payback_months: number
  /** 该业态翻台上限（经验值） */
  turnover_cap_per_day: number
  /** 该业态常规翻台（次/日，按座计）——用于校验输入营收是否与面积自洽 */
  normal_turnover_per_day: number
  /** 桌数（按桌均人数折算）；无法确定时为 -1 */
  tables: number
  /** 桌均人数（缺省 4，须披露） */
  table_size: number
  /** 桌翻台率（次/日）= 客流 ÷ 桌数，行业口语常用的口径；无法计算时为 -1 */
  turnover_tables_per_day: number
  /** 按业态常规翻台反推的应有日营收（元）；用来对比当前营收假设 */
  implied_daily_revenue_normal: number
  /** 当前营收假设 ÷ 应有日营收；显著低于 0.4 说明营收与面积不匹配 */
  revenue_vs_normal_ratio: number
  /** 输入自洽性：ok ｜ revenue_too_low ｜ turnover_impossible */
  input_consistency: 'ok' | 'revenue_too_low' | 'turnover_impossible'
  /** 该业态典型客单价下限（元/人） */
  typical_ticket_min: number
  /** 该业态典型客单价上限（元/人） */
  typical_ticket_max: number
  /** 客单价是否落在该业态典型区间内；未提供客单价时为 true */
  ticket_matches_format: boolean
  /** 客单价与业态标签不符时的说明；空串表示相符或未提供 */
  ticket_note: string
  /** 座位容量上限下的日客流 */
  capacity_customers_per_day: number
  /** 容量利用率（%）：客流 ÷ (座位数 × 业态翻台上限)。**不是翻台率**，报告须写全名 */
  utilization_pct: number
  /** 容量利用率的分母口径，供报告原样展示 */
  utilization_basis: string
  /** 原始客流（未乘点位截流系数） */
  daily_customers_raw: number
  /** 计算客流时使用的点数截流乘数（1 = 未调整） */
  catchment_multiplier: number
  /** 目标回本日营业额（现金流口径，不含摊销） */
  target_daily_revenue_cash: number
  /** 目标回本所需翻台（现金流口径）；-1 表示无法计算 */
  target_turnover_cash_per_day: number
  /** 业态翻台风险分级：red 该组合现实可行性低 ｜ yellow 偏低 ｜ green 合理 ｜ high 偏高 */
  turnover_risk: TurnoverRisk
  /** 翻台五档基准；未匹配业态时不输出该字段（供报告展示红/黄/绿/上限） */
  turnover_band?: {
    alert_below: number; warn_low: number; warn_high: number
    normal_low: number; normal_high: number; max_real: number
    label: string
  }
  /** 翻台风险的人话说明 */
  turnover_risk_note: string
  /** 坪效（元/㎡/月，按建筑面积计） */
  revenue_per_sqm_month: number
  /** 该业态坪效经验基准（元/㎡/月） */
  revenue_per_sqm_benchmark: number
  /** 保本营业额（月） */
  breakeven_revenue_monthly: number
  /** 保本客单量（单/日）；无客单价时为 -1 */
  breakeven_customers_daily: number
  /** 单方造价（元/㎡，= 初始投入 ÷ 建筑面积） */
  investment_per_sqm: number
  warnings: string[]
  defaults_used: string[]
}

/**
 * 构建空间容量模型。
 * @param breakevenDaily 基准档保本日营业额（来自财务测算）
 */
function buildSpaceModel(
  values: FinancialParams,
  formatCode: string,
  areaSqm: number | undefined,
  spaceRaw: Record<string, unknown> | undefined,
  breakevenDaily: number,
  targetPaybackMonths: number,
  overridesRaw: Record<string, unknown> | undefined,
  catchmentCode?: string,
): SpaceModel {
  const readNum = (key: string): number | undefined => {
    const entry = spaceRaw?.[key]
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry
    if (typeof entry === 'string' && entry.trim() !== '' && Number.isFinite(Number(entry))) return Number(entry)
    return undefined
  }

  const empty: SpaceModel = {
    available: false,
    note: '',
    area_sqm: 0,
    kitchen_ratio: 0,
    kitchen_area_sqm: 0,
    operating_area_sqm: 0,
    seats: -1,
    seat_source: 'missing',
    seat_area_sqm: -1,
    avg_ticket: -1,
    daily_customers: -1,
    turnover_per_day: -1,
    breakeven_turnover_per_day: -1,
    target_turnover_per_day: -1,
    target_daily_revenue: -1,
    target_within_capacity: false,
    target_payback_months: targetPaybackMonths,
    turnover_cap_per_day: 0,
    normal_turnover_per_day: 0,
    tables: -1,
    table_size: DEFAULT_TABLE_SIZE,
    turnover_tables_per_day: -1,
    implied_daily_revenue_normal: -1,
    revenue_vs_normal_ratio: -1,
    input_consistency: 'ok',
    typical_ticket_min: 0,
    typical_ticket_max: 0,
    ticket_matches_format: true,
    ticket_note: '',
    capacity_customers_per_day: 0,
    utilization_pct: -1,
    utilization_basis: '',
    daily_customers_raw: -1,
    catchment_multiplier: 1,
    target_daily_revenue_cash: -1,
    target_turnover_cash_per_day: -1,
    turnover_risk: 'unknown',
    turnover_risk_note: '',
    revenue_per_sqm_month: 0,
    revenue_per_sqm_benchmark: 0,
    breakeven_revenue_monthly: roundTo(breakevenDaily * 30, 2),
    breakeven_customers_daily: -1,
    investment_per_sqm: 0,
    warnings: [],
    defaults_used: [],
  }

  const area = areaSqm ?? readNum('area_sqm')
  if (area === undefined || area <= 0) {
    return { ...empty, note: '未提供建筑面积，无法计算厨房/营业面积、座位数、翻台率与坪效' }
  }

  const presetBase = SPACE_DEFAULTS_BY_FORMAT.find((item) => item.match.test(formatCode)) ?? SPACE_DEFAULTS_FALLBACK
  const preset = {
    kitchenRatio: overrideNumber(overridesRaw, 'kitchen_ratio') ?? presetBase.kitchenRatio,
    seatAreaSqm: overrideNumber(overridesRaw, 'seat_area_sqm') ?? presetBase.seatAreaSqm,
    normalTurnover: overrideNumber(overridesRaw, 'normal_turnover') ?? presetBase.normalTurnover,
    turnoverCap: overrideNumber(overridesRaw, 'turnover_cap') ?? presetBase.turnoverCap,
    revenuePerSqmBenchmark:
      overrideNumber(overridesRaw, 'revenue_per_sqm_benchmark') ?? presetBase.revenuePerSqmBenchmark,
    ticketMin: overrideNumber(overridesRaw, 'typical_ticket_min') ?? presetBase.ticketMin,
    ticketMax: overrideNumber(overridesRaw, 'typical_ticket_max') ?? presetBase.ticketMax,
  }
  const tableSizeOverride = overrideNumber(overridesRaw, 'table_size')
  const defaultsUsed: string[] = []
  const warnings: string[] = []

  let kitchenRatio = readNum('kitchen_ratio')
  if (kitchenRatio === undefined) {
    kitchenRatio = preset.kitchenRatio
    defaultsUsed.push(`kitchen_ratio=${preset.kitchenRatio}`)
  }
  if (kitchenRatio > 1) kitchenRatio = kitchenRatio / 100

  const kitchenArea = area * kitchenRatio
  const operatingArea = area - kitchenArea

  // 座位数：优先用调用方给的，其次按每座面积推算；每座面积也要披露
  const seatsInput = readNum('seats')
  let seatAreaSqm = readNum('seat_area_sqm')
  let seatSource: SpaceModel['seat_source'] = 'input'
  let seats = seatsInput
  if (seats === undefined) {
    if (seatAreaSqm === undefined) {
      seatAreaSqm = preset.seatAreaSqm
      defaultsUsed.push(`seat_area_sqm=${preset.seatAreaSqm}`)
    }
    if (seatAreaSqm > 0) {
      seats = Math.floor(operatingArea / seatAreaSqm)
      seatSource = 'derived'
    } else {
      seatSource = 'missing'
    }
  }

  const avgTicket = readNum('avg_ticket')
  const monthlyRevenue = values.daily_revenue * 30
  const customersInput = readNum('daily_customers')
  // 原始客流（未乘截流系数）：来自 日营业额 ÷ 客单价
  let dailyCustomersRaw = customersInput
  if (dailyCustomersRaw === undefined && avgTicket !== undefined && avgTicket > 0) {
    dailyCustomersRaw = values.daily_revenue / avgTicket
  }
  // 截流修正后客流：财务模型已按点位截流力把营收 ×1.1 等，这里同步还原，
  // 否则「原始 240 人」与「空间模块 264 人」会对不上，读者以为算错
  const catchmentMult = catchmentOf(catchmentCode)?.multiplier ?? 1
  const dailyCustomers = dailyCustomersRaw !== undefined ? dailyCustomersRaw * catchmentMult : undefined

  const seatsValue = seats ?? -1
  const seatsKnown = seatsValue > 0
  const turnover = seatsKnown && dailyCustomers !== undefined && dailyCustomers > 0
    ? dailyCustomers / seatsValue
    : undefined
  // 容量利用率：分母是「座位数 × 业态翻台上限」，不是「座位数 × 常规翻台」，
  // 所以它与翻台率不是一回事，报告里必须写全名，不能简称「利用率」并排放在翻台率旁
  const capacityCustomers = seatsKnown ? seatsValue * preset.turnoverCap : 0
  const utilization = capacityCustomers > 0 && dailyCustomers !== undefined
    ? (dailyCustomers / capacityCustomers) * 100
    : undefined
  const utilizationBasis = `座位数 ${seatsValue} × 业态翻台上限 ${preset.turnoverCap}`

  const revenuePerSqm = monthlyRevenue / area
  const investmentPerSqm = values.initial_investment / area

  // ── 门槛翻台率：三个口径必须同税后贡献率，否则「目标翻台」会比「保本翻台」更宽松，两列不可比 ──
  // 贡献率 = 毛利率 − 税率（保本公式 revenue ×(gm − tax) = fixed 的同一条线）
  const monthlyFixed = values.monthly_rent + values.monthly_labor + values.monthly_other_fixed
  const contribRate = values.gross_margin - values.tax_rate
  const paybackMonths = targetPaybackMonths > 0 ? targetPaybackMonths : 24
  const amortMonthly = values.amortization_months > 0
    ? values.initial_investment / values.amortization_months
    : 0
  const investSlice = values.initial_investment / paybackMonths

  // 现金流口径：营收×贡献率 − 固定 = 投资/回本月
  const requiredMonthlyRevenueCash =
    contribRate > 0 ? (investSlice + monthlyFixed) / contribRate : 0
  // 会计口径：再扣月摊销（即「月净利 = 投资/回本月」）
  // 业务口语说的「X 个月回本」通常指会计口径 —— 主结论用这条
  const requiredMonthlyRevenueAcct =
    contribRate > 0 ? (investSlice + monthlyFixed + amortMonthly) / contribRate : 0

  const targetDailyRevenue = requiredMonthlyRevenueAcct / 30
  const targetDailyRevenueCash = requiredMonthlyRevenueCash / 30
  const ticketUsable = avgTicket !== undefined && avgTicket > 0
  const breakevenTurnover =
    seatsKnown && ticketUsable ? breakevenDaily / avgTicket! / seatsValue : undefined
  const targetTurnover =
    seatsKnown && ticketUsable && targetDailyRevenue > 0
      ? targetDailyRevenue / avgTicket! / seatsValue
      : undefined
  const targetTurnoverCash =
    seatsKnown && ticketUsable && targetDailyRevenueCash > 0
      ? targetDailyRevenueCash / avgTicket! / seatsValue
      : undefined
  const targetWithinCapacity = targetTurnover !== undefined ? targetTurnover <= preset.turnoverCap : false

  // 桌口径（行业口语常用）与输入自洽性校验
  let tableSize = readNum('table_size') ?? tableSizeOverride
  if (tableSize === undefined) {
    tableSize = DEFAULT_TABLE_SIZE
    defaultsUsed.push(`table_size=${DEFAULT_TABLE_SIZE}`)
  }
  const tablesInput = readNum('tables')
  const tables = tablesInput ?? (seatsKnown && tableSize > 0 ? Math.floor(seatsValue / tableSize) : -1)
  // 桌口径：桌翻台 = (客流 ÷ 桌均人数) ÷ 桌数 = 桌次 ÷ 桌数。
  // 注意：桌均人数与座位/桌数一致时，它与座翻台在数学上相等；
  // 只有「实际每桌坐不满」或「给了真实桌数（与 座位÷桌均人数 不符）」时才会分叉。
  const turnoverTables =
    tables > 0 && dailyCustomers !== undefined && tableSize > 0
      ? dailyCustomers / tableSize / tables
      : undefined
  const impliedDailyNormal = seatsKnown && ticketUsable ? seatsValue * preset.normalTurnover * avgTicket! : -1
  const revenueVsNormal = impliedDailyNormal > 0 ? values.daily_revenue / impliedDailyNormal : -1
  let consistency: SpaceModel['input_consistency'] = 'ok'
  if (turnover !== undefined && preset.turnoverCap > 0 && turnover > preset.turnoverCap) {
    consistency = 'turnover_impossible'
  } else if (revenueVsNormal >= 0 && revenueVsNormal < 0.4) {
    consistency = 'revenue_too_low'
  }

  const turnoverGrade = gradeTurnoverRisk(formatCode, turnover)
  // 客单价区间与翻台基准同源：成对校验，避免「业态标签贴错、整套判读跑偏」
  const ticketRange = bandTicketRange(formatCode, preset.ticketMin, preset.ticketMax)

  // 客单价 ↔ 业态标签一致性：茶楼（只喝茶吃点心，50~110 元）与正餐（有菜有酒，150~400 元）不能混
  const formatLabel = suggestTargetPayback(formatCode).label
  const ticketMatches = avgTicket === undefined
    ? true
    : avgTicket >= ticketRange.min && avgTicket <= ticketRange.max
  const ticketNote = ticketMatches || avgTicket === undefined
    ? ''
    : `客单价 ${Math.round(avgTicket)} 元不在「${formatLabel}」的典型区间 ${preset.ticketMin}~${preset.ticketMax} 元：`
      + `茶楼只喝茶吃点心（客单低、翻台高），正餐有菜有酒（客单高、翻台低），两者产能基准不同，先确认业态归类再算`

  if (!ticketMatches) warnings.push(ticketNote)
  if (utilization !== undefined && utilization > 95) {
    warnings.push(`容量利用率 ${utilization.toFixed(0)}%：营收假设已接近座位上限，要再增长只能加面积或提客单`)
  }
  if (consistency === 'turnover_impossible' && turnover !== undefined) {
    warnings.push(
      `翻台率 ${turnover.toFixed(2)} 次/日 超过该业态上限 ${preset.turnoverCap}：物理上不可能，`
      + `营收、客单价、座位数至少有一个是错的`,
    )
  } else if (consistency === 'revenue_too_low') {
    warnings.push(
      `营收假设 ${Math.round(values.daily_revenue)} 元/日，仅为该面积常规产能（${Math.round(impliedDailyNormal)} 元/日）的 `
      + `${(revenueVsNormal * 100).toFixed(1)}%：**面积与营收严重不匹配**——要么营收估低了，要么面积选大了，先核这一个再谈别的`,
    )
  } else if (turnover !== undefined && preset.normalTurnover > 0 && turnover < preset.normalTurnover * 0.6) {
    warnings.push(`翻台率 ${turnover.toFixed(2)} 次/日，低于该业态常规 ${preset.normalTurnover}：营收偏保守或面积偏大`)
  }
  if (revenuePerSqm < preset.revenuePerSqmBenchmark * 0.6) {
    warnings.push(`坪效 ${revenuePerSqm.toFixed(0)} 元/㎡/月，低于该业态经验基准 ${preset.revenuePerSqmBenchmark}：面积利用率偏低`)
  }
  if (targetTurnover !== undefined && !targetWithinCapacity) {
    warnings.push(
      `按当前租金与面积，达到 ${targetPaybackMonths} 个月回本需 ${targetTurnover.toFixed(2)} 次/日翻台，`
      + `超过该业态上限 ${preset.turnoverCap}：这个「面积 × 租金」组合做不出来`,
    )
  }

  return {
    available: true,
    note: '',
    area_sqm: roundTo(area, 2),
    kitchen_ratio: roundTo(kitchenRatio, 4),
    kitchen_area_sqm: roundTo(kitchenArea, 2),
    operating_area_sqm: roundTo(operatingArea, 2),
    seats: seatsKnown ? seatsValue : -1,
    seat_source: seatSource,
    seat_area_sqm: seatAreaSqm !== undefined && seatAreaSqm > 0 ? roundTo(seatAreaSqm, 2) : -1,
    avg_ticket: avgTicket !== undefined ? roundTo(avgTicket, 2) : -1,
    daily_customers: dailyCustomers !== undefined ? roundTo(dailyCustomers, 1) : -1,
    turnover_per_day: turnover !== undefined ? roundTo(turnover, 3) : -1,
    breakeven_turnover_per_day: breakevenTurnover !== undefined ? roundTo(breakevenTurnover, 2) : -1,
    target_turnover_per_day: targetTurnover !== undefined ? roundTo(targetTurnover, 2) : -1,
    target_daily_revenue: targetDailyRevenue > 0 ? roundTo(targetDailyRevenue, 2) : -1,
    target_within_capacity: targetWithinCapacity,
    target_payback_months: targetPaybackMonths,
    turnover_cap_per_day: preset.turnoverCap,
    normal_turnover_per_day: preset.normalTurnover,
    tables,
    table_size: tableSize,
    turnover_tables_per_day: turnoverTables !== undefined ? roundTo(turnoverTables, 2) : -1,
    implied_daily_revenue_normal: impliedDailyNormal > 0 ? roundTo(impliedDailyNormal, 2) : -1,
    revenue_vs_normal_ratio: revenueVsNormal >= 0 ? roundTo(revenueVsNormal, 4) : -1,
    input_consistency: consistency,
    typical_ticket_min: ticketRange.min,
    typical_ticket_max: ticketRange.max,
    ticket_matches_format: ticketMatches,
    ticket_note: ticketNote,
    capacity_customers_per_day: roundTo(capacityCustomers, 1),
    utilization_pct: utilization !== undefined ? roundTo(utilization, 1) : -1,
    utilization_basis: utilizationBasis,
    daily_customers_raw: dailyCustomersRaw !== undefined ? roundTo(dailyCustomersRaw, 1) : -1,
    catchment_multiplier: catchmentMult,
    target_daily_revenue_cash: targetDailyRevenueCash > 0 ? roundTo(targetDailyRevenueCash, 2) : -1,
    target_turnover_cash_per_day: targetTurnoverCash !== undefined ? roundTo(targetTurnoverCash, 2) : -1,
    turnover_risk: turnoverGrade.risk,
    turnover_risk_note: turnoverGrade.note,
    ...(turnoverGrade.band === null ? {} : {
      turnover_band: {
        alert_below: turnoverGrade.band.alertBelow,
        warn_low: turnoverGrade.band.warnLow,
        warn_high: turnoverGrade.band.warnHigh,
        normal_low: turnoverGrade.band.normalLow,
        normal_high: turnoverGrade.band.normalHigh,
        max_real: turnoverGrade.band.maxReal,
        label: turnoverGrade.band.label,
      },
    }),
    revenue_per_sqm_month: roundTo(revenuePerSqm, 2),
    revenue_per_sqm_benchmark: preset.revenuePerSqmBenchmark,
    breakeven_revenue_monthly: roundTo(breakevenDaily * 30, 2),
    breakeven_customers_daily: avgTicket !== undefined && avgTicket > 0 ? roundTo(breakevenDaily / avgTicket, 1) : -1,
    investment_per_sqm: roundTo(investmentPerSqm, 2),
    warnings,
    defaults_used: defaultsUsed,
  }
}

/** 执行全量测算，返回规范结果。 */
/** 假设台账的一行：本次测算里「不是你亲口给的数」。 */
export interface LedgerRow {
  /** 分类：财务参数 / 缺省值 / 空间系数 / 租期系数 / 覆盖 */
  category: string
  /** 参数名 */
  item: string
  /** 本次实际取值（数字或文字） */
  value: string
  /** 来源：调用方提供 / 业态默认 / 内置默认 / 参数文件 / 推算 */
  source: string
  /** 建议动作：可直接用 / 建议核实 / 必须补 / 可按项目特征校准 */
  action: string
}

/** 敏感度一行：把某个参数上下扰动 20%，看结论会不会翻。 */
export interface SensitivityRow {
  param: string
  delta_pct: number
  anchor_low: number
  anchor_base: number
  anchor_high: number
  /** 当前租金相对锚点的差（正=租金偏高） */
  gap_base: number
  /** 扰动后「租金是否高于锚点」这个结论是否翻转 */
  conclusion_flips: boolean
}

/** 空间侧敏感度一行：扰动空间系数后，座位数、应有日营收、自洽性怎么变。 */
export interface SpaceSensitivityRow {
  param: string
  delta_pct: number
  seats_low: number
  seats_base: number
  seats_high: number
  implied_revenue_low: number
  implied_revenue_base: number
  implied_revenue_high: number
  /** 当前营收 ÷ 应有日营收（基准） */
  ratio_base: number
  /** 扰动后，「面积与营收是否自洽（占比 ≥40%）」的结论是否翻转 */
  consistency_flips: boolean
  note: string
}

/**
 * 业态合理性区间（比值口径）。
 *
 * 用途：**不依赖任何外部抓取数据**，靠内部比值互锁，发现「人力估低了 / 投入估低了 /
 * 毛利不合行规」这类参数错误——外部点评数据可刷、房价有偏，但内部比值编不出来。
 *
 * 各业态差异极大，全部可经 overrides 覆盖：
 *   gross_margin_min/max、labor_ratio_min/max、investment_per_sqm_min/max
 */
const RATIO_BENCHMARKS: ReadonlyArray<{
  match: RegExp
  grossMargin: readonly [number, number]
  laborRatio: readonly [number, number]
  investmentPerSqm: readonly [number, number]
}> = [
  { match: /tea_drink|milk_tea|奶茶|茶饮|咖啡/, grossMargin: [0.55, 0.72], laborRatio: [0.15, 0.25], investmentPerSqm: [3000, 6000] },
  { match: /convenience|便利店/, grossMargin: [0.20, 0.32], laborRatio: [0.08, 0.15], investmentPerSqm: [2000, 4000] },
  { match: /fast_food|fastfood|快餐|粉面|小吃/, grossMargin: [0.55, 0.68], laborRatio: [0.15, 0.22], investmentPerSqm: [2500, 4500] },
  { match: /tea_house|yumcha|早茶|茶楼|茶居|点心/, grossMargin: [0.58, 0.70], laborRatio: [0.22, 0.30], investmentPerSqm: [3500, 5500] },
  { match: /large_dining|large_yuecai|large_|酒楼|正餐大店|宴会/, grossMargin: [0.55, 0.65], laborRatio: [0.22, 0.30], investmentPerSqm: [3500, 5000] },
  { match: /mid_dining|dinner|正餐|餐厅/, grossMargin: [0.55, 0.65], laborRatio: [0.20, 0.28], investmentPerSqm: [3000, 4500] },
]

const RATIO_BENCHMARKS_FALLBACK = {
  grossMargin: [0.5, 0.7] as readonly [number, number],
  laborRatio: [0.18, 0.28] as readonly [number, number],
  investmentPerSqm: [3000, 5000] as readonly [number, number],
}

/** 一条比值校验结果。 */
export type RatioStatus = RatioCheck['status']

interface RatioCheck {
  item: string
  value: number
  unit: string
  healthy_min: number
  healthy_max: number
  /** 仅租售比使用：警戒线上限；健康线以内 ok，健康线~警戒线 watch，超警戒线 breach */
  warning_max?: number
  status: 'ok' | 'low' | 'high' | 'watch' | 'breach'
  note: string
}

/** 落在区间哪一侧。 */
function judgeRatio(value: number, lo: number, hi: number): 'ok' | 'low' | 'high' {
  if (value < lo) return 'low'
  if (value > hi) return 'high'
  return 'ok'
}

/** 内部比值校验：只用已录入参数互相验证，不抓任何外部数据。 */
function buildRatioChecks(
  values: FinancialParams,
  formatCode: string,
  areaSqm: number | undefined,
  overridesRaw: Record<string, unknown> | undefined,
): RatioCheck[] {
  const base = RATIO_BENCHMARKS.find((item) => item.match.test(formatCode)) ?? RATIO_BENCHMARKS_FALLBACK
  const pick = (key: string, fallback: number): number => overrideNumber(overridesRaw, key) ?? fallback
  const gmMin = pick('gross_margin_min', base.grossMargin[0])
  const gmMax = pick('gross_margin_max', base.grossMargin[1])
  const lrMin = pick('labor_ratio_min', base.laborRatio[0])
  const lrMax = pick('labor_ratio_max', base.laborRatio[1])
  const ipMin = pick('investment_per_sqm_min', base.investmentPerSqm[0])
  const ipMax = pick('investment_per_sqm_max', base.investmentPerSqm[1])

  const monthlyRevenue = values.daily_revenue * 30
  const checks: RatioCheck[] = []

  const gmStatus = judgeRatio(values.gross_margin, gmMin, gmMax)
  checks.push({
    item: '毛利率',
    value: roundTo(values.gross_margin * 100, 1),
    unit: '%',
    healthy_min: roundTo(gmMin * 100, 1),
    healthy_max: roundTo(gmMax * 100, 1),
    status: gmStatus,
    note: gmStatus === 'high'
      ? '高于该业态常规：可能没扣折扣、赠送、损耗，实际毛利会低'
      : gmStatus === 'low'
        ? '低于该业态常规：成本结构偏重或客单偏低'
        : '在常规区间内',
  })

  const laborRatio = monthlyRevenue > 0 ? values.monthly_labor / monthlyRevenue : 0
  const lrStatus = judgeRatio(laborRatio, lrMin, lrMax)
  checks.push({
    item: '人力占营收',
    value: roundTo(laborRatio * 100, 1),
    unit: '%',
    healthy_min: roundTo(lrMin * 100, 1),
    healthy_max: roundTo(lrMax * 100, 1),
    status: lrStatus,
    note: lrStatus === 'low'
      ? `低于该业态常规：人力大概率估少了——按 ${roundTo(lrMin * 100, 0)}% 反推应为 ${Math.round((monthlyRevenue * lrMin) / 10000)} 万/月`
      : lrStatus === 'high'
        ? '高于该业态常规：人效偏低，或营收估得偏高'
        : '在常规区间内',
  })

  const rentLine = rentRatioLineFor(formatCode)
  const rentRatio = monthlyRevenue > 0 ? values.monthly_rent / monthlyRevenue : 0
  // 三档：健康线以内 ok；健康线~警戒线 watch（偏高）；超警戒线 breach（破线）
  // 必须与 recommendation.rent_ratio_verdict 口径一致，否则报告里同一指标两个结论
  const rrStatus: RatioStatus = rentRatio <= rentLine.healthyMax
    ? 'ok'
    : rentRatio <= rentLine.warningMax ? 'watch' : 'breach'
  checks.push({
    item: '租售比',
    value: roundTo(rentRatio * 100, 1),
    unit: '%',
    healthy_min: 0,
    healthy_max: roundTo(rentLine.healthyMax * 100, 1),
    warning_max: roundTo(rentLine.warningMax * 100, 1),
    status: rrStatus,
    note: rrStatus === 'ok'
      ? `未超健康线 ${roundTo(rentLine.healthyMax * 100, 1)}%`
      : rrStatus === 'watch'
        ? `超健康线 ${roundTo(rentLine.healthyMax * 100, 1)}%，未破警戒线 ${roundTo(rentLine.warningMax * 100, 1)}%`
        : `已破警戒线 ${roundTo(rentLine.warningMax * 100, 1)}%`,
  })

  if (areaSqm !== undefined && areaSqm > 0) {
    const perSqm = values.initial_investment / areaSqm
    const ipStatus = judgeRatio(perSqm, ipMin, ipMax)
    checks.push({
      item: '单方造价',
      value: roundTo(perSqm, 0),
      unit: '元/㎡',
      healthy_min: ipMin,
      healthy_max: ipMax,
      status: ipStatus,
      note: ipStatus === 'low'
        ? `低于该业态常规：初始投入大概率漏项——按 ${ipMin} 元/㎡ 反推应为 ${Math.round((areaSqm * ipMin) / 10000)} 万`
        : ipStatus === 'high'
          ? '高于该业态常规：确认是否含转让费、押金等一次性支出'
          : '在常规区间内',
    })
  }

  return checks
}

/** 一条计算口径记录：公式 + 本次代入的数值 + 结果。 */
export interface FormulaRow {
  /** 指标名 */
  metric: string
  /** 计算口径（公式） */
  formula: string
  /** 本次代入的实际数值 */
  substituted: string
  /** 算出来的结果 */
  result: string
  /** 分组：财务 / 租金 / 空间 / 比率 */
  group: string
}

/** 从 overrides 里取数值；支持数字与数字字符串，非法值一律当作未提供。 */
function overrideNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  if (source === undefined) return undefined
  const raw = source[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return undefined
}

/** 允许被 overrides 覆盖的键（其余键忽略，避免拼错却静默生效）。 */
export const OVERRIDABLE_KEYS: readonly string[] = [
  'payback_months',
  'rent_ratio_healthy_max',
  'rent_ratio_warning_max',
  'kitchen_ratio',
  'seat_area_sqm',
  'normal_turnover',
  'turnover_cap',
  'table_size',
  'revenue_per_sqm_benchmark',
  'typical_ticket_min',
  'typical_ticket_max',
  'gross_margin_min',
  'gross_margin_max',
  'labor_ratio_min',
  'labor_ratio_max',
  'investment_per_sqm_min',
  'investment_per_sqm_max',
  'tax_rate',
  'amortization_months',
  'term_years',
  'rent_escalation_pct',
  'renovation_cycle_years',
  'renovation_cost_ratio',
  'param_version',
  'param_source',
]

function runFinancials(
  formatCode: string,
  rawParams: Record<string, unknown>,
  scenarios: readonly ScenarioKey[] | undefined,
  targetPaybackMonths: number | undefined,
  areaSqm: number | undefined,
  leaseRaw: Record<string, unknown> | undefined,
  spaceRaw: Record<string, unknown> | undefined,
  overridesRaw: Record<string, unknown> | undefined,
  catchmentLevel?: string,
): FinancialCalcResult {
  const { values, defaulted, lowConfidence } = resolveParams(formatCode, rawParams)

  // 点位截流力：把「行业常规客流」调成「这个点位实际能拿到的客流」。
  // 只在调用方显式给出等级时生效——客户已给实测营业额的话不要再乘一次。
  const catchment = catchmentOf(catchmentLevel)
  const rawDailyRevenue = values.daily_revenue
  if (catchment !== undefined && catchment.multiplier !== 1) {
    values.daily_revenue = roundTo(values.daily_revenue * catchment.multiplier, 2)
  }

  const requested = normalizeScenarios(scenarios)
  const targetExplicit =
    targetPaybackMonths !== undefined && Number.isFinite(targetPaybackMonths) && targetPaybackMonths > 0
  // 目标回本周期：调用方显式指定 > 参数文件覆盖 > 业态内置默认
  const overridePayback = overrideNumber(overridesRaw, 'payback_months')
  const target = targetExplicit
    ? targetPaybackMonths!
    : (overridePayback ?? suggestTargetPayback(formatCode).months)
  const perScenario: Partial<Record<ScenarioKey, ScenarioResult>> = {}
  for (const key of requested) {
    perScenario[key] = computeScenario(values, key, target)
  }

  // 极限租金汇总：优先基准档；未请求基准档时退回到第一个请求的情景
  // normalizeScenarios 保证 requested 非空，故 ceilingScenario 必然存在
  const ceilingKey: ScenarioKey = perScenario.base !== undefined ? 'base' : requested[0]!
  const ceilingScenario = perScenario[ceilingKey]!
  const rentCeiling: RentCeiling = {
    scenario: ceilingKey,
    target_payback_months: target,
    rent_ceiling_breakeven: ceilingScenario.max_rent_breakeven,
    rent_ceiling_at_target: ceilingScenario.max_rent_target,
    current_rent: roundTo(values.monthly_rent, 2),
    above_ceiling_at_target: roundTo(values.monthly_rent - ceilingScenario.max_rent_target, 2),
    above_ceiling_at_breakeven: roundTo(values.monthly_rent - ceilingScenario.max_rent_breakeven, 2),
  }

  // 建议租金：谈判锚点取**基准档** —— 压力测试键不能拿来当出价（拿最坏情况谈不成），
  // 否则一遇到「营收 -15%、成本 +5%」的悲观情景就全盘推翻。
  const computed = requested.map((key) => ({ key, result: perScenario[key]! }))
  // 锚点按基准档：除非没算基准档，才退回首个情景
  let anchorScenario = computed.find((item) => item.key === 'base') ?? computed[0]!
  // 红线与压力下限仍取全档最保守
  const baseScenario = computed.find((item) => item.key === 'base') ?? computed[0]!
  let anchorScenarioWorst = computed[0]!
  let ceilingScenarioWorst = computed[0]!
  for (const item of computed) {
    if (item.result.max_rent_target < anchorScenarioWorst.result.max_rent_target) anchorScenarioWorst = item
    if (item.result.max_rent_breakeven < ceilingScenarioWorst.result.max_rent_breakeven) {
      ceilingScenarioWorst = item
    }
  }
  const baseRevenue = perScenario.base?.revenue ?? computed[0]!.result.revenue
  const currentRentRatio = baseRevenue > 0 ? values.monthly_rent / baseRevenue : 0
  const ratioLineBase = rentRatioLineFor(formatCode)
  const ovHealthy = overrideNumber(overridesRaw, 'rent_ratio_healthy_max')
  const ovWarning = overrideNumber(overridesRaw, 'rent_ratio_warning_max')
  const ratioLine = {
    healthyMax: ovHealthy ?? ratioLineBase.healthyMax,
    warningMax: ovWarning ?? ratioLineBase.warningMax,
    label: ratioLineBase.label + (ovHealthy !== undefined || ovWarning !== undefined ? '（参数覆盖）' : ''),
  }
  const ratioVerdict: RentRecommendation['rent_ratio_verdict'] =
    currentRentRatio > ratioLine.warningMax
      ? 'breach'
      : currentRentRatio > ratioLine.healthyMax
        ? 'watch'
        : 'healthy'
  const asPct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const rentRatioHint =
    ratioVerdict === 'healthy'
      ? `${ratioLine.label}经验健康线 ≤${asPct(ratioLine.healthyMax)}；当前 ${asPct(currentRentRatio)}，在健康区间内`
      : ratioVerdict === 'watch'
        ? `${ratioLine.label}经验健康线 ≤${asPct(ratioLine.healthyMax)}；当前 ${asPct(currentRentRatio)}，`
          + `高出健康线 ${((currentRentRatio - ratioLine.healthyMax) * 100).toFixed(1)} 个百分点，尚未破警戒线 ${asPct(ratioLine.warningMax)}`
        : `${ratioLine.label}经验健康线 ≤${asPct(ratioLine.healthyMax)}，警戒线 ${asPct(ratioLine.warningMax)}；`
          + `当前 ${asPct(currentRentRatio)}，超警戒线 ${((currentRentRatio - ratioLine.warningMax) * 100).toFixed(1)} 个百分点`
  const recommendation: RentRecommendation = {
    target_rent: anchorScenario.result.max_rent_target,
    target_rent_conservative: anchorScenarioWorst.result.max_rent_target,
    conservative_scenario: anchorScenarioWorst.key,
    ceiling_rent: baseScenario.result.max_rent_breakeven,
    ceiling_rent_conservative: ceilingScenarioWorst.result.max_rent_breakeven,
    gap_to_target: roundTo(values.monthly_rent - anchorScenario.result.max_rent_target, 2),
    // 租金安全余量（元/月）= 锚点 − 当前租金；正数=还有空间，负数=需下调
    rent_headroom: roundTo(anchorScenario.result.max_rent_target - values.monthly_rent, 2),
    // 余量占锚点比例：当前 12 万、锚点 23.08 万 → 余量 11.08 万、占锚点 48%
    rent_headroom_pct: anchorScenario.result.max_rent_target > 0
      ? roundTo((anchorScenario.result.max_rent_target - values.monthly_rent) / anchorScenario.result.max_rent_target, 4)
      : 0,
    rent_vs_anchor_pct: anchorScenario.result.max_rent_target > 0
      ? roundTo(values.monthly_rent / anchorScenario.result.max_rent_target, 4)
      : 0,
    gap_to_ceiling: roundTo(values.monthly_rent - baseScenario.result.max_rent_breakeven, 2),
    based_on_scenario: anchorScenario.key,
    current_rent_ratio: roundTo(currentRentRatio, 4),
    rent_ratio_healthy_max: ratioLine.healthyMax,
    rent_ratio_warning_max: ratioLine.warningMax,
    rent_ratio_label: ratioLine.label,
    rent_ratio_verdict: ratioVerdict,
    rent_ratio_hint: rentRatioHint,
    anchor_unreachable: anchorScenario.result.max_rent_target < 0,
  }

  const leaseModel = simulateLease(
    values,
    areaSqm,
    {
      term_years: overrideNumber(overridesRaw, 'term_years'),
      rent_escalation_pct: overrideNumber(overridesRaw, 'rent_escalation_pct'),
      renovation_cycle_years: overrideNumber(overridesRaw, 'renovation_cycle_years'),
      renovation_cost_ratio: overrideNumber(overridesRaw, 'renovation_cost_ratio'),
      ...(leaseRaw ?? {}),
    },
    target,
    formatCode,
    targetExplicit,
  )
  const spaceModel = buildSpaceModel(
    values,
    formatCode,
    areaSqm,
    spaceRaw,
    perScenario.base?.breakeven_revenue_daily ?? computed[0]!.result.breakeven_revenue_daily,
    target,
    overridesRaw,
    catchmentLevel,
  )

  const appliedOverrides = overridesRaw === undefined
    ? []
    : Object.keys(overridesRaw).filter((key) => OVERRIDABLE_KEYS.includes(key))

  // ---- 假设台账：把所有「不是调用方亲口给的数」摊在桌面上 ----
  const providedParams = normalizeParams(rawParams)
  const ledger: LedgerRow[] = []
  for (const key of PARAM_KEYS) {
    const entry = providedParams.get(key)
    const isPolicy = POLICY_PARAM_KEYS.includes(key)
    if (entry === undefined) {
      ledger.push({
        category: isPolicy ? '口径' : '财务参数',
        item: key,
        value: String(roundTo(values[key], 4)),
        source: isPolicy ? '内置口径（政策默认）' : '业态默认（未提供）',
        action: isPolicy
          ? '可按实际税负 / 折旧年限校准'
          : '必须补实际值，否则结论无意义',
      })
      continue
    }
    const low = lowConfidence.includes(key)
    ledger.push({
      category: '财务参数',
      item: key,
      value: String(roundTo(values[key], 4)),
      source: entry.source,
      action: low ? '建议核实（置信度低）' : '可直接用',
    })
  }
  const parseDefault = (raw: string): { item: string; value: string } => {
    const idx = raw.indexOf('=')
    return idx > 0
      ? { item: raw.slice(0, idx), value: raw.slice(idx + 1) }
      : { item: raw, value: '—' }
  }
  for (const raw of leaseModel.defaults_used) {
    const { item, value } = parseDefault(raw)
    ledger.push({ category: '租期系数', item, value, source: '内置默认', action: '可按合同实际校准' })
  }
  for (const raw of spaceModel.defaults_used) {
    const { item, value } = parseDefault(raw)
    ledger.push({ category: '空间系数', item, value, source: '内置默认', action: '可按项目特征校准' })
  }
  for (const key of appliedOverrides) {
    const raw = overridesRaw?.[key]
    ledger.push({
      category: '参数覆盖',
      item: key,
      value: typeof raw === 'number' ? String(raw) : String(raw ?? '见参数文件'),
      source: typeof overridesRaw?.param_version === 'string' ? overridesRaw.param_version : '调用方覆盖',
      action: '已按覆盖值生效',
    })
  }
  if (!targetExplicit && overrideNumber(overridesRaw, 'payback_months') === undefined) {
    ledger.push({
      category: '口径',
      item: '目标回本周期',
      value: `${target} 个月`,
      source: '业态内置默认',
      action: '可按客户实际要求校准',
    })
  }

  // ---- 敏感度：把关键参数各扰动 ±20%，看「租金是否高于锚点」这个结论会不会翻 ----
  const anchorOf = (v: FinancialParams): number => computeScenario(v, 'pessimistic', target).max_rent_target
  const baseAnchor = anchorOf(values)
  const rentNow = values.monthly_rent
  const baseSign = Math.sign(baseAnchor - rentNow)
  const sensitivity: SensitivityRow[] = (
    [
      // 只放「输入侧不确定的量」；月租金是结论的对象，不是锚点的输入，放进来会误导
      ['daily_revenue', '日营业额'],
      ['gross_margin', '毛利率'],
      ['monthly_labor', '人力成本'],
      ['initial_investment', '初始投入'],
    ] as ReadonlyArray<readonly [ParamKey, string]>
  ).map(([key, label]) => {
    const lowValue = anchorOf({ ...values, [key]: values[key] * 0.8 })
    const highValue = anchorOf({ ...values, [key]: values[key] * 1.2 })
    return {
      param: label,
      delta_pct: 20,
      anchor_low: roundTo(lowValue, 2),
      anchor_base: roundTo(baseAnchor, 2),
      anchor_high: roundTo(highValue, 2),
      gap_base: roundTo(rentNow - baseAnchor, 2),
      conclusion_flips:
        Math.sign(lowValue - rentNow) !== baseSign || Math.sign(highValue - rentNow) !== baseSign,
    }
  })

  // ---- 空间侧敏感度：扰动座位密度/厨房占比/翻台基准，看座位数与应有产能怎么变 ----
  const spaceSensitivity: SpaceSensitivityRow[] = []
  if (
    spaceModel.available
    && spaceModel.seats > 0
    && spaceModel.avg_ticket > 0
    && spaceModel.normal_turnover_per_day > 0
  ) {
    const ticket = spaceModel.avg_ticket
    const norm = spaceModel.normal_turnover_per_day
    const dailyRev = values.daily_revenue
    const baseSeats = spaceModel.seats
    const opsArea = spaceModel.operating_area_sqm
    const seatArea = spaceModel.seat_area_sqm
    const grossArea = spaceModel.area_sqm
    const kitchenRatio = spaceModel.kitchen_ratio
    const ratioOf = (seats: number, turnover: number): number =>
      seats > 0 && turnover > 0 && ticket > 0 ? dailyRev / (seats * turnover * ticket) : -1
    const baseRatio = ratioOf(baseSeats, norm)
    const baseOk = baseRatio >= 0.4
    const pushRow = (
      param: string,
      seatsAtLow: number,
      seatsAtHigh: number,
      turnoverAtLow: number,
      turnoverAtHigh: number,
      note: string,
    ): void => {
      const implied = (seats: number, turnover: number): number => seats * turnover * ticket
      const ratioLow = ratioOf(seatsAtLow, turnoverAtLow)
      const ratioHigh = ratioOf(seatsAtHigh, turnoverAtHigh)
      spaceSensitivity.push({
        param,
        delta_pct: 20,
        seats_low: seatsAtLow,
        seats_base: baseSeats,
        seats_high: seatsAtHigh,
        implied_revenue_low: roundTo(implied(seatsAtLow, turnoverAtLow), 2),
        implied_revenue_base: roundTo(implied(baseSeats, norm), 2),
        implied_revenue_high: roundTo(implied(seatsAtHigh, turnoverAtHigh), 2),
        ratio_base: roundTo(baseRatio, 4),
        consistency_flips: (ratioLow >= 0.4) !== baseOk || (ratioHigh >= 0.4) !== baseOk,
        note,
      })
    }
    if (seatArea > 0) {
      // 每座面积 −20% → 同样面积能摆更多座位；+20% → 座位更少
      pushRow(
        '每座面积',
        Math.floor(opsArea / (seatArea * 0.8)),
        Math.floor(opsArea / (seatArea * 1.2)),
        norm,
        norm,
        '参数 −20% → 每座更省面积、座位更多；+20% → 座位更少',
      )
    }
    if (seatArea > 0 && kitchenRatio > 0 && kitchenRatio < 1) {
      // 厨房占比 −20% → 厨房更小、营业面积更大、座位更多
      pushRow(
        '厨房占比',
        Math.floor((grossArea * (1 - kitchenRatio * 0.8)) / seatArea),
        Math.floor((grossArea * (1 - kitchenRatio * 1.2)) / seatArea),
        norm,
        norm,
        '参数 −20% → 厨房更小、营业面积更大、座位更多；+20% → 反之',
      )
    }
    pushRow('常规翻台', baseSeats, baseSeats, norm * 0.8, norm * 1.2, '座位不变，只改翻台基准')
  }

  // ---- 计算口径台账：公式 + 本次代入值 + 结果 ----
  // 目的：参数搞乱时能一眼看出「哪个数进了哪个公式、算出了什么」，
  // 而不是只看到结果却不知道它怎么来的。
  const n2 = (n: number): string => String(roundTo(n, 2))
  const pc = (n: number): string => `${roundTo(n * 100, 1)}%`
  // 台账必须与「财务测算·基准档」用同一个营业额口径。
  // 基准档 = 原始日营业额 × 截流系数 × 情景系数(1.0)，若这里用 values.daily_revenue × 30，
  // 台账会显示 108 万而财务表显示 118.8 万，同一份报告出现两个「月营业额」。
  const monthlyRevenueV = perScenario.base?.revenue
    ?? values.daily_revenue * 30 * (catchmentOf(catchmentLevel)?.multiplier ?? 1)
  const grossProfitV = monthlyRevenueV * values.gross_margin
  const fixedCostV = values.monthly_rent + values.monthly_labor + values.monthly_other_fixed
  const taxV = monthlyRevenueV * values.tax_rate
  const amortV = values.amortization_months > 0 ? values.initial_investment / values.amortization_months : 0
  const costF = SCENARIO_FACTORS.base.cost
  const baseScene = perScenario.base ?? computed[0]!.result
  const formulaTrace: FormulaRow[] = [
    { group: '财务', metric: '月营业额（基准档）', formula: '日营业额 × 截流系数 × 30', substituted: `${n2(values.daily_revenue)} × ${catchmentOf(catchmentLevel)?.multiplier ?? 1} × 30`, result: n2(monthlyRevenueV) },
    { group: '财务', metric: '月毛利', formula: '月营业额 × 毛利率', substituted: `${n2(monthlyRevenueV)} × ${values.gross_margin}`, result: n2(grossProfitV) },
    { group: '财务', metric: '月税费', formula: '月营业额 × 税费率（增值税及附加）', substituted: `${n2(monthlyRevenueV)} × ${values.tax_rate}`, result: n2(taxV) },
    { group: '财务', metric: '月摊销', formula: '初始投入 ÷ 摊销月数（装修与设备按年限摊，非现金）', substituted: `${n2(values.initial_investment)} ÷ ${values.amortization_months}`, result: n2(amortV) },
    { group: '财务', metric: '月固定成本', formula: '租金 + 人力 + 其他固定', substituted: `${n2(values.monthly_rent)} + ${n2(values.monthly_labor)} + ${n2(values.monthly_other_fixed)}`, result: n2(fixedCostV) },
    { group: '财务', metric: '月现金净流', formula: '月毛利 − 月税费 − 月固定成本（不含摊销）', substituted: `${n2(grossProfitV)} − ${n2(taxV)} − ${n2(fixedCostV)}`, result: n2(baseScene.monthly_cash_flow) },
    { group: '财务', metric: '月净利（会计）', formula: '月现金净流 − 月摊销', substituted: `${n2(baseScene.monthly_cash_flow)} − ${n2(amortV)}`, result: n2(baseScene.net_profit) },
    { group: '财务', metric: '保本日营业额', formula: '月固定成本 ÷ (毛利率 − 税费率) ÷ 30', substituted: `${n2(fixedCostV)} ÷ (${values.gross_margin} − ${values.tax_rate}) ÷ 30`, result: n2(baseScene.breakeven_revenue_daily) },
    { group: '财务', metric: '回本（现金口径·月）', formula: '初始投入 ÷ 月现金净流（现金净流≤0 记 -1）', substituted: `${n2(values.initial_investment)} ÷ ${n2(baseScene.monthly_cash_flow)}`, result: baseScene.payback_static_months > 0 ? n2(baseScene.payback_static_months) : '无法回本' },
    { group: '财务', metric: '回本（会计口径·月）', formula: '初始投入 ÷ 月净利（含摊销；与行业基准表可比）', substituted: `${n2(values.initial_investment)} ÷ ${n2(baseScene.net_profit)}`, result: baseScene.accounting_payback_months > 0 ? n2(baseScene.accounting_payback_months) : '无法回本' },
    { group: '财务', metric: '年化 ROI', formula: '月净利 × 12 ÷ 初始投入', substituted: `${n2(baseScene.net_profit)} × 12 ÷ ${n2(values.initial_investment)}`, result: pc(baseScene.roi) },
    { group: '租金', metric: '极限租金·保本', formula: '(月毛利 − 税费) ÷ 成本因子 − 人力 − 其他固定', substituted: `(${n2(grossProfitV)} − ${n2(taxV)}) ÷ ${costF} − ${n2(values.monthly_labor)} − ${n2(values.monthly_other_fixed)}`, result: n2(baseScene.max_rent_breakeven) },
    { group: '租金', metric: '极限租金·目标回本', formula: '(月毛利 − 税费 − 初始投入 ÷ 目标月数) ÷ 成本因子 − 人力 − 其他', substituted: `(${n2(grossProfitV)} − ${n2(taxV)} − ${n2(values.initial_investment)} ÷ ${target}) ÷ ${costF} − ${n2(values.monthly_labor)} − ${n2(values.monthly_other_fixed)}`, result: n2(baseScene.max_rent_target) },
      { group: '租金', metric: '建议锚点', formula: '基准档的极限租金·目标回本（保守档另列作压力下限，不参与取值）', substituted: perScenario.base !== undefined ? `base 档 = ${n2(perScenario.base.max_rent_target)}`  + (perScenario.pessimistic !== undefined     ? `；保守档 ${n2(perScenario.pessimistic.max_rent_target)} 仅作压力下限，不参与取值` : '') : '—', result: n2(recommendation.target_rent) },
    { group: '租金', metric: '租售比', formula: '月租金 ÷ 月营业额', substituted: `${n2(values.monthly_rent)} ÷ ${n2(monthlyRevenueV)}`, result: pc(recommendation.current_rent_ratio) },
    { group: '租金', metric: '租期回本（月）', formula: '租金按年递增后，累计现金首次 ≥ 0 的月份', substituted: `租期 ${leaseModel.term_years} 年，年递增 ${pc(leaseModel.rent_escalation_pct)}，首次投入 −${n2(values.initial_investment)}`, result: leaseModel.payback_month > 0 ? `${leaseModel.payback_month}` : '租期内未回本' },
    { group: '比率', metric: '人力占营收', formula: '月人力 ÷ 月营业额', substituted: `${n2(values.monthly_labor)} ÷ ${n2(monthlyRevenueV)}`, result: pc(values.monthly_labor / (monthlyRevenueV || 1)) },
  ]

  if (spaceModel.available) {
    const ticket = spaceModel.avg_ticket
    formulaTrace.push(
      { group: '空间', metric: '厨房面积', formula: '建筑面积 × 厨房占比', substituted: `${n2(spaceModel.area_sqm)} × ${spaceModel.kitchen_ratio}`, result: n2(spaceModel.kitchen_area_sqm) },
      { group: '空间', metric: '营业面积', formula: '建筑面积 − 厨房面积', substituted: `${n2(spaceModel.area_sqm)} − ${n2(spaceModel.kitchen_area_sqm)}`, result: n2(spaceModel.operating_area_sqm) },
      { group: '空间', metric: '座位数',
        // seat_area_sqm = -1 表示座位数是调研表直接给的，不能展示成「÷ -1」
        formula: spaceModel.seat_area_sqm > 0 ? '营业面积 ÷ 每座面积（向下取整）' : '由调研表直接输入',
        substituted: spaceModel.seat_area_sqm > 0 ? `${n2(spaceModel.operating_area_sqm)} ÷ ${spaceModel.seat_area_sqm}` : '调研表 seats 字段',
        result: `${spaceModel.seats}` },
      { group: '空间', metric: '日均客流', formula: '日营业额 ÷ 客单价', substituted: `${n2(values.daily_revenue)} ÷ ${ticket}`, result: `${spaceModel.daily_customers}` },
      { group: '空间', metric: '翻台率（次/日）', formula: '日均客流 ÷ 座位数', substituted: `${spaceModel.daily_customers} ÷ ${spaceModel.seats}`, result: `${spaceModel.turnover_per_day}` },
      { group: '空间', metric: '应有日营收', formula: '座位数 × 业态常规翻台 × 客单价', substituted: `${spaceModel.seats} × ${spaceModel.normal_turnover_per_day} × ${ticket}`, result: n2(spaceModel.implied_daily_revenue_normal) },
      { group: '空间', metric: '营收占比', formula: '日营业额 ÷ 应有日营收', substituted: `${n2(values.daily_revenue)} ÷ ${n2(spaceModel.implied_daily_revenue_normal)}`, result: pc(spaceModel.revenue_vs_normal_ratio) },
      { group: '空间', metric: '保本翻台率', formula: '保本日营业额 ÷ 客单价 ÷ 座位数', substituted: `${n2(baseScene.breakeven_revenue_daily)} ÷ ${ticket} ÷ ${spaceModel.seats}`, result: `${spaceModel.breakeven_turnover_per_day}` },
      { group: '空间', metric: '坪效（元/㎡/月）', formula: '月营业额 ÷ 建筑面积', substituted: `${n2(monthlyRevenueV)} ÷ ${n2(spaceModel.area_sqm)}`, result: n2(spaceModel.revenue_per_sqm_month) },
      { group: '空间', metric: '单方造价（元/㎡）', formula: '初始投入 ÷ 建筑面积', substituted: `${n2(values.initial_investment)} ÷ ${n2(spaceModel.area_sqm)}`, result: n2(spaceModel.investment_per_sqm) },
    )
  }

  return {
    per_scenario: perScenario,
    scenario_factors: SCENARIO_FACTORS_WITH_LABEL,
    low_confidence_params: lowConfidence,
    param_version: PARAM_VERSION,
    formula_version: FORMULA_VERSION,
    rent_ceiling: rentCeiling,
    recommendation,
    lease_model: leaseModel,
    space_model: spaceModel,
    param_overrides_applied: appliedOverrides,
    param_version_source: typeof overridesRaw?.param_version === 'string' ? overridesRaw.param_version : '',
    param_defaults_used: defaulted,
    assumption_ledger: ledger,
    sensitivity,
    space_sensitivity: spaceSensitivity,
    ratio_checks: buildRatioChecks(values, formatCode, areaSqm, overridesRaw),
    formula_trace: catchment !== undefined
      ? [
          {
            group: '口径',
            metric: '客流乘数',
            formula: `点位截流力 ${catchment.code}（${catchment.label}，区间 ${catchment.range}）`,
            substituted: `常规日营业额 ${n2(rawDailyRevenue)} × ${catchment.multiplier}`,
            result: n2(values.daily_revenue),
          },
          ...formulaTrace,
        ]
      : formulaTrace,
    catchment_code: catchment?.code ?? '',
    catchment_label: catchment?.label ?? '',
    catchment_multiplier: catchment?.multiplier ?? 1,
  }
}

/** 渲染所需的请求上下文。 */
interface FinancialHeader {
  store_id: string
  format_code: string
  params: Record<string, unknown>
}

/** 把测算结果渲染成模型可见文本；默认口径与低置信项在此显式披露。 */
function formatFinancialReport(header: FinancialHeader, result: FinancialCalcResult): string {
  const scenarioLabels: Record<ScenarioKey, string> = {
    base: '基准',
    pessimistic: '保守',
    optimistic: '乐观',
  }
  const lines = [
    `门店 ${header.store_id}｜业态 ${header.format_code}`
    + `｜参数版本 ${result.param_version}｜公式版本 ${result.formula_version}`,
  ]

  for (const key of SCENARIO_KEYS) {
    const scenario = result.per_scenario[key]
    if (scenario === undefined) continue
    const payback =
      scenario.payback_static_months > 0 ? `${scenario.payback_static_months} 个月` : '无法回本'
    lines.push(
      `[${scenarioLabels[key]}] 月营业额 ${scenario.revenue.toFixed(2)}`
      + `｜净利 ${scenario.net_profit.toFixed(2)}`
      + `｜年ROI ${(scenario.roi * 100).toFixed(1)}%`
      + `｜保本日营业额 ${scenario.breakeven_revenue_daily.toFixed(2)}`
      + `｜静态回本 ${payback}`,
    )
  }

  const { defaulted } = resolveParams(header.format_code, header.params)
  lines.push(
    `低置信参数：${result.low_confidence_params.length > 0 ? result.low_confidence_params.join('、') : '无'}`,
  )
  lines.push(
    `使用业态默认值：${defaulted.length > 0 ? defaulted.join('、') : '无'}`,
  )

  const ceiling = result.rent_ceiling
  const fmt = (n: number): string => n.toFixed(2)
  lines.push(
    `极限租金（${ceiling.scenario} 档｜目标回本 ${ceiling.target_payback_months} 个月）：`
    + `净利=0 上限 ${fmt(ceiling.rent_ceiling_breakeven)} 元/月`
    + `｜目标回本上限 ${fmt(ceiling.rent_ceiling_at_target)} 元/月`
    + `｜当前租金 ${fmt(ceiling.current_rent)} 元/月`,
  )
  // 负值不能拼进「需降 X 元」——读者会以为要往下砍，实际是还有余量。
  const gapWord = (v: number): string => (v > 0
    ? `需降 ${fmt(v)} 元/月`
    : `无需降，尚有余量 ${fmt(Math.abs(v))} 元/月`)
  lines.push(
    `压价空间：按目标回本口径 ${gapWord(ceiling.above_ceiling_at_target)}`
    + `｜按保本口径 ${gapWord(ceiling.above_ceiling_at_breakeven)}`,
  )

  const rec = result.recommendation
  const verdictLabel: Record<RentRecommendation['rent_ratio_verdict'], string> = {
    healthy: '健康',
    watch: '偏高',
    breach: '超红线',
  }
  lines.push(
    rec.anchor_unreachable
      ? `建议租金：**锚点不可达**——即便租金为零，${rec.based_on_scenario} 档也达不到 ${ceiling.target_payback_months} 个月回本。`
        + `问题不在租金，在营收或初始投入，必须先重核参数或改变交易结构。`
      : `建议租金：谈判锚点 ${fmt(rec.target_rent)} 元/月（取自 ${rec.based_on_scenario} 档；保守档另列作压力下限）`
        + `｜保本红线 ${fmt(rec.ceiling_rent)} 元/月`,
  )
  lines.push(
    `租售比：当前 ${(rec.current_rent_ratio * 100).toFixed(1)}%（健康线 ${(rec.rent_ratio_healthy_max * 100).toFixed(0)}%，`
    + `警戒线 ${(rec.rent_ratio_warning_max * 100).toFixed(0)}%）`
    + `→ ${verdictLabel[rec.rent_ratio_verdict]}｜距谈判锚点 `
    + (rec.anchor_unreachable
      ? '不可达（零租金也达不到目标回本）'
      : gapWord(rec.gap_to_target)),
  )
  lines.push(`租售比判读：${rec.rent_ratio_hint}`)

  const lease = result.lease_model
  const leaseVerdictLabel: Record<LeaseModel['verdict'], string> = {
    healthy: '回本充分',
    tight: '回本偏晚（>60% 租期）',
    fail: '租期内收不回投资',
  }
  lines.push(
    `租期现金流：${lease.term_years} 年｜租金年递增 ${(lease.rent_escalation_pct * 100).toFixed(1)}%`
    + `｜翻新每 ${lease.renovation_cycle_years} 年 ${fmt(lease.renovation_cost)} 元`,
  )
  lines.push(
    `租期内累计：净利 ${fmt(lease.total_net_profit)}｜付租 ${fmt(lease.total_rent_paid)}`
    + `｜翻新 ${fmt(lease.total_renovation)}｜期末累计现金 ${fmt(lease.ending_cumulative)}`,
  )
  lines.push(
    `租期回本：${lease.payback_month > 0 ? `${lease.payback_month} 个月（${lease.payback_year} 年）` : '租期内未回本'}`
    + `｜判定：${leaseVerdictLabel[lease.verdict]}`,
  )
  lines.push(
    `目标回本：${ceiling.target_payback_months} 个月`
    + `（业态建议 ${lease.suggested_target_payback_months} 个月 · ${lease.suggested_target_label}`
    + `；${lease.target_explicit ? '本次为调用方指定' : '本次采用业态默认'}）`,
  )
  if (lease.term_warning !== '') lines.push(`⚠️ ${lease.term_warning}`)
  if (lease.term_capacity_warning !== '') lines.push(`⚠️ ${lease.term_capacity_warning}`)
  if (lease.target_payback_mismatch) lines.push(`⚠️ ${lease.target_payback_note}`)
  if (lease.defaults_used.length > 0) lines.push(`租期模型缺省项：${lease.defaults_used.join('、')}`)

  const sp = result.space_model
  if (sp.available) {
    lines.push(
      `空间容量：建筑 ${fmt(sp.area_sqm)}㎡ → 厨房 ${fmt(sp.kitchen_area_sqm)}㎡（${(sp.kitchen_ratio * 100).toFixed(0)}%）`
      + `｜营业 ${fmt(sp.operating_area_sqm)}㎡｜座位 ${sp.seats}（${sp.seat_source === 'derived' ? '按每座面积推算' : '调用方提供'}）`,
    )
    if (sp.turnover_per_day >= 0) {
      lines.push(
        `翻台率：座口径 ${sp.turnover_per_day} 次/日（业态常规 ${sp.normal_turnover_per_day}／上限 ${sp.turnover_cap_per_day}）`
        + `｜桌口径 ${sp.turnover_tables_per_day} 次/日（${sp.tables} 桌 × ${sp.table_size} 人）`
        + `｜日均客流 ${sp.daily_customers}｜容量利用率 ${sp.utilization_pct}%`,
      )
    } else {
      lines.push('翻台率：未计算（缺座位数或客单价，缺一不算）')
    }
    if (sp.implied_daily_revenue_normal > 0) {
      lines.push(
        `面积产能校验：该面积按常规翻台应做 ${fmt(sp.implied_daily_revenue_normal)} 元/日`
        + `，当前假设 ${fmt(sp.implied_daily_revenue_normal * sp.revenue_vs_normal_ratio)} 元/日`
        + `（${(sp.revenue_vs_normal_ratio * 100).toFixed(0)}%）`
        + (sp.input_consistency === 'ok' ? '' : ' ⚠️ 不自洽'),
      )
    }
    if (sp.breakeven_turnover_per_day >= 0) {
      lines.push(
        `建议翻台率：保本线 ${sp.breakeven_turnover_per_day} 次/日`
        + `｜${sp.target_payback_months} 个月回本需 ${sp.target_turnover_per_day} 次/日`
        + `｜业态上限 ${sp.turnover_cap_per_day}`
        + (sp.target_within_capacity ? '（目标在上限内）' : '⚠️ 目标已超上限，这个面积×租金组合做不出来'),
      )
    }
    lines.push(
      `坪效 ${fmt(sp.revenue_per_sqm_month)} 元/㎡/月（经验基准 ${sp.revenue_per_sqm_benchmark}）`
      + `｜单方造价 ${fmt(sp.investment_per_sqm)} 元/㎡`,
    )
    lines.push(
      `盈亏平衡：日 ${fmt(sp.breakeven_revenue_monthly / 30)} 元｜月 ${fmt(sp.breakeven_revenue_monthly)} 元`
      + (sp.breakeven_customers_daily >= 0 ? `｜保本客单量 ${sp.breakeven_customers_daily} 单/日` : ''),
    )
    if (sp.defaults_used.length > 0) lines.push(`空间模型缺省项：${sp.defaults_used.join('、')}`)
    for (const w of sp.warnings) lines.push(`⚠️ ${w}`)
  } else {
    lines.push(`空间容量：未计算（${sp.note}）`)
    lines.push(`盈亏平衡：日 ${fmt(sp.breakeven_revenue_monthly / 30)} 元｜月 ${fmt(sp.breakeven_revenue_monthly)} 元`)
  }

  if (result.param_overrides_applied.length > 0) {
    lines.push(
      `系数覆盖生效：${result.param_overrides_applied.join('、')}`
      + (result.param_version_source !== '' ? `（参数版本 ${result.param_version_source}）` : ''),
    )
  }

  // 假设台账：把「不是你亲口给的数」逐条摊开，方便你只改该改的那几条
  const needCheck = result.assumption_ledger.filter((row) => row.action !== '可直接用' && row.action !== '已按覆盖值生效')
  if (needCheck.length > 0) {
    lines.push(`待你确认的假设（共 ${needCheck.length} 条，其余为可直接用）：`)
    for (const row of needCheck) {
      lines.push(`- [${row.category}] ${row.item} = ${row.value}｜来源：${row.source}｜${row.action}`)
    }
  }

  // 敏感度：告诉用户改哪个参数最可能翻结论
  if (result.sensitivity.length > 0) {
    lines.push('敏感度（各参数 ±20% 对谈判锚点的影响）：')
    for (const row of result.sensitivity) {
      lines.push(
        `- ${row.param}：锚点 ${fmt(row.anchor_low)} → ${fmt(row.anchor_base)} → ${fmt(row.anchor_high)}`
        + (row.conclusion_flips ? '｜**改这个会翻转「租金偏高」的结论**' : '｜不改变结论'),
      )
    }
  }

  if (result.space_sensitivity.length > 0) {
    lines.push('空间侧敏感度（各系数 ±20% 对座位与产能的影响）：')
    for (const row of result.space_sensitivity) {
      lines.push(
        `- ${row.param}：座位 ${row.seats_low} → ${row.seats_base} → ${row.seats_high}`
        + `｜应有日营收 ${fmt(row.implied_revenue_low)} → ${fmt(row.implied_revenue_base)} → ${fmt(row.implied_revenue_high)}`
        + (row.consistency_flips ? '｜**会翻转「面积与营收是否自洽」的结论**' : '｜不改变结论'),
      )
    }
  }

  if (result.ratio_checks.length > 0) {
    lines.push('内部比值校验（不依赖外部数据，六项互锁）：')
    for (const c of result.ratio_checks) {
      const flag = c.status === 'ok' ? '✓' : '⚠️'
      lines.push(
        `- ${flag} ${c.item} ${c.value}${c.unit}（该业态常规 ${c.healthy_min}~${c.healthy_max}${c.unit}）｜${c.note}`,
      )
    }
  }

  if (result.formula_trace.length > 0) {
    lines.push('计算口径（公式 + 本次代入值 + 结果）：')
    let group = ''
    for (const row of result.formula_trace) {
      if (row.group !== group) {
        group = row.group
        lines.push(`【${group}】`)
      }
      lines.push(`- ${row.metric} = ${row.formula} ｜ 代入 ${row.substituted} = ${row.result}`)
    }
  }

  return lines.join('\n')
}

/** 单情景结果的 schema。 */
const scenarioResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revenue: { type: 'number', required: true, description: '月营业额（元）' },
    net_profit: { type: 'number', required: true, description: '月净利（会计口径：已扣税费与折旧摊销，元）' },
    monthly_cash_flow: {
      type: 'number',
      required: true,
      description: '月现金净流（不含摊销，元）：回本与保本按这个算',
    },
    roi: {
      type: 'number',
      required: true,
      description: '年化投资回报率（年净利 ÷ 初始投入），-1 ≤ roi，负值表示亏损',
    },
    breakeven_revenue_daily: {
      type: 'number',
      required: true,
      description: '保本所需的日营业额（元）：现金净流 = 0 的底线',
    },
    payback_static_months: {
      type: 'number',
      required: true,
      description: '现金口径回本周期（月）；-1 表示无法回本',
    },
    accounting_payback_months: {
      type: 'number',
      required: true,
      description: '会计口径回本周期（月）= 初始投入 ÷ 含摊销的净利；与行业基准表可比',
    },
    payback_verdict: {
      type: 'object',
      required: true,
      description: '回本判读（行业实操标尺）：24–36 月优秀／≤48 月可接受上限／>48 风险偏高／>60 极高／>84 无投资价值',
      additionalProperties: false,
      properties: {
        level: { type: 'string', required: true, enum: ['too_good', 'excellent', 'acceptable', 'risky', 'very_risky', 'no_value', 'never'] },
        label: { type: 'string', required: true },
        note: { type: 'string', required: true },
      },
    },
    payback_verdict_cash: {
      type: 'object',
      required: true,
      description: '回本判读（现金流口径）',
      additionalProperties: false,
      properties: {
        level: { type: 'string', required: true, enum: ['too_good', 'excellent', 'acceptable', 'risky', 'very_risky', 'no_value', 'never'] },
        label: { type: 'string', required: true },
        note: { type: 'string', required: true },
      },
    },
    max_rent_breakeven: {
      type: 'number',
      required: true,
      description: '极限租金：净利=0 时的租金上限（元/月）；负值表示零租金也亏损',
    },
    max_rent_target: {
      type: 'number',
      required: true,
      description: '极限租金：回本周期恰好等于目标月数时的租金上限（元/月）；负值表示零租金也达不到目标',
    },
    max_rent_ratio: {
      type: 'number',
      required: true,
      description: '极限租金（净利=0 口径）占月营业额的比例，可与租售比红线直接比对',
    },
  },
} as const

/** 情景乘数子 schema：营收 × revenue、成本 × cost */
const scenarioFactorSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    revenue: { type: 'number' as const, required: true as const, description: '营收乘数' },
    cost: { type: 'number' as const, required: true as const, description: '成本乘数' },
    label: { type: 'string' as const, required: true as const, description: '人话标签' },
  },
} as const

export const financialCalcTool = defineTool({
  name: 'financial_calc',
  description:
    '按参数库执行确定性财务测算：分情景（基准/保守/乐观）计算月营业额、月净利、年化投资回报率（ROI）、'
    + '保本日营业额与静态回本周期。全部为 TypeScript 数学公式，不调用大模型；缺省参数按业态默认口径并在结果中披露。',
  parameters: {
    store_id: {
      type: 'string',
      required: true,
      description: '门店编号，如 S-0001',
    },
    format_code: {
      type: 'string',
      required: true,
      description: '业态编码，如 convenience_store',
    },
    params: {
      type: 'object',
      additionalProperties: true,
      required: true,
      description:
        '参数库。键为参数名（daily_revenue 日营业额 / gross_margin 毛利率 0–1 / monthly_rent 月租金 / '
        + 'monthly_labor 月人力成本 / monthly_other_fixed 其他固定成本 / initial_investment 初始投入），'
        + '值为 { value, source, confidence }；confidence 支持 high/medium/low 或 0–1 数值。',
    },
    scenarios: {
      type: 'array',
      description: '需要测算的情景；缺省返回 base/pessimistic/optimistic 三档',
      items: { type: 'string', enum: SCENARIO_CODES },
    },
    target_payback_months: {
      type: 'number',
      description: '极限租金反推用的目标回本周期（月），默认 24；用于算「回本 T 个月内最多能承受多少租金」',
    },
    area_sqm: {
      type: 'number',
      description: '门店面积（㎡），用于给出租期建议：≥1000㎡ 建议 ≥7 年，300~1000㎡ ≥5 年，小店 2~3 年',
    },
    catchment_level: {
      type: 'string',
      enum: ['L1', 'L2', 'L3', 'L4', 'L5'],
      description:
        '点位截流力分级（现场判定，与竞争压力是两个维度）：'
        + 'L1 顶级截流（×1.30，地铁直出口/商场主入口第一卡位）｜'
        + 'L2 强截流（×1.10，主动线中段）｜'
        + 'L3 中等截流（×1.00，行业基准，GIS 样本默认）｜'
        + 'L4 弱截流（×0.65，动线末梢）｜'
        + 'L5 极低截流（×0.15，目的地型/死角）。'
        + '注意：若已给出实测日营业额，不要再传本参数，否则重复调整。',
    },
    lease: {
      type: 'object',
      additionalProperties: true,
      description:
        '租期与现金流参数（可省略，缺省会在结果中披露）：'
        + 'term_years 合同年限（默认 5）｜rent_escalation_pct 年租金递增（默认 0.03，可传 3 表示 3%）｜'
        + 'renovation_cycle_years 翻新周期（默认 5，0=不翻新）｜renovation_cost 单次翻新金额（缺省 = 初始投入 × 25%）。'
        + '用于把静态回本扩展成「租期内能否赚回投资」。',
    },
    space: {
      type: 'object',
      additionalProperties: true,
      description:
        '空间容量参数（可省略）：area_sqm 建筑面积（也可用顶层 area_sqm）｜kitchen_ratio 厨房占建筑面积比例｜'
        + 'seat_area_sqm 每座占用营业面积｜seats 座位数（给了就不再推算）｜avg_ticket 客单价｜daily_customers 日均客流｜'
        + 'tables 实际桌数｜table_size 桌均人数。'
        + '用于计算厨房/营业面积、座位数、翻台率、坪效，并校验营收假设与座位容量是否自洽。未提供面积时整段不计算。',
    },
    overrides: {
      type: 'object',
      additionalProperties: true,
      description:
        '系数覆盖（可省略）。用于把「经验系数」从代码里移出来，允许按业态/城市/单店人工校准而不改代码。'
        + '优先级：本参数 > 内置默认。支持的键：'
        + 'payback_months 目标回本（月）｜rent_ratio_healthy_max / rent_ratio_warning_max 租售比两条线｜'
        + 'kitchen_ratio / seat_area_sqm / normal_turnover / turnover_cap / table_size / revenue_per_sqm_benchmark / typical_ticket_min / typical_ticket_max 空间系数｜'
        + 'term_years / rent_escalation_pct / renovation_cycle_years / renovation_cost_ratio 租期系数｜'
        + 'param_version 参数版本号（报告须引用）｜param_source 依据说明。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        per_scenario: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: '按情景的测算结果；未请求的情景不出现',
          properties: {
            base: scenarioResultSchema,
            pessimistic: scenarioResultSchema,
            optimistic: scenarioResultSchema,
          },
        },
        scenario_factors: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: '三档情景的营收/成本乘数。报告必须披露——否则保守/乐观两档的保本额与极限租金无法按公式复算',
          properties: {
            base: { ...scenarioFactorSchema, required: true as const },
            pessimistic: { ...scenarioFactorSchema, required: true as const },
            optimistic: { ...scenarioFactorSchema, required: true as const },
          },
        },
        low_confidence_params: {
          type: 'array',
          required: true,
          description: '置信度为 low 的参数名',
          items: { type: 'string' },
        },
        rent_ceiling: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description:
            '极限租金反推汇总（取基准档，未请求基准档时取首个情景）。'
            + 'above_ceiling_* 为正数表示当前租金偏高、需压到这个幅度以下；为负数表示当前租金仍有余量。',
          properties: {
            scenario: { type: 'string', required: true, description: '所依据的情景' },
            target_payback_months: { type: 'number', required: true, description: '目标回本周期（月）' },
            rent_ceiling_breakeven: {
              type: 'number',
              required: true,
              description: '净利=0 时的租金上限（元/月）',
            },
            rent_ceiling_at_target: {
              type: 'number',
              required: true,
              description: '回本恰好等于目标月数时的租金上限（元/月）',
            },
            current_rent: { type: 'number', required: true, description: '参数里的当前月租金（元/月）' },
            above_ceiling_at_target: {
              type: 'number',
              required: true,
              description: '当前租金 − 目标口径上限；正数=需降租的幅度',
            },
            above_ceiling_at_breakeven: {
              type: 'number',
              required: true,
              description: '当前租金 − 保本口径上限；正数=当前租金已让项目亏损',
            },
          },
        },
        recommendation: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description:
            '建议租金。target_rent 是谈判锚点（按基准档），target_rent_conservative 是压力测试下限（保守档，仅作风险提示），ceiling_rent 是不可越过的保本红线（取全档最保守）。',
          properties: {
            target_rent: {
              type: 'number', required: true,
              description: '谈判锚点（元/月）：基准档的目标回本租金上限，常规经营预期下可接受的价格上限',
            },
            target_rent_conservative: {
              type: 'number', required: true,
              description: '压力测试下限（元/月）：保守档（营收↓15% 且 成本↑5%）下的目标回本租金上限。只作风险提示，不作谈判出价',
            },
            conservative_scenario: {
              type: 'string', required: true,
              description: '压力下限取自哪个情景',
            },
            ceiling_rent: {
              type: 'number', required: true,
              description: '保本红线（元/月）：基准档的保本租金上限，越过即亏损',
            },
            ceiling_rent_conservative: {
              type: 'number', required: true,
              description: '压力红线（元/月）：保守档的保本租金上限，仅作最坏情况提示',
            },
            gap_to_target: { type: 'number', required: true, description: '当前租金 − 锚点；正数=需下调' },
            rent_headroom: { type: 'number', required: true, description: '租金安全余量（元/月）= 锚点 − 当前租金' },
            rent_headroom_pct: { type: 'number', required: true, description: '安全余量占锚点比例（0–1）' },
            rent_vs_anchor_pct: { type: 'number', required: true, description: '当前租金占锚点比例（0–1）' },
            gap_to_ceiling: { type: 'number', required: true, description: '当前租金 − 红线；正数=已越线' },
            based_on_scenario: { type: 'string', required: true, description: '锚点取自哪个情景' },
            current_rent_ratio: { type: 'number', required: true, description: '当前租售比（租金÷基准月营业额）' },
            rent_ratio_healthy_max: {
              type: 'number',
              required: true,
              description: '该业态租售比健康线（低于此值为健康）',
            },
            rent_ratio_warning_max: {
              type: 'number',
              required: true,
              description: '该业态租售比警戒线（高于此值为超红线）',
            },
            rent_ratio_label: {
              type: 'string',
              required: true,
              description: '经验线来源业态标签',
            },
            rent_ratio_hint: {
              type: 'string',
              required: true,
              description: '一句话判读：当前值相对健康线与警戒线的位置',
            },
            rent_ratio_verdict: {
              type: 'string',
              required: true,
              enum: ['healthy', 'watch', 'breach'],
              description: 'healthy=健康｜watch=偏高｜breach=超红线',
            },
            anchor_unreachable: {
              type: 'boolean',
              required: true,
              description: 'true = 即便零租金也达不到目标回本周期；此时 target_rent 不可作为谈判价',
            },
          },
        },
        lease_model: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: '租期内现金流模拟：含租金年递增与装修翻新，回答「这份合同期内能不能赚回投资」',
          properties: {
            term_years: { type: 'number', required: true, description: '合同年限' },
            rent_escalation_pct: { type: 'number', required: true, description: '年租金递增率' },
            renovation_cycle_years: { type: 'number', required: true, description: '翻新周期（年）；0=不翻新' },
            renovation_cost: { type: 'number', required: true, description: '单次翻新金额（元）' },
            base_rent: { type: 'number', required: true, description: '首年月租金（元）' },
            monthly_net_year1: { type: 'number', required: true, description: '首年月净利（元）' },
            payback_month: { type: 'number', required: true, description: '考虑递增与翻新后的回本月序；-1=租期内未回本' },
            payback_year: { type: 'number', required: true, description: '回本年数；-1=未回本' },
            total_net_profit: { type: 'number', required: true, description: '租期内累计净利（元）' },
            total_rent_paid: { type: 'number', required: true, description: '租期内累计付租（元）' },
            total_renovation: { type: 'number', required: true, description: '租期内翻新投入合计（元）' },
            ending_cumulative: { type: 'number', required: true, description: '租期结束累计现金；负=没赚回投资' },
            covers_investment: { type: 'boolean', required: true, description: '租期内是否收回全部投资' },
            verdict: {
              type: 'string',
              required: true,
              enum: ['healthy', 'tight', 'fail'],
              description: 'healthy=回本充分｜tight=回本偏晚｜fail=租期内收不回投资',
            },
            term_advice: { type: 'string', required: true, description: '按面积的租期建议' },
            term_warning: { type: 'string', required: true, description: '租期短于建议下限时的警告；空串=无' },
            defaults_used: {
              type: 'array',
              required: true,
              description: '本次使用的缺省项（须在报告中披露）',
              items: { type: 'string' },
            },
            suggested_target_payback_months: {
              type: 'number',
              required: true,
              description: '该业态建议的目标回本周期（月）：茶饮约 12、全天茶楼约 27、大型正餐约 36、中型正餐约 24',
            },
            suggested_target_label: {
              type: 'string',
              required: true,
              description: '业态建议来源说明',
            },
            target_explicit: {
              type: 'boolean',
              required: true,
              description: '调用方是否显式指定了目标回本周期',
            },
            target_payback_mismatch: {
              type: 'boolean',
              required: true,
              description: '调用方传入的目标回本与业态建议偏离超过 25%',
            },
            target_payback_note: {
              type: 'string',
              required: true,
              description: '偏离说明；空串表示匹配',
            },
            required_term_years: {
              type: 'number',
              required: true,
              description: '容纳「回本 + 等长赚钱期」所需的最短租期（年）',
            },
            term_capacity_warning: {
              type: 'string',
              required: true,
              description: '租期不足以容纳回本与赚钱期时的警告；空串表示够',
            },
            yearly: {
              type: 'array',
              required: true,
              description: '逐年现金流行',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  year: { type: 'number', required: true },
                  rent_monthly: { type: 'number', required: true },
                  revenue: { type: 'number', required: true },
                  rent_total: { type: 'number', required: true },
                  net_profit: { type: 'number', required: true },
                  renovation: { type: 'number', required: true },
                  cumulative: { type: 'number', required: true },
                },
              },
            },
          },
        },
        space_model: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: '空间容量模型：面积↔营收对账（厨房/营业面积、座位、翻台率、坪效、盈亏平衡）',
          properties: {
            available: { type: 'boolean', required: true, description: '是否计算成功；false 时各数值为 0，note 说明缺什么' },
            note: { type: 'string', required: true, description: '未计算原因；已计算时为空串' },
            area_sqm: { type: 'number', required: true, description: '建筑面积（㎡）' },
            kitchen_ratio: { type: 'number', required: true, description: '厨房占建筑面积比例' },
            kitchen_area_sqm: { type: 'number', required: true, description: '厨房面积（㎡）' },
            operating_area_sqm: { type: 'number', required: true, description: '营业面积（㎡）= 建筑面积 − 厨房' },
            seats: { type: 'number', required: true, description: '座位数；无法推算时为 -1' },
            seat_source: {
              type: 'string',
              required: true,
              enum: ['input', 'derived', 'missing'],
              description: 'input=调用方提供｜derived=按每座面积推算｜missing=无法确定',
            },
            seat_area_sqm: {
              type: 'number',
              required: true,
              description: '每座占用营业面积的实际取值（㎡）；直接给座位数且未指定时为 -1',
            },
            avg_ticket: { type: 'number', required: true, description: '客单价；未提供时为 -1' },
            daily_customers: { type: 'number', required: true, description: '日均客流；无法推算时为 -1' },
            turnover_per_day: { type: 'number', required: true, description: '翻台率（次/日）；无法计算时为 -1' },
            breakeven_turnover_per_day: {
              type: 'number',
              required: true,
              description: '保本所需翻台率（次/日）= 保本日营业额 ÷ 客单价 ÷ 座位数；低于必亏。无法计算时为 -1',
            },
            target_turnover_per_day: {
              type: 'number',
              required: true,
              description: '达到目标回本周期所需翻台率（次/日）；无法计算时为 -1',
            },
            target_daily_revenue: {
              type: 'number',
              required: true,
              description: '目标回本口径所需日营业额（元）；无法计算时为 -1',
            },
            target_within_capacity: {
              type: 'boolean',
              required: true,
              description: '目标翻台率是否在业态产能上限之内；false=该面积×租金组合做不出来',
            },
            target_payback_months: {
              type: 'number',
              required: true,
              description: '计算目标翻台率时采用的回本月数',
            },
            turnover_cap_per_day: { type: 'number', required: true, description: '该业态翻台上限（经验值）' },
            normal_turnover_per_day: {
              type: 'number',
              required: true,
              description: '该业态常规翻台（次/日，按座计），用于校验营收与面积是否自洽',
            },
            tables: { type: 'number', required: true, description: '桌数（按桌均人数折算）；无法确定时为 -1' },
            table_size: { type: 'number', required: true, description: '桌均人数（缺省 4，已在 defaults_used 披露）' },
            turnover_tables_per_day: {
              type: 'number',
              required: true,
              description: '桌翻台率（次/日）= 客流 ÷ 桌数；行业口语常用口径。无法计算时为 -1',
            },
            implied_daily_revenue_normal: {
              type: 'number',
              required: true,
              description: '按业态常规翻台反推的应有日营收（元），用来对比当前营收假设',
            },
            revenue_vs_normal_ratio: {
              type: 'number',
              required: true,
              description: '当前营收 ÷ 应有日营收；显著低于 0.4 说明营收与面积不匹配',
            },
            input_consistency: {
              type: 'string',
              required: true,
              enum: ['ok', 'revenue_too_low', 'turnover_impossible'],
              description: 'ok=输入自洽｜revenue_too_low=营收相对面积过低｜turnover_impossible=翻台超上限，物理不可能',
            },
            typical_ticket_min: { type: 'number', required: true, description: '该业态典型客单价下限' },
            typical_ticket_max: { type: 'number', required: true, description: '该业态典型客单价上限' },
            ticket_matches_format: {
              type: 'boolean',
              required: true,
              description: '客单价是否落在该业态典型区间；false 说明业态标签可能贴错',
            },
            ticket_note: {
              type: 'string',
              required: true,
              description: '客单价与业态不符的说明；空串表示相符或未提供',
            },
            capacity_customers_per_day: { type: 'number', required: true, description: '座位容量上限下的日客流' },
            utilization_pct: { type: 'number', required: true, description: '容量利用率（%）；无法计算时为 -1' },
            utilization_basis: { type: 'string', required: true, description: '容量利用率的分母口径' },
            daily_customers_raw: { type: 'number', required: true, description: '原始客流（未乘截流系数）' },
            catchment_multiplier: { type: 'number', required: true, description: '截流乘数' },
            target_daily_revenue_cash: { type: 'number', required: true, description: '现金流口径目标日营业额' },
            target_turnover_cash_per_day: { type: 'number', required: true, description: '现金流口径目标翻台' },
            turnover_risk: {
              type: 'string', required: true,
              enum: ['red', 'yellow', 'green', 'high', 'impossible', 'unknown'],
              description: '座位翻台五档：red 现实可行性低（只作压力测算）／yellow 偏低薄利／'
                + 'green 合理／high 高于常态（旺季/爆火）／impossible 超物理上限（参数可疑）',
            },
            turnover_risk_note: { type: 'string', required: true, description: '翻台风险说明（展示 3 位小数）' },
            turnover_band: {
              type: 'object', additionalProperties: false,
              description: '该业态的五档翻台基准；未匹配业态时为 null。max_real 仅作物理上限提示，不用于财务测算',
              properties: {
                alert_below: { type: 'number', required: true, description: '告警线：低于此值判红' },
                warn_low: { type: 'number', required: true, description: '黄色区间下界' },
                warn_high: { type: 'number', required: true, description: '黄色区间上界' },
                normal_low: { type: 'number', required: true, description: '绿色合理区间下界' },
                normal_high: { type: 'number', required: true, description: '绿色合理区间上界' },
                max_real: { type: 'number', required: true, description: '物理上限，超过即参数可疑' },
                label: { type: 'string', required: true, description: '业态子类型名称' },
              },
            },
            revenue_per_sqm_month: { type: 'number', required: true, description: '坪效（元/㎡/月，按建筑面积计）' },
            revenue_per_sqm_benchmark: { type: 'number', required: true, description: '该业态坪效经验基准（元/㎡/月）' },
            breakeven_revenue_monthly: { type: 'number', required: true, description: '保本营业额（月，元）' },
            breakeven_customers_daily: { type: 'number', required: true, description: '保本客单量（单/日）；无客单价时为 -1' },
            investment_per_sqm: { type: 'number', required: true, description: '单方造价（元/㎡）= 初始投入 ÷ 建筑面积' },
            warnings: {
              type: 'array',
              required: true,
              description: '容量与营收不自洽时的告警',
              items: { type: 'string' },
            },
            defaults_used: {
              type: 'array',
              required: true,
              description: '本次使用的缺省系数（须在报告中披露）',
              items: { type: 'string' },
            },
          },
        },
        param_overrides_applied: {
          type: 'array',
          required: true,
          description: '本次实际生效的系数覆盖键；审计用，报告应披露哪些经验值被改过',
          items: { type: 'string' },
        },
        param_version_source: {
          type: 'string',
          required: true,
          description: '参数文件版本号；未提供时为空串',
        },
        param_defaults_used: {
          type: 'array',
          required: true,
          description: '因缺参数而回落到业态默认的参数名（必须补，否则结论无意义）',
          items: { type: 'string' },
        },
        assumption_ledger: {
          type: 'array',
          required: true,
          description: '假设台账：所有「不是调用方亲口给的数」，供人工逐条修正；报告必须原样呈现',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', required: true, description: '分类：财务参数/缺省值/空间系数/租期系数/覆盖/口径' },
              item: { type: 'string', required: true, description: '参数名' },
              value: { type: 'string', required: true, description: '本次取值' },
              source: { type: 'string', required: true, description: '来源：调用方提供/业态默认/内置默认/参数文件/推算' },
              action: { type: 'string', required: true, description: '建议动作' },
            },
          },
        },
        sensitivity: {
          type: 'array',
          required: true,
          description: '各关键参数 ±delta_pct 时谈判锚点的变化，以及「租金是否高于锚点」结论是否翻转',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              param: { type: 'string', required: true },
              delta_pct: { type: 'number', required: true },
              anchor_low: { type: 'number', required: true },
              anchor_base: { type: 'number', required: true },
              anchor_high: { type: 'number', required: true },
              gap_base: { type: 'number', required: true, description: '当前租金 − 基准锚点；正数=租金偏高' },
              conclusion_flips: { type: 'boolean', required: true, description: '扰动后结论是否翻转' },
            },
          },
        },
        space_sensitivity: {
          type: 'array',
          required: true,
          description:
            '空间侧敏感度：每座面积/厨房占比/常规翻台 ±delta_pct 时，座位数与应有日营收怎么变、自洽性结论是否翻转',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              param: { type: 'string', required: true },
              delta_pct: { type: 'number', required: true },
              seats_low: { type: 'number', required: true, description: '参数 −20% 时的座位数' },
              seats_base: { type: 'number', required: true },
              seats_high: { type: 'number', required: true, description: '参数 +20% 时的座位数' },
              implied_revenue_low: { type: 'number', required: true },
              implied_revenue_base: { type: 'number', required: true },
              implied_revenue_high: { type: 'number', required: true },
              ratio_base: { type: 'number', required: true, description: '当前营收 ÷ 应有日营收' },
              consistency_flips: {
                type: 'boolean',
                required: true,
                description: '扰动后「面积与营收是否自洽（占比≥40%）」的结论是否翻转',
              },
              note: { type: 'string', required: true, description: '扰动方向说明' },
            },
          },
        },
        ratio_checks: {
          type: 'array',
          required: true,
          description:
            '内部比值校验：不抓任何外部数据，用已录入参数互锁（毛利率/人力占营收/租售比/单方造价 vs 业态区间），发现估错的参数',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              item: { type: 'string', required: true },
              value: { type: 'number', required: true },
              unit: { type: 'string', required: true },
              healthy_min: { type: 'number', required: true },
              healthy_max: { type: 'number', required: true },
              warning_max: { type: 'number', description: '仅租售比：警戒线上限' },
              status: {
                type: 'string', required: true,
                enum: ['ok', 'low', 'high', 'watch', 'breach'],
                description: '租售比用三档（ok 健康／watch 偏高／breach 破线），其余比值用 ok/low/high',
              },
              note: { type: 'string', required: true, description: '偏离方向的人话解释与反推值' },
            },
          },
        },
        formula_trace: {
          type: 'array',
          required: true,
          description: '计算口径台账：每条关键指标的公式 + 本次代入值 + 结果，供人工核对参数是否搞错',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              group: { type: 'string', required: true, description: '分组：财务/租金/空间/比率/口径' },
              metric: { type: 'string', required: true, description: '指标名' },
              formula: { type: 'string', required: true, description: '计算口径' },
              substituted: { type: 'string', required: true, description: '本次代入的数值' },
              result: { type: 'string', required: true, description: '计算结果' },
            },
          },
        },
        catchment_code: {
          type: 'string',
          required: true,
          description: '点位截流力等级 L1~L5；未提供时为空串',
        },
        catchment_label: { type: 'string', required: true, description: '等级名称；未提供时为空串' },
        catchment_multiplier: { type: 'number', required: true, description: '客流乘数，1 表示未调整' },
        param_version: { type: 'string', required: true, description: '参数库版本' },
        formula_version: { type: 'string', required: true, description: '公式版本' },
      },
    },
    render: (args, value) => [{ type: 'text', text: formatFinancialReport(args, value) }],
  },
  async execute(args) {
    return runFinancials(
      args.format_code,
      args.params,
      args.scenarios,
      args.target_payback_months,
      args.area_sqm,
      args.lease as Record<string, unknown> | undefined,
      args.space as Record<string, unknown> | undefined,
      args.overrides as Record<string, unknown> | undefined,
      args.catchment_level,
    )
  },
})

// ---------------------------------------------------------------------------
// poi_dedupe —— POI 去重 / 清洗 / 质量统计（L3 数据治理，纯本地计算）
// ---------------------------------------------------------------------------

/** 竞争分段：一段 = 品类 × 规模（同段才是直接竞品） */
/** 业态档案里的一个竞争分段：key + 匹配正则源串 */
interface ProfileSegment {
  key: string
  match: string
}

interface DedupeSegment {
  key: string
  pattern: RegExp
}

/** 去重与清洗阈值；**不含任何业态假设**，全部由调用方传入。 */
interface DedupeConfig {
  sameNameMergeM: number
  crossSourceMergeM: number
  crossSourceSameSpotM: number
  nameSimilarity: number
  /** 竞品类目白名单（正则）。undefined = 不按类目过滤。 */
  categoryPattern: RegExp | undefined
  /** 名称排除规则（只匹配店名）。undefined = 不排除 */
  excludePattern: RegExp | undefined
  /** 类目排除规则（只匹配平台类目）。平台类目用词不可靠，默认不用 */
  excludeCategoryPattern: RegExp | undefined
  /** 竞争分段（按顺序首个命中）；空数组 = 不分段 */
  segments: readonly DedupeSegment[]
  /** 客户自身所属分段；该段数量 = 直接竞品数 */
  selfSegment: string | undefined
  /**
   * 是否餐饮业态。仅当为 true 时才启用「非堂食零售」过滤——
   * 便利店/超市业态里，这些名字本身就是竞品，不能剔。
   */
  diningOnly?: boolean
}

/** 默认只给几何阈值；类目/排除规则必须由用户在调用时声明。 */
const DEDUPE_DEFAULTS: DedupeConfig = {
  sameNameMergeM: 50,
  crossSourceMergeM: 100,
  crossSourceSameSpotM: 30,
  nameSimilarity: 0.6,
  categoryPattern: undefined,
  excludePattern: undefined,
  excludeCategoryPattern: undefined,
  segments: [],
  selfSegment: undefined,
}


/** 归一化后的 POI。 */
interface Poi {
  name: string
  category: string
  keytag: string
  lat: number
  lng: number
  distanceToCenter: number
  address: string
  tel: string
  source: string
  sources: string[]
  /** 人均消费（高德 biz_ext.cost）；-1 = 未取到 */
  cost: number
  /** 评分；-1 = 未取到 */
  rating: number
}

/** 被剔除的 POI。 */
interface DroppedPoi {
  name: string
  source: string
  reason: string
}

/** 被合并的 POI。 */
interface MergedPoi {
  kept: string
  merged_from: string
  source: string
  distance_m: number
}

/** 同品牌集中度。 */
interface BrandGroup {
  brand: string
  count: number
  nearest_m: number
}

/** 可疑/待核记录。 */
interface SuspiciousPoi {
  name: string
  flags: string[]
}

/** `poi_dedupe` 的规范返回值。 */
export interface PoiDedupeResult {
  raw: number
  effective: number
  /** 同类型（细分品类命中）数量 = 真正的竞品 */
  same_type_count: number
  /** 异类数量 = 协同客群（餐饮聚集效应） */
  other_type_count: number
  /** 客户自身所属分段 key；空串表示未分段 */
  self_segment: string
  /** 各竞争分段统计（品类 × 规模）；同段才是直接竞品 */
  segments: Array<{ key: string; count: number; is_self: boolean }>
  /** 存活 POI 的坐标，可直接喂给 geo_analyze（第 5 步 → 第 6 步的接口） */
  kept: Array<{ name: string; lat: number; lng: number; segment: string; same_type: boolean; cost: number; rating: number }>
  dropped: DroppedPoi[]
  merged: MergedPoi[]
  brand_groups: BrandGroup[]
  suspicious: SuspiciousPoi[]
  nearest: { name: string; distance_m: number }
}

const EARTH_R = 6371000

const toRadians = (deg: number): number => (deg * Math.PI) / 180

/** 两点球面距离（米）。 */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(a))
}

/** 字符二元组 Dice 系数（中文 POI 名称相似度）。 */
function diceSimilarity(left: string, right: string): number {
  const grams = (input: string): Map<string, number> => {
    const text = input.replace(/[\s()（）\-—·,，.。]/g, '')
    const out = new Map<string, number>()
    for (let i = 0; i < text.length - 1; i += 1) {
      const gram = text.slice(i, i + 2)
      out.set(gram, (out.get(gram) ?? 0) + 1)
    }
    return out
  }
  const a = grams(left)
  const b = grams(right)
  let aSize = 0
  let bSize = 0
  for (const n of a.values()) aSize += n
  for (const n of b.values()) bSize += n
  if (aSize === 0 || bSize === 0) return left === right ? 1 : 0
  let hit = 0
  for (const [gram, n] of a) hit += Math.min(n, b.get(gram) ?? 0)
  return (2 * hit) / (aSize + bSize)
}

/** 宽松数值解析：兼容 "146" 这类字符串字段。 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 编译调用方传入的正则：空值 = 不启用该规则；非法表达式直接报错（不静默降级）。 */
function compilePattern(source: string | undefined, label: string): RegExp | undefined {
  if (source === undefined || source.trim() === '') return undefined
  try {
    return new RegExp(source)
  } catch {
    throw new Error(`poi_dedupe: ${label} 不是合法正则表达式 → ${source}`)
  }
}

/** 兼容腾讯 {lat,lng} 与高德 "lng,lat" 两种坐标写法。 */
function readCoordinate(location: unknown): { lat: number; lng: number } | undefined {
  if (Array.isArray(location)) {
    const lat = asNumber(location[0])
    const lng = asNumber(location[1])
    return lat === undefined || lng === undefined ? undefined : { lat, lng }
  }
  if (typeof location === 'object' && location !== null) {
    const box = location as Record<string, unknown>
    const lat = asNumber(box['lat'])
    const lng = asNumber(box['lng'])
    return lat === undefined || lng === undefined ? undefined : { lat, lng }
  }
  if (typeof location === 'string' && location.includes(',')) {
    const parts = location.split(',')
    const lng = asNumber(parts[0])
    const lat = asNumber(parts[1])
    return lat === undefined || lng === undefined ? undefined : { lat, lng }
  }
  return undefined
}

/** 归一化一条原始记录；失败返回剔除原因字符串。 */
function normalizePoi(entry: unknown): Poi | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return '记录不是对象'
  const raw = entry as Record<string, unknown>
  const name = String(raw['title'] ?? raw['name'] ?? '').trim()
  if (name === '') return '名称为空'
  const coordinate = readCoordinate(raw['location'])
  if (coordinate === undefined) return '坐标缺失/非法'
  const source = String(raw['source'] ?? 'tencent')
  return {
    name,
    category: String(raw['category'] ?? raw['type'] ?? ''),
    keytag: String(raw['keytag'] ?? ''),
    lat: coordinate.lat,
    lng: coordinate.lng,
    distanceToCenter: asNumber(raw['_distance'] ?? raw['distance']) ?? -1,
    address: String(raw['address'] ?? ''),
    tel: String(raw['tel'] ?? ''),
    source,
    sources: [source],
    cost: asNumber(raw['cost']) ?? -1,
    rating: asNumber(raw['rating']) ?? -1,
  }
}

/** 剔除判定；返回原因或 undefined。规则全部来自调用方，脚本不含业态假设。 */
/** 停业状态特征：这类店不构成竞争，必须先剔除再统计竞品基数。 */
const CLOSED_NAME_PATTERN = /暂停营业|歇业|停业|已关闭|关闭中|装修中|即将开业|未开业|空铺|招租/

/**
 * 非堂食餐饮：农贸肉档、生鲜、食品零售、干货、粮油、水产批发等。
 * 它们出现在「餐饮」类目里，但不是「顾客坐下吃饭的对手」，混进来会把竞品数吹大。
 */
const NON_DINING_NAME_PATTERN = /肉档|猪肉|牛肉档|生鲜|蔬菜|水果店|水产|海鲜批发|冻品|干货|粮油|食品店|食品商行|副食|调料|农贸|菜市场|粮油店|烟酒|便利店|超市/

/** 前置清洗：返回剔除原因，未命中返回 undefined。 */
function preCleanRejectReason(poi: Poi): string | undefined {
  if (CLOSED_NAME_PATTERN.test(poi.name)) return '停业/未开业状态（不构成竞争）'
  if (NON_DINING_NAME_PATTERN.test(poi.name)) return '非堂食餐饮（农贸/生鲜/食品零售）'
  return undefined
}

function dedupeRejectReason(poi: Poi, config: DedupeConfig): string | undefined {
  // 停业状态永远剔（任何业态都不构成竞争）
  if (CLOSED_NAME_PATTERN.test(poi.name)) return '停业/未开业状态（不构成竞争）'
  // 非堂食零售只在餐饮业态里剔
  if (config.diningOnly === true && NON_DINING_NAME_PATTERN.test(poi.name)) {
    return '非堂食餐饮（农贸/生鲜/食品零售）'
  }
  const excludeName = config.excludePattern
  if (excludeName !== undefined && excludeName.test(poi.name)) {
    return '命中名称排除规则'
  }
  const excludeCategory = config.excludeCategoryPattern
  if (excludeCategory !== undefined && excludeCategory.test(poi.category)) {
    return `命中类目排除规则：${poi.category || '空'}`
  }
  const allow = config.categoryPattern
  if (allow !== undefined && !allow.test(poi.category)) {
    return `类目不在白名单：${poi.category || '空'}`
  }
  return undefined
}

/** 可疑标记（不一定剔除，但必须披露）。 */
function dedupeDirtyFlags(poi: Poi): string[] {
  const flags: string[] = []
  if (poi.lat < 20 || poi.lat > 50 || poi.lng < 100 || poi.lng > 130) flags.push('坐标越界')
  if (poi.tel === '' && poi.address === '') flags.push('电话与地址均空')
  return flags
}

/** 品牌名归并：去括号注释、去通用后缀。 */
function brandOf(name: string): string {
  const stripped = name
    .replace(/[（(].*?[）)]/g, '')
    .replace(/便利店|超市|综合商店|食品店|商店/g, '')
    .trim()
  return stripped === '' ? name : stripped
}

/** 主流程：清洗 → 去重 → 分组 → 统计。 */
export function analyzePois(entries: readonly unknown[], config: DedupeConfig): PoiDedupeResult {
  const dropped: DroppedPoi[] = []
  const suspicious: SuspiciousPoi[] = []
  const kept: Poi[] = []

  for (const entry of entries) {
    const normalized = normalizePoi(entry)
    if (typeof normalized === 'string') {
      const rawName =
        typeof entry === 'object' && entry !== null
          ? String((entry as Record<string, unknown>)['title'] ?? (entry as Record<string, unknown>)['name'] ?? '').trim()
          : ''
      dropped.push({ name: rawName === '' ? '(无名称)' : rawName, source: '-', reason: normalized })
      continue
    }
    const reason = dedupeRejectReason(normalized, config)
    if (reason !== undefined) {
      dropped.push({ name: normalized.name, source: normalized.source, reason })
      continue
    }
    const flags = dedupeDirtyFlags(normalized)
    if (flags.length > 0) suspicious.push({ name: normalized.name, flags })
    kept.push(normalized)
  }

  // 同坐标堆叠检测
  const stacks = new Map<string, number>()
  for (const poi of kept) {
    const key = `${poi.lat.toFixed(5)},${poi.lng.toFixed(5)}`
    stacks.set(key, (stacks.get(key) ?? 0) + 1)
  }
  for (const [key, count] of stacks) {
    if (count >= 5) suspicious.push({ name: `坐标堆叠 ${key}`, flags: [`同坐标 ${count} 条`] })
  }

  // 去重（O(n²)，选址场景量级足够）
  const merged: MergedPoi[] = []
  const survivors: Poi[] = []
  for (const poi of kept) {
    let target: Poi | undefined
    for (const candidate of survivors) {
      const distance = haversine(poi.lat, poi.lng, candidate.lat, candidate.lng)
      const sameName = poi.name === candidate.name
      const crossSource = poi.source !== candidate.source
      if (sameName && distance <= config.sameNameMergeM) {
        target = candidate
        break
      }
      if (crossSource && distance <= config.crossSourceSameSpotM) {
        target = candidate
        break
      }
      if (crossSource && distance <= config.crossSourceMergeM && diceSimilarity(poi.name, candidate.name) >= config.nameSimilarity) {
        target = candidate
        break
      }
    }
    if (target === undefined) {
      survivors.push(poi)
      continue
    }
    merged.push({
      kept: target.name,
      merged_from: poi.name,
      source: poi.source,
      distance_m: Math.round(haversine(poi.lat, poi.lng, target.lat, target.lng)),
    })
    for (const source of poi.sources) {
      if (!target.sources.includes(source)) target.sources.push(source)
    }
  }

  // 同品牌集中度
  const groups = new Map<string, BrandGroup>()
  for (const poi of survivors) {
    const brand = brandOf(poi.name)
    const existing = groups.get(brand)
    const nearest = poi.distanceToCenter >= 0 ? poi.distanceToCenter : Number.POSITIVE_INFINITY
    if (existing === undefined) {
      groups.set(brand, { brand, count: 1, nearest_m: Math.round(nearest) })
      continue
    }
    existing.count += 1
    existing.nearest_m = Math.round(Math.min(existing.nearest_m, nearest))
  }
  const brandGroups = [...groups.values()]
    .filter((group) => group.count >= 2)
    .sort((a, b) => b.count - a.count || a.nearest_m - b.nearest_m)

  // 只保留最终存活 POI 的可疑项，并按「名称+标记」去重（合并掉的重复记录不再重复报）
  const survivorNames = new Set(survivors.map((poi) => poi.name))
  const seenSuspicious = new Set<string>()
  const finalSuspicious: SuspiciousPoi[] = []
  for (const item of suspicious) {
    if (!survivorNames.has(item.name)) continue
    const key = `${item.name}|${item.flags.join(',')}`
    if (seenSuspicious.has(key)) continue
    seenSuspicious.add(key)
    finalSuspicious.push(item)
  }

  let nearestName = '-'
  let nearestDistance = -1
  for (const poi of survivors) {
    if (poi.distanceToCenter < 0) continue
    if (nearestDistance < 0 || poi.distanceToCenter < nearestDistance) {
      nearestDistance = poi.distanceToCenter
      nearestName = poi.name
    }
  }

  // 竞争分段：品类 × 规模。同段 = 直接竞品；异段 = 协同或弱竞争
  const segmentOf = (poi: Poi): string => {
    if (config.segments.length === 0) return 'all'
    const hay = `${poi.category} ${poi.name}`
    for (const seg of config.segments) {
      if (seg.pattern.test(hay)) return seg.key
    }
    return 'other'
  }
  const segmentCounts = new Map<string, number>()
  for (const poi of survivors) {
    const key = segmentOf(poi)
    segmentCounts.set(key, (segmentCounts.get(key) ?? 0) + 1)
  }
  const segmentList = [...segmentCounts.entries()]
    .map(([key, count]) => ({ key, count, is_self: config.selfSegment !== undefined && key === config.selfSegment }))
    .sort((a, b) => b.count - a.count)
  const selfCount = config.segments.length === 0
    ? survivors.length
    : (config.selfSegment === undefined ? 0 : (segmentCounts.get(config.selfSegment) ?? 0))

  return {
    raw: entries.length,
    effective: survivors.length,
    same_type_count: selfCount,
    other_type_count: survivors.length - selfCount,
    self_segment: config.selfSegment ?? '',
    segments: segmentList,
    kept: survivors.map((poi) => {
      const segment = segmentOf(poi)
      return {
        name: poi.name,
        lat: poi.lat,
        lng: poi.lng,
        segment,
        same_type: config.segments.length === 0 || segment === config.selfSegment,
        cost: poi.cost,
        rating: poi.rating,
      }
    }),
    dropped,
    merged,
    brand_groups: brandGroups,
    suspicious: finalSuspicious,
    nearest: { name: nearestName, distance_m: nearestDistance < 0 ? -1 : Math.round(nearestDistance) },
  }
}

/** 渲染成模型可见的文本。 */
function formatDedupeReport(result: PoiDedupeResult): string {
  const pct = (part: number, total: number): string => (total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`)
  const lines = [
    `POI 清洗结果：原始 ${result.raw}｜有效 ${result.effective}｜剔除 ${result.dropped.length}｜合并 ${result.merged.length}`,
    `最近竞品：${result.nearest.name}（${result.nearest.distance_m} 米）`,
    `数据质量：合并率 ${pct(result.merged.length, result.raw)}｜可疑率 ${pct(result.suspicious.length, Math.max(result.raw, 1))}`,
  ]
  if (result.dropped.length > 0) {
    lines.push('剔除明细：')
    for (const item of result.dropped) lines.push(`- ${item.name}（${item.source}）：${item.reason}`)
  }
  if (result.merged.length > 0) {
    lines.push('合并明细：')
    for (const item of result.merged) {
      const label = item.merged_from === item.kept ? '同名同点重复' : `「${item.merged_from}」`
      lines.push(`- ${label} → 「${item.kept}」：相距 ${item.distance_m} 米，来源 ${item.source}`)
    }
  }
  if (result.brand_groups.length > 0) {
    lines.push('同品牌集中度：')
    for (const group of result.brand_groups) lines.push(`- ${group.brand}：${group.count} 处，最近 ${group.nearest_m} 米`)
  }
  if (result.suspicious.length > 0) {
    lines.push('可疑待核：')
    for (const item of result.suspicious) lines.push(`- ${item.name}：${item.flags.join('、')}`)
  }
  return lines.join('\n')
}

export const poiDedupeTool = defineTool({
  name: 'poi_dedupe',
  description:
    '对 POI 列表做去重与清洗：同名同点合并、跨源合并、折扣/杂货类剔除、坐标越界与堆叠检测，'
    + '输出原始数/有效数/剔除与合并明细/同品牌集中度。纯本地计算，不发起网络请求。',
  parameters: {
    pois: {
      type: 'array',
      required: true,
      description:
        'POI 数组。字段宽松：title|name、category|type、location（腾讯 {lat,lng} 或高德 "lng,lat"）、'
        + '_distance|distance、address、tel、source（tencent|amap）',
      items: { type: 'object', additionalProperties: true },
    },
    same_name_merge_m: { type: 'number', description: '同名同点合并阈值（米），默认 50' },
    cross_source_merge_m: { type: 'number', description: '跨源名称相似合并阈值（米），默认 100' },
    cross_source_same_spot_m: { type: 'number', description: '跨源极近直接合并阈值（米），默认 30' },
    name_similarity: { type: 'number', description: '名称相似度阈值 0–1，默认 0.6' },
    category_pattern: {
      type: 'string',
      description:
        '竞品类目白名单正则（可选，留空=不按类目过滤）。示例：便利店「便利店」；茶饮「茶饮|奶茶|咖啡」；'
        + '大型餐饮「酒楼|宴会|海鲜」；火锅「火锅|串串」',
    },
    exclude_pattern: {
      type: 'string',
      description:
        '⚠️ 名称排除规则（只匹配店名，不匹配类目）。示例：排除快餐「快餐|外卖|自助餐」。'
        + '平台类目用词不可靠（"小吃店"可能是高端潮州菜），所以类目排除要单独用 exclude_category_pattern。',
    },
    segments: {
      type: 'array',
      description:
        '竞争分段（按顺序首个命中）：每条 { key, match }。**同段才是直接竞品**，异段是协同或弱竞争。'
        + '用途：品类 × 规模 —— 潮汕粿条店(30㎡) 与 粤菜馆(300㎡) 不是同一段。'
        + '示例：[{key:"yuecai_large",match:"粤菜|顺德|烧腊"},{key:"chaoshan_small",match:"粿条|牛肉饭|潮汕小吃"}]',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true, description: '分段 key，如 yuecai_large' },
          match: { type: 'string', required: true, description: '匹配店名+类目的正则' },
        },
      },
    },
    self_segment: { type: 'string', description: '客户自身所属分段 key；该段数量＝直接竞品数' },
        dining_only: {
          type: 'boolean',
          description: '是否餐饮业态：true 时剔除农贸/生鲜/食品零售等非堂食 POI；'
            + '便利店/超市业态必须传 false，否则会把真竞品剔光',
        },
    exclude_category_pattern: {
      type: 'string',
      description:
        '类目排除规则（只匹配平台类目，可选）。示例：排除超市「超市|百货」、排除便利店「便利店」。'
        + '谨慎使用：类目匹配会误杀真实同类门店。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        raw: { type: 'number', required: true, description: '原始条数' },
        effective: { type: 'number', required: true, description: '清洗去重后的有效竞品数' },
        same_type_count: { type: 'number', required: true, description: '同类型（细分品类）数量＝真正竞品' },
        other_type_count: { type: 'number', required: true, description: '异类数量＝协同客群' },
        self_segment: { type: 'string', required: true, description: '客户所属分段 key；空串=未分段' },
        segments: {
          type: 'array',
          required: true,
          description: '竞争分段统计（品类×规模）：同段才是直接竞品',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string', required: true },
              count: { type: 'number', required: true },
              is_self: { type: 'boolean', required: true },
            },
          },
        },
        kept: {
          type: 'array',
          required: true,
          description: '存活竞品坐标（可直接作为 geo_analyze 的 pois 入参）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              lat: { type: 'number', required: true },
              lng: { type: 'number', required: true },
              segment: { type: 'string', required: true, description: '所属竞争分段 key' },
              same_type: { type: 'boolean', required: true, description: 'true=同段竞品，false=异段协同' },
              cost: { type: 'number', required: true, description: '人均消费；-1=未取到' },
              rating: { type: 'number', required: true, description: '评分；-1=未取到' },
            },
          },
        },
        dropped: {
          type: 'array',
          required: true,
          description: '剔除明细',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              source: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
        merged: {
          type: 'array',
          required: true,
          description: '合并明细',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kept: { type: 'string', required: true },
              merged_from: { type: 'string', required: true },
              source: { type: 'string', required: true },
              distance_m: { type: 'number', required: true },
            },
          },
        },
        brand_groups: {
          type: 'array',
          required: true,
          description: '同品牌多店（≥2 处）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              brand: { type: 'string', required: true },
              count: { type: 'number', required: true },
              nearest_m: { type: 'number', required: true },
            },
          },
        },
        suspicious: {
          type: 'array',
          required: true,
          description: '可疑/待核记录',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              flags: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
        nearest: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: '最近竞品',
          properties: {
            name: { type: 'string', required: true },
            distance_m: { type: 'number', required: true },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: formatDedupeReport(value) }],
  },
  async execute(args) {
    const config: DedupeConfig = {
      sameNameMergeM: args.same_name_merge_m ?? DEDUPE_DEFAULTS.sameNameMergeM,
      crossSourceMergeM: args.cross_source_merge_m ?? DEDUPE_DEFAULTS.crossSourceMergeM,
      crossSourceSameSpotM: args.cross_source_same_spot_m ?? DEDUPE_DEFAULTS.crossSourceSameSpotM,
      nameSimilarity: args.name_similarity ?? DEDUPE_DEFAULTS.nameSimilarity,
      categoryPattern: compilePattern(args.category_pattern, 'category_pattern'),
      excludePattern: compilePattern(args.exclude_pattern, 'exclude_pattern'),
      excludeCategoryPattern: compilePattern(args.exclude_category_pattern, 'exclude_category_pattern'),
      segments: (args.segments ?? []).map((seg: ProfileSegment) => ({
        key: seg.key,
        pattern: compilePattern(seg.match, `segments.${seg.key}`) as RegExp,
      })),
      selfSegment: args.self_segment === undefined || args.self_segment === '' ? undefined : args.self_segment,
      diningOnly: args.dining_only ?? false,
    }
    return analyzePois(args.pois, config)
  },
})

// ---------------------------------------------------------------------------
// crs_guard —— 坐标系守卫（以高德 GCJ-02 为基准）
// ---------------------------------------------------------------------------

const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323
const PI = Math.PI

/** 判断是否在中国境外（境外不做偏移）。 */
function outsideChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLatOffset(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  return ret
}

function transformLngOffset(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  return ret
}

/** WGS84 → GCJ-02（火星坐标）。 */
export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outsideChina(lat, lng)) return { lat, lng }
  const dLat0 = transformLatOffset(lng - 105, lat - 35)
  const dLng0 = transformLngOffset(lng - 105, lat - 35)
  const radLat = (lat / 180) * PI
  const magic = 1 - GCJ_EE * Math.sin(radLat) * Math.sin(radLat)
  const sqrtMagic = Math.sqrt(magic)
  const dLat = (dLat0 * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI)
  const dLng = (dLng0 * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

/** 单点转换结果。 */
interface CrsPoint {
  name: string
  lat: number
  lng: number
  converted: boolean
  shift_m: number
}

export interface CrsGuardResult {
  input_crs: string
  converted: number
  points: CrsPoint[]
  warnings: string[]
}

/** `crs_guard` 的规范返回值。 */
export function guardCoordinates(entries: readonly unknown[], inputCrs: string): CrsGuardResult {
  const warnings: string[] = []
  const points: CrsPoint[] = []
  const crs = inputCrs.trim().toLowerCase()
  let converted = 0

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push('存在非对象的坐标项，已跳过')
      continue
    }
    const raw = entry as Record<string, unknown>
    const coordinate = readCoordinate(raw['location'] ?? raw)
    if (coordinate === undefined) {
      warnings.push(`坐标非法：${String(raw['name'] ?? raw['title'] ?? '(无名称)')}`)
      continue
    }
    const name = String(raw['name'] ?? raw['title'] ?? '(无名称)')
    if (crs === 'wgs84') {
      const fixed = wgs84ToGcj02(coordinate.lat, coordinate.lng)
      const shift = haversine(coordinate.lat, coordinate.lng, fixed.lat, fixed.lng)
      converted += 1
      points.push({ name, lat: Number(fixed.lat.toFixed(6)), lng: Number(fixed.lng.toFixed(6)), converted: true, shift_m: Math.round(shift) })
    } else {
      points.push({ name, lat: coordinate.lat, lng: coordinate.lng, converted: false, shift_m: 0 })
    }
  }

  if (crs !== 'gcj02' && crs !== 'wgs84') {
    warnings.push(`未识别的坐标系「${inputCrs}」，按 GCJ-02 处理；若原始数据是 GPS 导出的 WGS84，距离会出现数百米系统偏差`)
  }
  if (crs === 'wgs84') {
    warnings.push('已按 WGS84→GCJ-02 转换；转换后坐标可直接用于高德/腾讯接口')
  }
  return { input_crs: crs, converted, points, warnings }
}

// ---------------------------------------------------------------------------
// geo_analyze —— 本地空间分析（等时圈估算 / 距离矩阵 / 网格 Voronoi 份额）
// ---------------------------------------------------------------------------

/** 各出行方式的平均速度（米/分钟）与绕行系数。 */
const TRAVEL_MODES: Readonly<Record<string, { speed: number; label: string }>> = {
  walk: { speed: 80, label: '步行' },
  bike: { speed: 250, label: '骑行' },
  car: { speed: 500, label: '驾车（含拥堵）' },
}

/** 直线距离换算为路网距离的经验绕行系数。 */
const DETOUR_FACTOR = 1.35

interface ReachablePoi {
  name: string
  distance_m: number
  inside: boolean
}

interface VoronoiCell {
  name: string
  area_sqm: number
  share_pct: number
}

/** 截流等级：none=无截流｜light=轻度分流｜heavy=重度截流。 */
type InterceptionLevel = 'none' | 'light' | 'heavy'

/** 截流判定阈值（写进返回值，保证结论可复核）。 */
export const INTERCEPT_THRESHOLDS = {
  /** 最近竞品距离 < 此值 → 贴脸，直接判重度 */
  heavy_distance_m: 300,
  /** 最近竞品距离 < 此值 → 至少轻度 */
  light_distance_m: 800,
  /** Top1 份额 ≥ 此值（%）→ 重度的独立触发条件 */
  heavy_top1_share_pct: 30,
  /** Top1 份额 ≥ 此值（%）→ 至少轻度 */
  light_top1_share_pct: 15,
  /** Top3 合计份额 ≥ 此值（%）→ 重度 */
  heavy_top3_share_pct: 60,
  /** Top3 合计份额 ≥ 此值（%）→ 轻度 */
  light_top3_share_pct: 40,
} as const

/** 截流判定阈值快照（写进返回值，保证结论可复核）。 */
interface InterceptThresholds {
  heavy_distance_m: number
  light_distance_m: number
  heavy_top1_share_pct: number
  light_top1_share_pct: number
  heavy_top3_share_pct: number
  light_top3_share_pct: number
}

interface CompetitionResult {
  /** 圈内是否存在竞品；false 时下列各字段为空哨兵 */
  has_competitor: boolean
  /** 等时圈内最近的竞品；无竞品时 { name: '', distance_m: -1 } */
  nearest: { name: string; distance_m: number }
  /** 份额第一的竞品；无竞品时 { name: '', share_pct: 0 } */
  top1: { name: string; share_pct: number }
  /** 前三名份额合计（%） */
  top3_share_pct: number
  /** 候选点位落在谁的 Voronoi 势力范围内：即圈内最近的那家竞品；无竞品时全哨兵 */
  center_in_cell_of: { name: string; distance_m: number; share_pct: number }
  /** 截流定级与触发理由（理由逐条列出，供报告原样引用） */
  interception: { level: InterceptionLevel; label: string; reasons: string[] }
  /** 本次判定使用的阈值快照（保证结论可复核） */
  thresholds: InterceptThresholds
}

interface DistancePair {
  from: string
  to: string
  distance_m: number
}

export interface GeoAnalyzeResult {
  isochrone: {
    mode: string
    minutes: number
    speed_m_per_min: number
    detour_factor: number
    straight_radius_m: number
    note: string
  }
  reachable: ReachablePoi[]
  voronoi: VoronoiCell[]
  /** 竞争格局：Voronoi 归属判定 + 截流定级（本版新增） */
  competition: CompetitionResult
  distance_matrix: DistancePair[]
  coverage: { total_area_sqm: number; poi_count: number }
}

/** `geo_analyze` 的规范返回值。 */
export function analyzeGeography(
  centerLat: number,
  centerLng: number,
  entries: readonly unknown[],
  mode: string,
  minutes: number,
  gridStepM: number,
): GeoAnalyzeResult {
  const travel = TRAVEL_MODES[mode] ?? TRAVEL_MODES['walk']!
  const radius = Math.round((travel.speed * minutes) / DETOUR_FACTOR)

  const pois: { name: string; lat: number; lng: number }[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    const coordinate = readCoordinate(raw['location'] ?? raw)
    if (coordinate === undefined) continue
    pois.push({ name: String(raw['name'] ?? raw['title'] ?? '(无名称)'), lat: coordinate.lat, lng: coordinate.lng })
  }

  const reachable: ReachablePoi[] = pois.map((poi) => {
    const distance = haversine(centerLat, centerLng, poi.lat, poi.lng)
    return { name: poi.name, distance_m: Math.round(distance), inside: distance <= radius }
  })
  reachable.sort((a, b) => a.distance_m - b.distance_m)

  // 网格化 Voronoi（最近站点归属）：只在**等时圈内**逐格判归属，圈外不计入份额
  const step = Math.max(gridStepM, 20)
  const cells = new Map<string, number>()
  let totalArea = 0
  if (pois.length > 0) {
    const half = Math.max(1, Math.ceil(radius / step))
    const cellArea = step * step
    const metersPerDegLat = 111320
    const metersPerDegLng = 111320 * (Math.cos((centerLat * PI) / 180) || 1)
    for (let gy = -half; gy <= half; gy += 1) {
      for (let gx = -half; gx <= half; gx += 1) {
        const lat = centerLat + (gy * step) / metersPerDegLat
        const lng = centerLng + (gx * step) / metersPerDegLng
        // 圈外网格点直接丢弃：Voronoi 份额只统计等时圈覆盖范围
        if (haversine(centerLat, centerLng, lat, lng) > radius) continue
        let best: string | undefined
        let bestDistance = Number.POSITIVE_INFINITY
        for (const poi of pois) {
          const distance = haversine(lat, lng, poi.lat, poi.lng)
          if (distance < bestDistance) {
            bestDistance = distance
            best = poi.name
          }
        }
        if (best === undefined) continue
        cells.set(best, (cells.get(best) ?? 0) + cellArea)
        totalArea += cellArea
      }
    }
  }

  const voronoi: VoronoiCell[] = [...cells.entries()]
    .map(([name, area]) => ({
      name,
      area_sqm: Math.round(area),
      share_pct: totalArea === 0 ? 0 : Number(((area / totalArea) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.area_sqm - a.area_sqm)

  // ---- 竞争格局：Voronoi 归属判定 + 截流定级 ----
  const shareOf = new Map(voronoi.map((cell) => [cell.name, cell.share_pct]))
  const insideReachable = reachable.filter((item) => item.inside)
  const nearestInside = insideReachable[0]
  const top1Cell = voronoi[0]
  const top3Share = Number(
    voronoi
      .slice(0, 3)
      .reduce((sum, cell) => sum + cell.share_pct, 0)
      .toFixed(1),
  )
  const centerInCellOf = nearestInside === undefined
    ? { name: '', distance_m: -1, share_pct: 0 }
    : {
        name: nearestInside.name,
        distance_m: nearestInside.distance_m,
        share_pct: shareOf.get(nearestInside.name) ?? 0,
      }

  const reasons: string[] = []
  let level: InterceptionLevel = 'none'
  if (nearestInside === undefined) {
    reasons.push('等时圈内无竞品记录（先确认为什么没人，可能没需求而非机会）')
  } else {
    const top1Share = top1Cell?.share_pct ?? 0
    const heavyHits: string[] = []
    if (nearestInside.distance_m < INTERCEPT_THRESHOLDS.heavy_distance_m) {
      heavyHits.push(`最近竞品 ${nearestInside.distance_m}m < ${INTERCEPT_THRESHOLDS.heavy_distance_m}m（贴脸）`)
    }
    if (top1Share >= INTERCEPT_THRESHOLDS.heavy_top1_share_pct) {
      heavyHits.push(`Top1「${top1Cell?.name}」占 ${top1Share}% ≥ ${INTERCEPT_THRESHOLDS.heavy_top1_share_pct}%（单一强势玩家）`)
    }
    if (top3Share >= INTERCEPT_THRESHOLDS.heavy_top3_share_pct) {
      heavyHits.push(`Top3 合计 ${top3Share}% ≥ ${INTERCEPT_THRESHOLDS.heavy_top3_share_pct}%（头部包围）`)
    }
    if (heavyHits.length > 0) {
      level = 'heavy'
      reasons.push(...heavyHits)
    } else {
      const lightHits: string[] = []
      if (nearestInside.distance_m < INTERCEPT_THRESHOLDS.light_distance_m) {
        lightHits.push(`最近竞品 ${nearestInside.distance_m}m < ${INTERCEPT_THRESHOLDS.light_distance_m}m（同街竞争）`)
      }
      if (top1Share >= INTERCEPT_THRESHOLDS.light_top1_share_pct) {
        lightHits.push(`Top1「${top1Cell?.name}」占 ${top1Share}% ≥ ${INTERCEPT_THRESHOLDS.light_top1_share_pct}%（有强势玩家但未垄断）`)
      }
      if (top3Share >= INTERCEPT_THRESHOLDS.light_top3_share_pct) {
        lightHits.push(`Top3 合计 ${top3Share}% ≥ ${INTERCEPT_THRESHOLDS.light_top3_share_pct}%（头部集中）`)
      }
      if (lightHits.length > 0) {
        level = 'light'
        reasons.push(...lightHits)
      } else {
        reasons.push('竞品距离与份额均未触发截流阈值（竞争分散）')
      }
    }
  }

  const interceptionLabel: Record<InterceptionLevel, string> = {
    none: '无截流',
    light: '轻度分流',
    heavy: '重度截流',
  }

  const competition: CompetitionResult = {
    has_competitor: nearestInside !== undefined,
    nearest: nearestInside === undefined
      ? { name: '', distance_m: -1 }
      : { name: nearestInside.name, distance_m: nearestInside.distance_m },
    top1: top1Cell === undefined ? { name: '', share_pct: 0 } : { name: top1Cell.name, share_pct: top1Cell.share_pct },
    top3_share_pct: top3Share,
    center_in_cell_of: centerInCellOf,
    interception: { level, label: interceptionLabel[level], reasons },
    thresholds: INTERCEPT_THRESHOLDS,
  }

  const distanceMatrix: DistancePair[] = []
  const limited = pois.slice(0, 20)
  for (let i = 0; i < limited.length; i += 1) {
    for (let j = i + 1; j < limited.length; j += 1) {
      const a = limited[i]
      const b = limited[j]
      if (a === undefined || b === undefined) continue
      distanceMatrix.push({ from: a.name, to: b.name, distance_m: Math.round(haversine(a.lat, a.lng, b.lat, b.lng)) })
    }
  }

  return {
    isochrone: {
      mode: travel.label,
      minutes,
      speed_m_per_min: travel.speed,
      detour_factor: DETOUR_FACTOR,
      straight_radius_m: radius,
      note: `按${travel.label} ${travel.speed} 米/分、绕行系数 ${DETOUR_FACTOR} 估算的等时圈半径（非路网精确等时圈，标注【估算】使用）`,
    },
    reachable,
    voronoi,
    competition,
    distance_matrix: distanceMatrix,
    coverage: { total_area_sqm: Math.round(totalArea), poi_count: pois.length },
  }
}

/** 渲染坐标系守卫结果。 */
function formatCrsReport(result: CrsGuardResult): string {
  const lines = [
    `坐标系守卫：输入 ${result.input_crs.toUpperCase()}｜共 ${result.points.length} 点｜转换 ${result.converted} 个`,
  ]
  if (result.warnings.length > 0) {
    lines.push('提示：')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }
  for (const point of result.points.slice(0, 10)) {
    lines.push(`- ${point.name}：${point.lat}, ${point.lng}${point.converted ? `（已偏移 ${point.shift_m} 米）` : ''}`)
  }
  return lines.join('\n')
}

/** 渲染空间分析结果。 */
function formatGeoReport(result: GeoAnalyzeResult): string {
  const inside = result.reachable.filter((item) => item.inside)
  const lines = [
    `等时圈【估算】：${result.isochrone.mode} ${result.isochrone.minutes} 分钟 → 直线半径约 ${result.isochrone.straight_radius_m} 米`,
    `可达竞品：${inside.length} / ${result.reachable.length} 家`,
    `分析范围：${(result.coverage.total_area_sqm / 1000000).toFixed(2)} 平方公里`,
  ]
  if (result.voronoi.length > 0) {
    lines.push('竞争面积份额（网格 Voronoi，Top5）：')
    for (const cell of result.voronoi.slice(0, 5)) {
      lines.push(`- ${cell.name}：${(cell.area_sqm / 10000).toFixed(1)} 公顷，占 ${cell.share_pct}%`)
    }
  }
  const comp = result.competition
  lines.push(
    `截流定级：${comp.interception.label}（${comp.interception.level}）`
    + `｜圈内最近竞品 ${comp.has_competitor ? `${comp.nearest.name} ${comp.nearest.distance_m}m` : '无'}`
    + `｜Top1 ${comp.has_competitor ? `${comp.top1.name} ${comp.top1.share_pct}%` : '无'}`
    + `｜Top3 合计 ${comp.top3_share_pct}%`,
  )
  if (comp.has_competitor) {
    lines.push(
      `Voronoi 归属：本点位落在「${comp.center_in_cell_of.name}」的势力范围内`
      + `（距离 ${comp.center_in_cell_of.distance_m}m，占圈内面积 ${comp.center_in_cell_of.share_pct}%）`,
    )
  }
  for (const reason of comp.interception.reasons) lines.push(`- ${reason}`)

  if (result.distance_matrix.length > 0) {
    const closest = [...result.distance_matrix].sort((a, b) => a.distance_m - b.distance_m)[0]
    if (closest !== undefined) {
      lines.push(`最近一对竞品：${closest.from} ↔ ${closest.to}：${closest.distance_m} 米`)
    }
  }
  return lines.join('\n')
}

export const crsGuardTool = defineTool({
  name: 'crs_guard',
  description:
    '坐标系守卫：以高德 GCJ-02 为基准，校验输入坐标并自动把 WGS84（GPS 原始）转换为 GCJ-02，'
    + '输出每个点的偏移量。纯本地计算，不联网。',
  parameters: {
    points: {
      type: 'array',
      required: true,
      description: '坐标点数组：{ name?, lat, lng } 或 { name?, location: {lat,lng} }',
      items: { type: 'object', additionalProperties: true },
    },
    input_crs: {
      type: 'string',
      description: '输入坐标系：gcj02（默认，高德/腾讯返回）或 wgs84（手机 GPS 原始点）',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input_crs: { type: 'string', required: true },
        converted: { type: 'number', required: true },
        points: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              lat: { type: 'number', required: true },
              lng: { type: 'number', required: true },
              converted: { type: 'boolean', required: true },
              shift_m: { type: 'number', required: true },
            },
          },
        },
        warnings: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: formatCrsReport(value) }],
  },
  async execute(args) {
    return guardCoordinates(args.points, args.input_crs ?? 'gcj02')
  },
})

export const geoAnalyzeTool = defineTool({
  name: 'geo_analyze',
  description:
    '本地空间分析（不调任何收费接口）：① 按出行方式估算等时圈半径并筛可达竞品；'
    + '② 网格 Voronoi 计算各竞品的竞争面积份额；③ 输出竞品间距离矩阵。'
    + '等时圈为经验估算（速度 ÷ 绕行系数），报告中须标注【估算】。',
  parameters: {
    center: {
      type: 'object',
      additionalProperties: false,
      required: true,
      description: '分析中心点（GCJ-02）',
      properties: {
        lat: { type: 'number', required: true },
        lng: { type: 'number', required: true },
      },
    },
    pois: {
      type: 'array',
      required: true,
      description: '竞品点数组：{ name, lat, lng } 或 { name, location: {lat,lng} }',
      items: { type: 'object', additionalProperties: true },
    },
    mode: { type: 'string', description: 'walk（默认）| bike | car' },
    minutes: { type: 'number', description: '等时圈时长（分钟），默认 10' },
    grid_step_m: { type: 'number', description: 'Voronoi 网格边长（米），默认 100' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        isochrone: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            mode: { type: 'string', required: true },
            minutes: { type: 'number', required: true },
            speed_m_per_min: { type: 'number', required: true },
            detour_factor: { type: 'number', required: true },
            straight_radius_m: { type: 'number', required: true },
            note: { type: 'string', required: true },
          },
        },
        reachable: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              distance_m: { type: 'number', required: true },
              inside: { type: 'boolean', required: true },
            },
          },
        },
        voronoi: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              area_sqm: { type: 'number', required: true },
              share_pct: { type: 'number', required: true },
            },
          },
        },
        competition: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: '竞争格局：Voronoi 归属判定 + 截流定级',
          properties: {
            has_competitor: {
              type: 'boolean',
              required: true,
              description: '等时圈内是否存在竞品；false 时下面的对象字段为哨兵值',
            },
            nearest: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: '圈内最近竞品；无竞品时 name="" 且 distance_m=-1',
              properties: {
                name: { type: 'string', required: true },
                distance_m: { type: 'number', required: true },
              },
            },
            top1: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: '份额第一的竞品；无竞品时 name="" 且 share_pct=0',
              properties: {
                name: { type: 'string', required: true },
                share_pct: { type: 'number', required: true },
              },
            },
            top3_share_pct: { type: 'number', required: true, description: '前三名份额合计（%）' },
            center_in_cell_of: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: '本点位落在谁的 Voronoi 势力范围内；无竞品时全为哨兵值',
              properties: {
                name: { type: 'string', required: true },
                distance_m: { type: 'number', required: true },
                share_pct: { type: 'number', required: true },
              },
            },
            interception: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: '截流定级',
              properties: {
                level: {
                  type: 'string',
                  required: true,
                  enum: ['none', 'light', 'heavy'],
                  description: 'none=无截流｜light=轻度分流｜heavy=重度截流',
                },
                label: { type: 'string', required: true, description: '中文标签' },
                reasons: {
                  type: 'array',
                  required: true,
                  description: '触发理由（逐条可引用）',
                  items: { type: 'string' },
                },
              },
            },
            thresholds: {
              type: 'object',
              required: true,
              additionalProperties: false,
              description: '本次使用的阈值快照（可复核）',
              properties: {
                heavy_distance_m: { type: 'number', required: true, description: '贴脸距离阈值（米）' },
                light_distance_m: { type: 'number', required: true, description: '同街距离阈值（米）' },
                heavy_top1_share_pct: { type: 'number', required: true, description: 'Top1 份额重度阈值（%）' },
                light_top1_share_pct: { type: 'number', required: true, description: 'Top1 份额轻度阈值（%）' },
                heavy_top3_share_pct: { type: 'number', required: true, description: 'Top3 合计重度阈值（%）' },
                light_top3_share_pct: { type: 'number', required: true, description: 'Top3 合计轻度阈值（%）' },
              },
            },
          },
        },
        distance_matrix: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string', required: true },
              to: { type: 'string', required: true },
              distance_m: { type: 'number', required: true },
            },
          },
        },
        coverage: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            total_area_sqm: { type: 'number', required: true },
            poi_count: { type: 'number', required: true },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: formatGeoReport(value) }],
  },
  async execute(args) {
    return analyzeGeography(
      args.center.lat,
      args.center.lng,
      args.pois,
      args.mode ?? 'walk',
      args.minutes ?? 10,
      args.grid_step_m ?? 100,
    )
  },
})

// ---------------------------------------------------------------------------
// 行业基准库（由 tools/base-data/*.json 提供，来源见 base-data/README）
// ---------------------------------------------------------------------------

/** 基准库中的一行（城市 × 具体业态）。 */
interface BenchmarkRow {
  city: string
  city_level: string | null
  category: string | null
  format: string | null
  area_sqm: number | null
  investment_wan: number | null
  rent_wan: number | null
  avg_ticket: number | null
  daily_customers: number | null
  revenue_wan: number | null
  net_margin: number | null
  net_profit_wan: number | null
  payback_months: number | null
  note: string | null
}

interface CityBaseline {
  city: string | null
  city_level: string | null
  population_wan: number | null
  mall_gf_rent_per_sqm: number | null
  street_shop_rent_per_sqm_day: number | null
  avg_ticket: number | null
  growth_2025: string | null
  key_districts: string | null
}

const BENCHMARK_DIR_NOTE = 'tools/base-data（由 tools/import-benchmarks.py 生成）'

/** 懒加载：把紧凑元组转成对象，只做一次。 */
let benchmarkCache: { rows: BenchmarkRow[]; cities: CityBaseline[] } | null = null

function loadBenchmarks(): { rows: BenchmarkRow[]; cities: CityBaseline[] } {
  if (benchmarkCache !== null) return benchmarkCache
  const rows: BenchmarkRow[] = BENCH_ROWS.map((t) => ({
    city: BENCH_CITIES[t[0] ?? -1] ?? '',
    // 城市级别是城市属性，行里没有——从 CITY_BASELINES 按城市名回查
    city_level: CITY_BASELINES.find((c) => c[0] === (BENCH_CITIES[t[0] ?? -1] ?? ''))?.[1] ?? null,
    category: BENCH_CATEGORIES[t[2] ?? -1] ?? null,
    format: BENCH_FORMATS[t[1] ?? -1] ?? null,
    area_sqm: t[3] ?? 0,
    investment_wan: t[4] ?? 0,
    rent_wan: t[5] ?? 0,
    avg_ticket: t[6] ?? 0,
    daily_customers: t[7] ?? 0,
    revenue_wan: t[8] ?? 0,
    net_margin: t[9] ?? 0,
    net_profit_wan: t[10] ?? 0,
    payback_months: t[11] ?? 0,
    note: null,
  }))
  const cities: CityBaseline[] = CITY_BASELINES.map((c) => ({
    city: c[0],
    city_level: c[1],
    population_wan: c[2],
    mall_gf_rent_per_sqm: c[3],
    street_shop_rent_per_sqm_day: c[4],
    avg_ticket: c[5],
    growth_2025: null,
    key_districts: null,
  }))
  benchmarkCache = { rows, cities }
  return benchmarkCache
}

/** 一条对标结论。 */
export interface BenchmarkCompare {
  item: string
  ours: number
  benchmark: number
  /** 偏离百分比：正数表示我们高于基准 */
  deviation_pct: number
  unit: string
  verdict: 'ok' | 'high' | 'low'
  note: string
}

/** 基准对标结果。 */
export interface BenchmarkResult {
  matched: boolean
  city: string
  query_format: string
  matched_format: string
  category: string
  /** 该业态在库里覆盖的城市数（样本量） */
  sample_size: number
  /** 库里所有城市的回本月数区间与中位 */
  payback_median: number
  payback_min: number
  payback_max: number
  benchmark: {
    area_sqm: number
    investment_wan: number
    rent_wan: number
    avg_ticket: number
    daily_customers: number
    revenue_wan: number
    net_margin: number
    payback_months: number
  }
  compares: BenchmarkCompare[]
  city_baseline: {
    found: boolean
    city_level: string
    population_wan: number
    mall_gf_rent_per_sqm: number
    street_shop_rent_per_sqm_day: number
    avg_ticket: number
  }
  /** 候选业态（匹配不唯一时给出前三个，便于人工纠正） */
  candidates: string[]
  note: string
}

/** 业态名匹配：关键词命中计分，返回得分最高的业态与其得分。 */
function matchFormat(query: string, formats: readonly string[]): { format: string; score: number } {
  const q = query.trim()
  if (q === '') return { format: '', score: 0 }
  if (formats.includes(q)) return { format: q, score: 100 }

  const tokens = q.split(/[\/、（）()·\s]+/).filter((t) => t.length >= 2)
  let best = { format: '', score: 0 }
  for (const f of formats) {
    let score = 0
    if (f.includes(q) || q.includes(f)) score += 20
    for (const t of tokens) if (f.includes(t)) score += 10
    for (const t of tokens) if (t.includes(f.slice(0, 2))) score += 3
    if (score > best.score) best = { format: f, score }
  }
  return best
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** 偏离判定：基准表自带「单店实际 ±30%」说明，故 30% 内视为正常。 */
function judgeDeviation(ours: number, bench: number, unit: string): BenchmarkCompare {
  const dev = bench !== 0 ? ((ours - bench) / Math.abs(bench)) * 100 : 0
  const verdict: 'ok' | 'high' | 'low' = Math.abs(dev) <= 30 ? 'ok' : dev > 0 ? 'high' : 'low'
  return {
    item: '',
    ours,
    benchmark: bench,
    deviation_pct: roundTo(dev, 1),
    unit,
    verdict,
    note:
      verdict === 'ok'
        ? '在基准 ±30% 内'
        : dev > 0
          ? '高于行业基准 30% 以上：要么本项目条件更优，要么参数估高了'
          : '低于行业基准 30% 以上：要么参数估低了（常见于投入漏项），要么定位更轻',
  }
}

/** 行业基准对标：把我们算出来的数，放到 19 城 × 48 业态的基准里看偏离。 */
export function checkBenchmark(input: {
  city: string
  format: string
  area_sqm?: number
  initial_investment_wan?: number
  monthly_rent_wan?: number
  avg_ticket?: number
  daily_revenue_wan?: number
  accounting_payback_months?: number
  net_margin?: number
}, deviation_pct = 30): BenchmarkResult {
  const { rows, cities } = loadBenchmarks()
  const empty = (note: string): BenchmarkResult => ({
    matched: false,
    city: input.city,
    query_format: input.format,
    matched_format: '',
    category: '',
    sample_size: 0,
    payback_median: 0,
    payback_min: 0,
    payback_max: 0,
    benchmark: {
      area_sqm: 0, investment_wan: 0, rent_wan: 0, avg_ticket: 0,
      daily_customers: 0, revenue_wan: 0, net_margin: 0, payback_months: 0,
    },
    compares: [],
    city_baseline: {
      found: false, city_level: '', population_wan: 0,
      mall_gf_rent_per_sqm: 0, street_shop_rent_per_sqm_day: 0, avg_ticket: 0,
    },
    candidates: [],
    note,
  })

  if (rows.length === 0) {
    return empty('基准库未找到（tools/base-data/formats.json），请先运行 tools/import-benchmarks.py')
  }

  const formats = [...new Set(rows.map((r) => r.format).filter((f): f is string => f !== null))]
  const hit = matchFormat(input.format, formats)
  if (hit.score === 0) {
    return empty(`未匹配到业态「${input.format}」，请改用库内业态名（见 candidates）`)
  }

  const candidates = formats
    .map((f) => ({ f, s: matchFormat(input.format, [f]).score }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.f)

  const all = rows.filter((r) => r.format === hit.format)
  const paybacks = all.map((r) => r.payback_months).filter((v): v is number => typeof v === 'number' && v > 0)
  const sameCity = all.find((r) => r.city === input.city) ?? all[0]
  if (sameCity === undefined) return empty('基准库中该业态没有可用行')

  const cityHit = cities.find((c) => c.city === input.city)

  const compares: BenchmarkCompare[] = []
  const add = (item: string, ours: number | undefined, bench: number | null, unit: string) => {
    if (ours === undefined || typeof bench !== 'number' || bench <= 0) return
    const row = judgeDeviation(ours, bench, unit)
    row.item = item
    compares.push(row)
  }

  // 面积单独处理：偏离方向的含义和其他指标不同（面积大了 = 单位产出被摊薄）
  if (input.area_sqm !== undefined && input.area_sqm > 0 && (sameCity.area_sqm ?? 0) > 0) {
    const benchArea = sameCity.area_sqm as number
    const dev = roundTo(((input.area_sqm - benchArea) / benchArea) * 100, 1)
    const verdict: 'ok' | 'high' | 'low' = Math.abs(dev) <= deviation_pct ? 'ok' : dev > 0 ? 'high' : 'low'
    compares.push({
      item: '营业面积',
      ours: input.area_sqm,
      benchmark: benchArea,
      deviation_pct: dev,
      unit: '㎡',
      verdict,
      note: verdict === 'ok'
        ? '与该业态典型规模同量级'
        : dev > 0
          ? '面积远大于该业态典型规模：要么业态定位不同，要么面积选大了——单位面积产出会被摊薄'
          : '面积小于该业态典型规模：注意后厨与动线能否放得下',
    })
  }

  add('初始投资', input.initial_investment_wan, sameCity.investment_wan, '万元')
  add('月租金', input.monthly_rent_wan, sameCity.rent_wan, '万元')
  add('客单价', input.avg_ticket, sameCity.avg_ticket, '元')
  add('月营业额', input.daily_revenue_wan, sameCity.revenue_wan, '万元')
  add('会计口径回本', input.accounting_payback_months, sameCity.payback_months, '月')
  add('净利率', input.net_margin !== undefined ? roundTo(input.net_margin * 100, 1) : undefined, sameCity.net_margin !== null && sameCity.net_margin > 0 ? roundTo(sameCity.net_margin * 100, 1) : null, '%')

  const flagged = compares.filter((c) => c.verdict !== 'ok')
  const note = flagged.length === 0
    ? `各项均在「${sameCity.city}·${hit.format}」基准 ±${deviation_pct}% 内`
    : `有 ${flagged.length} 项偏离基准超过 ${deviation_pct}%：${flagged.map((c) => `${c.item} ${c.deviation_pct > 0 ? '+' : ''}${c.deviation_pct}%`).join('、')}`

  return {
    matched: true,
    city: input.city,
    query_format: input.format,
    matched_format: hit.format,
    category: sameCity.category ?? '',
    sample_size: all.length,
    payback_median: roundTo(median(paybacks), 1),
    // 空数组时 Math.min(...[]) = Infinity、Math.max(...[]) = -Infinity，
    // 会直接写进 JSON（JSON 不支持 Infinity → 序列化失败）。先判空。
    payback_min: paybacks.length > 0 ? roundTo(Math.min(...paybacks), 1) : -1,
    payback_max: paybacks.length > 0 ? roundTo(Math.max(...paybacks), 1) : -1,
    benchmark: {
      area_sqm: Math.max(0, sameCity.area_sqm ?? 0),
      investment_wan: Math.max(0, sameCity.investment_wan ?? 0),
      rent_wan: Math.max(0, sameCity.rent_wan ?? 0),
      avg_ticket: Math.max(0, sameCity.avg_ticket ?? 0),
      daily_customers: Math.max(0, sameCity.daily_customers ?? 0),
      revenue_wan: Math.max(0, sameCity.revenue_wan ?? 0),
      net_margin: Math.max(0, sameCity.net_margin ?? 0),
      payback_months: Math.max(0, sameCity.payback_months ?? 0),
    },
    compares,
    city_baseline: {
      found: cityHit !== undefined,
      city_level: cityHit?.city_level ?? '',
      population_wan: cityHit?.population_wan ?? 0,
      mall_gf_rent_per_sqm: cityHit?.mall_gf_rent_per_sqm ?? 0,
      street_shop_rent_per_sqm_day: cityHit?.street_shop_rent_per_sqm_day ?? 0,
      avg_ticket: cityHit?.avg_ticket ?? 0,
    },
    candidates,
    note,
  }
}

function formatBenchmarkReport(r: BenchmarkResult): string {
  const lines: string[] = []
  if (!r.matched) {
    lines.push(`行业基准对标：未匹配 —— ${r.note}`)
    if (r.candidates.length > 0) lines.push(`候选业态：${r.candidates.join('、')}`)
    return lines.join('\n')
  }
  lines.push(`行业基准对标：${r.city} · ${r.matched_format}（${r.category}）｜样本 ${r.sample_size} 城`)
  lines.push(`该业态回本月数：中位 ${r.payback_median}｜区间 ${r.payback_min}~${r.payback_max}`)
  lines.push(
    `本城市基准行：面积 ${r.benchmark.area_sqm}㎡｜投资 ${r.benchmark.investment_wan} 万`
    + `｜租金 ${r.benchmark.rent_wan} 万｜客单 ${r.benchmark.avg_ticket}`
    + `｜客流 ${r.benchmark.daily_customers}｜净利率 ${roundTo(r.benchmark.net_margin * 100, 1)}%`
    + `｜回本 ${r.benchmark.payback_months} 月`,
  )
  if (r.compares.length > 0) {
    lines.push('逐项对标：')
    for (const c of r.compares) {
      const flag = c.verdict === 'ok' ? '✓' : c.verdict === 'high' ? '↑' : '↓'
      lines.push(
        `- ${flag} ${c.item}：我们 ${c.ours}${c.unit} vs 基准 ${c.benchmark}${c.unit}`
        + `（${c.deviation_pct > 0 ? '+' : ''}${c.deviation_pct}%）${c.verdict === 'ok' ? '' : `｜${c.note}`}`,
      )
    }
  }
  lines.push(`结论：${r.note}`)
  if (r.city_baseline.found) {
    lines.push(
      `城市基准：${r.city_baseline.city_level}｜人口 ${r.city_baseline.population_wan} 万`
      + `｜购物中心首层租金 ${r.city_baseline.mall_gf_rent_per_sqm} 元/㎡/月`
      + `｜街铺 ${r.city_baseline.street_shop_rent_per_sqm_day} 元/㎡/天`,
    )
  }
  return lines.join('\n')
}

export const benchmarkCheckTool = defineTool({
  name: 'benchmark_check',
  description:
    '行业基准对标：把本项目算出来的数（投资/租金/客单/营业额/回本/净利率）'
    + '放到 19 城 × 48 业态的行业基准库（tools/base-data）里逐项比对，'
    + '输出偏离百分比与判定。基准为行业估算区间（单店实际 ±30%），**只作现实性校验，不替代单店参数**。',
  parameters: {
    city: { type: 'string', required: true, description: '城市名，如「广州」' },
    format: { type: 'string', required: true, description: '业态名，如「粤式茶楼早茶」「平价茶饮」；支持关键词模糊匹配' },
    area_sqm: { type: 'number', description: '本项目建筑面积（㎡）' },
    initial_investment_wan: { type: 'number', description: '本项目初始投入（万元）' },
    monthly_rent_wan: { type: 'number', description: '本项目月租金（万元）' },
    avg_ticket: { type: 'number', description: '本项目客单价（元）' },
    daily_revenue_wan: { type: 'number', description: '本项目月营业额（万元）' },
    accounting_payback_months: { type: 'number', description: '本项目会计口径回本月数' },
    net_margin: { type: 'number', description: '本项目净利率（小数，如 0.11）' },
    deviation_pct: { type: 'number', description: '允许偏离百分比，默认 30（基准表自带 ±30% 说明）' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        matched: { type: 'boolean', required: true, description: '是否匹配到基准业态' },
        city: { type: 'string', required: true },
        query_format: { type: 'string', required: true },
        matched_format: { type: 'string', required: true },
        category: { type: 'string', required: true },
        sample_size: { type: 'number', required: true },
        payback_median: { type: 'number', required: true },
        payback_min: { type: 'number', required: true },
        payback_max: { type: 'number', required: true },
        benchmark: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            area_sqm: { type: 'number', required: true },
            investment_wan: { type: 'number', required: true },
            rent_wan: { type: 'number', required: true },
            avg_ticket: { type: 'number', required: true },
            daily_customers: { type: 'number', required: true },
            revenue_wan: { type: 'number', required: true },
            net_margin: { type: 'number', required: true },
            payback_months: { type: 'number', required: true },
          },
        },
        compares: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              item: { type: 'string', required: true },
              ours: { type: 'number', required: true },
              benchmark: { type: 'number', required: true },
              deviation_pct: { type: 'number', required: true },
              unit: { type: 'string', required: true },
              verdict: { type: 'string', required: true, enum: ['ok', 'high', 'low'] },
              note: { type: 'string', required: true },
            },
          },
        },
        city_baseline: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            found: { type: 'boolean', required: true },
            city_level: { type: 'string', required: true },
            population_wan: { type: 'number', required: true },
            mall_gf_rent_per_sqm: { type: 'number', required: true },
            street_shop_rent_per_sqm_day: { type: 'number', required: true },
            avg_ticket: { type: 'number', required: true },
          },
        },
        candidates: { type: 'array', required: true, items: { type: 'string' } },
        note: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: formatBenchmarkReport(value) }],
  },
  async execute(args) {
    return checkBenchmark(args, args.deviation_pct ?? 30)
  },
})

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx: Context) {
  ctx.tools.register(vetoCheckTool)
  ctx.tools.register(financialCalcTool)
  ctx.tools.register(poiDedupeTool)
  ctx.tools.register(crsGuardTool)
  ctx.tools.register(geoAnalyzeTool)
  ctx.tools.register(benchmarkCheckTool)
}
