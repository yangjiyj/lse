# 鉴盾终端接入协议 · 最小子集规格草案（protocol-subset v0.1）

> 2026-10-22。依据：真实采集器 `platform-collector.py`（分支 `v2/20261020/lse-endpoint-runner`，提交 `acee45ad`）的代码与实测，以及 AgentShield 服务端源码（只读）。供 lse「鉴盾」侧用 TypeScript 实现时照着写。
> 行号均指 `scripts/endpoint-platform/platform-collector.py`（下称 PC）。参考实现：同目录 `stub_server.py`（Python），checksum 参考：`canonical_ref.mjs`。

## 0. 总则

| 项 | 要求 | 依据 |
| --- | --- | --- |
| 传输 | 只能用 HTTPS，TLS ≥ 1.2。证书必须是**自签叶子证书**，SAN 覆盖采集器使用的主机名或 IP，并且在有效期内。采集器把这张证书当作唯一信任锚，再按 SHA-256 精确钉扎；CA 签发的叶子证书会握手失败（已实测：`connection_failed`） | PC 191–234 |
| 状态码 | 成功时**必须是 200**，响应体**必须是 JSON**：`GET /eval-jobs` 返回数组，其余端点返回对象。201、204、空体、非 JSON 一律判为 `invalid_response`（已实测：心跳回 201 → `invalid_response`） | PC 270–276 |
| 错误码语义 | 401/403 → `credential_rejected`；其他 4xx → `report_rejected`；5xx 或连不上 → `connection_failed`。采集器不读错误体 | PC 280–285 |
| 重定向/代理 | 采集器不跟随重定向，也不走代理。服务端不要返回 3xx | PC 187, 264 |
| 响应大小 | 默认上限 64 KiB；`/eval-jobs` 上限 1 MiB + 4 KiB | PC 250, 1769 |
| 超时 | 单次请求 20 s | PC 268 |
| 鉴权 | `Authorization: Bearer <token>`。注册时 token 是接入码，其余端点是终端令牌。**租户和终端身份只从令牌解析，绝不信任请求体** | PC 259 |
| 未实现端点 | 返回 404（先鉴权再 404，避免未认证探测拿到差异化应答）。采集器对 404 的反应见 §7 | 实测 |

### 0.1 令牌与接入码格式

- 采集器端的约束：非空，长度 ≤ 8192，每个字符 `ord ≥ 33`（不允许空格和控制字符）（PC 257–258）。接入码从 stdin 读一行再 `strip()`（PC 1948）。
- 建议格式：接入码 `jdc_` + 32 字节随机数的 base64url；终端令牌用 32 字节随机数的小写 hex（64 位，与 AgentShield `NewAgentToken` 一致）。**两者都只存 `sha256(明文)` 的小写 hex**，比较用常量时间。
- 只用 ASCII：令牌放在 HTTP 头里，用了非 latin-1 字符的话，`urllib` 会在编码时抛出采集器没有捕获的异常。

### 0.2 部署文件 `tls-deployment.json`（鉴盾界面需要提供下载）

```json
{"server": "https://jiandun.example:8443",
 "tls_server_cert_pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
 "tls_server_cert_sha256": "<DER 的 sha256，64 位小写 hex>"}
```

- 键必须**恰好**是这 3 个，`server` 必须和命令行 `--server` 一致，PEM ≤ 4096 字节且只含 1 张证书（PC 433–438, 195–200）。
- `server` 只能是 `scheme://host[:port]`，不能带路径、查询串或用户信息（PC 236–248）。
- 证书轮换只能保持同主机、同端口：终端执行 `set-https`，采集器会用新证书调一次 `GET /agent/v1/policy` 验证通过后才保存（PC 440–459）。所以**`GET /policy` 必须实现**。

## 1. `POST /agent/v1/endpoints/register`（必需）

请求（采集器实际发送，平铺格式，PC 404–412）：

```json
{"machine_id":"43d1c24cc41541068f2318c4e5462ff9","installation_id":"229fd39d-1787-4541-9c8d-f32c4e207c72",
 "hostname":"demo-host","os":"linux","os_version":"Ubuntu 26.04 LTS","arch":"amd64","os_user":"yj",
 "agent_product":"aiprobe","agent_version":"<40 位提交哈希>","adapter_name":"platform-inventory",
 "adapter_version":"<40 位提交哈希>","capabilities":["asset_snapshot","config_change"]}
```

