# 终端体检：三项沙箱检查的判定规则

核对日期：2026-11-17。各智能体的配置项名称和语义以文末官方文档为准；文档没有写明的一律记为「未检查」，不推断。

## 一、检查项

| 编号 | 名称 | 检查什么 | 级别 |
|---|---|---|---|
| `sandbox_enabled` | 沙箱开启状态 | 智能体自带的沙箱是否开启。当前系统不支持、智能体没有自带沙箱两种情形也算风险，说法与「没开」分开 | 中 |
| `sandbox_bypass` | 沙箱绕开设置 | 沙箱开启后，配置是否仍允许命令不经沙箱运行，或允许智能体自行越出沙箱 | 中 |
| `sandbox_credential_read` | 沙箱内凭据目录读取 | 沙箱开启后，凭据目录是否仍在沙箱可读范围内 | 中 |

沙箱没有开启时，后两项记为「未检查」（成因 `sandbox_not_enabled`），由第一项的风险说明，概览里不单独成行。

凭据目录固定为 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.azure`、`~/.config/gcloud`，只检查该账号下实际存在的。

## 二、探针上报字段

探针在 `aiprobe.report.v1` 的 `assets[].evidence.sandbox` 上报，只发给鉴盾。字段全部是固定词表里的取值，不含路径、命令和文件内容。

| 字段 | 取值 | 说明 |
|---|---|---|
| `support` | `supported` \| `platform_unsupported` \| `no_builtin` | 必填 |
| `enabled` | boolean | 没取得时省略 |
| `enabled_source` | `explicit` \| `default` \| `cli` | 显式配置、官方默认值、启动参数 |
| `mode` | 文档里的模式名，如 `workspace-write`、`docker` | 仅供查看，不参与判定 |
| `unsandboxed_allowed` | boolean | 是否留有不经沙箱运行的途径 |
| `unsandboxed_via` | 途径代码数组 | 见第三节 |
| `credential_dirs` | `{ checked: string[], readable: string[] }` | 目录用相对家目录的固定标签，如 `.ssh` |
| `unread` | `{ enabled?, unsandboxed?, credential_dirs?: 原因代码 }` | 某一项没取得的原因 |

约定：

- 没取得的项必须省略并在 `unread` 里写原因，不要填 `false` 或空数组。
- 整个 `sandbox` 字段缺失表示探针版本较旧，三项都记为「未检查」（成因 `sandbox_not_reported`，升级探针后补查）。
- `unread` 的原因为 `config_read_failed` 时沿用成因「配置读取失败」；其余原因归为 `sandbox_unverifiable`（需人工核对）。
- 平台只认下表六种智能体，其余智能体即使上报也记为 `sandbox_unverifiable`。

## 三、各智能体的判定规则

「风险」对应页面上的有风险，「通过」对应已检查无风险。

| 智能体 | 沙箱开启状态 | 沙箱绕开设置 | 沙箱内凭据目录读取 |
|---|---|---|---|
| Claude Code | 原生 Windows：风险（当前系统不支持）。其余系统看托管设置和用户设置的 `sandbox.enabled`：`true` 通过；`false` 或没写（官方默认关闭）风险 | `sandbox.allowUnsandboxedCommands` 不是 `false`（途径 `allow_unsandboxed_commands`），或 `sandbox.excludedCommands` 非空（途径 `excluded_commands`）：风险；否则通过 | 目录被 `sandbox.filesystem.denyRead`、`sandbox.credentials.files`（`deny` 或 `mask`）、`permissions.deny` 的 `Read(...)` 规则或 `permissions.blockReadsOutsideWorkingDirectories` 盖住，且没有被 `sandbox.filesystem.allowRead` 重新放开：通过；否则风险。`sandbox.filesystem.disabled` 为 `true` 时全部算可读 |
| Codex | `sandbox_mode` 为 `read-only`、`workspace-write`，或 `default_permissions` 为 `:read-only`、`:workspace`、自定义权限档：通过。`danger-full-access`、`:danger-full-access` 或带关闭沙箱的启动参数：风险。两项都没写：按官方默认通过 | `approval_policy` 为 `on-request`、`on-failure`，或 `granular.sandbox_approval = true`（途径 `approval_on_request`）：风险。`never` 或 `granular.sandbox_approval = false`：通过。没写：未检查 | 只判断自定义权限档（且没有写 `sandbox_mode`）：`[permissions.<名称>.filesystem]` 里目录为 `deny` 通过，为 `read`、`write` 风险，没提到的目录未检查。内置模式的可读范围官方文档没有写明：未检查 |
| Gemini CLI | `tools.sandbox` 为 `true`、`docker`、`podman`、`sandbox-exec`、`runsc`、`lxc`、对象写法，或带 `--sandbox` 启动：通过。`false`：风险。没写：未检查（还可以用环境变量 `GEMINI_SANDBOX` 开启，探针读不到） | 未检查（没有可核实的配置项） | 未检查（取决于沙箱方式和环境变量 `SEATBELT_PROFILE`、`SANDBOX_MOUNTS`） |
| OpenCode | 风险（没有自带沙箱） | 未检查（沙箱未开启） | 未检查（沙箱未开启） |
| OpenClaw | `agents.defaults.sandbox.mode` 为 `all`：通过。`off` 或没写（官方默认关闭）：风险。`non-main`（主会话不进沙箱）或 `agents.entries.*.sandbox.mode` 与默认不同：未检查 | `tools.elevated.enabled` 为 `true`（途径 `elevated_exec`）：风险；`false`：通过；没写：未检查（默认值官方文档没有写明） | 未检查（挂载范围没有核对到文档） |
| Hermes | `terminal.backend` 为 `docker`、`ssh`、`modal`、`daytona`、`vercel_sandbox`、`singularity`、`sprites`：通过。`local` 或没写（官方默认 `local`）：风险 | 未检查（没有可核实的配置项） | 未检查（挂载范围取决于多项设置，本次没有判定） |

其他智能体：三项都是未检查。

## 四、已知边界

- 只读托管配置文件和用户级配置文件。项目级配置、通过管理后台或系统策略下发的托管设置、环境变量都读不到。Claude Code 用 `/sandbox` 面板开启时写在项目的 `.claude/settings.local.json` 里，用户级没开仍会判为风险。
- Claude Code 的路径只解析 `~/` 和绝对路径；相对路径和带通配符的 `Read(...)` 规则不计入排除。只挡住目录里个别文件的条目，该目录仍算可读。
- Codex 的 `requirements.toml` 没有读取。
- 探针没有区分 WSL1，Claude Code 在 WSL1 上按 Linux 判断。

## 五、依据文档

- Claude Code：<https://code.claude.com/docs/en/sandboxing>、<https://code.claude.com/docs/en/settings>、<https://code.claude.com/docs/en/settings-reference>
- Codex：<https://developers.openai.com/codex/concepts/sandboxing>、<https://developers.openai.com/codex/agent-approvals-security>（核对时分别跳转到 <https://learn.chatgpt.com/docs/sandboxing>、<https://learn.chatgpt.com/docs/agent-approvals-security>）、<https://learn.chatgpt.com/docs/permissions>、<https://learn.chatgpt.com/docs/config-file/config-reference>
- Gemini CLI：<https://geminicli.com/docs/cli/sandbox>
- OpenCode：<https://github.com/anomalyco/opencode/blob/dev/SECURITY.md>、<https://opencode.ai/docs/permissions/>
- OpenClaw：<https://docs.openclaw.ai/gateway/sandboxing>、<https://docs.openclaw.ai/gateway/sandboxing/modes-scope-and-backend>、<https://docs.openclaw.ai/tools/elevated>
- Hermes：<https://hermes-agent.nousresearch.com/docs/user-guide/configuration>、<https://hermes-agent.nousresearch.com/docs/user-guide/security>
