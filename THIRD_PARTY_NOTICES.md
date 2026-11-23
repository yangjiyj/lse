# 第三方组件与许可证声明（THIRD_PARTY_NOTICES）

本产品集成下列第三方开源组件与数据。均为宽松许可（MIT / Apache-2.0 / BSD / ISC / PostgreSQL / SIL OFL-1.1，漏洞数据另有 CC BY 4.0），允许商用与闭源分发；本文件履行其署名与许可证保留义务。打包分发时随附各自 LICENSE/NOTICE 原文。

## 安全引擎 / 题库

| 组件 | 许可证 | 用途 | 集成方式 | 期 |
|---|---|---|---|---|
| [Tencent/AI-Infra-Guard](https://github.com/Tencent/AI-Infra-Guard) | Apache-2.0 | 红队 / Agent / MCP / AI 基础设施扫描 | sidecar 容器 | 一期 |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | Apache-2.0 | LLM Judge / 评测指标 | python-judge 服务 | 一期 |
| [protectai/llm-guard](https://github.com/protectai/llm-guard) | MIT | PII / 敏感信息 / 泄露扫描 | python-judge 服务 | 一期 |
| [thu-coai/Safety-Prompts](https://github.com/thu-coai/Safety-Prompts) | Apache-2.0 | 内置题库「中文通用安全场景」（随附数据集，13 类共 99,798 题） | `apps/api/prisma/datasets/safety-prompts.jsonl.gz` | 一期 |
| [whitzard-ai/jade-db](https://github.com/whitzard-ai/jade-db) | MIT | 中文越狱题库（格式来源） | 格式适配器 / 数据自备 | 三期 |
| [OpenSafetyLab/SALAD-BENCH](https://github.com/OpenSafetyLab/SALAD-BENCH) | Apache-2.0 | 中英文安全评测题库（格式来源） | 格式适配器 / 数据自备 | 三期 |
| [NVIDIA/garak](https://github.com/NVIDIA/garak) | Apache-2.0 | 越狱 / 注入 / 数据泄漏深度 probes（task-level） | sidecar 容器 | 二期 |
| [microsoft/PyRIT](https://github.com/Azure/PyRIT) | MIT | 多轮红队（task-level） | sidecar 容器 | 二期 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | MIT | 评测（可选） | worker 适配 | 二期 |

> 说明：一期实际启用的判定为内置 `rule-judge` + `sensitive-info`（worker 进程内规则/正则引擎，无外部依赖）。上表 deepeval / llm-guard / AI-Infra-Guard 以可选服务（python-judge / sidecar）形式集成，默认不启用；题库类条目除 Safety-Prompts（随附为内置题库）外均为格式 / 数据来源署名，**产品不随附其数据集**，按需自备导入（详见下文「测评基准框架（三期）」）。

## 国际安全框架数据（W2）

| 数据 | 来源与版本 | 许可证 / 用途 |
|---|---|---|
| [MITRE ATLAS](https://github.com/mitre-atlas/atlas-data) | v2026.09，`apps/api/src/modules/frameworks/data/ATLAS.yaml`；上游文件 SHA-256：`c9c23971d0db07e2782423d795a20e78d5c2c9bcdc78fc67e24530657daaec41`；来源 URL：`https://raw.githubusercontent.com/mitre-atlas/atlas-data/v2026.09/dist/ATLAS.yaml` | Apache-2.0；离线内置战术和技术数据，运行时不联网。转换脚本：`scripts/convert-atlas.py`。 |
| OWASP LLM Top 10 2025 / OWASP Top 10 for Agentic Applications 2025 | 官方条目名称摘录，见 `apps/api/src/modules/frameworks/data/owasp.json` | OWASP 官方名称仅作框架识别和平台参考映射；中文为平台译名。 |

## 测评基准框架（三期 · apps/api/src/modules/benchmarks）

平台提供四个**格式适配器**（平台自有 TypeScript 代码，从零实现，不引入上述项目源码）：`salad-bench`、`jade-db`、`generic-jsonl`、`generic-csv`，用于把公开安全基准或自有数据集解析为平台题目。

**许可证边界（重要）：**

- 除下条所列 Safety-Prompts 外，产品**不随附第三方基准数据集**。上表 SALAD-Bench / JADE-DB 等条目仅为**格式来源署名**；其仓库标注的 Apache-2.0 / MIT 系**代码仓库**许可，**数据集本身**可能另有研究用途 / 非商业（如 CC-BY-NC）等更严格条款。是否下载、导入、商用这些数据集，由**部署方依其各自许可自行评估并承担合规责任**。
- **随附数据集 Safety-Prompts**：来源 thu-coai/Safety-Prompts（Hugging Face 数据卡 `license: apache-2.0`，论文 arXiv:2304.10436，Copyright THU-CoAI）。平台仅抽取其中的中文提问文本与场景类别（13 类，99,798 题），未随附原数据集中的模型回复；按 Apache-2.0 保留署名，并在题目 metadata 中标注 `dataset`/`license`。
- 平台自有创作的基准数据为 `lse-safety-mini`（12 题，`generic-jsonl` 格式），系**平台自有创作**，以 **CC0-1.0（平台自有授权）** 提供，可自由商用与再分发。
- 适配器代码与 `lse-safety-mini` 数据均为本产品自有资产，不受第三方 copyleft 约束。
- 逐题语义判定引擎 `llm-judge`（LLM-as-judge）调用部署方自配的评审模型（OpenAI 兼容接口），为平台自有代码，无新增第三方依赖；评审模型不可用时自动回退内置规则引擎。

接口：`GET /api/benchmarks/formats`、`GET /api/benchmarks/samples`、`POST /api/benchmarks/import`；前端入口见「题库管理 → 测评基准」。

## 运行时 / 框架（后端 / 基础设施）

| 组件 | 许可证 |
|---|---|
| Node.js | MIT |
| TypeScript | Apache-2.0 |
| Fastify | MIT |
| Prisma | Apache-2.0 |
| BullMQ | MIT |
| ioredis | MIT |
| PostgreSQL | PostgreSQL License（宽松，等价 BSD/MIT） |
| Valkey | BSD-3-Clause（替代 Redis，规避 RSALv2/SSPL） |
| Caddy | Apache-2.0（Web 容器：静态托管 + 反向代理 /api） |
| FastAPI | MIT |
| Starlette（FastAPI 依赖，ASGI 框架） | BSD-3-Clause |
| Uvicorn（python-judge ASGI 服务器） | BSD-3-Clause |
| Pydantic / pydantic-core（请求体校验） | MIT |
| h11（HTTP/1.1 协议实现，Uvicorn 依赖） | MIT |
| exceljs | MIT |
| pdfkit（PDF 报告导出） | MIT |
| unpdf 1.8.1（RAG 知识库 PDF 文本提取，内置 Mozilla pdf.js 无 worker 服务端构建） | MIT（内置 pdf.js 为 Apache-2.0） |
| mammoth 1.13.0（RAG 知识库 DOCX 文本提取） | BSD-2-Clause |
| mammoth 依赖：lop 0.4.2、duck 0.1.12、option 0.2.4、dingbat-to-unicode 1.0.2 | BSD-2-Clause / BSD |
| mammoth 依赖：@xmldom/xmldom 0.8.15、xmlbuilder 10.1.1、underscore 1.13.8、bluebird 3.4.7、base64-js 1.5.1、argparse 1.0.10 | MIT |
| mammoth 依赖：sprintf-js 1.0.3 | BSD-3-Clause |
| mammoth 依赖：jszip 3.10.1（已随 exceljs 引入） | MIT OR GPL-3.0-or-later，按 MIT 选择使用 |
| @napi-rs/canvas 1.0.9（多模态越狱图片生成；含平台预编译包 @napi-rs/canvas-linux-x64-gnu 1.0.9，内嵌 Skia，BSD-3-Clause） | MIT |

## 前端运行时 / 构建（apps/web）

| 组件 | 许可证 |
|---|---|
| react / react-dom | MIT |
| react-router-dom | MIT |
| @tanstack/react-query | MIT |
| recharts | MIT |
| react-markdown | MIT |
| remark-gfm | MIT |
| lucide-react | ISC |
| class-variance-authority | Apache-2.0 |
| clsx | MIT |
| tailwind-merge | MIT |
| shadcn/ui（组件复制粘贴范式） | MIT |
| tailwindcss / postcss / autoprefixer | MIT |
| Vite / @vitejs/plugin-react | MIT |
| TypeScript | Apache-2.0 |

> react-markdown / remark-gfm 用于在前端渲染中文评估报告（Markdown，含 GFM 表格）。以上前端依赖及其主要传递依赖（unified / remark / rehype / micromark 系，均 MIT）为宽松许可，可商用与闭源分发。

## 明确排除（不进入产品代码 / 不随产品分发）

- ProAI / AscendGrace — AGPL
- meta-llama/PurpleLlama — Llama Community License
- Tencent/AICGSecEval — NOASSERTION（许可证不明）
- SuperCLUE-Safety — 无 License（仅作内部参考，不分发其数据）

> exceljs（MIT）用于题库 Excel 解析与样本集导出；其传递依赖 archiver / dayjs / fast-csv / readable-stream / saxes(ISC) / tmp / unzipper / uuid 均为 MIT/ISC。其中 jszip 3.10.1 为双许可「MIT OR GPL-3.0-or-later」，本产品**选用 MIT** 一支（保留其 MIT LICENSE 原文），不适用 GPL 条款。

> pdfkit（MIT）用于服务端生成中文 PDF 评估报告。为正确渲染中文，产品镜像内置 **Noto Sans CJK** 字体（[Google/notofonts](https://github.com/notofonts/noto-cjk)，**SIL Open Font License 1.1**）；OFL-1.1 明确允许将字体随软件捆绑分发（含商用、闭源软件），分发时保留其 OFL 许可证原文即可。刻意不选用思源黑体的 GPL 派生字体（wqy / arphic 等），以符合本产品「禁止 GPL/AGPL/SSPL」的许可红线。

> 多模态越狱（W6b）图片生成：@napi-rs/canvas 1.0.9（MIT，Copyright (c) 2020 lynweklm@gmail.com；其内嵌的 Skia 为 BSD-3-Clause），钉死精确版本，随 node_modules 进入离线包；产品镜像基底为 node:22-bookworm-slim（glibc），使用 linux-x64-gnu 预编译包。图片内中文字体为 **Noto Sans CJK SC** 的子集 `apps/api/assets/fonts/NotoSansSC-GB2312-Subset.otf`（GB2312 全部字符 + 可打印 ASCII + 常用中文标点，共 7542 个码位；**SIL Open Font License 1.1**，Copyright 2014-2021 Adobe，Noto is a trademark of Google Inc.），许可原文随附 `apps/api/assets/fonts/OFL-1.1.txt`。子集为 OFL 意义下的 Modified Version，仅随软件捆绑分发、不单独出售。来源：Debian 包 fonts-noto-cjk 1:20240730+repack1-1build1 的 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`（集合第 2 号字体，Version 2.004，sha256 `b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`）；子集 sha256 `baa2412076e4f885f7215eaf31929220f34fa6e48f63e33c382cebb52ff6f33c`，由 `scripts/build-cjk-font-subset.py`（fonttools 4.60.1，MIT，仅构建期使用、不进入产品运行时）可复现生成。

> python-judge sidecar（engines/python-judge，二期·引擎增强）运行时依赖仅 FastAPI(MIT) + Starlette(BSD-3) + Uvicorn(BSD-3) + Pydantic/pydantic-core(MIT) + h11(MIT)，**纯 Python、无 torch / 无 GPL/AGPL/SSPL**；核心判定逻辑 scanner.py 仅用标准库实现，可商用闭源分发。

> garak sidecar（engines/garak，二期·引擎增强）封装 NVIDIA/garak(Apache-2.0) 的 task-level probes。garak 携带 **torch / transformers 等重型 ML 传递依赖**，仅存在于 garak sidecar 容器内，经 HTTP 与闭源产品隔离，**不进入产品二进制**（产品仓库只含纯 HTTP 客户端 TS 适配器 garak.ts）。聚合逻辑核心 report.py 仅用标准库实现并有单测覆盖；胶水层 app.py 依赖 FastAPI(MIT)+Uvicorn(BSD-3)。该引擎默认**不启用**，需用户显式部署 sidecar 并开启 GARAK_ENABLED；其重型 ML 传递依赖的许可证审计在制作离线镜像前完成。

> PyRIT sidecar（engines/pyrit，二期·引擎增强）封装 microsoft/PyRIT(MIT) 的 task-level 多轮自动化红队攻击。PyRIT 携带 **torch / transformers 等重型 ML 传递依赖**，仅存在于 pyrit sidecar 容器内，经 HTTP 与闭源产品隔离，**不进入产品二进制**（产品仓库只含纯 HTTP 客户端 TS 适配器 pyrit.ts，不 import 任何 PyRIT 代码）。聚合逻辑核心 report.py 仅用标准库实现并有单测覆盖（6/6）；胶水层 app.py 依赖 FastAPI(MIT)+Uvicorn(BSD-3)。语义上 PyRIT 的 succeeded=攻击得手=平台侧 FAIL（与 garak 默认相反）。该引擎默认**不启用**，需用户显式部署 sidecar 并开启 PYRIT_ENABLED；其重型 ML 传递依赖的许可证审计在制作离线镜像前完成。

> 传递依赖（尤其 Python ML 栈）在制作离线镜像前进行完整许可证审计（三期）。

## 本次新增依赖

| 组件 | 版本 | 许可证 | 用途 |
|---|---:|---|---|
| docx | 9.8.0 | MIT | 备案材料及通用 A 公文版式 Word 导出 |
| fflate | 0.8.2 | MIT | DOCX 结构测试解析及备案材料 ZIP |
| csv-parse | 6.1.0 | MIT | 关键词 CSV 文件安全解析 |

## AI 组件漏洞库数据：Tencent AI-Infra-Guard（Apache-2.0）

Based on Tencent Zhuque Lab AI-Infra-Guard（https://github.com/Tencent/AI-Infra-Guard）。

- 来源：AI-Infra-Guard 仓库 `data/vuln/**.yaml`（中文版，2738 个文件，收录 2642 条；未导入英文副本 `data/vuln_en`）
- commit：`faf9c8ffa9f0d792a66cd8078b3fd56e2572d782`（2026-11-17 拉取）
- 许可证：Apache License 2.0
- 生成文件：`apps/api/src/modules/engines/ai-asset/vulndb/data/aig-vulns.json`（`meta.sources` 同样记录来源、commit、许可证与 NOTICE）
- 生成脚本：`apps/api/scripts/update-aig-vulns.ts`（同时合并下节的 OSV 数据；YAML 读取辅助 `apps/api/scripts/aig-vulndb-yaml-dump.py`，需 python3 + PyYAML，仅开发期使用）
- 重跑：`cd apps/api && node --import tsx scripts/update-aig-vulns.ts --raw-dir <原始数据目录> [--offline]`
- 所做转换：跳过空规则（87 条）、`is_internal` 部署提示类规则（7 条）和没有 CVE/GHSA 编号的条目（1 条）；严重度统一为 CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN；按官方仓库与发布包把组件目录映射到 PyPI/npm 包名（`vulndb/packages.ts`，含子包归属，如 langchain-core、xgrammar），无法确定包名的条目保留但不参与依赖匹配；保留原始规则表达式、中文标题/详情/修复建议、参考链接与来源文件路径。运行时只读该 JSON，不调用 AI-Infra-Guard 服务。
- 页面署名：「AI 组件漏洞扫描」页底部显示「漏洞数据部分来自 Tencent Zhuque Lab AI-Infra-Guard（Apache-2.0）」并链接原仓库。
- 来源、许可与去重口径详见 `docs/ai-component-vulndb-sources.md`。
- 原仓库 NOTICE（逐字）：

```text
Tencent AI-Infra-Guard
Copyright 2024-2026 Tencent Zhuque Lab

This product includes software developed at
Tencent Zhuque Lab (https://github.com/Tencent/AI-Infra-Guard).

Mandatory Attribution Requirement (per Apache License 2.0, Section 4(d)):
Any redistribution, integration, or derivative work — whether open-source or commercial —
that incorporates, modifies, or is based on this project must:

1. Clearly state "Based on Tencent Zhuque Lab AI-Infra-Guard" in the product documentation,
   About page, or release notes.
2. Include a link to the original repository: https://github.com/Tencent/AI-Infra-Guard.
```

## AI 组件漏洞库数据：OSV（GitHub Advisory Database、PyPI Advisory Database，CC BY 4.0）

- 来源：OSV（<https://osv.dev>）中 AI 相关 PyPI、npm 包的公告，只用 `GHSA-*`（GitHub Advisory Database，<https://github.com/github/advisory-database>）与 `PYSEC-*`（PyPI Advisory Database，<https://github.com/pypa/advisory-database>）两类
- 版本：PyPI 取 `https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip`（Last-Modified 2026-11-17 10:18:23 UTC，sha256 `2a9d9926624dd3b9bd0a552283aff131bdb2b17610594baba6b3f1f8de958206`）；npm 取 `https://api.osv.dev/v1/query` 按包查询（2026-11-17 拉取）
- 收录：PyPI 1253 条、npm 208 条（与 AI-Infra-Guard 同编号同组件的已去重）；收录的包见 `apps/api/src/modules/engines/ai-asset/vulndb/osv-packages.ts`
- 许可证：Creative Commons Attribution 4.0 International（CC BY 4.0，<https://creativecommons.org/licenses/by/4.0/>）
- 所做修改：只保留 AI 相关包；受影响范围转换为规则表达式；与 AI-Infra-Guard 合并去重；修复建议按上游修复版本生成中文说明。标题与详情保留英文原文（详情超过 4000 字截断）。
- 页面署名：「AI 组件漏洞扫描」页底部同一行写明「部分来自 GitHub Advisory Database 与 PyPI Advisory Database（经 OSV 汇总，CC BY 4.0），已筛选并转换格式」并链接许可证；每条记录保留 osv.dev 公告链接。
- 署名文本：

```text
Vulnerability data from OSV (https://osv.dev), originally published by the GitHub Advisory Database
(https://github.com/github/advisory-database) and the PyPI Advisory Database
(https://github.com/pypa/advisory-database), licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Changes: filtered to AI-related packages,
converted affected ranges to rule expressions, de-duplicated, remediation text generated from fixed versions.
```