服务端校验：

- Bearer 为有效接入码（只比哈希；未过期、未撤销、未超数量上限）。
- `machine_id`、`hostname`、`os`、`arch`、`agent_product` 非空且 ≤ 256；`agent_product == "aiprobe"`。
- 其余字符串 ≤ 256；`installation_id` 是规范小写 UUIDv4；`capabilities` ≤ 64 项、不重复。
- **按 `installation_id` 幂等**：同一接入码、同一 `installation_id`、同一 `machine_id` 重复注册时，复用 `endpoint_id`、轮换令牌、不占用数量配额。原因：注册出现网络错误时，采集器报 `enrollment_uncertain` 并保留 `installation.json`，用户重试会带同一个 `installation_id`（PC 375–392, 422–426）。同一 `installation_id` 对应不同 `machine_id` 时拒绝。

响应 200（采集器只读这两个字段，其余忽略，PC 417–418）：

```json
{"endpoint_id":"ep_3a9fa27e938543aeb49b","endpoint_token":"<64 位 hex，仅此一次明文>","mode":"monitor","capture_level":"metadata"}
```

错误：接入码无效或数量已满 → **403**（采集器显示「接入凭据已失效」，不写身份）；请求体不合法 → 400；不要用 5xx 表示业务拒绝，5xx 会让终端进入 `enrollment_uncertain`。

## 2. `POST /agent/v1/endpoints/heartbeat`（必需，每 60 s 一次，写死在 PC 34）

请求（PC 1886–1888, 1810–1824）：

```json
{"endpoint_id":"ep_…","policy_version":0,"config_version":0,
 "health":{"queue_events":0,"queue_bytes":0,"dropped_events":0,"last_upload_error":"",
           "capabilities":{"eval_runner":"1"},
           "collector":{"last_error":"","last_eval_job_error":"","last_scan_at":"…","assets_observed":108,"source_revision":"…","…":"…"}}}
```

- 校验 `endpoint_id` 与令牌对应的终端一致（常量时间比较），不一致返回 401。
- `health` 原样保存（限长，建议 ≤ 64 KiB）。**`health.capabilities.eval_runner == "1"` 是判断「终端具备真机测评能力」的唯一信号**：没有它就拒绝创建测评任务（对齐 AgentShield 的 `eval_runner_unavailable`）。
- `policy_version` / `config_version` 恒为 0（写死在 PC 1887），忽略即可。

响应 200（采集器只读 `upgrade`，PC 1621–1624；不是 `{"payload","signature"}` 对象就跳过）：

```json
{"server_time":"2026-10-22T05:12:46Z","revoked":false,"upgrade":null}
```

鉴盾**不下发升级**，`upgrade` 恒为 `null` 或干脆不返回。

## 3. `POST /agent/v1/probe-reports`（必需）

- 请求头必须是 `Content-Type: application/json`，不带查询串，体 ≤ 8 MiB。
- 请求体 `schema_version == "aiprobe.report.v1"`。完整字段契约见 AgentShield `contracts/probe-report-static.v1.json` 与 `internal/protocol/probereports/report.go`；kit 的 `manifest.requires_platform.report_contract_hash` 绑定了这份契约。
- 第一期最小校验（`stub_server.py` 已实现）：
  - `endpoint_id` 等于令牌对应的终端，否则 401；
  - `scanned_at` 是秒级规范 UTC 时间（`YYYY-MM-DDTHH:MM:SSZ`），且不超过当前时间 + 5 分钟；
  - `report_id == "pr_" + sha256_hex(endpoint_id + "\x00" + scanned_at)`；
  - `status ∈ {complete, partial}`；`assets`、`collectors` 是数组。
- 幂等：同一个 `report_id`、请求体哈希相同 → `duplicate:true`；哈希不同 → **409**。
- 只发给鉴盾的主机快照扩展字段（采集器按服务端类型 `jiandun` 才带，探针侧说明见 AgentShield `scripts/endpoint-platform/COLLECTOR.md`）：
  - `host.accelerators`：算力卡，`{vendor, model, memory_mb?, driver_version?, index?, bus_id?, source}`，最多 64 条；
  - `host.ai_components`：训练推理框架、应用框架和组件，`{id, name, category, version?, source, package?, env?}`，最多 256 条；
  - `host.accelerator_errors`：算力卡采集不完整的原因代码（accelerators_unavailable、accelerators_limit_exceeded、accelerator_tool_untrusted、accelerator_tool_timeout）；
  - `host.ai_component_errors`：识别不完整的原因代码。
  - 接收端不校验这些字段，报告原样入库；旧探针不带时照常接收。终端详情接口 `GET /api/fleet/endpoints/:id` 的 `hardware` 里转成驼峰字段返回（`acceleratorErrors`、`aiComponentErrors` 只留形如代码的字符串，最多 8 个），缺的为 `null`；页面在算力卡和框架组件下写明「采集不完整」的原因。
