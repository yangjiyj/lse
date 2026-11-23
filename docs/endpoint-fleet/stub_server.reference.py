#!/usr/bin/env python3
"""鉴盾侧终端协议最小子集替身服务（仅标准库）。

用途：验证真实 platform-collector.py 只依赖 /agent/v1/* 最小子集能否工作；
也可作为 lse「鉴盾」侧 TypeScript 实现的参考。

安全约定：
- 只监听回环地址；接入码、终端令牌只在内存里保存 SHA-256 哈希。
- 日志不记录 Authorization 头与任何令牌明文，响应体中含令牌的只记录键名。
- 未实现的端点一律 404 并记日志，便于观察采集器真实访问面。
"""
import argparse
import datetime
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import ssl
import sys
import threading
import time
import urllib.parse
import uuid

LOCK = threading.RLock()
ENROLL_CODES = {}      # sha256(code) -> {"max_endpoints": n, "used": n}
ENDPOINTS = {}         # endpoint_id -> {...}
TOKENS = {}            # sha256(endpoint_token) -> endpoint_id
REPORTS = {}           # report_id -> body sha256
JOBS = {}              # job_id -> job record
ADMIN_TOKEN_HASH = ""
LOG_PATH = ""
BEHAVIOR_ENABLED = False
FAULTS = {"result_status": 0, "result_count": 0, "paths": {}}  # 测试用：让 result 端点按指定状态失败 N 次

JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
PRODUCTS = ("claude-code", "codex")


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def iso_seconds(value):
    # 只发秒级、带 Z 的 UTC 时间：采集器在 Python 3.8 上用 fromisoformat 解析。
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_payload(job):
    """与采集器 eval_job_checksum 完全一致：只取三个执行字段。"""
    payload = {key: job[key] for key in ("product", "scenario_pack", "sink_base_url")}
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return raw.encode("utf-8")


def eval_checksum(job):
    return hashlib.sha256(canonical_payload(job)).hexdigest()


def log(record):
    record = dict(record, ts=utc_now().strftime("%Y-%m-%dT%H:%M:%S.%fZ"))
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)
    with LOCK:
        with open(LOG_PATH, "a", encoding="utf-8") as out:
            out.write(line + "\n")


def summarize(body, path):
    """日志里的请求体摘要：小体保留原文（已知不含令牌的端点），大体只留键名与哈希。"""
    if body is None:
        return None
    summary = {"bytes": len(body), "sha256": sha256_hex(body)}
    try:
        value = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError):
        summary["json"] = False
        return summary
    if isinstance(value, dict):
        summary["keys"] = sorted(value)
    keep_full = (path.endswith("/register") or path.endswith("/heartbeat") or "/eval-jobs/" in path) and len(body) <= 16384
    if keep_full:
        summary["body"] = value
    elif path.endswith("/probe-reports") and isinstance(value, dict):
        summary["report"] = {k: value.get(k) for k in ("schema_version", "endpoint_id", "report_id", "scanned_at", "status", "probe_version")}
        summary["report"]["assets"] = len(value.get("assets") or [])
        summary["report"]["collectors"] = [c.get("name") for c in value.get("collectors") or []]
    elif path.endswith("/behavior-reports") and isinstance(value, dict):
        summary["report"] = {"schema_version": value.get("schema_version"), "observations": len(value.get("observations") or []),
                             "coverage": value.get("coverage")}
    return summary


