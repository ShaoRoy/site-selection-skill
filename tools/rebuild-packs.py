#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""rebuild-packs.py —— 三包重建（工作区工具，不进任何发布包）

核心原则（踩过坑，别改）：
  **以现有 zip 为基线做增量替换**，未变更条目原样保留（含换行、compression、date_time、
  external_attr）。严禁"从 _src 全量重建 + 统一换行"——那会制造大面积假差异，
  而且会把 03 的混合换行状态（62/80 含 CRLF）一次性抹平。

用法：
  python tools/rebuild-packs.py --dry-run        # 只报差异，不写
  python tools/rebuild-packs.py                  # 实际重建 + 同步 release/

退出码：0 成功；1 有阻断错误。
"""
import argparse
import hashlib
import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
UPLOAD = os.path.abspath(os.path.join(HERE, '..', '..', 'upload'))
SRC = os.path.join(UPLOAD, '_src')

# (key, 根 zip 文件名, 源目录, zip 内前缀, release 副本名)
SPECS = [
    ('01', '01-skill-导入技能.zip',
     os.path.join(SRC, '01-skill', 'site-report'), 'site-report',
     'site-selection-workbuddy-v2.10.38.zip'),
    ('03', '03-github-仓库源码.zip',
     os.path.join(SRC, '03-source'), '',
     'site-selection-dsh-v2.10.38.zip'),
]

EXCLUDE_DIRS = {'out', '__pycache__', 'node_modules'}
# 特例：离线采集链需要的 dsh-tools 极简 shim（1.6 KB），必须随包分发
SHIM_PREFIX = 'node_modules/@deepseek-ai/dsh-tools/'
EXCLUDE_EXT = {'.pyc'}
# 工作区工具：明确不进任何包
EXCLUDE_NAMES = {'verify-release.mjs', 'rebuild-packs.py', 'check-lockstep.py'}


def norm(b):
    return hashlib.sha256(b.replace(b'\r\n', b'\n')).hexdigest()


def collect_src(root):
    """收集源树文件 → {rel: abspath}"""
    out = {}
    for r, ds, fs in os.walk(root):
        rel_dir = os.path.relpath(r, root).replace(os.sep, '/') + '/'
        if rel_dir.startswith(SHIM_PREFIX) or not rel_dir.startswith('node_modules'):
            ds[:] = [d for d in ds if d not in EXCLUDE_DIRS]
            if rel_dir.startswith(SHIM_PREFIX):
                ds[:] = [d for d in ds]  # shim 内部不排除
        for f in fs:
            if os.path.splitext(f)[1] in EXCLUDE_EXT:
                continue
            if f in EXCLUDE_NAMES:
                continue
            rel = os.path.relpath(os.path.join(r, f), root).replace(os.sep, '/')
            out[rel] = os.path.join(r, f)
    return out


def plan(key, zip_path, src_root, prefix):
    """对比 zip 与源树，算出 add / replace / remove / unchanged"""
    src = collect_src(src_root)
    zip_entries = {}
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(prefix) + 1:] if prefix and info.filename.startswith(prefix + '/') else info.filename
            zip_entries[rel] = norm(z.read(info))

    add, replace, unchanged = [], [], []
    for rel, ap in src.items():
        h = norm(open(ap, 'rb').read())
        if rel not in zip_entries:
            add.append(rel)
        elif zip_entries[rel] != h:
            replace.append(rel)
        else:
            unchanged.append(rel)
    remove = [k for k in zip_entries if k not in src]
    return add, replace, remove, unchanged, src


def rebuild(key, zip_path, src_root, prefix, rel_copy, dry_run, prune=False):
    add, replace, remove, unchanged, src = plan(key, zip_path, src_root, prefix)
    print(f'\n=== {key}  {os.path.basename(zip_path)}')
    print(f'  条目 {len(unchanged) + len(replace) + len(remove)} → {len(src)}')
    print(f'  新增 {len(add)}: {add if add else "无"}')
    print(f'  替换 {len(replace)}: {replace if replace else "无"}')
    if remove:
        act = "删除" if prune else "保留（加 --prune 才删）"
        print(f'  ⚠️ 源树已无、zip 仍有的条目 {len(remove)}: {remove}  （{act}）')
    print(f'  未变 {len(unchanged)}')

    if dry_run:
        return 0

    if not (add or replace or (prune and remove)):
        print('  → 无变化，跳过重建')
        return 0

    tmp = zip_path + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)

    new_entries = dict(src)
    with zipfile.ZipFile(zip_path) as zin, zipfile.ZipFile(tmp, 'w') as zout:
        written = set()
        # 按原顺序写：未变/替换的沿用原 entry 元数据
        for info in zin.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(prefix) + 1:] if prefix and info.filename.startswith(prefix + '/') else info.filename
            if rel in remove and prune:
                continue  # --prune：丢弃源树已无的条目
            if rel in replace or (rel in unchanged):
                if rel in replace:
                    data = open(src[rel], 'rb').read()
                else:
                    data = zin.read(info)
                zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zi.compress_type = info.compress_type
                zi.external_attr = info.external_attr
                zi.internal_attr = info.internal_attr
                zi.create_system = info.create_system
                zout.writestr(zi, data)
                written.add(rel)
        # 追加新增条目
        for rel in add:
            name = f'{prefix}/{rel}' if prefix else rel
            zi = zipfile.ZipInfo(name, date_time=(2026, 11, 7, 23, 30, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zout.writestr(zi, open(src[rel], 'rb').read())

    os.replace(tmp, zip_path)
    shutil.copyfile(zip_path, os.path.join(UPLOAD, 'release', rel_copy))
    h = hashlib.sha256(open(zip_path, 'rb').read()).hexdigest()[:12]
    size = os.path.getsize(zip_path)
    print(f'  ✅ 已重建: {size:,} B  {h}  → 同步 release/{rel_copy}')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--only', default='', help='只重建某个包，如 03')
    ap.add_argument('--prune', action='store_true',
                    help='删除「源树已无、zip 仍有」的条目（默认保留）')
    a = ap.parse_args()

    fails = 0
    for key, name, src_root, prefix, rel_copy in SPECS:
        if a.only and a.only != key:
            continue
        zip_path = os.path.join(UPLOAD, name)
        if not os.path.exists(zip_path):
            print(f'❌ 缺包 {zip_path}')
            fails += 1
            continue
        if not os.path.isdir(src_root):
            print(f'❌ 缺源目录 {src_root}')
            fails += 1
            continue
        fails += rebuild(key, zip_path, src_root, prefix, rel_copy, a.dry_run, a.prune)

    print(f'\n=== 结果：{"完成" if fails == 0 else f"{fails} 个错误"}')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