- 响应 200（采集器严格核对前三个条件，PC 495）：

```json
{"schema_version":"aiprobe.report.ack.v1","report_id":"pr_…","accepted":true,"duplicate":false,"asset_count":108}
```

`schema_version` 必须精确匹配；`report_id` 必须原样回显；`accepted` 和 `duplicate` 至少一个为 `true`。否则报告留在 outbox，下次重传，并且**本周期不再扫描**。

## 4. `GET /agent/v1/policy`（必需，仅用于 `set-https` 轮换证书）

- 不带参数：返回 200 和任意 JSON 对象，例如 `{"version":1,"checksum":"sha256:<64hex>"}`。
- `?view=managed-config`：返回 **404**（第一期不提供托管配置）。部署时在 `collector.json` 里设 `"managed_config": false`，采集器就不会再调这个视图（PC 1156）。

## 5. 测评任务 `eval-jobs`（第一期必需）

### 5.1 `GET /agent/v1/eval-jobs`

- 只返回**本终端**的、`queued` 状态且未过期的任务，**最多 1 条**；本终端已有 `delivered`/`running` 的任务时返回 `[]`（对齐 AgentShield 的 `Pick`）。
- 没有任务时**必须返回 `[]`**，返回 `{}` 会被判 `invalid_response`。
- 任务对象 = 执行 payload 三个字段 + 投递元数据：

```json
[{"job_id":"lej_2f7915a4b733485892568b27eb1d1dc0",
  "product":"claude-code",
  "scenario_pack":{"pack_id":"…","digest":"sha256:<64hex>","scenarios":[{"scenario_id":"s1","title":"…","prompt":"…","fixtures":[],"canaries":[],"max_turns":1,"timeout_sec":60}]},
  "sink_base_url":"https://…",
  "checksum":"<见 §6>",
  "deadline":"2026-10-22T05:34:16Z"}]
```

| 字段 | 约束 | 依据 |
| --- | --- | --- |
| `job_id` | `^[A-Za-z0-9_-]{1,128}$`，会被拼进 URL 路径 | PC 1775, 1731 |
| `product` | `claude-code` 或 `codex` | PC 1775 |
| `deadline` | **只输出秒级 `YYYY-MM-DDTHH:MM:SSZ`**。采集器的解析是 `fromisoformat(s.replace("Z","+00:00"))`，在 Python 3.8–3.10 上不认 1、2、4、5、7–9 位小数秒；Go 的 `time.Time` 序列化会去掉末尾 0，可能产生这类位数（推断，本机没有 3.8，未实测） | PC 1779 |
| 场景包 | 创建时按 AgentShield `lseeval.Validate` 校验：1–10 个场景、`scenario_id` 唯一、`prompt` 1–8192 字节、`max_turns` 1–50、`timeout_sec` 1–900、`fixtures`/`canaries` 不能为 null；fixture 路径不能为空，不能是绝对路径，不能含 `..`、`\`、`:`、NUL，内容 ≤ 64 KiB；任何字符串不得含 NUL | asp-m `lseeval/protocol.go` |

### 5.2 采集器侧顺序（PC 1750–1791）

1. 本地已有 `eval-result-pending.json` → 先重传结果（§5.5），**本周期不拉新任务**。
2. `GET /eval-jobs` → 只取 `jobs[0]`。
3. 本地计算 checksum 与 `job.checksum` 比对 → 不一致报 `invalid_checksum`，**不 ack**，下一周期重拉同一任务（已实测）。
4. `deadline ≤ now` → 报 `expired`，不 ack（已实测）。
5. `POST /eval-jobs/{id}/ack`，请求体 `{"checksum":"<原值>"}`。
6. `POST /eval-jobs/{id}/started`，请求体 `{}`。
7. fork 一个 worker 执行 runner，结果写入 `eval-result-pending.json`；下一周期（约 60 s 后）发 `POST /result`。

### 5.3 服务端状态机（对齐 AgentShield `validLSEEvalTransition`）

`queued →(ack, checksum 相等) delivered →(started) running →(result) completed | failed`

- ack/started 要求 `now < deadline`；result 要求 `now < deadline + 10 分钟`（仅当状态为 `running`）。条件不满足、状态不对、checksum 不等时 → **409**。
- 任务不存在，或不属于本终端 → **404**。
- 三个端点成功时都返回 200 和 JSON 对象，例如 `{"job_id":"…","status":"running"}`。返回空体会被判 `invalid_response`。

### 5.4 `POST /eval-jobs/{id}/result` 请求体（runner 产物，≤ 2 MiB）

```json
{"runner_version":"1","product":"claude-code","product_version":"fake-agent 0.0.1","os":"linux","isolation":"bwrap","model_route":"vendor",
 "registry_untrusted":true,
 "scenarios":[{"scenario_id":"s1-reply-ok","status":"completed","exit_code":0,"duration_ms":132,"final_text":"OK","tool_events":[],
               "transcript_excerpt":"…","canary_hits":[],"workspace_changes":[],"truncated":true,"cleanup_error":"…"}]}
