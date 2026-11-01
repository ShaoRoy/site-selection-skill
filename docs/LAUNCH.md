# 上线检查清单

> 每次交付前按此表过一遍。全部打勾才算可用。

---

## 一、代码健康

```powershell
cd scratch-plugin
pnpm verify
```

- [ ] `pnpm typecheck` 0 error
- [ ] `pnpm test` 全绿（当前 **200 条**：veto 13 / geo 17 / dedupe 15 / segments 13 / finance 73 / report 33 / benchmark 20 / grid 16）
- [ ] `python tools/grid-registry.py --self-test` 12/12

## 二、端到端跑通（用模拟数据，不动真实业务数）

```powershell
node tools\run-site.mjs --profile=large-yuecai `
  --address="广州白鹅潭万象城" `
  --survey="survey\白鹅潭万象城-模拟.csv" --no-open
```

模拟数据集在 `survey/白鹅潭万象城-模拟.csv`，**所有值都标了【模拟】**，用途只有一个：验证框架不崩。

- [ ] 退出码 0
- [ ] 报告 8 个 `##` 段齐全
- [ ] 报告里搜不到 `NaN` / `undefined` / `Infinity` / `null` / `[object`
- [ ] 财务表三档齐全，无 `-0`、无负回本（除非确实无法回本，显示"无法回本"）
- [ ] 「距锚点」为负时显示「**无需降**，尚有余量 X」，不是负数
- [ ] html 与 md 内容一致（建议租金、极限租金、比值校验、口径附录都在）
- [ ] `out/index.md` 新增一行
- [ ] `out/grid/registry.json` 状态推进到「已评估」
- [ ] `out/<点位>/history/<时间戳>/` 生成快照

## 三、留痕与历史

- [ ] 每次跑完 `status.json` 更新
- [ ] registry `history` 追加一条（不覆盖）
- [ ] `history/` 保留最近 20 份快照，更早的自动清理

## 四、交付物

| 文件 | 是否随报告交付 |
|---|---|
| `report.html` | ✅ 主交付物 |
| `report.md` | ✅ 便于复制到文档 |
| `probe.json` | ✅ 所有数字的出处 |
| `survey.json` | ✅ 调研表 + 财务结果 |
| `map.html` | ✅ **单独打开**（1000×720，不嵌报告） |
| `history/` | 内部留存，不交付 |

## 五、必须标注的口径（少一条都算不合格）

- [ ] 等时圈来源（valhalla / osrm / 直线估算【估算】）
- [ ] 采集可信度（`data_quality.verdict`）
- [ ] 低置信参数（标【预估】）
- [ ] 需求侧标注「代理指标，不是实测人口」
- [ ] 行业基准标注「行业估算区间 ±30%，不替代单店实测」
- [ ] 点位截流力标注「现场判定」，与竞争截流**分两行写**
- [ ] 缺调研表时，第 5、6 段明确写「未提供调研表」，**不得用估算补**
- [ ] 模拟数据必须标【模拟】，交付前替换成真实值

## 六、已知限制（交付时口头说明）

1. **等时圈是直线估算**（Docker 未启）——品类排序够用，绝对值偏乐观
2. **动线阻断靠现场**——报告第 2.5 段只在有实测数据时出现
3. **行业基准是行业平均**——单店实际 ±30%
4. **人口维度用 POI 代理**——不是真实人口
5. **财务参数来自调研表**——租金、面积、投入、人力、客单，少一个都不出财务段

## 七、常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot find module './population.mjs'` | 归档后 import 未改 | 应指向 `./legacy/population.mjs` |
| 需求侧第 4 段为空 | `survey/demand/*.json` 地址对不上 | 检查 `demand` 文件里的 `address` |
| 财务段跳过 | 调研表没有 `param` 行 | 补 `param,<键>,<值>,<来源>,<置信度>` |
| 报告被覆盖 | 输出目录没带点位名 | 检查 `${slug}-${addrSlug}/` |
| 高德返回 0 | 配额耗尽/Key 失效 | 看 `data_quality.verdict`，查 `survey/demand/.quota.json` |
| 中文乱码 | PowerShell 未指定编码 | `Get-Content -Encoding utf8` |
