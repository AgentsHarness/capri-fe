#!/usr/bin/env python3
"""变异测试 harness：把实现改坏，看测试是否变红。

一次性审计工具，不是每条新测试的关卡。覆盖率只说明代码被执行过；
这里回答的是「改坏了会不会被发现」。

用法:
    python3 scripts/mutate.py <mutations.json> [repo_root]

mutations.json 是数组，每项:
    {"label": "描述", "file": "src/x.ts", "old": "原样片段", "new": "改坏后片段",
     "only": ["src/x.test.ts"]}          # only 可选，限定跑哪些测试文件

必须在隔离副本里跑（本仓库常有并发写入者，直接在主树跑会互相污染）:

    W=/tmp/mut-wt; rm -rf "$W"; mkdir -p "$W"
    rsync -a --exclude node_modules --exclude .git --exclude coverage --exclude .playwright-cli ./ "$W/"
    ln -sfn /Users/benin/ccwork/acp-fe/node_modules "$W/node_modules"
    cd "$W" && python3 /Users/benin/ccwork/acp-fe/scripts/mutate.py /tmp/mut.json "$W"

判读:
  * KILLED = 测试抓住了这个缺陷。
  * SURVIVED 有两种，必须逐条分类，别直接当缺口补测:
      1) 真缺口：构造出能区分出错的输入，测试就会红 → 补测试。
      2) 等价变异体：行为本就不可能变（被上游守卫屏蔽、消费方用
         `x != null` 判断所以 undefined 与缺失不可区分）→ 不补，从分母剔除。
  * 退出码 1 表示有 SURVIVED，意思是「去分类」，不是「补到 100% 全杀」。
    目标不必 100%；挑容易杀死的变异体交差没有意义。
  * 已确认的等价变异体：`foldRunningSubagents` 末尾的 `if (!changed) return null`
    被开头的 `if (rows.length === 0) return null` 屏蔽；
    `...(row.turns != null ? …)` 改成展开 undefined 后，消费方用
    `entry.turns != null` 判断，两者不可区分。

设计要点（每一条都对应一个踩过的坑，别改）:
  * old 必须在文件里**唯一出现**，否则拒绝执行并报出出现次数。同一段代码
    常在多个函数里重复（例如 `row.turns != null ? {...}`），
    str.replace(old, new, 1) 会悄悄打到第一个，得出「存活」的假结论。
  * 每次改完必须还原，并断言还原后内容与原文逐字节一致。
  * 判定用「退出码 != 0」或「失败用例数 > 0」。vitest 4 存在 0 失败用例
    但退出码非 0 的情况（未捕获异常），只看失败数会漏判。
  * 不要加裸的 `--silent`：vitest 4 会把后面的路径吃成它的值并瞬间崩溃，
    退出码非 0 被误判成 Killed。
  * 先确认未变异时测试是绿的。套件本身是红的，所有变异体都会显示 Killed。
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path


def run_tests(only=None):
    cmd = ["npx", "vitest", "run", "--reporter=dot"]
    if only:
        cmd += list(only)
    p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout + p.stderr
    m = re.search(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed", out)
    fails = int(m.group(1)) if (m and m.group(1)) else 0
    return (p.returncode != 0 or fails > 0), fails, out


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0 if len(sys.argv) >= 2 else 2
    spec_path = sys.argv[1]
    root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path.cwd()

    if not Path(spec_path).is_file():
        print(f"找不到变异清单文件：{spec_path}")
        return 2

    if not (root / "src" / "components" / "Composer.tsx").is_file():
        print(f"拒绝执行：{root} 看起来不是 capri-fe 仓库根")
        return 2

    os.chdir(root)
    muts = json.loads(Path(spec_path).read_text())
    results, bad = [], 0

    for m in muts:
        path = root / m["file"]
        src = path.read_text()
        n = src.count(m["old"])
        if n != 1:
            print(f"SKIP({n} 处匹配) | {m['label']}  <-- old 不唯一，需加长上下文", flush=True)
            bad += 1
            continue

        line = src[: src.index(m["old"])].count("\n") + 1
        path.write_text(src.replace(m["old"], m["new"], 1))
        try:
            killed, fails, _ = run_tests(m.get("only"))
        finally:
            path.write_text(src)
        if path.read_text() != src:
            print(f"!! 还原失败，请手工检查 {path}")
            return 3

        results.append(killed)
        print(
            f"{'KILLED  ' if killed else 'SURVIVED'} | 行{line:5d} | {m['label']}"
            f"  (fails={fails})",
            flush=True,
        )

    if not results:
        print("没有任何变异体被执行")
        return 2

    k = sum(results)
    print(f"\n变异得分: {k}/{len(results)} = {k / len(results) * 100:.0f}%")
    if bad:
        print(f"（{bad} 个因 old 不唯一被跳过，请补上下文后重跑）")

    survivors = [r for r in results if not r]
    if survivors:
        print(
            "\n注意：SURVIVED 有两种可能，必须逐条判断，别直接当缺口补测——\n"
            "  1) 真缺口：测试没覆盖住这个行为，补能区分出错的输入。\n"
            "  2) 等价变异体：行为本就不可能变（被上游守卫屏蔽、消费方用\n"
            "     `x != null` 判断所以 undefined 与缺失不可区分）。等价变异体\n"
            "     不该补测，应从分母里剔除。\n"
            "退出码 1 表示有存活项要分类，不是要求补到 100% 全杀。"
        )
    return 0 if not [r for r in results if not r] else 1


if __name__ == "__main__":
    sys.exit(main())
