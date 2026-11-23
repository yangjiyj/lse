# 语料扫描命令行版

离线扫描训练语料、微调语料，检测三类内容：

- **违规内容**：GB/T 45654 附录 A 国标关键词（随包附带 `keywords.json`），命中记条目编码（A.x.y）；
- **敏感信息**：身份证号、手机号、银行卡号、护照号、军官证号、密码、数据库连接串、API 密钥等 40 类，身份证校验位、银行卡 Luhn 照样校验；
- **自定义规则**：自己写的关键词或正则。

检测逻辑与平台「数据安全 → 语料扫描」共用一套代码，同样的文件、同样的词表和规则，统计结果一致。

## 环境要求

- Node.js 22.6 及以上（用 `--experimental-strip-types` 直接运行 TypeScript），不需要安装任何依赖；
- 语料文件为 UTF-8 编码。

## 用法

```bash
node --experimental-strip-types cli.ts <语料文件> [选项]
```

| 选项 | 说明 |
|---|---|
| `--format <格式>` | `auto`（默认，自动识别）、`alpaca`、`sharegpt`、`messages`、`prompt_completion`、`chosen_rejected`、`csv`、`txt` |
| `--keywords <文件>` | 国标关键词 JSON，默认用 `cli.ts` 同目录的 `keywords.json` |
| `--rules <文件>` | 自定义规则，CSV 或 TXT，见下文 |
| `--csv-columns <列>` | CSV 只检测这些列，逗号分隔；默认全部列 |
| `--out <文件>` | 报告 JSON 写到这个文件；不给就输出到标准输出 |
| `--max-findings <数>` | 报告里最多列出的命中条数，默认 50000（统计照实计） |
| `--no-sensitive` | 不检测敏感信息 |

示例：

```bash
# 自动识别格式，报告写到 report.json
node --experimental-strip-types cli.ts train.jsonl --out report.json

# 指定 ShareGPT 格式，带自定义规则
node --experimental-strip-types cli.ts sharegpt.json --format sharegpt --rules rules.csv --out report.json

# CSV 只检测 question、answer 两列
node --experimental-strip-types cli.ts qa.csv --csv-columns question,answer --out report.json
```

扫描结束后，标准错误输出一行汇总，例如：

```text
记录 120000 条（非法 3 条），命中 512 条：违规内容 40、敏感信息 460、自定义规则 12
```

## 支持的语料格式

- jsonl 或 json 数组：
  - Alpaca：`instruction`、`input`、`output`（可带 `system`、`history`）；
  - ShareGPT：`conversations[{from, value}]`；
  - OpenAI messages：`messages[{role, content}]`；
  - `prompt`、`completion`；
  - `chosen`、`rejected`（可带 `prompt`，值可以是文本或对话）；
  - 认不出的按通用 JSON 处理，检测全部字符串字段。
- csv：首行是表头。
- txt：每行一条。

结构不合法的记录（坏 JSON、缺字段）记行号和原因，不中断扫描。

## 自定义规则文件

CSV，首行表头：

```csv
类型,内容,类别,严重度,启用
关键词,内部资料,涉密,高,是
正则,PRJ-\d{3},项目代号,中,是
```

- 类型：`关键词` 或 `正则`；
- 严重度：`严重`、`高`、`中`、`低`；
- 正则不超过 500 个字符，不能写嵌套量词（如 `(a+)+`），否则这一行不导入并提示行号。

TXT：每行一个关键词，类别记为「自定义」、严重度为「中」。

## 报告内容

```json
{
  "tool": "lse-corpus-scan-cli",
  "version": "…",
  "file": { "name": "train.jsonl", "bytes": 1024, "sha256": "…" },
  "format": "auto",
  "stats": {
    "detectedFormat": "alpaca",
    "totalRecords": 120000,
    "invalidRecords": 3,
    "invalidSamples": [{ "line": 57, "reason": "不是合法的 JSON" }],
    "findingCount": 512,
    "byCategory": { "violation": 40, "sensitive": 460, "custom": 12 },
    "bySubtype": [{ "category": "sensitive", "subtype": "phone_cn", "label": "手机号", "count": 300 }]
  },
  "findings": [
    {
      "recordIndex": 12,
      "line": 12,
      "fieldPath": "output",
      "category": "sensitive",
      "subtype": "id_card_cn",
      "matchText": "…",
      "contextBefore": "…",
      "contextAfter": "…",
      "severity": "HIGH"
    }
  ]
}
```

报告里的命中原文没有打码，请按敏感数据保管。

## 更新关键词

在平台的 API 目录下导出最新词表，替换包里的 `keywords.json`：

```bash
npx tsx scripts/export-corpus-keywords.ts --out keywords.json
```