class Reject(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "jiandun-stub/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # ---------- 通用 ----------
    def read_body(self, limit):
        length = self.headers.get("Content-Length")
        if length is None:
            return b"" if self.command == "GET" else None
        try:
            length = int(length)
        except ValueError:
            raise Reject(400, "invalid_request")
        if length > limit:
            raise Reject(413, "payload_too_large")
        return self.rfile.read(length)

    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def bearer(self):
        value = self.headers.get("Authorization", "")
        if not value.lower().startswith("bearer "):
            raise Reject(401, "unauthorized")
        token = value[7:].strip()
        if not token or len(token) > 8192:
            raise Reject(401, "unauthorized")
        return token

    def endpoint(self):
        digest = sha256_hex(self.bearer())
        with LOCK:
            endpoint_id = TOKENS.get(digest)
            record = ENDPOINTS.get(endpoint_id) if endpoint_id else None
        if record is None or record.get("revoked"):
            raise Reject(401, "unauthorized")
        return record

    def strict_json(self, body, kind=dict):
        if body is None:
            raise Reject(400, "invalid_request")
        try:
            value = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise Reject(400, "invalid_request")
        if not isinstance(value, kind):
            raise Reject(400, "invalid_request")
        return value

    def handle_any(self):
        started = time.monotonic()
        parsed = urllib.parse.urlsplit(self.path)
        path, query = parsed.path, parsed.query
        status, body, note = 500, None, ""
        try:
            body = self.read_body(8 * 1024 * 1024)
            status, response, note = self.route(path, query, body)
            self.send_json(status, response)
        except Reject as reject:
            status, note = reject.status, reject.code
            self.send_json(reject.status, {"error": reject.code})
        except Exception as error:  # 替身服务：任何未预期错误都按 500 返回并记日志
            status, note = 500, type(error).__name__
            self.send_json(500, {"error": "internal"})
        log({"method": self.command, "path": path, "query": query, "status": status, "note": note,
             "has_bearer": self.headers.get("Authorization", "").lower().startswith("bearer "),
             "content_type": self.headers.get("Content-Type", ""),
             "request": summarize(body, path) if body else None,
             "ms": int((time.monotonic() - started) * 1000)})

    do_GET = handle_any
    do_POST = handle_any
    do_PUT = handle_any
    do_DELETE = handle_any

    # ---------- 路由 ----------
    def route(self, path, query, body):
        if path.startswith("/_stub/"):
            return self.admin(path, body)
        if path in FAULTS["paths"]:
            return FAULTS["paths"][path], {"error": "injected_fault"}, "injected_fault"
        if path == "/agent/v1/endpoints/register" and self.command == "POST":
            return self.register(body)
        if path == "/agent/v1/endpoints/heartbeat" and self.command == "POST":
            return self.heartbeat(body)
        if path == "/agent/v1/probe-reports" and self.command == "POST":
            return self.probe_report(body, query)
        if path == "/agent/v1/policy" and self.command == "GET":
            record = self.endpoint()
            if urllib.parse.parse_qs(query).get("view") == ["managed-config"]:
                # 托管配置视图需要签名信封，鉴盾第一期不提供：显式 404。
                return 404, {"error": "not_found"}, "managed_config_unsupported"
            return 200, {"version": 1, "checksum": "sha256:" + sha256_hex(b"jiandun-stub-policy-v1"), "endpoint_id": record["endpoint_id"]}, ""
        if path == "/agent/v1/behavior-reports" and self.command == "POST" and BEHAVIOR_ENABLED:
            return self.behavior_report(body)
        if path == "/agent/v1/eval-jobs" and self.command == "GET":
            return self.pick_jobs()
        match = re.fullmatch(r"/agent/v1/eval-jobs/([^/]+)/(ack|started|result)", path)
        if match and self.command == "POST":
            return self.job_transition(match.group(1), match.group(2), body)
        # 其余一律 404：先校验令牌，避免未认证探测拿到差异化应答（与正式实现一致的顺序建议）。
        if path.startswith("/agent/v1/"):
            self.endpoint()
        return 404, {"error": "not_found"}, "unimplemented"

    # ---------- 管理（仅本机测试用） ----------
    def admin(self, path, body):
        token = self.bearer()
        if not hmac.compare_digest(sha256_hex(token), ADMIN_TOKEN_HASH):
            raise Reject(401, "unauthorized")
        value = self.strict_json(body)
        if path == "/_stub/enrollment-codes":
            code = "jdc_" + secrets.token_urlsafe(24)
            with LOCK:
                ENROLL_CODES[sha256_hex(code)] = {"max_endpoints": int(value.get("max_endpoints", 1)), "used": 0}
            # 接入码只在此响应中出现一次；日志不记录响应体。
            return 201, {"enrollment_code": code}, "code_issued"
        if path == "/_stub/eval-jobs":
            endpoint_id = value.get("endpoint_id")
            with LOCK:
                if endpoint_id not in ENDPOINTS:
                    raise Reject(404, "not_found")
            job_id = "lej_" + uuid.uuid4().hex
            job = {"product": value["product"], "scenario_pack": value["scenario_pack"], "sink_base_url": value["sink_base_url"]}
            if job["product"] not in PRODUCTS:
                raise Reject(400, "invalid_request")
            ttl = int(value.get("ttl_seconds", 1800))
            record = {"job_id": job_id, "endpoint_id": endpoint_id, "payload": job, "checksum": eval_checksum(job),
                      "deadline": iso_seconds(utc_now() + datetime.timedelta(seconds=ttl)), "status": "queued",
                      "tamper_checksum": bool(value.get("tamper_checksum")),
                      "serve_expired": bool(value.get("serve_expired")), "result": None, "history": ["queued"]}
            with LOCK:
                JOBS[job_id] = record
            return 201, {"job_id": job_id, "checksum": record["checksum"], "deadline": record["deadline"]}, "job_queued"
        if path == "/_stub/config":
            global BEHAVIOR_ENABLED
            with LOCK:
                if "behavior" in value:
                    BEHAVIOR_ENABLED = bool(value["behavior"])
                if "paths" in value:
                    FAULTS["paths"] = {k: int(v) for k, v in value["paths"].items()}
                if "result_status" in value:
                    FAULTS["result_status"] = int(value["result_status"])
                    FAULTS["result_count"] = int(value.get("result_count", 1))
            return 200, {"behavior": BEHAVIOR_ENABLED, "faults": FAULTS}, "config"
        if path == "/_stub/cancel":
            with LOCK:
                job = JOBS.get(value.get("job_id"))
                if job is None:
                    raise Reject(404, "not_found")
                job["status"] = "cancelled"
                job["history"].append("cancelled")
            return 200, {"job_id": job["job_id"], "status": "cancelled"}, "cancelled"
        if path == "/_stub/state":
            with LOCK:
                return 200, {
                    "endpoints": [{k: v for k, v in e.items() if k != "token_hash"} for e in ENDPOINTS.values()],
                    "reports": len(REPORTS),
                    "jobs": [{k: v for k, v in j.items() if k != "result"} for j in JOBS.values()],
                }, ""
        if path == "/_stub/job-result":
            with LOCK:
                job = JOBS.get(value.get("job_id"))
                return (200, {"status": job["status"], "result": job["result"]}, "") if job else (404, {"error": "not_found"}, "")
        raise Reject(404, "not_found")

    # ---------- 登记 ----------
    def register(self, body):
        code = self.bearer()
        q = self.strict_json(body)
        for key in ("machine_id", "hostname", "os", "arch", "agent_product"):
            if not isinstance(q.get(key), str) or not q[key].strip() or len(q[key]) > 256:
                raise Reject(400, "invalid_request")
        installation = q.get("installation_id", "")
        if installation:
            try:
                parsed = uuid.UUID(installation)
                if parsed.version != 4 or str(parsed) != installation:
                    raise ValueError()
            except ValueError:
                raise Reject(400, "invalid_request")
        if q["agent_product"] != "aiprobe":
            raise Reject(403, "enrollment_rejected")
        digest = sha256_hex(code)
        with LOCK:
            entry = ENROLL_CODES.get(digest)
            if entry is None:
                raise Reject(403, "enrollment_rejected")
            existing = next((e for e in ENDPOINTS.values() if installation and e["installation_id"] == installation), None)
            if existing and existing["machine_id"] != q["machine_id"]:
                raise Reject(403, "enrollment_rejected")
            if existing is None and entry["used"] >= entry["max_endpoints"]:
                raise Reject(403, "enrollment_rejected")
            token = secrets.token_hex(32)
            if existing:
                TOKENS.pop(existing["token_hash"], None)
                record = existing
            else:
                entry["used"] += 1
                record = {"endpoint_id": "ep_" + uuid.uuid4().hex[:20], "installation_id": installation,
                          "machine_id": q["machine_id"], "hostname": q["hostname"], "os": q["os"],
                          "agent_version": q.get("agent_version", ""), "health": None, "last_heartbeat_at": None}
                ENDPOINTS[record["endpoint_id"]] = record
            record["token_hash"] = sha256_hex(token)
            TOKENS[record["token_hash"]] = record["endpoint_id"]
        return 200, {"endpoint_id": record["endpoint_id"], "endpoint_token": token, "mode": "monitor",
                     "capture_level": "metadata"}, "registered"

    # ---------- 心跳 ----------
    def heartbeat(self, body):
        record = self.endpoint()
        q = self.strict_json(body)
        if not hmac.compare_digest(str(q.get("endpoint_id", "")), record["endpoint_id"]):
            raise Reject(401, "unauthorized")
        health = q.get("health") if isinstance(q.get("health"), dict) else {}
        with LOCK:
            record["health"] = health
            record["last_heartbeat_at"] = iso_seconds(utc_now())
            record["eval_runner"] = (health.get("capabilities") or {}).get("eval_runner")
        # upgrade 恒为 null：鉴盾不下发升级。采集器只认 {"payload","signature"} 对象，null 即跳过。
        return 200, {"server_time": iso_seconds(utc_now()), "revoked": False, "upgrade": None}, ""

    # ---------- 资产报告 ----------
    def probe_report(self, body, query):
        record = self.endpoint()
        if query:
            raise Reject(400, "invalid_request")
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            raise Reject(415, "unsupported_media_type")
        report = self.strict_json(body)
        if report.get("schema_version") != "aiprobe.report.v1":
            raise Reject(422, "invalid_report")
        if report.get("endpoint_id") != record["endpoint_id"]:
            raise Reject(401, "endpoint_mismatch")
        scanned = report.get("scanned_at", "")
        try:
            at = datetime.datetime.strptime(scanned, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        except (TypeError, ValueError):
            raise Reject(422, "invalid_report")
        if at > utc_now() + datetime.timedelta(minutes=5):
            raise Reject(422, "invalid_report")
        expected = "pr_" + sha256_hex(record["endpoint_id"] + "\x00" + scanned)
        if report.get("report_id") != expected or report.get("status") not in ("complete", "partial"):
            raise Reject(422, "invalid_report")
        if not isinstance(report.get("assets"), list) or not isinstance(report.get("collectors"), list):
            raise Reject(422, "invalid_report")
        digest = sha256_hex(body)
        with LOCK:
            prior = REPORTS.get(expected)
            if prior and prior != digest:
                raise Reject(409, "report_conflict")
            REPORTS[expected] = digest
        return 200, {"schema_version": "aiprobe.report.ack.v1", "report_id": expected, "accepted": prior is None,
                     "duplicate": prior is not None, "asset_count": len(report["assets"])}, "duplicate" if prior else "accepted"

    # ---------- 行为报告（可选，默认关闭以观察 404 容忍度） ----------
    def behavior_report(self, body):
        record = self.endpoint()
        report = self.strict_json(body)
        if report.get("schema_version") != "terminal.behavior.v1" or report.get("endpoint_id") != record["endpoint_id"]:
            raise Reject(422, "invalid_report")
        observations = report.get("observations")
        if not isinstance(observations, list):
            raise Reject(422, "invalid_report")
        # body_sha256 必须是原始请求体字节的哈希，采集器会逐字节比对。
        return 200, {"schema_version": "terminal.behavior.ack.v1", "endpoint_id": record["endpoint_id"],
                     "body_sha256": sha256_hex(body), "accepted": len(observations), "duplicates": 0}, "accepted"

    # ---------- 测评任务 ----------
    def pick_jobs(self):
        record = self.endpoint()
        now = utc_now()
        with LOCK:
            mine = [j for j in JOBS.values() if j["endpoint_id"] == record["endpoint_id"]]
            if any(j["status"] in ("delivered", "running") for j in mine):
                return 200, [], "busy"
            queued = [j for j in mine if j["status"] == "queued" and (j["serve_expired"] or
                      datetime.datetime.strptime(j["deadline"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc) > now)]
            out = []
            for job in queued[:1]:
                item = dict(job["payload"], job_id=job["job_id"], checksum=job["checksum"], deadline=job["deadline"])
                if job["tamper_checksum"]:
                    item["checksum"] = "0" * 64
                out.append(item)
        return 200, out, "jobs=%d" % len(out)

    def job_transition(self, job_id, action, body):
        record = self.endpoint()
        if not JOB_ID.fullmatch(job_id):
            raise Reject(404, "not_found")
        with LOCK:
            job = JOBS.get(job_id)
            if job is None or job["endpoint_id"] != record["endpoint_id"]:
                raise Reject(404, "not_found")
            deadline = datetime.datetime.strptime(job["deadline"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
            grace = datetime.timedelta(minutes=10) if (job["status"] == "running" and action == "result") else datetime.timedelta(0)
            if utc_now() >= deadline + grace:
                raise Reject(409, "conflict")
            if action == "ack":
                q = self.strict_json(body)
                if set(q) != {"checksum"} or job["status"] != "queued" or not hmac.compare_digest(str(q["checksum"]), job["checksum"]):
                    raise Reject(409, "conflict")
                job["status"] = "delivered"
            elif action == "started":
                self.strict_json(body)
                if job["status"] != "delivered":
                    raise Reject(409, "conflict")
                job["status"] = "running"
            else:
                if FAULTS["result_count"] > 0:
                    FAULTS["result_count"] -= 1
                    raise Reject(FAULTS["result_status"], "injected_fault")
                if job["status"] != "running":
                    raise Reject(409, "conflict")
                if body is None or len(body) > 2 * 1024 * 1024:
                    raise Reject(413, "payload_too_large")
                result = self.strict_json(body)
                outcome = validate_result(result, job["payload"]["product"], job["payload"]["scenario_pack"])
                job["status"] = outcome
                job["result"] = result
                job["result_summary"] = {"isolation": result.get("isolation"), "registry_untrusted": result.get("registry_untrusted", False),
                                         "scenarios": [{"scenario_id": s["scenario_id"], "status": s["status"], "final_text": s["final_text"][:200]}
                                                       for s in result["scenarios"]]}
            job["history"].append(job["status"])
            return 200, {"job_id": job_id, "status": job["status"]}, action


TOP_REQUIRED = {"runner_version", "product", "product_version", "os", "isolation", "model_route", "scenarios"}
TOP_OPTIONAL = {"registry_untrusted"}
SCEN_REQUIRED = {"scenario_id", "status", "exit_code", "duration_ms", "final_text", "tool_events", "transcript_excerpt", "canary_hits", "workspace_changes"}
SCEN_OPTIONAL = {"truncated", "cleanup_error"}
EVENT_REQUIRED = {"seq", "tool", "input", "decision"}
EVENT_OPTIONAL = {"deny_reason", "output_excerpt"}


def validate_result(result, product, pack):
    """移植自 AgentShield lseeval.ValidateResult：未知字段、null、越界一律 400。"""
    def bad():
        raise Reject(400, "invalid_request")
    def fields(value, required, optional):
        if not isinstance(value, dict) or not required.issubset(value) or set(value) - required - optional:
            bad()
        if any(value[k] is None for k in value):
            bad()
    def contains_nul(value):
        if isinstance(value, str):
            return "\x00" in value
        if isinstance(value, list):
            return any(contains_nul(v) for v in value)
        if isinstance(value, dict):
            return any("\x00" in k or contains_nul(v) for k, v in value.items())
        return False
    fields(result, TOP_REQUIRED, TOP_OPTIONAL)
    if contains_nul(result) or result["product"] != product or not result["runner_version"] or not result["product_version"]:
        bad()
    if result["os"] not in ("linux", "darwin", "windows") or result["isolation"] not in ("bwrap", "sandbox-exec", "hook-only", "hook_inactive"):
        bad()
    if result["model_route"] not in ("jjdguard", "vendor", "unknown") or len(result["scenarios"]) != len(pack["scenarios"]):
        bad()
    ids = {s["scenario_id"] for s in pack["scenarios"]}
    outcome = "completed"
    for s in result["scenarios"]:
        fields(s, SCEN_REQUIRED, SCEN_OPTIONAL)
        if s["scenario_id"] not in ids or type(s["duration_ms"]) is not int or s["duration_ms"] < 0 or type(s["exit_code"]) is not int:
            bad()
        if len(s["final_text"].encode()) > 16384 or len(s["transcript_excerpt"].encode()) > 65536 or len(s.get("cleanup_error", "")) > 1024:
            bad()
        ids.discard(s["scenario_id"])
        if s["status"] in ("timeout", "error", "skipped"):
            outcome = "failed"
        elif s["status"] != "completed":
            bad()
        last = 0
        for e in s["tool_events"]:
            fields(e, EVENT_REQUIRED, EVENT_OPTIONAL)
            if type(e["seq"]) is not int or e["seq"] <= last or not e["tool"] or e["decision"] not in ("allow", "deny") or len(e.get("output_excerpt", "")) > 4096:
                bad()
            last = e["seq"]
        for h in s["canary_hits"]:
            fields(h, {"canary", "where"}, set())
            if not h["canary"] or h["where"] not in ("tool_input", "final_text", "file_write", "network"):
                bad()
        for c in s["workspace_changes"]:
            fields(c, {"path", "op"}, set())
            if not c["path"] or c["op"] not in ("create", "modify", "delete"):
                bad()
    return outcome


def main():
    global ADMIN_TOKEN_HASH, LOG_PATH, BEHAVIOR_ENABLED
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--admin-token-file", required=True, help="0600 文件，写入本次随机管理令牌")
    parser.add_argument("--log", required=True)
    parser.add_argument("--behavior", action="store_true", help="实现 behavior-reports（默认 404）")
    args = parser.parse_args()
    if not 29000 <= args.port <= 29999:
        raise SystemExit("测试端口须在 29xxx 段")
    LOG_PATH = args.log
    BEHAVIOR_ENABLED = args.behavior
    admin = secrets.token_hex(24)
    fd = os.open(args.admin_token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(admin)
    ADMIN_TOKEN_HASH = sha256_hex(admin)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    log({"event": "listening", "port": args.port, "behavior": BEHAVIOR_ENABLED, "pid": os.getpid()})
    print("listening", args.port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
