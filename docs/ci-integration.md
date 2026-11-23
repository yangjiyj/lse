# CI/CD 流水线接入

把 LSE 评估嵌进 CI/CD：合并或发布前自动触发评估，结果以 JUnit / SARIF / JSON 输出，门禁未通过则让流水线失败。

门禁结论是平台评分，不是认证结论。底层的触发与查询接口见 [ci-gate.md](./ci-gate.md)，本文在其基础上给出命令行脚本、结果导出与三种主流 CI 的示例。

## 1. 概念

| 名称 | 说明 |
| --- | --- |
| 评估计划 | 固定「评估对象 + 题库/参数」的一次评估配方。CI 触发计划即生成一个评估任务 |
| 评估任务 | 一次评估的执行实例，有任务 ID |
| 上线门禁 | 绑定到评估对象或评估计划的规则（最低得分、高风险数上限、类别失败率、相对上次不退化）。任务完成后平台自动判定 |
| API 令牌 | 供流水线使用的受限凭据，只能调用少数只读/触发接口 |
| `scripts/lse-ci.mjs` | 零依赖命令行脚本（Node 18+，仅用内置 fetch），封装「触发 → 等待 → 门禁 → 导出」 |

流程：`run`（触发计划，得到任务 ID）→ `wait`（轮询到完成）→ `gate`（读门禁结果，按结果退出）→ `export`（导出 JUnit/SARIF/JSON 作为构建产物）。`run --wait` 一条命令完成前三步。

## 2. 令牌创建与最小权限

管理员在「系统管理 → API 令牌」创建令牌。按用途只勾需要的权限范围：

| 权限范围 | 作用 | 对应命令 |
| --- | --- | --- |
| 触发评估计划（`eval-plans:trigger`） | `POST /api/eval-plans/:id/trigger` | `run --plan` |
| 查询门禁判定（`gates:read`） | `GET /api/gates/:id/latest`、`GET /api/gates/evaluations/by-task/:taskId`（任务状态 + 门禁结果） | `run --wait`、`wait`、`gate` |
| 导出评估任务结果（`eval-tasks:read`） | `GET /api/eval-tasks/:id/export` | `export` |

建议：

- 完整流水线用三项权限；只做「查看最近一次门禁结果」的作业只给 `gates:read`。
- 令牌必须设置有效期（最长 365 天），按项目/流水线分别创建，泄露时立即在页面吊销。
- 令牌的每次使用（成功或失败）都会写入操作日志；导出会额外记一条「导出评估任务结果」。
- 令牌只能访问上述接口，访问其他接口一律 401/403。

## 3. 命令行脚本

```bash
export LSE_URL="https://lse.example.internal"   # 平台地址
export LSE_TOKEN="lse_xxxxxxxx_..."             # 来自 CI 密文变量，不要写进仓库

node scripts/lse-ci.mjs run --plan <评估计划ID> --wait --timeout 4800 --task-file lse-task.txt
node scripts/lse-ci.mjs export --task-file lse-task.txt --format junit --out lse-junit.xml
```

使用时需同时拷贝 `scripts/lse-ci.mjs` 与 `scripts/lib/lse-ci-core.mjs`（保持 `lib/` 相对位置）。

| 子命令 | 参数 | 说明 |
| --- | --- | --- |
| `run` | `--plan <ID>` 或 `--task <ID>`，可加 `--wait`、`--task-file <文件>` | 触发计划（或接入已有任务）并输出任务 ID；`--wait` 继续等待并读取门禁，退出码即门禁结论 |
| `wait` | `--task <ID>`，`--timeout 秒`（默认 3600）、`--interval 秒`（默认 15） | 轮询到任务结束 |
| `gate` | `--task <ID>`，`--allow-no-gate` | 读取门禁结果；任务刚完成时会在宽限期内等待判定生成 |
| `export` | `--task <ID>`，`--format junit\|sarif\|json`，`--out <文件>` | 导出结果文件 |

`--task` 可省略：改用 `--task-file`（`run` 写入、其余命令读取）或环境变量 `LSE_TASK_ID`。

