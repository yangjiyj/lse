#!/usr/bin/env python3
"""离线导入辅助：从 AI-Infra-Guard 仓库（git 对象）批量读取 data/vuln/**.yaml，输出 JSON Lines。

仅供开发期导入脚本 apps/api/scripts/update-aig-vulns.ts 调用（需要 PyYAML）；
运行时平台只读取生成好的 JSON，不依赖本脚本或 Python。

用法：python3 aig-vulndb-yaml-dump.py <repo_dir> [<rev>] [<prefix>]
输出：首行 {"commit": "..."}，其后每行 {"path": ..., "doc": ...} 或 {"path": ..., "error": ...}
"""
import json
import subprocess
import sys

import yaml


def main() -> None:
    repo = sys.argv[1]
    rev = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    prefix = sys.argv[3] if len(sys.argv) > 3 else "data/vuln/"
    commit = subprocess.check_output(["git", "-C", repo, "rev-parse", rev]).decode().strip()
    listing = subprocess.check_output(
        ["git", "-C", repo, "ls-tree", "-r", "-z", "--name-only", commit, prefix]
    )
    paths = sorted(
        p for p in listing.decode("utf-8").split("\0") if p.endswith((".yaml", ".yml"))
    )
    out = sys.stdout
    out.write(json.dumps({"commit": commit}, ensure_ascii=False) + "\n")
    proc = subprocess.Popen(
        ["git", "-C", repo, "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    assert proc.stdin is not None and proc.stdout is not None
    for path in paths:
        proc.stdin.write(f"{commit}:{path}\n".encode("utf-8"))
        proc.stdin.flush()
        header = proc.stdout.readline().decode("utf-8").strip().split(" ")
        if len(header) < 3 or header[1] != "blob":
            out.write(json.dumps({"path": path, "error": "missing blob"}, ensure_ascii=False) + "\n")
            continue
        size = int(header[2])
        body = proc.stdout.read(size)
        proc.stdout.read(1)  # 结尾换行
        try:
            doc = yaml.safe_load(body.decode("utf-8"))
            out.write(json.dumps({"path": path, "doc": doc}, ensure_ascii=False, default=str) + "\n")
        except Exception as exc:  # noqa: BLE001 - 记录解析失败，由导入脚本计数
            out.write(json.dumps({"path": path, "error": f"yaml: {exc}"}, ensure_ascii=False) + "\n")
    proc.stdin.close()
    proc.wait()


if __name__ == "__main__":
    main()
