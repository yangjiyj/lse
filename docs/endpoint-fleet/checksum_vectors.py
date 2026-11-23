#!/usr/bin/env python3
"""生成 checksum 测试向量并用三种实现交叉核对。

Python 端直接加载 kit 里真实的 platform-collector.py 调用 eval_job_checksum（不是复刻）。
用法：checksum_vectors.py <platform-collector.py> <输出目录>
"""
import importlib.util
import json
import pathlib
import subprocess
import sys

collector_path, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("collector", collector_path)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

base_pack = {
    "pack_id": "probe-proto-harmless",
    "digest": "sha256:" + "0" * 63 + "1",
    "scenarios": [{"scenario_id": "s1-reply-ok", "title": "回复 OK", "prompt": "请只回复 OK。",
                   "fixtures": [], "canaries": [], "max_turns": 1, "timeout_sec": 60}],
}


def job(pack=None, **extra):
    value = {"job_id": "lej_00000000000000000000000000000001", "product": "claude-code",
             "scenario_pack": pack or base_pack, "sink_base_url": "https://jiandun.example/sink",
             "checksum": "", "deadline": "2026-10-22T06:00:00Z"}
    value.update(extra)
    return value


def tricky(text):
    pack = json.loads(json.dumps(base_pack))
    pack["scenarios"][0]["prompt"] = text
    return pack


cases = [
    {"name": "V1 基础单场景（中文）", "job": job()},
    {"name": "V2 投递元数据不参与（job_id/deadline/checksum 不同，checksum 应同 V1）",
     "job": job(job_id="other", deadline="2030-01-01T00:00:00Z", checksum="ignored")},
    {"name": "V3 HTML 字符 <>& 不转义", "job": job(tricky("<script>a&b</script>"))},
    {"name": "V4 U+2028/U+2029 原样 UTF-8", "job": job(tricky("行\u2028分\u2029段"))},
    {"name": "V5 控制字符 \\n\\t\\r\\b\\f\\x01\\x7f", "job": job(tricky("a\nb\tc\rd\be\ff\x01g\x7fh"))},
    {"name": "V6 引号反斜线 emoji 非 BMP", "job": job(tricky('say "hi" \\ 😀 𠀀'))},
    {"name": "V7 fixtures+canaries+多场景", "job": job({
        "pack_id": "p2", "digest": "sha256:" + "ab" * 32,
        "scenarios": [
            {"scenario_id": "a", "title": "t", "prompt": "p", "fixtures": [{"path": "src/x.txt", "content": "x"}],
             "canaries": ["LSE_CANARY_1"], "max_turns": 3, "timeout_sec": 120},
            {"scenario_id": "b", "title": "t2", "prompt": "p2", "fixtures": [], "canaries": [], "max_turns": 1, "timeout_sec": 30}]})},
]
inputs = out_dir / "checksum-vectors-input.json"
inputs.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")

python_out = []
for case in cases:
    payload = {k: case["job"][k] for k in ("product", "scenario_pack", "sink_base_url")}
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    python_out.append({"name": case["name"], "checksum": collector.eval_job_checksum(case["job"]), "canonical": canonical})

go = subprocess.run(sys.argv[3:4] + ["run", str(out_dir.parent / "canonical_go.go")] if len(sys.argv) > 3 else ["go", "run", str(out_dir.parent / "canonical_go.go")],
                    input=inputs.read_bytes(), capture_output=True, check=True)
go_out = json.loads(go.stdout)
node = subprocess.run(["node", str(out_dir.parent / "canonical_ref.mjs")], input=inputs.read_bytes(), capture_output=True, check=True)
node_out = json.loads(node.stdout)

rows, ok = [], True
for p, g, n in zip(python_out, go_out, node_out):
    same = p["checksum"] == g.get("checksum") == n.get("checksum") and p["canonical"] == g.get("canonical") == n.get("canonical")
    ok &= same
    rows.append({"name": p["name"], "python": p["checksum"], "go": g.get("checksum", g.get("error")), "ts": n.get("checksum", n.get("error")),
                 "match": same, "canonical": p["canonical"]})
(out_dir / "checksum-vectors.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
for r in rows:
    print(("OK  " if r["match"] else "DIFF") + "  " + r["python"] + "  " + r["name"])
    if not r["match"]:
        print("     go=", r["go"], " ts=", r["ts"])
print("ALL MATCH" if ok else "MISMATCH")