### 退出码

| 退出码 | 含义 | 流水线建议 |
| --- | --- | --- |
| 0 | 门禁通过（`export` 成功也返回 0） | 继续 |
| 1 | 门禁未通过 | 让流水线失败，阻止合并/发布 |
| 2 | 评估执行失败：任务失败/取消、计划触发被跳过（上次未结束、间隔不足、对象已停用等）、等待超时、网络或服务端异常 | 失败，排查后重试 |
| 3 | 用法或认证错误：参数不对、缺少 `LSE_URL`/`LSE_TOKEN`、令牌无效/权限不足、任务或计划不存在、任务完成但没有匹配的门禁 | 修正配置 |

任务完成但没有匹配门禁时默认返回 3（避免「没配门禁却显示通过」）；确认不需要门禁时加 `--allow-no-gate`。

## 4. 结果导出格式

接口：`GET /api/eval-tasks/:id/export?format=junit|sarif|json`，权限为 `eval_task:read` 或令牌权限 `eval-tasks:read`，只读。

- **JUnit**：每个风险类别一个 `testsuite`，每道题一个 `testcase`。未通过的题含 `failure`（判定理由摘要），执行出错的含 `error`，未判定的用 `skipped` 并说明。
- **SARIF 2.1.0**：每个未通过的发现一个 `result`。`ruleId` 为风险类别；`level` 按严重度映射（严重/高 → `error`，中 → `warning`，其余 → `note`）；`properties` 带 `taskId`、`questionId`，以及已有的 OWASP / ATLAS 映射。
- **JSON**：任务摘要 + 门禁结果 + 发现列表。

安全约束：导出**不含模型的完整回答**；判定摘要经平台脱敏函数处理后截断到 300 字。导出仍包含风险类别、题目摘录等评估信息，请按内部资料管理构建产物。

### 在各平台怎么看

| 平台 | JUnit | SARIF |
| --- | --- | --- |
| GitHub Actions | 作为构建产物下载（或用第三方测试报告 Action 展示） | `github/codeql-action/upload-sarif` 上传后显示在 Security → Code scanning（需启用该功能） |
| GitLab CI | `artifacts:reports:junit`，合并请求「测试」页签展示失败用例 | 作为产物下载 |
| Jenkins | `junit` 步骤，构建页展示测试结果与趋势 | 作为产物归档（`archiveArtifacts`） |

## 5. 示例

- GitHub Actions：[ci-examples/github-actions.yml](./ci-examples/github-actions.yml)
- GitLab CI：[ci-examples/gitlab-ci.yml](./ci-examples/gitlab-ci.yml)
- Jenkins：[ci-examples/Jenkinsfile](./ci-examples/Jenkinsfile)

三份示例的结构一致：`run --plan … --wait` 作为门禁步骤（退出码 1 即失败），无论成败都导出 JUnit/SARIF 并归档。

## 6. 注意事项

- **评估耗时与预算**：评估会按题库规模调用被测模型与判定模型，耗时从几分钟到数小时，并消耗调用额度。建议 CI 里用抽样的小计划，全量评估放在夜间定时计划；合理设置 `--timeout` 与 CI 作业超时。计划有最小触发间隔（默认 60 分钟），间隔内重复触发会被跳过（退出码 2）。
- **不要在 CI 日志里打印令牌**：令牌放 CI 的密文/Masked 变量，不要 `echo`、不要写进仓库或命令行参数；脚本不会输出令牌，错误信息也会做遮蔽。怀疑泄露立即吊销。
- **私有化环境自签证书**：推荐把 CA 证书文件放进仓库或构建镜像，设置 `NODE_EXTRA_CA_CERTS=<CA 文件路径>` 让 Node 信任它。不建议设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`（会关闭所有证书校验，令牌可能被中间人截获）。
- **并发**：同一计划上一次任务未结束时再次触发会被跳过，多个分支并行跑同一计划请拆成不同计划。
- **门禁口径**：门禁只按平台已有规则判定，脚本不改变判定；没有为评估对象/计划配置并启用门禁时无法得出结论。
