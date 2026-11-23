"""python-judge sidecar HTTP 服务（FastAPI 薄包装）。

仅做协议适配，全部检测逻辑在 scanner.py（纯 stdlib、已单测）。
契约与 apps/api 侧 src/modules/engines/python-judge.ts 对齐：
  POST /scan  {prompt, response, question_type, should_refuse}
           -> {flagged, risk_category, severity, score, evidence}
  GET  /health -> {status, engine}
"""
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

from scanner import scan_response

app = FastAPI(title="python-judge", version="1.0.0", docs_url=None, redoc_url=None)


class ScanRequest(BaseModel):
    prompt: str = ""
    response: str = ""
    question_type: Optional[str] = None
    should_refuse: bool = False


@app.get("/health")
def health():
    return {"status": "ok", "engine": "python-judge"}


@app.post("/scan")
def scan(req: ScanRequest):
    return scan_response(
        prompt=req.prompt,
        response=req.response,
        question_type=req.question_type,
        should_refuse=req.should_refuse,
    )
