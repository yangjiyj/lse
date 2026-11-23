# 鉴盾独立探针 · 自管终端管理接口（第一期）

> 2026-10-22。模块：`apps/api/src/modules/fleet-admin/`，前缀 `/api/fleet`。给鉴盾前端和管理员用，走平台登录 JWT 与 RBAC。
> 采集器访问的协议端点 `/agent/v1/*` 在另一个模块（fleet-agent），见 `protocol-subset.md`。

## 1. 开关与配置

| 环境变量 | 作用 |
| --- | --- |
| `FLEET_AGENT_ENABLED=true` | 总开关，与协议端点共用；关闭时 `/api/fleet/*` 一律返回 404 |
| `LSE_PUBLIC_BASE_URL` | 诱饵落点基地址，场景包里的 `sink_base_url = <它>/sink/<runToken>`（与现有真机测评一致） |
| `LSE_ENDPOINT_EVAL_ENABLED=true` | 现有落点 `/sink/<runToken>/exfil` 只在它开启时记录命中；自管终端复用这套落点，所以也要开 |
| `FLEET_PUBLIC_BASE_URL` | 终端访问鉴盾的 HTTPS 地址，只能是 `https://主机[:端口]` |
| `FLEET_TLS_CERT_PEM_PATH` | 挂载的**自签叶子证书** PEM（只放证书，不放私钥） |
| `FLEET_KIT_DIR` | 容器内探针包目录（AgentShield 的 collectors 目录：`catalog.json` + `linux-amd64.tar.gz` 等；Windows 安装包 `*.exe` 也放在这里），一键安装与 Windows 安装包用；未配置不影响 `ready` |
| `FLEET_KIT_BASE_URL` | 终端下载一键脚本与探针包的地址（可选），默认取 `LSE_PUBLIC_BASE_URL`，再默认取请求所用地址 |
| `LSE_ENDPOINT_EVAL_MCP_ALLOWLIST` | 配置体检 MCP 外联白名单（与现有体检共用） |

## 2. 权限

不新增角色和权限码，沿用现有权限：

| 用途 | 权限码 | 内置角色 |
| --- | --- | --- |
| 查看终端、体检结果、任务 | `model_target:read` | admin、operator、auditor |
| 管理接入码、吊销终端、部署信息、下载 Windows 安装包；批准/驳回升级前遗留的待批准任务 | `model_target:create` | admin、operator |
| 发起配置体检、发起真机测评 | `model_target:create` **且** `eval_task:create`（另需 `web_ai` 授权特性，与现有终端测评一致） | admin、operator |
| 取消任务 | 申请人本人无需额外权限；其他人需要 `model_target:create` | — |

约束：**管理员可以直接对终端发起真机测评，不需要另一位管理员审批**；批准接口只为升级前库里遗留的 `PENDING_APPROVAL` 任务保留，发起人本人也可以批准（不再有「申请人与审批人必须是两个账号」的限制，`FLEET_SELF_APPROVAL` 错误码已取消）。`requestedBy.id`、`approvedBy.id` 与 `/api/auth/me` 的 `user.id` 属于同一 ID 空间（`User.id`）。

## 3. 接口

