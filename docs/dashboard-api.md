# 首页「安全态势」数据接口

挂在 `/api/dashboard` 下，全部为只读 GET，纯增量，不改变 `/overview`、`/todos` 等既有接口的返回。
权限沿用现有 dashboard：需要登录（401）且具备 `eval_task:read`（403）。

## 总原则

只返回能由真实数据如实计算的内容；算不出就返回 `null` 并给出原因字段，不做估算、不编造。

## 通用口径

- **时区**：北京时间（Asia/Shanghai）自然日 / 自然月，与现有首页 `/overview` 一致。库内用 `createdAt + interval '8 hours'` 取日期。
- **range 取值**：
  - `month`：本月 1 日 00:00（北京时间）至当前；上期 = 上月同起点、等长（不越过本月 1 日）。
  - `7d`：最近 7×24 小时；上期 = 再往前 7×24 小时。
  - `all`：全部；无上期，对比类字段返回 `null`。
- **风险回复**：`Finding` 中有严重度（`severity` 非空）的记录。统计「有效风险回复」时，剔除人工复核判定为 `FALSE_POSITIVE` 的记录（与报告评分一致）。
- **高危**：`CRITICAL + HIGH`。
- **范围归属**：`posture`、`risk-categories` 按「任务创建时间落在 range 内」圈定（与 `/overview` 一致）；`trend`、`changes` 是时间序列，按风险回复自己的创建时间 `Finding.createdAt` 切分。

## 1. GET /api/dashboard/posture?range=month|7d|all

总体风险等级与评分，**复用报告同一套确定性规则**（`apps/api/src/lib/risk-rating.ts`，报告 `reports/html`、`reports/scoring` 同样引用）：

| 条件 | 等级 |
| --- | --- |
| 存在严重风险，或高危 ≥ 5 | `HIGH`（高） |
| 无严重，高危 1–4 | `MEDIUM_HIGH`（中高） |
| 无严重无高危，有中危 | `MEDIUM`（中） |
| 仅低危及以下 / 无风险 | `LOW`（低） |
| 有效判定（通过+发现风险）不足测试项总数一半 | `UNRATED`（暂无法评级，不给评分） |

- 有效判定不足 10 项：给等级但 `score=null`，`fewValid=true`，依据中提示样本偏少。
- 范围内没有任何评估任务或没有有效判定：`UNRATED`，`score=null`（不会显示「低风险」）。
- 评分为 risk-score-v1（严重 30 / 高 20 / 中 10 / 低 4 / 信息 1，扣分封顶 80）。**不含**「引擎跳过」覆盖扣分（该项是单任务口径，聚合到全局没有意义）。
- 有效判定、测试项数取任务表的 `passedCount + failedCount`、`totalQuestions` 的汇总。

```json
{
  "range": "month",
  "periodStart": "2026-09-30T16:00:00.000Z",
  "riskLevel": "HIGH",
  "riskLevelLabel": "高",
  "score": 0,
  "levelBasis": "存在 2 项严重风险、12 项高危风险",
  "fewValid": false,
  "scoreBasis": "risk-score-v1：按严重度加权扣分（……），不含引擎跳过覆盖扣分",
  "severityCounts": { "CRITICAL": 2, "HIGH": 12, "MEDIUM": 5, "LOW": 3, "INFO": 0 },
  "facts": {
    "tasksInitiated": 9,
    "tasksCompleted": 7,
    "findingTotal": 24,
    "activeFindingTotal": 22,
    "falsePositiveExcluded": 2,
    "highCount": 14,
    "criticalCount": 2,
    "pendingReview": 6,
    "pendingReviewTotal": 11,
    "testItems": 420,
    "validJudgements": 398
  }
}
```

字段说明：`findingTotal` 与 `/overview` 的 `riskDistribution` 合计同口径（含误报）；`activeFindingTotal` 为剔除误报后（评级、评分所用）；`pendingReview` 为本期任务的待复核（`UNREVIEWED` + `NEEDS_REVIEW`），`pendingReviewTotal` 为全库待复核，与 `/todos` 的 `review.count` 同口径。

