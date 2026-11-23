"""garak sidecar — 异步任务式 HTTP 封装（薄 I/O 胶水层，逻辑核心在 report.py）。

契约（被 apps/api/test/garak-engine.test.ts 锁定）：
    POST /scan      {target:{base_url,api_key,model}, probes?, generations?, prompt_seeds?}
                    -> {job_id}
    GET  /scan/{id} -> {state:'running'|'done'|'failed', report?, message?}
    GET  /health    -> {status, engine}

report 形状：{"probes":[{probe,detector,total,passed,failed,failure_rate}, ...]}

garak 本体（NVIDIA, Apache-2.0）以子进程方式被拉起；它会产出 report.jsonl，
我们用 report.parse_report_lines + report.aggregate_report 聚合成上面的形状。
garak 携带重型 ML 依赖（torch/transformers 等），仅在本 sidecar 容器内出现，
通过 HTTP 与闭源产品隔离，不进入产品二进制（详见 README / THIRD_PARTY_NOTICES）。
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import uuid
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from report import aggregate_report, parse_report_lines
from seed_probe import prepare_seed_probe

ENGINE = "garak"
DEFAULT_PROBES = ["dan.Dan_11_0", "promptinject"]
DEFAULT_GENERATIONS = 5


def _install_seed_probe(seeds: Optional[list[str]]) -> Optional[str]:
    """把平台种子做成 garak 自定义 probe 装进 garak.probes 目录，返回 --probes 规格名。

    失败一律返回 None（由调用方回退标准 probe）。仅在 sidecar 容器内、garak 已安装时生效。
    """
    if not seeds:
        return None
    import importlib.util

    spec = importlib.util.find_spec("garak.probes")
    locations = list(getattr(spec, "submodule_search_locations", []) or [])
    if not locations:
        return None
    return prepare_seed_probe(seeds, locations[0])

app = FastAPI(title="garak-sidecar", docs_url=None, redoc_url=None)

# 任务状态内存表：job_id -> {state, report?, message?}
_JOBS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()


class Target(BaseModel):
    base_url: str
    api_key: str = ""
    model: str


class ScanRequest(BaseModel):
    target: Target
    probes: Optional[list[str]] = None
    generations: Optional[int] = None
    prompt_seeds: Optional[list[str]] = None


def _set_job(job_id: str, **fields: Any) -> None:
    with _LOCK:
        job = _JOBS.setdefault(job_id, {})
        job.update(fields)


def _run_garak(job_id: str, req: ScanRequest) -> None:
    """子进程跑 garak，结束后解析 report.jsonl 并写回任务状态。"""
    try:
        probes = list(req.probes or DEFAULT_PROBES)
        # 平台中文题库种子 → garak 自定义 probe（附加在标准 probe 之后）。
        # 任何失败静默回退到标准 probe，绝不因种子注入失败而中断扫描。
        try:
            seed_spec = _install_seed_probe(req.prompt_seeds)
            if seed_spec and seed_spec not in probes:
                probes.append(seed_spec)
        except Exception:  # noqa: BLE001 — 自定义 probe 不可用时回退标准 probe
            pass
        generations = req.generations or DEFAULT_GENERATIONS
        with tempfile.TemporaryDirectory(prefix="garak-") as tmp:
            prefix = os.path.join(tmp, "garak_run")
            cmd = [
                "python3",
                "-m",
                "garak",
                "--model_type",
                "openai.OpenAICompatible",
                "--model_name",
                req.target.model,
                "--probes",
                ",".join(probes),
                "--generations",
                str(generations),
                "--report_prefix",
                prefix,
            ]
            env = dict(os.environ)
            # OpenAI 兼容端点：garak 通过这两个环境变量定位上游
            env["OPENAI_API_KEY"] = req.target.api_key or "sk-noauth"
            env["OPENAI_BASE_URL"] = req.target.base_url
            proc = subprocess.run(
                cmd,
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
            )
            report_path = prefix + ".report.jsonl"
            if not os.path.exists(report_path):
                msg = (proc.stderr or proc.stdout or "garak 未产出 report.jsonl").strip()
                _set_job(job_id, state="failed", message=msg[:2000])
                return
            with open(report_path, "r", encoding="utf-8") as fh:
                records = parse_report_lines(fh.read())
            report = aggregate_report(records)
            _set_job(job_id, state="done", report=report)
    except Exception as exc:  # noqa: BLE001 — 胶水层兜底，任何异常都转成 failed
        _set_job(job_id, state="failed", message=str(exc)[:2000])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": ENGINE}


@app.post("/scan")
def scan(req: ScanRequest) -> dict[str, str]:
    job_id = uuid.uuid4().hex
    _set_job(job_id, state="running")
    thread = threading.Thread(target=_run_garak, args=(job_id, req), daemon=True)
    thread.start()
    return {"job_id": job_id}


@app.get("/scan/{job_id}")
def scan_status(job_id: str) -> dict[str, Any]:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown job_id")
        return dict(job)