错误统一为 `{"error":{"message","code","details?"}}`；分页参数 `page`（默认 1）、`pageSize`（默认 20，最大 100），列表返回 `{items,total,page,pageSize}`。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/enrollment-codes` | 管理 | 体 `{label, expiresInHours=24(1–168), maxUses=1(1–1000)}` → 201 `{code, notice, item}`。`code` 为 `jdc_`+32 字节 base64url，**只返回这一次**；库里只存 SHA-256 和前 8 位前缀 |
| GET | `/enrollment-codes` | 管理 | `?status=ACTIVE\|EXPIRED\|REVOKED\|EXHAUSTED`；不含明文和哈希 |
| POST | `/enrollment-codes/:id/revoke` | 管理 | 撤销，幂等 |
| GET | `/endpoints` | 查看 | `?q=`（主机名/所属用户/终端 ID）`&os=&online=online\|offline&status=ACTIVE\|REVOKED&evalRunner=yes\|no` |
| GET | `/endpoints/:id` | 查看 | 详情：基础信息 + health 摘要（白名单字段、脱敏）+ 最近体检报告摘要 + 最近 10 个任务 |
| POST | `/endpoints/:id/revoke` | 管理 | 令牌立即失效；排队中（含遗留的待批准）的任务 → CANCELLED，已下发/执行中的任务 → FAILED(`endpoint_revoked`) |
| GET | `/endpoints/:id/posture` | 查看 | 基于最近一份体检报告的判定结果（不落库）；没有报告时 409 |
| POST | `/endpoints/:id/posture-eval` | 发起 | 创建一个已完成的 EvalTask（问题集、结果、风险项），返回 201 `{taskId}`；没有报告时 409 `FLEET_NO_PROBE_REPORT`，`error.message` 为中文原因 |
| POST | `/endpoints/:id/eval-jobs` | 发起 | 体 `{product: claude-code\|codex, reason?, name?}` → 201。`reason` 为选填备注（缺省记「管理员发起」，最长 500 字，空白视同缺省）。**创建即 `QUEUED`**，`approvedBy`/`approvedAt` 记为发起人和创建时间；同时创建 EvalTask（描述「等待终端领取」，不再出现「审批」） |
| GET | `/eval-jobs` | 查看 | `?view=pending\|active\|history&status=&endpointId=&product=` |
| GET | `/eval-jobs/:id` | 查看 | 详情，附场景标题、提示词、夹具路径，供管理员了解终端上将执行什么；不含诱饵值、落点令牌和 payload 原文 |
| POST | `/eval-jobs/:id/approve` | 管理 | 仅用于升级前遗留的 `PENDING_APPROVAL` 任务：→ `QUEUED`，写入 approvedBy/approvedAt；发起人本人也可批准。其他状态返回 409（`FLEET_JOB_STATE`） |
| POST | `/eval-jobs/:id/reject` | 管理 | 仅用于遗留的 `PENDING_APPROVAL` 任务；体 `{reason}`（必填），→ REJECTED |
| POST | `/eval-jobs/:id/cancel` | 发起人或管理 | 只有 QUEUED（以及遗留的 PENDING_APPROVAL）可以取消；DELIVERED/RUNNING 返回 409（无法远程中止） |
| GET | `/deployment-info` | 管理 | `{ready, issues[], warnings[], server, certificate{pem,sha256,…}, tlsDeployment, collectorConfigPatch, installCommands[]}`；缺配置时 `ready:false`，`issues` 说明原因 |
| GET | `/deployment-info/tls-deployment.json` | 管理 | 附件下载，键恰好 3 个（规格 §0.2）；未就绪时 409 |
| POST | `/install/windows-installer` | 管理 | 下载内置了接入码的 Windows 安装包，见 §7 |
| GET | `/install/linux.sh` | 无需登录 | 动态生成的 Linux 一键安装脚本；部署未就绪或无可用探针包时 404 |
| GET | `/install/linux.sh.sha256` | 无需登录 | 上述脚本的 SHA-256（纯文本） |
| GET | `/kits/:filename` | 无需登录 | 探针包下载（流式，带 content-length）；只认 `catalog.json` 里列出的 linux-amd64 / linux-arm64 文件名，其余（含 `../`）404 |

`deployment-info` 另返回 `oneclick{available, reasons[], scriptUrl, scriptSha256, scriptFile, targets[]}`；探针包目录问题（未配置、缺 catalog、文件缺失、散列不符）只追加到 `warnings`，不影响 `ready`。Windows 目标（`windows-amd64`、`windows-arm64`）的 `targets[]` 条目另带 `installer{available, reason?}`，表示该架构的安装包现在能不能下载（不可用时 `reason` 是中文原因），前端据此决定下载按钮是否可点。

终端对象主要字段：`id, publicId, platform:'jiandun', hostname, os, osVersion, arch, osUser, status, online, lastSeenAt, evalRunner, agents[{product, version, headlessCapable}], capabilities, enrollmentCode{label,codePrefix}, latestReport{scannedAt, assetCount, …}`。

- `online`：终端为 ACTIVE 且 `lastSeenAt` 距今 ≤ 10 分钟。
- `agents` 取自心跳 health 里的 `agents`（或 `collector.agents`）。当前版本采集器还不上报这项，所以返回空数组，不做推断。

列表和详情都不返回 `tokenHash`、`codeHash`、`lastHealth` 原文、报告 `body`、`payloadCanonical`、`result`。

## 4. 测评任务状态流转

```
              创建（终端 ACTIVE、有 evalRunner、离线不超过 24h、无未结束任务）
                 │  管理员发起即下发，不需要审批
                 ▼
         QUEUED ──取消──▶ CANCELLED
           │   └──超过 deadline──▶ EXPIRED
     采集器 ack（协议端点）
           ▼
       DELIVERED ──started──▶ RUNNING ──result──▶ COMPLETED | FAILED
          （这两个状态不能远程取消；吊销终端时记为 FAILED）

   升级前遗留的 PENDING_APPROVAL（新任务不会再进入这个状态）：
         PENDING_APPROVAL ──批准（任何有管理权限的账号，含发起人本人）──▶ QUEUED
           │  │    └──────驳回────▶ REJECTED
           │  └──超过 deadline──▶ EXPIRED   └──取消──▶ CANCELLED
