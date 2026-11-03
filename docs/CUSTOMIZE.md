# 自定义与地区适配

> 本文件教你把项目改造成**你自己城市、你自己业态**能用的样子。
> 三处可替换：**城市基准库**、**业态规则**、**单店参数**。全部改文件，不改代码。

---

## 0. 先弄清三处分别管什么

| 改哪 | 文件 | 管什么 | 影响 |
|---|---|---|---|
| **城市基准** | `data/benchmarks.json` | 同城市同业态的行业平均值（面积、投资、租金、回本） | 财务结论的**现实性校验** |
| **业态规则** | `data/formats.json` | 该业态的目标回本月数、租售比区间、比值区间、空间参数 | **极限租金反推**与所有区间判定 |
| **单店参数** | `params/<业态>.json` | 某一个项目的经验系数 | 覆盖前两者的默认值 |

优先级：**单店参数 > 业态规则 > 内置默认**。

---

## 1. 上海用户：基准库里已经有，但要选对业态

上海在基准库的 19 个城市里。查一下你有多少可选项：

```bash
python scripts/site_core.py benchmark --city 上海 --format 本帮菜 --area 600 --rent-wan 9 --ticket 120
```

**第一个坑：业态名要对得上。**

基准库用的是原始业态名（如「早餐包子铺档口(15-30㎡)」），传「包子铺」能模糊匹配上，传「早餐」不一定。

先看有哪些业态：

```bash
python -c "import json;d=json.load(open('data/benchmarks.json',encoding='utf-8'));print(sorted({r['format'] for r in d['rows']}))"
```

**第二个坑：上海的城市系数。**

`data/cities.json` 里上海相对广州的系数是：

| 系数 | 上海 / 广州 |
|---|---|
| 投资系数 | 1.15 |
| 租金系数 | 1.30 |
| 客单价系数 | 1.20 |
| 客流系数 | 1.10 |

也就是说**同样的面积和业态，上海的租金基准比广州高 30%**。用广州的参数直接套上海，会低估租金压力、高估回本速度。

**第三个坑：本帮菜没有专属参数——但已经内置了。**

`data/formats.json` 出厂就带 4 条规则（鲁菜、本帮菜、烧烤火锅、面食），开箱即用。\n\n想改数值直接编辑该文件：

```json
{
  "formats": [
    {
      "pattern": "benbang|本帮|上海菜",
      "label": "本帮正餐",
      "payback_months": 30,
      "rent_ratio": [0.10, 0.16],
      "ratios": {
        "gross_margin": [0.58, 0.68],
        "labor_ratio": [0.22, 0.30],
        "investment_per_sqm": [4000, 6500]
      }
    }
  ]
}
```

验证：

```bash
python scripts/site_core.py formats          # 看当前生效规则
python scripts/site_core.py formats --formats data/formats.json   # 看加载了几个外部规则
```

---

## 2. 山东用户：基准库里只有青岛

已覆盖 19 城：上海、广州、深圳、佛山、重庆、成都、杭州、武汉、苏州、西安、南京、长沙、天津、**青岛**、宁波、东莞、郑州、合肥、昆明。

济南 / 烟台 / 潍坊 / 临沂 **没有**。程序不会静默套用别的城市，而是明确报错：

```bash
python scripts/site_core.py benchmark --city 济南 --format 鲁菜 --area 800 --rent-wan 8 --ticket 60
```

返回：

```json
{
  "city_in_benchmark": false,
  "available_cities": ["上海", "东莞", "佛山", ...],
  "note": "基准库没有「济南」的数据……为避免误导，不自动套用其他城市"
}
```

### 补录济南基准

在 `data/benchmarks.json` 的 `rows` 数组里加行，字段照抄现有行：

```json
{
  "city": "济南",
  "city_level": "二线",
  "category": "中式正餐",
  "format": "鲁菜正餐(300-800㎡)",
  "area_sqm": 600.0,
  "investment_wan": 180.0,
  "rent_wan": 7.5,
  "avg_ticket": 88.0,
  "daily_customers": 160.0,
  "revenue_wan": 42.24,
  "net_margin": 0.14,
  "net_profit_wan": 5.91,
  "payback_months": 30.5,
  "note": "数据来源：__（填你的依据）"
}
```

> **必填**：`city`、`format`、`area_sqm`、`investment_wan`、`rent_wan`、`avg_ticket`、`payback_months`
> **建议填**：`net_margin`、`revenue_wan`、`note`（注明数据来源，别人才能复核）

