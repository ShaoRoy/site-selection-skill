#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""check-lockstep.py —— 跨包一致性校验（工作区工具，不进任何发布包）

> 本项目只有 01 技能包与 03 源码包，两包共享同一套引擎与文档。

现行检查三项：
  1. 01 ↔ 03 同源文件（README 除外）CRLF→LF 归一后逐字节相同 ← 强制
  1b. 01 ↔ 03 的 README.md 全文逐字节相同 ← 强制
  2. release/ 两副本与根包同哈希 ← 强制
  3. 工作副本 ↔ 03 源码树同名文件逐字节相同 ← 强制（防「改工作副本再打包 = 静默回退」）

用法：
  python tools/check-lockstep.py
  python tools/check-lockstep.py --upload=<dist/upload 路径>

退出码：0 全过；1 有失败。
"""
import argparse
import hashlib
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_UPLOAD = os.path.abspath(os.path.join(HERE, '..', '..', 'upload'))

PACKS = [
    ('01', '01-skill-导入技能.zip', 'site-report', 'site-selection-workbuddy-v2.10.40.zip'),
    ('03', '03-github-仓库源码.zip', '', 'site-selection-dsh-v2.10.40.zip'),
]


def norm(b):
    return hashlib.sha256(b.replace(b'\r\n', b'\n')).hexdigest()


def zmap(path, prefix):
    out = {}
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith('/'):
                continue
            if prefix and not n.startswith(prefix + '/'):
                continue
            out[n[len(prefix) + 1:] if prefix else n] = norm(z.read(n))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', default=DEFAULT_UPLOAD)
    a = ap.parse_args()
    up = a.upload

    paths = {k: os.path.join(up, f) for k, f, _, _ in PACKS}
    for k, p in paths.items():
        if not os.path.exists(p):
            print(f'❌ 缺包 {k}: {p}')
            return 1

    m1 = zmap(paths['01'], 'site-report')
    m3 = zmap(paths['03'], '')
    fails = 0

    print('=== 1. 01 ↔ 03 同源文件（归一后，README 除外）← 强制')
    common = sorted(set(m1) & set(m3))
    same = [k for k in common if m1[k] == m3[k]]
    different = [k for k in common if m1[k] != m3[k] and k != 'README.md']
    readme_diff = [k for k in common if m1[k] != m3[k] and k == 'README.md']
    print(f'  同名 {len(common)}；相同 {len(same)}；README 不同 {len(readme_diff)}（已统一，另见 1b 全文校验）')
    if different:
        print('  ❌ 非 README 文件出现差异:', different)
        fails += 1
    else:
        print(f'  ✅ 除 README 外全部一致（{len(same)} 个）')

    print('\n=== 1b. README.md 全文须逐字节一致（归一 CRLF→LF）← 强制')
    # 2026-11-08：两份说明书已统一成同一份内容，不再允许「首屏按包定位」的差异。
    # 改任一份忘了同步另一份 → 直接判红，防止说法分叉。
    def _readme_full(zip_path, prefix):
        """从 zip 里读 README.md 全文，仅做 CRLF→LF 归一"""
        with zipfile.ZipFile(zip_path) as z:
            name = f'{prefix}/README.md' if prefix else 'README.md'
            if name not in z.namelist():
                return None
            return z.read(name).decode('utf-8', 'replace').replace('\r\n', '\n')

    r1 = _readme_full(paths['01'], 'site-report')
    r3 = _readme_full(paths['03'], '')
    if r1 is None or r3 is None:
        print('  ⚠️ 至少一包缺 README.md，跳过')
        r1 = r3 = ''
    if r1 == r3:
        print('  ✅ 两份 README 全文逐字节一致')
    else:
        import difflib
        d = [l for l in difflib.unified_diff(r1.split('\n'), r3.split('\n'), lineterm='')
             if l and l[0] in '+-' and not l.startswith(('+++', '---'))]
        print(f'  ❌ 两份 README 有 {len(d)} 行差异：')
        for l in d[:12]:
            print(f'       {l[:100]}')
        fails += 1

    print('\n=== 2. release/ 两副本 ← 强制')
    for k, name, _, rel in PACKS:
        rp = os.path.join(up, 'release', rel)
        if not os.path.exists(rp):
            print(f'  ❌ {rel} 不存在')
            fails += 1
            continue
        h_root = hashlib.sha256(open(paths[k], 'rb').read()).hexdigest()
        h_rel = hashlib.sha256(open(rp, 'rb').read()).hexdigest()
        if h_root == h_rel:
            print(f'  ✅ {rel}')
        else:
            print(f'  ❌ {rel} 与根包不一致')
            fails += 1

    print('\n=== 3. 工作副本 ↔ 03 源码树（同名文件逐字节，归一 CRLF→LF）← 强制')
    # 2026-11-08 补：工作副本的 .github/workflows/ci.yml 曾停在 15 步，
    # 而已发布的 03 源包是 18 步（含 CSV / WorldPop / 渲染链三组）。
    # 后果不是当下报错，而是「下次从工作副本改 CI 再打包 → 三组测试被静默回退」。
    # 此处钉死：两边同名文件必须逐字节相同；03 源有而工作副本缺的，判红（工作副本落后）。
    # 仅工作副本有的文件（verify-release.mjs / check-lockstep.py / rebuild-packs.py 等
    # 工作区专用工具、以及 .cache / survey 等运行产物）不入包，只计数不判红。
    WS = os.path.abspath(os.path.join(HERE, '..'))
    SRC = os.path.join(up, '_src', '03-source')
    SKIP_DIRS = {'node_modules', 'out', '.git', '__pycache__', 'tiles', '.workbuddy',
                 '.pytest_cache', 'cache', '.cache', 'survey', '.mypy_cache'}

    def _walk(root):
        s = set()
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in SKIP_DIRS]
            for f in fns:
                s.add(os.path.relpath(os.path.join(dp, f), root).replace('\\', '/'))
        return s

    if not os.path.isdir(SRC):
        print(f'  ❌ 缺 03 源码树: {SRC}')
        fails += 1
    else:
        wa, wb = _walk(WS), _walk(SRC)
        common_w = sorted(wa & wb)
        diff_w, only_src = [], sorted(wb - wa)
        for rel in common_w:
            pa, pb = os.path.join(WS, rel), os.path.join(SRC, rel)
            try:
                a = open(pa, 'rb').read().replace(b'\r\n', b'\n')
                b = open(pb, 'rb').read().replace(b'\r\n', b'\n')
            except OSError as e:
                print(f'  ❌ 读取失败 {rel}: {e}')
                fails += 1
                continue
            if a != b:
                diff_w.append(rel)
        print(f'  同名 {len(common_w)}；不一致 {len(diff_w)}；'
              f'仅 03 源有 {len(only_src)}；仅工作副本有 {len(wa - wb)}（工作区专用/运行产物，不计）')
        if diff_w:
            print('  ❌ 工作副本与已发布源码不一致（此状态下打包会把差异带进发布物）:')
            for rel in diff_w[:15]:
                print(f'       {rel}')
            fails += 1
        elif only_src:
            print('  ❌ 03 源有而工作副本缺（工作副本未同步）:')
            for rel in only_src[:15]:
                print(f'       {rel}')
            fails += 1
        else:
            print(f'  ✅ 全部一致（{len(common_w)} 个）')

    print(f'\n=== 结果：{"全部通过" if fails == 0 else f"{fails} 项失败"}')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