```

- deadline 默认为创建后 24 小时。排队中（含遗留的待批准）的任务过了 deadline，会在下一次查询相关接口时**惰性**置为 EXPIRED。
- 每次状态变化都会把 EvalTask 的 `description` 同步成状态文案（等待终端领取 / 终端已接收任务 / 终端正在执行 / 终端测评完成 / 任务已过期，终端未领取 …），并写审计日志 `fleet.*`。自管终端用 `FLEET_STATUS_LABELS`（`fleet-admin/service.ts`），升级前遗留的待批准任务沿用「等待终端审批」「终端审批通过，等待执行」；AgentShield 联动链路继续用 `endpoint-evals` 的 `STATUS_LABELS`，文案不变。

## 5. 与现有真机测评复用同一条入库路径

- 场景包由 `buildEndpointPack(sink)` 生成，诱饵落点用现有的 `/sink/<runToken>/exfil`。
- 创建任务时写入 `终端测评任务绑定` 日志，内容为 `{jobId:'', product, runToken, pack, source:'fleet', fleetJobId}`。`jobId` 留空，因此 AgentShield 轮询和回调都不会触碰自管终端任务。
- 入库统一走 `endpoint-evals/service.ts` 的 `applyEndpointUpdateTx`（由 `applyEndpointUpdate` 拆出，可以在调用方事务内执行）。自管终端任务传 `{source:'fleet', labels: FLEET_STATUS_LABELS}`，按 `fleetJobId` 校验绑定。结果判定、诱饵命中、EvalResult/Finding 写法与 AgentShield 回调**完全一致**。
- 每台自管终端对应一个 ENDPOINT_AGENT 评估对象（`provider='jiandun-fleet'`，通过 `accessConfig.fleetEndpointId` 关联），首次体检或测评时自动创建，供评估任务列表和报告使用。
- 结果钩子：`finish.ts` 导出 `finalizeFleetJob(jobId)` 和 `installFleetFinishHook(register)`。协议端点模块在 started/result 落库后调用注册的回调；合并后在 app 启动处执行 `installFleetFinishHook(registerFleetJobFinishedHook)`。

## 6. 配置体检判定

判定直接复用 `posture-judge.ts` 的 `judgePosture`；`fleet-admin/posture.ts` 负责把 `aiprobe.report.v1` 适配成它需要的输入：

- 权限模式、自动批准：取自智能体资产的 `evidence.config`，以及静态检查 `config.permission` 的命中情况。
- MCP：智能体资产下挂的 MCP 和独立的 `mcp_server` 资产合并去重。只有 `agents` 采集器状态为 complete 时，才认为 MCP/技能清单已采集。
- 凭据：只有每个智能体资产的 `config.credential` 检查都有结论（非 unknown）时，才算已采集。
- 报告里静态检查的命中项（`config.permission`、`config.auto_approval`、`mcp.description_*`、`mcp.transport`、`*.credential`）只会把对应规则**升级为 FAIL**。未采集的项保持 UNKNOWN，不会被当作安全。

## 7. Windows 安装包

管理员创建接入码后，可以下载一个**内置了接入码和服务端信息的 Windows 安装包**，在 Windows 终端上双击运行即可完成接入。安装包是把探针安装器 `exe` 加上一段部署配置拼成的，由 `fleet-admin/installer.ts` 生成。

### 7.1 接口

`POST /api/fleet/install/windows-installer`（需要登录和 `model_target:create`，与其他管理接口一样受 `FLEET_AGENT_ENABLED` 开关保护，关闭时 404）。

请求体：

```json
{ "code": "jdc_…（刚创建的接入码明文）", "target": "windows-amd64" }
```

- `target` 只能是 `windows-amd64` 或 `windows-arm64`，其他值 400。
- `code` 必须以 `jdc_` 开头。接入码明文不能放进 URL（会进访问日志），所以用 POST 请求体。
- 下载**不消耗**接入码的使用次数；次数只在终端真正登记时扣减。同一个接入码可以重复下载。

成功返回 200：`Content-Type: application/octet-stream`、`Content-Disposition: attachment; filename="jiandun-probe-setup-<target>.exe"`、准确的 `Content-Length`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，流式发送。

失败时统一为 `{"error":{"message","code"}}`，`message` 是中文原因（前端原样显示）：

| 状态码 | `code` | 场景 |
| --- | --- | --- |
| 409 | `FLEET_CODE_UNUSABLE` | 接入码不存在 / 已过期 / 已用完 / 已撤销（四种各有明确文案） |
| 409 | `FLEET_DEPLOYMENT_NOT_READY` | 部署信息不满足安装包的要求（见 §7.3），`message` 列出全部原因 |
| 409 | `FLEET_INSTALLER_UNAVAILABLE` | 探针包不支持或缺文件（见 §7.4），或文件在校验后又被更新（请稍后重试） |
| 400 | — | 请求体不合法（`target` 不是 Windows、`code` 格式不对） |
| 401 / 403 | — | 未登录 / 没有管理权限 |

审计动作 `fleet.installer.download`（审计日志页显示为「下载终端安装包」），目标类型 `fleet_enrollment_code`，记录 `codeId`、`codePrefix`、`target`，**不记明文接入码**；错误信息里也不会回显接入码。

### 7.2 安装包尾部格式

与探针仓库（AgentShield）`apps/api/internal/handler/client_installers.go` 的约定完全一致：

```
exe 原始字节
+ 部署配置 JSON（UTF-8，≤ 8192 字节）
+ 4 字节小端 uint32（JSON 的字节数）
+ ASCII "ASPDEPLOY1"（10 字节魔数）
```

JSON 只能出现下面这些键（安装器用 `DisallowUnknownFields` 严格解析，多一个键就装不上）：

| 键 | 类型 | 内容 |
| --- | --- | --- |
| `server` | string | 终端访问鉴盾的地址，如 `https://100.64.0.10:18453`（`FLEET_PUBLIC_BASE_URL`） |
| `enrollment_code` | string | 接入码明文 |
| `allow_http` | bool | 固定 `false` |
| `expires_at` | string | 接入码到期时间，RFC3339 UTC，精确到秒（向下取整）；**不做 7 天截断**，接入码有效多久就写多久 |
| `tls_server_cert_pem` | string | 服务端自签叶子证书 PEM（≤ 4096 字节） |
| `tls_server_cert_sha256` | string | 证书 DER 的 SHA-256，小写十六进制 |
| `server_kind` | string | 固定 `"jiandun"` |