补完验证：

```bash
python scripts/site_core.py benchmark --city 济南 --format 鲁菜 --area 600 --rent-wan 7.5 --ticket 88
# 应返回 city_in_benchmark: true
```

### 也可以不补，改用邻近城市并写明

在报告里写清楚「济南无基准，参照青岛（同省、城市级别相近）」，把这句话留在台账里。**这比静默套用诚实得多。**

---

## 3. 业态规则文件怎么用

`data/formats.json` 结构：

```json
{
  "version": "1.0",
  "formats": [
    {
      "pattern": "正则表达式，匹配 --format 传入的值",
      "label": "报告里显示的业态名",
      "payback_months": 30,
      "rent_ratio": [0.10, 0.16],
      "ratios": {
        "gross_margin": [0.58, 0.68],
        "labor_ratio": [0.22, 0.30],
        "investment_per_sqm": [4000, 6500]
      },
      "space": {
        "kitchen_ratio": 0.32,
        "seat_area_sqm": 2.6,
        "normal_turnover": 2.2,
        "turnover_cap": 3.2,
        "tmin": 80,
        "tmax": 260
      }
    }
  ]
}
```

### 字段含义

| 字段 | 含义 | 影响什么 |
|---|---|---|
| `pattern` | 正则，对业态代码做匹配 | 决定命中哪条规则 |
| `payback_months` | 目标回本月数 | **极限租金·目标回本** 与建议锚点 |
| `rent_ratio` | 租售比健康区间 `[下限, 上限]` | 租售比「偏高 / 破线」判定 |
| `ratios.gross_margin` | 毛利率区间 | 毛利率越界提示 |
| `ratios.labor_ratio` | 人力占营收区间 | **人力估少**的主要发现手段 |
| `ratios.investment_per_sqm` | 单方造价区间 元/㎡ | **投入漏项**的主要发现手段 |
| `space.*` | 厨房比、每座面积、翻台、客单价区间 | 空间容量对账 |

### 三条规则

1. **可以只写一部分**：没写的字段沿用内置默认，不用全填
2. **外部规则优先**：同一业态，本文件里的规则先命中
3. **顺序有效**：多条正则都能命中时，数组里靠前的生效

### 已验证的行为

```
不加载外部规则：  benbang -> 24 月 / 中型正餐
加载后：          benbang -> 30 月 / 本帮正餐 / 租售比 10~16%
```

---

## 4. 单店参数怎么用

复制模板：

```bash
cp params/_template.json params/my_store.json
```

改这几个即可（其余删掉就沿用默认）：

| 字段 | 作用 |
|---|---|
| `payback_months` | 这个老板能接受几个月回本 |
| `rent_ratio_healthy_max` / `_warning_max` | 租售比健康线 / 警戒线 |
| `gross_margin_min/max` | 该店实际毛利率区间 |
| `labor_ratio_min/max` | 该店实际人力区间 |
| `tax_rate` / `amortization_months` | 实际税负与折旧年限 |
| `_说明`、`param_source` | **必填**：这组数谁定的、依据是什么 |

调用时指定：

```bash
python scripts/site_core.py finance --format my_store --area 600 \
  --params params/my_store.json --out finance.json
```

> `param_source` 不是摆设。报告会把「这组参数谁定的」写进假设台账，没有来源的参数会被标为「未提供」。

---

## 5. 验证清单

改完任何一处，跑这三条：

```bash
# 1) 核心引擎没坏
python scripts/site_core.py selftest

# 2) 业态规则生效了
python scripts/site_core.py formats

# 3) 基准库查得到你的城市
python scripts/site_core.py benchmark --city <你的城市> --format <你的业态> \
  --area 600 --rent-wan 9 --ticket 100
```

三条都过，再跑正式测算。

---

## 6. 常见错误

| 现象 | 原因 | 解决 |
|---|---|---|
| `city_in_benchmark: false` | 该城市没录 | 补录，或改用邻近城市并写明来源 |
| 业态落到「中型正餐」 | 正则没命中 | 在 `formats.json` 加 `pattern` |
| `formats` 显示 `external_rules: 0` | 文件路径不对或 JSON 语法错 | 用 `--formats` 指定绝对路径；`python -m json.tool` 验语法 |
| 租金区间明显不合理 | 直接套了别的城市 | 改 `data/cities.json` 的系数，或补录本地基准 |
| 报告说「参数未校准」 | 用了内置默认值 | 正常行为，补齐 `params/<业态>.json` 即可 |