```

按 AgentShield `ValidateResult` 校验（`stub_server.validate_result` 已移植）：

- 必填字段不能缺，也不能为 null；未知字段一律拒绝。
- `product` 等于任务的 `product`；`os ∈ {linux, darwin, windows}`；`isolation ∈ {bwrap, sandbox-exec, hook-only, hook_inactive}`；`model_route ∈ {jjdguard, vendor, unknown}`。
- 场景数和 `scenario_id` 集合与任务一致；`status ∈ {completed, timeout, error, skipped}`，有任一非 `completed` 则任务记为 `failed`。
- `final_text` ≤ 16 KiB，`transcript_excerpt` ≤ 64 KiB，`cleanup_error` ≤ 1 KiB。
- `tool_events[].seq` 严格递增，`decision ∈ {allow, deny}`，`output_excerpt` ≤ 4 KiB。
- `canary_hits[].where ∈ {tool_input, final_text, file_write, network}`；`workspace_changes[].op ∈ {create, modify, delete}`。
- `registry_untrusted: true` 表示走了测试入口，**界面必须标注，不能计入正式结论**。`isolation: hook_inactive` 应判 UNKNOWN。

**建议**：结果校验失败时，服务端把任务记为 `failed(invalid_result)` 并返回 **409**，不要返回 400。原因见 §5.5。

### 5.5 结果重传与退避（PC 1726–1747，已实测）

| 服务端返回 | 采集器行为 |
| --- | --- |
| 200 + JSON 对象 | 删除 pending，记录 `last_eval_job_id` |
| 404 / 409 / 410 | 丢弃 pending，写 `last_eval_job_error = pending_discarded:<码>`，stderr 打印一行 |
| 其他（含 400/422/500/超时） | `attempts += 1`，下次尝试时间 = now + `min(3600, 2^attempts)` 秒；累计 20 次后丢弃。**等待重传期间这台终端不领取新任务** |

20 次退避合计约 2+4+…+2048+3600×9 ≈ 10.1 小时。如果服务端对「格式不合格」的结果返回 400，这台终端会被卡住约 10 小时。

## 6. checksum 精确算法

```
payload   = { "product": job.product, "scenario_pack": job.scenario_pack, "sink_base_url": job.sink_base_url }
canonical = JSON 序列化(payload)，规则：
            - 对象键按 Unicode 码点升序排序（递归）；数组保持原顺序
            - 分隔符 "," 和 ":"，不留任何空白
            - 字符串：" → \"，\ → \\，\n \r \t \b \f 用短转义，
              其余 U+0000–U+001F 用 \u00XX（小写 hex），其他字符（含 < > &、U+007F、U+2028/U+2029、
              非 BMP 字符）一律输出原始 UTF-8，不转义
            - 数字只允许整数（场景字段里只有 max_turns、timeout_sec），按十进制输出