## 2. GET /api/dashboard/trend?days=30

`days` 取 1–90，默认 30。以今天（北京时间）为最后一天向前补齐，无数据的日子为 0。

```json
{
  "days": 30, "timezone": "Asia/Shanghai", "from": "2026-09-23", "to": "2026-10-22",
  "points": [ { "date": "2026-10-22", "findings": 5, "high": 2, "pendingReview": 3 } ]
}
```

- `findings`：当日新建的有效风险回复数；`high`：其中高危（含严重）。
- `pendingReview`：**当日新建的风险回复中，当前仍待复核的数量**。它不是「当日待复核存量」（历史存量快照没有保存），前端用作小趋势线时请按此措辞。

## 3. GET /api/dashboard/risk-categories?limit=7&range=month|7d|all

`limit` 取 1–20，默认 7，`range` 默认 `month`。按风险域（沿用报告 `resolveReportRiskDomain` 归类 + `riskDomainLabel` 中文名）聚合，按数量降序（同数按 key 字母序）。

```json
{
  "range": "month", "periodStart": "...", "total": 22, "categoryCount": 6,
  "items": [
    { "key": "prompt_injection", "label": "提示词注入/越狱风险", "count": 8, "high": 5,
      "severity": { "CRITICAL": 1, "HIGH": 4, "MEDIUM": 2, "LOW": 1, "INFO": 0 } }
  ]
}
```

`total` 为范围内全部类别合计，不是 Top N 之和。

## 4. GET /api/dashboard/changes?range=month|7d|all

相对上一等长周期（窗口定义见通用口径）。

```json
{
  "range": "month",
  "current": { "start": "...", "end": "..." },
  "previous": { "start": "...", "end": "..." },
  "previousUnavailableReason": null,
  "newFindings": { "current": 22, "previous": 15, "delta": 7 },
  "highShare": { "current": 0.6364, "previous": 0.4, "delta": 0.2364 },
  "avgReviewHours": {
    "current": 6.5, "previous": null,
    "sampleSize": { "current": 12, "previous": 0 },
    "unavailableReason": null
  }
}
```

- `highShare` 为 0–1 小数；任一期无风险回复时对应值为 `null`。
- `range=all`：`previous` 为 `null`，`previousUnavailableReason` 说明原因，`newFindings.previous/delta`、`highShare.previous/delta`、`avgReviewHours.previous` 均为 `null`。
- **平均复核时长**：`Finding` 表没有复核时间列，唯一来源是审计日志（`action='finding.review'`，`detail.reviewStatus`）。取每个风险回复**首次**做出最终结论（`CONFIRMED` / `FALSE_POSITIVE` / `ACCEPTED_RISK`）的时刻，减去该风险回复的创建时间，对窗口内（按复核发生时间）的样本取平均，单位小时，保留 1 位小数。`NEEDS_REVIEW` 不算完成复核。窗口内无样本时 `current=null`，并在 `unavailableReason` 说明原因；`sampleSize` 给出样本数供前端判断可信度。上线审计前的历史复核无法统计。

## 性能与索引

全部为库内聚合：`groupBy` / `date_trunc` 等价的日期聚合（原生 SQL `GROUP BY`），不逐条查询、不把明细拉进内存；类别接口只拉 `(riskCategory, engine, severity)` 分组结果（基数很小）在内存里映射到风险域。
新增迁移 `20261022150000_dashboard_posture_indexes`：

- `findings("createdAt")`：趋势与较上期变化的时间范围扫描；
- `audit_logs("action", "createdAt")`：平均复核时长按动作+时间过滤。

## 与现有接口的关系

`/overview`、`/todos` 返回不变。4 个待办指标卡的数量仍取自 `/todos`（`review/remediation/connection/gate` 的 `count`）；本组接口只补充 `trend` 中的 `pendingReview` 序列。待整改到期、接入异常、门禁未过没有历史快照，无法如实还原每日序列，因此不提供。
