# 模型指纹

用固定探针集采集评估对象的输出特征，与该对象的基线指纹比对，发现被测模型被替换或静默升级。相似度为平台评分，不是认证结论。

参考指纹只来自平台真实采集，不内置任何已知模型指纹。

## 探针集（v1）

版本常量 `FINGERPRINT_PROBE_VERSION = 'v1'`，定义见 `apps/api/src/modules/model-fingerprint/similarity.ts` 中的 `FINGERPRINT_PROBES_V1`。共 10 道固定题：

| 编号 | 类型 | 目的 |
| --- | --- | --- |
| p01 | identity | 自报身份（机构、模型名） |
| p02 | cutoff | 知识截止日期 |
| p03 | json | 固定格式 JSON 输出 |
| p04 | arithmetic | 简单算术 |
| p05 | refusal | 应拒答题 |
| p06 | continuation | 固定文本续写 |
| p07–p10 | general | 概括、翻译、数列、概念解释 |

采集参数：模型对象（MODEL）走 OpenAI 兼容接口，`temperature=0`，附固定 `seed=20260929`；接口返回 400/422 时去掉 seed 后重试。智能体应用（AGENT_API / PUBLIC_AGENT）走与评估相同的应用调用器。出站复用现有目标出站校验。任一探针失败则整次采集失败，不保存残缺指纹。每题输出截断到 2000 字。

## 特征

每题提取：输出长度、是否拒答（复用 `eval-tasks/rule-judge.ts` 的 `isRefusal`）、输出能否按 JSON 解析、输出文本本身。

## 相似度公式

两个指纹按题号配对（只比对双方都有的题），计算五个分项，每项取值 0–1：

- ngram：各题字符 3-gram Jaccard 的均值（文本先小写并合并空白）
- length：各题 `min(lenA, lenB) / max(lenA, lenB)` 的均值（两者都为 0 时记 1）
- refusal：拒答判定一致的题目比例
- format：JSON 可解析性一致的题目比例
- identity：身份题（p01）的字符 3-gram Jaccard

总分 = Σ(权重 × 分项) / Σ权重，保留 4 位小数。没有可配对题目时总分为 0。

默认权重：ngram 0.4、length 0.15、refusal 0.15、format 0.1、identity 0.2。`compareFingerprints(a, b, { weights, threshold })` 可覆盖。

## 阈值

默认告警阈值 0.6。相似度低于阈值判为漂移（DRIFT），等于阈值不告警。

- 两两比对接口可用 `threshold` 查询参数临时指定。
- 任务前比对读环境变量 `LSE_FINGERPRINT_DRIFT_THRESHOLD`（0–1），未设置或非法时用 0.6。

## 任务前比对

`runEvalTask` 在题目执行前调用 `runPreTaskFingerprintCheck`：对象有基线时采集一次新指纹（source=PRE_TASK）并与基线比对，结果写入 `eval_tasks.fingerprintCheck`：

```json
{
  "status": "OK | DRIFT | FAILED | NO_BASELINE",
  "similarity": 0.8123,
  "threshold": 0.6,
  "baselineId": "uuid 或 null",
  "fingerprintId": "uuid 或 null",
  "reason": "说明或 null",
  "checkedAt": "ISO 时间"
}
```

DRIFT 时写一条 warn 级任务日志。比对失败或没有基线都不阻断任务。注意：每次任务前比对会额外向被测对象发送 10 次请求。

## 接口

| 方法 | 路径 | 权限 | 审计 |
| --- | --- | --- | --- |
| GET | `/api/model-targets/:id/fingerprints` | model_target:read | — |
| POST | `/api/model-targets/:id/fingerprints` | model_target:update | model_fingerprint.collect |
| POST | `/api/model-targets/:id/fingerprints/:fpId/baseline` | model_target:update | model_fingerprint.set_baseline |
| GET | `/api/model-targets/:id/fingerprints/compare?a=&b=&threshold=` | model_target:read | — |

每个对象同时只有一个基线。响应不包含 apiKey 等凭据。