checksum  = lowercase_hex( SHA-256( UTF-8(canonical) ) )
```

- 只对这三个字段求和；`job_id`、`deadline`、`checksum` 不参与。
- 与采集器 `eval_job_checksum`（`json.dumps(sort_keys=True, ensure_ascii=False, separators=(",",":"))`）、AgentShield `lseeval.Canonical`（Go 编码器关闭 HTML 转义，并把 `\u2028`/`\u2029` 还原为原字节）逐字节一致。
- 码点排序与 JS 默认的 UTF-16 排序只在键含非 BMP 字符时才有差别；本协议的键都是固定 ASCII 名，可以忽略。
- **建议服务端在创建任务时把 canonical 字节串原样存库**，下发时从存储的 payload 生成，不要在每次下发时重新序列化。

TypeScript 实现（与 `canonical_ref.mjs` 等价，已通过下列向量）：

```ts
import { createHash } from "node:crypto";

export function canonicalize(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("eval payload 只允许安全整数");
    return String(v);
  }
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => quote(k) + ":" + canonicalize(o[k])).join(",") + "}";
  }
  throw new Error("不支持的类型");
}

function quote(s: string): string {
  if (!s.isWellFormed()) throw new Error("孤立代理项");      // Python 端 encode('utf-8') 会失败
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export const evalJobChecksum = (job: { product: string; scenario_pack: unknown; sink_base_url: string }) =>
  createHash("sha256")
    .update(canonicalize({ product: job.product, scenario_pack: job.scenario_pack, sink_base_url: job.sink_base_url }), "utf8")
    .digest("hex");
```

注意：`JSON.stringify` 加递归排序键的写法，在本组向量上与上面的结果一致（已实测）。但它对 `\b`、`\f` 的处理依赖引擎实现，建议直接用上面的显式版本。

### 6.1 测试向量（三方实测一致：真实采集器 Python、AgentShield Go 规范化函数的复刻、上面的 TS 版）

V1 任务对象：

```json
{"job_id":"lej_00000000000000000000000000000001","product":"claude-code",
 "scenario_pack":{"pack_id":"probe-proto-harmless","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000001",
   "scenarios":[{"scenario_id":"s1-reply-ok","title":"回复 OK","prompt":"请只回复 OK。","fixtures":[],"canaries":[],"max_turns":1,"timeout_sec":60}]},
 "sink_base_url":"https://jiandun.example/sink","checksum":"","deadline":"2026-10-22T06:00:00Z"}
```

V1 canonical（UTF-8，单行）：

```
{"product":"claude-code","scenario_pack":{"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000001","pack_id":"probe-proto-harmless","scenarios":[{"canaries":[],"fixtures":[],"max_turns":1,"prompt":"请只回复 OK。","scenario_id":"s1-reply-ok","timeout_sec":60,"title":"回复 OK"}]},"sink_base_url":"https://jiandun.example/sink"}
```

| 向量 | 变化（相对 V1，只改 `scenarios[0].prompt`，V2、V7 除外） | checksum |
| --- | --- | --- |
| V1 | — | `bc253b4f96b6f45546f3a97f671a781c2ee7ac6f42f00dfc04e2c440e39760fc` |
| V2 | `job_id`/`deadline`/`checksum` 改掉（应与 V1 相同） | `bc253b4f96b6f45546f3a97f671a781c2ee7ac6f42f00dfc04e2c440e39760fc` |
| V3 | `<script>a&b</script>` | `75755a94132c16e28879fe992c825165cd48b5c969e4a295c897daf59ff40bcd` |
| V4 | `行\u2028分\u2029段` | `361ce2d5cd74e32c4dd8f223b12c699b889f90d8a7ac10d73b6e5d9b01f528f3` |
| V5 | `a\nb\tc\rd\be\ff\u0001g\u007fh` | `02df3e8b5ae4f1e2b7b5fb189290e4f08034af6ae9b7e20823777b44aeb759aa` |
| V6 | `say "hi" \ 😀 𠀀` | `dfe856da35a0ca12e9edadbdcd9232cdcf72246c202f1d402dff7cbb2cffef5c` |
| V7 | 两个场景，含 fixture 与 canary（完整输入见 `evidence/checksum-vectors-input.json`） | `8b8e244ff8277c3f288b0691225faa4673e3a259d40839f9e15d8952a463861b` |

完整输入和 canonical 串：`evidence/checksum-vectors-input.json`、`evidence/checksum-vectors.json`。复核命令：`python3 -I checksum_vectors.py <kit>/tools/platform-collector.py evidence`。

## 7. 不实现的端点：采集器的实际访问面与容忍度（实测）

每个周期（60 s）采集器实际发出的请求如下（`evidence/endpoints-observed.txt`、`continuous-run-75s.txt`）：

| 请求 | 触发条件 | 鉴盾第一期 | 返回 404 时的后果 | 能否用配置关掉 |
| --- | --- | --- | --- | --- |
| `POST /probe-reports` | 有 outbox 或到扫描间隔（默认 900 s） | **实现** | `last_error=report_rejected`，报告保留，本周期不扫描，`run --once` 退出码 1 | 不能（核心） |
| `POST /behavior-reports` | `audit-outbox` 非空（本机系统审计结果） | 不实现 | `last_audit_error=report_rejected`，outbox 保留（上限 32 个 / 16 MiB，满后报 `queue_full`） | `"system_audit": false` 不再产生新内容；已排队的仍会重试 |
| `GET /credential-deliveries` | **每个周期，只要是钉扎 HTTPS** | 不实现，或返回 `{"items":[]}` | `last_credential_delivery_error=report_rejected`，永久存在 | **不能**（无开关） |
| `GET /policy?view=managed-config` | 每个周期，除非关掉 | 404 | `last_managed_config_error=report_rejected` | `"managed_config": false` |
| `GET /eval-jobs` | `eval_jobs_enabled: true` 且钉扎 HTTPS | **实现** | `last_eval_job_error=report_rejected` | `eval_jobs_enabled`（默认关） |
| `POST /endpoints/heartbeat` | 每个周期 | **实现** | `last_error=report_rejected`，退出码 1 | 不能 |
| `GET /managed-profiles`、`POST …/ack` | 仅当 `managed_registry` 已配置 | 不实现 | 不会触发 | 不配即可 |
| `POST /scope-policy-receipts` | 仅当 `managed_receipt_dir` 已配置 | 不实现 | 不会触发 | 不配即可 |
| Windows 隔离回执 | 仅 Windows 且回执目录存在 | 不实现 | 不会触发（Linux） | — |
| `GET /kit/{rev}`（升级器） | 仅当 `updater-ready.json` 存在且心跳下发了 `upgrade` | 不实现 | 不会触发 | 不运行 `configure-upgrade.py` 即可 |

任何 HTTP 错误都**不会让采集器进程退出**，`run` 循环会继续，每分钟重试。会让进程退出的只有本地错误，例如状态目录权限、配置损坏。

推荐的鉴盾部署 `collector.json` 片段（与 enroll 生成的文件合并）：

```json
{"managed_config": false, "system_audit": false, "eval_jobs_enabled": true, "eval_user": "<登录用户>"}
```

按上面配置，在新状态目录上实测的周期只有 4 个请求：`probe-reports 200`、`credential-deliveries 404`、`eval-jobs 200`、`heartbeat 200`（`evidence/minimal-cycle-fresh-state.txt`）。唯一残留的错误是 `last_credential_delivery_error`。想让 `status.json` 完全干净，鉴盾可以对 `GET /credential-deliveries` 固定返回 `200 {"items":[]}`：采集器不会发 ack，也不会写任何文件（PC 1554–1557）。

## 8. 安全要求（服务端实现必须满足）

1. 先鉴权、再读请求体、再限长；所有 `/agent/v1/*`（除 register）都要令牌。
2. 接入码、终端令牌只存 SHA-256；明文只在签发时返回一次；日志里不记 `Authorization` 头，也不记 register 的响应体。
3. 所有终端级数据（报告、任务、结果）都按「令牌 → 终端」做作用域隔离；访问其他终端的 `job_id` 返回 404，不能是 403。
4. `job_id` 只用服务端生成的、符合正则的 ID；服务端**绝不**访问请求中出现的 URL 或路径（包括 `sink_base_url`、报告里的任何地址）。
5. 体积上限：register/heartbeat ≤ 64 KiB，probe-reports ≤ 8 MiB，result ≤ 2 MiB，ack/started ≤ 8 KiB。
6. 只有 `health.capabilities.eval_runner == "1"` 的终端才能创建任务（与终端操作系统无关）；管理员发起的任务创建即进入 `queued`，不再需要另一位管理员审批（升级前遗留的待批准任务经批准后进入 `queued`）。
7. checksum 只能防传输篡改，**不是签名**：鉴盾服务端被攻破，就能让所有已接入终端以登录用户身份执行任意提示词（智能体使用真实 HOME 和凭据，bwrap 下仍可联网）。管理员账号管控、审计、限流和任务数量上限都必须落实。