安装器读到尾部后，以管理员身份把探针安装成系统服务，并用其中的接入码向 `server` 登记。

### 7.3 生成前的部署预检

宁可在服务端给出中文原因，也不生成一个装不上的安装包。预检规则以安装器源码 `probe/internal/enterprise/deployment.go` 的 `ValidateDeployment` 为准（只读对照，已用该校验器对 32 种证书组合逐一核对，结论一致）：

- `FLEET_PUBLIC_BASE_URL` 必须是 `https`，主机必须是 **IP 地址**（安装包不支持域名），无用户信息、查询、片段，路径只能为空或 `/`。
- 证书文件只含**一个** CERTIFICATE 块，≤ 4096 字节；是**自签叶子证书**：BasicConstraints 扩展存在且显式 `CA:FALSE`，主体与颁发者相同。
- SAN 里**恰好一个 IP**，且等于服务地址的主机；不能有 DNS、URI、邮箱条目。
- KeyUsage 含 `digitalSignature`，不含 `keyCertSign`、`cRLSign`；ExtendedKeyUsage 含 `serverAuth`。
- 当前时间在证书有效期内。

用 `scripts/fleet-gen-cert.sh` 生成的证书（EC P-256、IP SAN）满足全部条件。不满足时接口返回 `FLEET_DEPLOYMENT_NOT_READY`，`deployment-info` 的 `oneclick.targets[].installer.reason` 也会给出同样的原因，前端据此把下载按钮置灰。

