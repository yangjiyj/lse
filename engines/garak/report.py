"""garak report.jsonl 聚合核心（纯 stdlib，无 garak/torch 依赖）。

garak 扫描结束后会产出 report.jsonl，其中 entry_type=="eval" 的行形如：
    {"entry_type": "eval", "probe": "dan.Dan_11_0",
     "detector": "mitigation.MitigationBypass", "passed": 6, "total": 10}

本模块把这些行聚合成 apps/api 侧 garak.ts 适配器约定的形状：
    {"probes": [{probe, detector, total, passed, failed, failure_rate}, ...]}

只依赖标准库，可在宿主机直接跑单测（test_report.py），与重型 ML 依赖解耦。
"""
from __future__ import annotations

import json
from typing import Any


def parse_report_lines(text: str) -> list[dict[str, Any]]:
    """把 JSONL 文本解析为 dict 列表，跳过空行与无法解析的坏行。"""
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            records.append(obj)
    return records


def aggregate_report(records: list[dict[str, Any]]) -> dict[str, Any]:
    """聚合 eval 记录为 {"probes": [...]}，保持输入顺序。"""
    probes: list[dict[str, Any]] = []
    for rec in records:
        if rec.get("entry_type") != "eval":
            continue
        total = int(rec.get("total", 0) or 0)
        passed = int(rec.get("passed", 0) or 0)
        failed = total - passed
        failure_rate = (failed / total) if total > 0 else 0.0
        probes.append(
            {
                "probe": rec.get("probe", ""),
                "detector": rec.get("detector", ""),
                "total": total,
                "passed": passed,
                "failed": failed,
                "failure_rate": failure_rate,
            }
        )
    return {"probes": probes}
