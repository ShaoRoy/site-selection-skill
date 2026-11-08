#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""test-worldpop.py —— WorldPop 两脚本的可离线测试部分

测什么：
  1. `worldpop-sample.py` 的 4 个纯函数（不依赖 GDAL / numpy）：
     `_tlat` / `_tlng` / `wgs84_to_gcj02` / `gcj02_to_wgs84`
  2. 源码级断言：`from osgeo import gdal` 只出现在 `main()` 内 ——
     防止将来把 GDAL 提到模块顶层，导致无 GDAL 的环境连纯函数都 import 不了。

测什么（明确不测）：
  · `worldpop-sample.py` 的 `main()` 需要 GDAL + numpy + 真实栅格 → SKIP
  · `worldpop-clip.py` 的 `clip()` 需要 GDAL → SKIP
  **SKIP 会显式打印，不伪装成通过。**

用法：
    python tools/test-worldpop.py
退出码：0 全通过（含 SKIP）；1 有 FAIL。
"""
import ast
import importlib.util
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', 'scripts')
SAMPLE = os.path.abspath(os.path.join(SCRIPTS, 'worldpop-sample.py'))
CLIP = os.path.abspath(os.path.join(SCRIPTS, 'worldpop-clip.py'))

passed = 0
failed = 0
skipped = []


def ok(name, detail=''):
    global passed
    passed += 1
    print(f'  PASS  {name}' + (f'  {detail}' if detail else ''))


def fail(name, detail=''):
    global failed
    failed += 1
    print(f'  FAIL  {name}' + (f'  {detail}' if detail else ''))


def skip(name, reason):
    skipped.append((name, reason))
    print(f'  SKIP  {name}  —— {reason}')


def load_module(path, modname):
    """从文件加载模块（import 真实现，不复制代码）"""
    spec = importlib.util.spec_from_file_location(modname, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


print('=' * 64)
print('WorldPop 脚本离线测试')
print('=' * 64)

if not os.path.exists(SAMPLE):
    print(f'  FAIL  找不到 {SAMPLE}')
    sys.exit(1)
if not os.path.exists(CLIP):
    print(f'  FAIL  找不到 {CLIP}')
    sys.exit(1)

# ── 1. 加载 worldpop-sample.py（纯函数部分不触发 GDAL）
print('\n--- 1. 模块加载')
try:
    sample = load_module(SAMPLE, 'wp_sample')
    ok('worldpop-sample.py 可在无 GDAL 环境加载')
except Exception as e:
    fail('worldpop-sample.py 加载失败', repr(e))
    print(f'\n=== 结果：{passed} 通过 / {failed} 失败 ===')
    sys.exit(1)

for fn in ('_tlat', '_tlng', 'wgs84_to_gcj02', 'gcj02_to_wgs84'):
    if callable(getattr(sample, fn, None)):
        ok(f'导出纯函数 {fn}')
    else:
        fail(f'缺纯函数 {fn}')

# ── 2. 源码级断言：GDAL 只能在 main() 内 import
print('\n--- 2. 源码级断言（GDAL 不得在模块顶层）')
src = open(SAMPLE, encoding='utf-8').read()
tree = ast.parse(src)

top_level_gdal = []
for node in tree.body:
    # 模块顶层的任意 import
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        else:
            names = [node.module or '']
        if any('osgeo' in n or 'numpy' in n for n in names):
            top_level_gdal.append((node.lineno, names))

if top_level_gdal:
    fail('GDAL/numpy 出现在模块顶层', str(top_level_gdal))
else:
    ok('GDAL / numpy 不在模块顶层（纯函数可无依赖 import）')

# 确认它们在 main() 内部
main_func = next((n for n in tree.body
                  if isinstance(n, ast.FunctionDef) and n.name == 'main'), None)
if main_func is None:
    fail('找不到 main() 函数')
else:
    inner = []
    for node in ast.walk(main_func):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ''])
            if any('osgeo' in n for n in names):
                inner.append(node.lineno)
    if inner:
        ok(f'GDAL 在 main() 内 import（L{inner[0]}）')
    else:
        fail('main() 内也没有 GDAL import —— 结构可能已变，需人工确认')

# ── 3. 坐标转换往返误差
print('\n--- 3. WGS84 ↔ GCJ02 往返')
CASES = [
    (23.118048, 113.324760, '珠江新城'),
    (39.904030, 116.407400, '天安门'),
    (31.230400, 121.473700, '人民广场'),
]
for lat, lng, label in CASES:
    try:
        g_lat, g_lng = sample.wgs84_to_gcj02(lat, lng)
        b_lat, b_lng = sample.gcj02_to_wgs84(g_lat, g_lng)
        err = max(abs(b_lat - lat), abs(b_lng - lng))
        if err < 1e-6:
            ok(f'往返误差 {label}', f'{err:.2e}')
        else:
            fail(f'往返误差过大 {label}', f'{err:.2e}')
    except Exception as e:
        fail(f'往返异常 {label}', repr(e))

# ── 4. 偏移方向：GCJ02 在中国境内应相对 WGS84 有可见偏移
print('\n--- 4. 偏移方向与量级')
lat, lng = 23.118048, 113.324760
try:
    g_lat, g_lng = sample.wgs84_to_gcj02(lat, lng)
    d_lat = g_lat - lat
    d_lng = g_lng - lng
    # GCJ02 相对 WGS84 在中国境内是加偏；华南实测纬度为负向、经度为正向量级几十到几百米。
    # 不锁死符号（各纬度带不同），只断言「有可见偏移」+ 量级合理。
    if abs(d_lat) > 1e-5 or abs(d_lng) > 1e-5:
        ok('存在可见偏移', f'dlat={d_lat:.6f} dlng={d_lng:.6f}')
    else:
        fail('几乎没有偏移 —— 坐标转换可能失效', f'dlat={d_lat:.6f} dlng={d_lng:.6f}')
    # 换算成米：1e-5 度约 1.1 m
    meters = max(abs(d_lat), abs(d_lng)) * 111000
    if 50 < meters < 1000:
        ok('偏移量级合理', f'约 {meters:.0f} m')
    else:
        fail('偏移量级异常', f'约 {meters:.0f} m')
except Exception as e:
    fail('偏移计算异常', repr(e))

# ── 5. _tlat / _tlng 存在性与确定性
print('\n--- 5. _tlat / _tlng')
for fn in ('_tlat', '_tlng'):
    f = getattr(sample, fn, None)
    if not callable(f):
        fail(f'{fn} 不可调用')
        continue
    try:
        # 真实签名是 (x, y) 二参数（WGS84 弧度偏移量），不是单参数
        v1 = f(0.0, 0.0)
        v2 = f(0.0, 0.0)
        v3 = f(0.1, -0.1)
        if v1 == v2:
            ok(f'{fn} 可调用且确定', f'f(0,0)={v1:.4f}')
        else:
            fail(f'{fn} 不确定')
        if isinstance(v3, float) and v3 != v1:
            ok(f'{fn} 随输入变化', f'f(.1,-.1)={v3:.4f}')
        else:
            fail(f'{fn} 输出不随输入变化')
    except Exception as e:
        fail(f'{fn} 调用异常', repr(e))

# ── 6. worldpop-clip.py：结构断言 + clip() SKIP
print('\n--- 6. worldpop-clip.py')
try:
    clip_src = open(CLIP, encoding='utf-8').read()
    clip_tree = ast.parse(clip_src)

    clip_fn = next((n for n in clip_tree.body
                    if isinstance(n, ast.FunctionDef) and n.name == 'clip'), None)
    if clip_fn:
        P = clip_fn.args.args
        params = [a.arg for a in P]
        if params == ['src', 'bbox', 'out', 'gdal']:
            ok('clip(src, bbox, out, gdal) 签名未变')
        else:
            fail('clip() 签名变化', str(params))
    else:
        fail('找不到 clip()')

    # gdal 作为参数传入 → clip() 自身不 import GDAL，可脱离环境做签名/逻辑审查
    gdal_in_clip = []
    if clip_fn:
        for node in ast.walk(clip_fn):
            if isinstance(node, ast.ImportFrom) and 'osgeo' in (node.module or ''):
                gdal_in_clip.append(node.lineno)
    if not gdal_in_clip:
        ok('clip() 内不 import GDAL（由参数注入）')
    else:
        fail('clip() 内 import GDAL', str(gdal_in_clip))
except Exception as e:
    fail('worldpop-clip.py 结构检查异常', repr(e))

# ── SKIP 项（显式记录，不伪装通过）
print('\n--- 7. 需外部依赖，明确跳过')
skip('worldpop-sample.py main()', '需 GDAL + numpy + 真实栅格（未执行-依赖缺失）')
skip('worldpop-clip.py clip()', '需 GDAL（未执行-依赖缺失）')

print()
print('=' * 64)
if failed == 0:
    print(f'=== 结果：PASS {passed}/{passed + len(skipped)}'
          f'（{passed} 通过 + {len(skipped)} 显式跳过，0 失败）===')
    for n, r in skipped:
        print(f'    SKIP {n} —— {r}')
    sys.exit(0)
else:
    print(f'=== 结果：FAIL（{passed} 通过 / {failed} 失败 / {len(skipped)} 跳过）===')
    sys.exit(1)