### 7.4 探针包目录里需要什么

`FLEET_KIT_DIR`（容器内路径，只读挂载）里的 `catalog.json`，Windows 条目需要带：

```json
{
  "target": "windows-amd64",
  "setup_filename": "agent-security-client-windows-amd64.exe",
  "setup_sha256": "<exe 的 SHA-256>",
  "setup_bytes": 23883791,
  "setup_server_kinds": ["agentshield", "jiandun"]
}
```

- `setup_filename` 必须是不含路径的 `.exe` 文件名，文件放在同一目录；`setup_sha256` 必须是 64 位十六进制；`setup_bytes` 可选。
- **只有 `setup_server_kinds` 含 `"jiandun"` 才提供下载**：旧版安装器解析部署配置时会拒绝未知字段，给它追加 `server_kind` 必然装不上，所以旧清单（没有这个字段）一律视为不支持。
- 服务端会校验 exe 的 SHA-256 与清单一致（按「路径 + 大小 + 修改时间」缓存校验结果，不会每次下载都重算几十 MB）；发送时还会对已打开的文件边读边算 SHA-256，读完与清单一致才发送含接入码的尾部，发送途中文件被替换则中断响应——宁可让下载失败，也不会把「被换过的安装包 + 接入码」发出去。

安装包不可用时，`installer.reason`（以及下载接口的 409 `message`）会是下面之一，界面上原样显示：

| 原因 | 处理 |
| --- | --- |
| 未配置探针包目录，暂不能提供安装包 | 配置 `FLEET_KIT_DIR` |
| 探针包清单无法读取，暂不能提供安装包 | 检查 `catalog.json` 是否存在、是否合法 JSON |
| 探针包清单中没有该架构的 Windows 安装包 | 清单里补上该架构的 `setup_filename`、`setup_sha256` |
| 当前探针包版本不支持鉴盾安装包，请更新探针包 | 换成含 `setup_server_kinds: ["jiandun"]` 的新版探针包 |
| 探针包目录缺少 Windows 安装包文件 | 把 `.exe` 拷进探针包目录（只拷了 catalog 和 Linux 包时会这样） |
| Windows 安装包的文件大小与探针包清单不符 / SHA-256 校验与探针包清单不一致 | 重新从受信渠道取包，不要手改 |

### 7.5 使用方式与未签名提示

1. 在「终端 → 接入终端」页签点「创建接入码」，明文只显示一次。
2. 在卡片里选 **Windows**，点「下载安装包（x64）」或「下载安装包（ARM64）」。
3. 把安装包拷到 Windows 终端，**双击运行**，按提示允许管理员权限，即可完成安装和接入。
4. **批量下发**：用 `安装包.exe /quiet` 静默安装（适合 EDR / 软件分发系统），一个接入码可接入的台数由「可用次数」决定。
5. **安装包暂未做代码签名**。首次运行如果出现「Windows 已保护你的电脑」（SmartScreen），点「更多信息」→「仍要运行」；静默安装不受影响，但企业环境的安全软件可能需要放行。
6. 安装包里**内置了接入码**，相当于带密码的文件：不要通过聊天或公开网盘传播；接入码过期、用完或被撤销后，这个安装包就不能再用于登记。

Windows 真机测评与其他系统一样，**是否可用取决于终端是否上报了测评执行器**（终端本机装有 Claude Code 或 Codex，并在安装探针时开启测评），不再按操作系统一刀切。

