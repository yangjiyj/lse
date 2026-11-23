# CI 上线门禁接入

在 CI 流水线里触发评估计划，等评估完成后查询门禁判定，未通过时让流水线失败。

门禁结论是平台评分，不是认证结论。

## 1. 准备

1. 管理员在「系统管理 → API 令牌」（`/settings/api-tokens`）创建令牌，勾选权限范围：
   - `eval-plans:trigger`：触发评估计划
   - `gates:read`：查询门禁最新判定

   明文令牌（`lse_<前缀>_<随机串>`）只在创建时显示一次，请立即保存到 CI 的密文变量（例如 GitLab 的 Masked Variable `LSE_TOKEN`）。令牌必须设置有效期，可以随时吊销；每次使用（成功或失败）都会写入操作日志。
2. 在「评估中心 → 上线门禁」（`/eval/gates`）为评估对象或评估计划配置门禁，记下门禁 ID。
3. 在「评估中心 → 评估计划」里记下计划 ID。

API 令牌只能调用下面两个接口。用它访问其他接口一律返回 401。

| 接口 | 权限范围 | 说明 |
| --- | --- | --- |
| `POST /api/eval-plans/:id/trigger` | `eval-plans:trigger` | 立即触发一次计划，生成一个评估任务并返回 `taskId`、`runId` |
| `GET /api/gates/:id/latest` | `gates:read` | 返回该门禁最新一次判定 |

`POST /api/eval-plans/:id/trigger` 的响应示例：

```json
{ "status": "triggered", "runId": "…", "taskId": "…" }
```

以下情况本次触发会被跳过，返回 `409`，同时在计划运行记录里记一条“跳过”及原因：同一计划上一次任务未结束（待执行/执行中/已暂停）、距上次触发不足计划的最小间隔、评估对象已禁用、样本库已删除、授权不可用。响应示例：

```json
{ "status": "skipped", "runId": "…", "taskId": null, "reason": "上一次运行任务未结束（…，RUNNING）", "code": "EVAL_PLAN_TRIGGER_SKIPPED", "message": "本次触发已跳过：…" }
```

最小间隔默认 60 分钟，可在计划里设为 5 分钟到 31 天；cron 相邻两次触发的间隔也不能小于它。CI 手动触发同样受最小间隔约束。

`GET /api/gates/:id/latest` 的响应示例：

```json
{
  "gateId": "…",
  "gateName": "生产发布门禁",
  "enabled": true,
  "evaluated": true,
  "passed": false,
  "reasons": ["总体得分低于门槛", "类别失败率超过门槛：隐私泄露"],
  "taskId": "…",
  "previousTaskId": "…",
  "metrics": { "score": 72.4, "highRiskCount": 3, "categoryFailureRates": { "隐私泄露": 0.18 }, "previousScore": 80.1 },
  "evaluatedAt": "2026-09-29T08:00:00.000Z"
}
```

还没有判定时返回 `"evaluated": false, "passed": null`。评估任务正常完成后，平台会自动判定匹配的已启用门禁。

## 2. curl

```bash
LSE_URL="https://lse.example.internal"
PLAN_ID="<评估计划 ID>"
GATE_ID="<门禁 ID>"

# 触发计划：成功返回 200 {"status":"triggered","runId":"…","taskId":"…"}；
# 被跳过返回 409 {"status":"skipped","runId":"…","taskId":null,"reason":"…"}。
# 不加 -f，以便跳过/鉴权失败时仍能打印原因
T=$(curl -sS -X POST -H "Authorization: Bearer $LSE_TOKEN" \
  "$LSE_URL/api/eval-plans/$PLAN_ID/trigger")
[ "$(echo "$T" | jq -r .status)" = "triggered" ] || { echo "计划未触发：$(echo "$T" | jq -r '.reason // .message')"; exit 1; }
TASK_ID=$(echo "$T" | jq -r .taskId)

# 轮询门禁，直到判定对象变成本次任务
for i in $(seq 1 120); do
  R=$(curl -fsS -H "Authorization: Bearer $LSE_TOKEN" "$LSE_URL/api/gates/$GATE_ID/latest")
  if [ "$(echo "$R" | jq -r .taskId)" = "$TASK_ID" ]; then break; fi
  sleep 30
done

echo "$R" | jq .
[ "$(echo "$R" | jq -r .taskId)" = "$TASK_ID" ] || { echo "等待门禁判定超时"; exit 1; }
[ "$(echo "$R" | jq -r .passed)" = "true" ] || { echo "上线门禁未通过"; exit 1; }
```

## 3. GitLab CI

```yaml
lse-gate:
  stage: test
  image: alpine:3.20
  variables:
    LSE_URL: "https://lse.example.internal"
    PLAN_ID: "<评估计划 ID>"
    GATE_ID: "<门禁 ID>"
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      T=$(curl -sS -X POST -H "Authorization: Bearer $LSE_TOKEN" \
        "$LSE_URL/api/eval-plans/$PLAN_ID/trigger")
      [ "$(echo "$T" | jq -r .status)" = "triggered" ] || { echo "计划未触发：$(echo "$T" | jq -r '.reason // .message')"; exit 1; }
      TASK_ID=$(echo "$T" | jq -r .taskId)
      echo "评估任务：$TASK_ID"
      for i in $(seq 1 120); do
        R=$(curl -fsS -H "Authorization: Bearer $LSE_TOKEN" "$LSE_URL/api/gates/$GATE_ID/latest")
        [ "$(echo "$R" | jq -r .taskId)" = "$TASK_ID" ] && break
        sleep 30
      done
      echo "$R" | jq .
      [ "$(echo "$R" | jq -r .taskId)" = "$TASK_ID" ] || { echo "等待门禁判定超时"; exit 1; }
      [ "$(echo "$R" | jq -r .passed)" = "true" ] || { echo "上线门禁未通过"; exit 1; }
  timeout: 90m
```

`LSE_TOKEN` 请配置成 Masked + Protected 变量，不要写进仓库。

## 4. 返回码

- `401`：令牌格式不对、不存在、已吊销或已过期；或者用令牌访问了不支持令牌的接口。
- `403`：令牌缺少该接口要求的权限范围。
- `404`：门禁或计划不存在。
- `409`：计划本次触发被跳过（原因见响应 `reason`）。
