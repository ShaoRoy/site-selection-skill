#!/usr/bin/env node
/**
 * 调研表示例数据守卫。
 *
 * 存在原因：`survey/*.csv` 里混有带「示例参数」来源标记的样例数据，与真实踏勘
 * 数据同目录存放。Agent 读取时无法从路径判断真伪，容易把样例当实测代入结论。
 * 本脚本把「哪几份是示例」变成可执行登记：新增或删除示例标记而不同步登记，即失败。
 *
 * 用法：
 *   node tools/check-survey-data.mjs            # 只报告，有未登记项仅提示
 *   node tools/check-survey-data.mjs --strict   # 未登记/登记失效即退出 1（发版用）
 *
 * 注：`survey/` 在 .gitignore 内，干净发布包没有该目录 —— 此时显式 SKIP 并退出 0。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SURVEY = join(HERE, '..', 'survey');

// 已登记的示例调研表：文件名 → 说明
const EXPECTED_EXAMPLES = {
  'BJ-WJ-huntun.csv': '北京望京馄饨（部分字段为示例参数）',
  'GZ-HCH-large-yuecai.csv': '广州花城汇大型粤菜（部分字段为示例参数）',
  'GZ-JNX-huntun.csv': '广州江南西馄饨（部分字段为示例参数）',
  'GZ-KC-huntun.csv': '广州客村馄饨（部分字段为示例参数）',
};

const strict = process.argv.includes('--strict');
let failed = 0;

function fail(msg) {
  console.log(`FAIL  ${msg}`);
  failed += 1;
}

if (!existsSync(SURVEY)) {
  console.log('SKIP  survey/ 不存在（干净发布包正常现象）');
  process.exit(0);
}

const files = readdirSync(SURVEY).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
const actualExamples = new Set();
const real = [];

for (const f of files) {
  const text = readFileSync(join(SURVEY, f), 'utf8');
  const hits = text.split('\n').filter((l) => l.includes('示例')).length;
  if (hits > 0) actualExamples.add(f);
  else real.push(f);
}

console.log(`调研表 ${files.length} 份：真实 ${real.length} / 含示例标记 ${actualExamples.size}`);
console.log('');

for (const f of files) {
  const isExample = actualExamples.has(f);
  const registered = Object.hasOwn(EXPECTED_EXAMPLES, f);
  let tag = 'REAL';
  if (isExample && registered) tag = 'EXAMPLE';
  else if (isExample && !registered) tag = 'UNREG ';
  else if (!isExample && registered) tag = 'STALE ';
  console.log(`  ${tag.padEnd(8)} ${f}`);
  if (tag === 'UNREG ') fail(`${f} 含示例标记但未在 EXPECTED_EXAMPLES 登记`);
  if (tag === 'STALE ') fail(`${f} 已登记为示例，但文件内已无「示例」标记（登记失效）`);
}

for (const f of Object.keys(EXPECTED_EXAMPLES)) {
  if (!files.includes(f)) {
    fail(`登记的示例文件 ${f} 不存在（改名或删除后需同步 EXPECTED_EXAMPLES）`);
  }
}

console.log('');
if (failed === 0) {
  console.log('OK  示例/真实调研表与登记表一致');
  process.exit(0);
}
console.log(`${strict ? 'FAIL' : 'WARN'}  ${failed} 项与登记表不符${strict ? '' : '（非 strict 模式不阻断）'}`);
process.exit(strict ? 1 : 0);
