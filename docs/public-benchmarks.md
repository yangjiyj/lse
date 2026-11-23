# 公开安全基准导入指南

本平台**不内置**任何第三方公开安全基准的数据，仅提供「格式适配器」：由客户自行下载数据集后，在 **样本库 → 评估基准 → 上传基准文件** 中选择对应格式导入。各数据集的使用须遵循其原始许可，请在使用前自行确认授权范围。

## 导入步骤

1. 从数据集官方渠道下载文件（典型文件名见下表）。
2. 打开「样本库」页，点击「评估基准」，来源选择「上传基准文件」。
3. 在格式下拉中选择对应基准，界面会显示出处、典型文件名与期望表头。
4. 选择文件，指定新建样本库或追加到已有样本库，提交导入。
5. 导入完成后查看解析报告：总行数、导入行数、失败行数，以及逐行问题清单（含重复题数）。

## 支持的基准

| 基准 | 典型文件名 | 期望表头 / 字段 | 用途 |
| --- | --- | --- | --- |
| HarmBench | `harmbench_behaviors_text_all.csv` 等 | `Behavior, FunctionalCategory, SemanticCategory, Tags, ContextString, BehaviorID` | 越狱鲁棒性、有害请求拒答，适合模型横向对比 |
| JailbreakBench | `harmful-behaviors.csv` | `Goal, Target, Behavior, Category, Source` | 越狱鲁棒性、有害请求拒答 |
| StrongREJECT | `strongreject_dataset.csv` | `category, source, forbidden_prompt` | 有害请求拒答强度，多类别覆盖，适合模型横向对比 |
| AdvBench | `harmful_behaviors.csv` | `goal, target` | 经典有害请求拒答，快速冒烟 |
| XSTest | `xstest_v2_prompts.csv` | `id, prompt, type, label, focus, note` | **过度拒答**检测 |
| BeaverTails | `30k_train.jsonl` 等 | `prompt, response, category, is_safe`（JSONL） | 多类别覆盖 |
| Do-Not-Answer | `Do-Not-Answer.csv` | `id, risk_area, types_of_harm, specific_harms, question` | 多类别覆盖的拒答评估 |

另有 SALAD-Bench（JSON）、JADE-DB（CSV）以及通用 JSONL / CSV 格式，用法同上。

## 字段映射与特殊处理

- **题面**：对应各格式的 `Behavior` / `Goal` / `forbidden_prompt` / `goal` / `prompt` / `question`。
- **类别**：优先保留原类别文本（平台的合规风险归类会在报告阶段基于该文本自动匹配）；无类别的基准（如 AdvBench）留空。
- **追溯**：原始 ID（如 `BehaviorID`、`Behavior`、`id`）写入题目的外部 ID；来源、分类、`Target` 等写入题目 `metadata`；基准名称同时作为标签。
- **HarmBench 的 `ContextString`**：非空时按 HarmBench 官方用法拼入题面，格式为「上下文 + 空行 + Behavior」，这样被测模型看到的是完整任务；原始 `Behavior` 与 `ContextString` 另存于 `metadata`。
- **JailbreakBench 的 `Target`**：是越狱目标前缀，只存 `metadata`，不作为参考答案。仅适用于 `harmful-behaviors`；`benign-behaviors` 请改用「通用 CSV」并增加 `should_refuse=false` 列。
- **XSTest**：`label=safe` 的题目看似敏感实则无害，会标记为「应正常回答」（`shouldRefuse=false`，题型为通用，期望行为为正常回答），拒答即判为过度拒答；`label=unsafe` 为对照题，标记为应拒答。
- **BeaverTails**：`is_safe` 标注的是**回答**是否安全，不等于题面是否有害，因此只导入 `is_safe=false` 的行，`is_safe=true` 的行计为跳过并给出警告；`category` 对象中值为 true 的键作为类别与标签；回答正文不入库。

## 导入校验

- **表头缺失**：缺少必需表头时整体失败，并提示期望表头。
- **编码**：优先按 UTF-8（自动去 BOM）；非 UTF-8 时自动回退 GB18030 并给出告警。
- **空行**：自动跳过，不计入总行数。
- **重复题**：按题面（忽略大小写与空白差异）去重，重复数记入解析报告 `duplicateRows` 与逐行告警，不计入失败行。
- **文件大小**：沿用现有请求体上限（16 MB）。
- **解析报告**：`totalRows / importedRows / failedRows / issues`，沿用现有结构。

## 怎么选用

| 目的 | 推荐 |
| --- | --- |
| 备案 / 合规评估 | 使用平台的**国标自动样本集**，不建议用公开基准替代 |
| 对比不同模型的横向安全能力 | HarmBench、StrongREJECT（可再配 JailbreakBench） |
| 检查模型是否过度拒答、误伤正常请求 | XSTest（safe 题应正常回答） |
| 多类别覆盖面核对 | Do-Not-Answer、BeaverTails |
| 快速冒烟 | AdvBench（题目风格单一，重复较多） |

建议：拒答类基准与 XSTest **成对使用**，同时观察「该拒答的是否拒答」与「不该拒答的是否被拒答」，避免只追求拒答率而导致可用性下降。
