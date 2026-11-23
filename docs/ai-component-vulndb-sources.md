# AI 组件漏洞库：数据来源与许可

AI 组件漏洞扫描用的离线漏洞库只收公开、可追溯的上游数据，不补写任何条目。本文记录每个来源的版本、许可证、署名方式，以及转换和去重口径。

- 数据文件：`apps/api/src/modules/engines/ai-asset/vulndb/data/aig-vulns.json`，结构为 `{ meta, records }`，`meta.sources` 里同样记录了下表各项。
- 生成脚本：`apps/api/scripts/update-aig-vulns.ts`。
- 收录的 OSV 包清单：`apps/api/src/modules/engines/ai-asset/vulndb/osv-packages.ts`。
- 转换与去重逻辑：`apps/api/src/modules/engines/ai-asset/vulndb/sources.ts`。

## 当前版本（2026-11-21 生成）

| 来源 | 上游版本 | 拉取时间（UTC） | 许可证 | 条数 |
|---|---|---|---|---:|
| Tencent Zhuque Lab AI-Infra-Guard `data/vuln` | commit `faf9c8ffa9f0d792a66cd8078b3fd56e2572d782` | 2026-11-21 04:27 | Apache-2.0 | 2,642 |
| OSV PyPI 全量包 `PyPI/all.zip`（GHSA、PYSEC 公告） | Last-Modified 2026-11-21 00:03:07，sha256 `fc59fe15…5756896834` | 2026-11-21 04:38 | CC BY 4.0 | 1,275 |
| OSV 查询接口 `/v1/query`（npm 的 GHSA 公告） | 按 40 个包查询，拉取时间即版本 | 2026-11-21 04:41 | CC BY 4.0 | 213 |
| **合计** | | | | **4,130** |

其中 3,617 条带包名，参与依赖清单匹配。其余 513 条都是 AI-Infra-Guard 条目，没有包名，不参与匹配，也不会出现在扫描结果里，只保留在数据文件中、计入总数：

- 502 条来自 `packages.ts` 里没有包名映射的 100 个目录，多为以二进制、镜像或 SaaS 形态分发的组件（如 Dify、Ollama、LibreChat、ClickHouse），或尚未核实对应包名的组件；
- 11 条来自有映射的目录（langchain 7 条、vllm 3 条、gradio 1 条），但条目说的是别的产品或上游依赖（如 LangChain.js），归属时判为不属于该包。

## 来源与许可

### Tencent Zhuque Lab AI-Infra-Guard

- 仓库：<https://github.com/Tencent/AI-Infra-Guard>，取 `data/vuln/**.yaml`（中文版），不取英文副本 `data/vuln_en`。
- 许可证：Apache License 2.0，允许商用和闭源分发。
- 署名要求：原仓库 NOTICE 要求在产品文档、「关于」页或发布说明中写明「Based on Tencent Zhuque Lab AI-Infra-Guard」并附原仓库链接；README 还要求保留 LICENSE、NOTICE，不得去掉来源当作原创产品。
- 本产品的署名位置：
  - 页面：「AI 组件漏洞扫描」页底部，依赖漏洞库启用时先写英文原文「Based on Tencent Zhuque Lab AI-Infra-Guard.」，再写「漏洞数据部分来自 Tencent Zhuque Lab AI-Infra-Guard（Apache-2.0）」，并链接到原仓库；
  - 文档：本文与仓库根目录 `THIRD_PARTY_NOTICES.md`（逐字保留原 NOTICE）；
  - 数据：`aig-vulns.json` 的 `meta.sources[].notice`，每条记录的 `sourcePath` 指向原仓库内的文件路径。
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

Based on Tencent Zhuque Lab AI-Infra-Guard（<https://github.com/Tencent/AI-Infra-Guard>）。

### OSV（GitHub Advisory Database、PyPI Advisory Database）

- 获取方式：PyPI 用 OSV 全量包 <https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip>；npm 全量包较大，改用查询接口 <https://api.osv.dev/v1/query> 按包查询。
- 只用两类公告：
  - `GHSA-*`：GitHub Advisory Database（<https://github.com/github/advisory-database>），许可证 CC BY 4.0；
  - `PYSEC-*`：PyPI Advisory Database（<https://github.com/pypa/advisory-database>），许可证 CC BY 4.0。

  两者的许可证均已在各自 GitHub 仓库的 LICENSE 文件和 OSV 官方数据说明（google/osv.dev 仓库 `docs/data.md`）中核对。恶意包公告 `MAL-*` 和 OSS-Fuzz 公告 `OSV-*` 不收。
- 许可证：CC BY 4.0（<https://creativecommons.org/licenses/by/4.0/>），允许商用；要求注明来源、附许可证链接、说明是否做过修改。
- 本产品的署名位置：
  - 页面：「AI 组件漏洞扫描」页底部同一行，写明「部分来自 GitHub Advisory Database 与 PyPI Advisory Database（经 OSV 汇总，CC BY 4.0），已筛选并转换格式」，并链接到许可证；
  - 文档：本文与 `THIRD_PARTY_NOTICES.md`；
  - 数据：`meta.sources[].notice`，每条记录的 `references` 第一条是该公告在 osv.dev 的地址，`sourcePath` 为 `osv:<生态>/<公告编号>`。
- 署名文本（与数据文件中的 notice 一致）：

```text
Vulnerability data from OSV (https://osv.dev), originally published by the GitHub Advisory Database
(https://github.com/github/advisory-database) and the PyPI Advisory Database
(https://github.com/pypa/advisory-database), licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Changes: filtered to AI-related packages,
converted affected ranges to rule expressions, de-duplicated, remediation text generated from fixed versions.
```

## 收录范围

AI-Infra-Guard 的条目全部收录（跳过的见下文）。OSV 只收 AI 相关的 PyPI、npm 包，按以下类别列在 `osv-packages.ts`：

- 深度学习框架与模型库：torch、tensorflow、keras、onnx、transformers、diffusers、paddlepaddle、scikit-learn 等；
- 推理与服务：vllm、sglang、lmdeploy、xinference、bentoml、ray 等；
- 大模型应用与智能体：langchain、langgraph、llama-index、litellm、gradio、open-webui、mcp 等，另按前缀收 `langchain-*`、`langgraph-*`、`llama-index-*`；
- MLOps 与数据标注：mlflow、aim、clearml、zenml、label-studio 等；
- 向量库客户端：chromadb、qdrant-client、pymilvus 等；
- Notebook：jupyterlab、notebook、jupyter-server、jupyterhub；
- npm：langchain 系列、@modelcontextprotocol/*、flowise、n8n、openclaw、@anthropic-ai/claude-code 等 40 个包。

不收通用库（lxml、PyYAML、OpenCV 等）。同一项目的构建变体（tensorflow-cpu、tensorflow-gpu、intel-tensorflow 等）与主包是同一份公告，只收主包。

## 转换规则

- **编号**：主编号取 CVE，没有 CVE 时取 GHSA。AI-Infra-Guard 条目依次看 `cve` 字段、文件名；都不是 CVE 或 GHSA 时，参考链接里只出现一个 GHSA 编号的取它，否则不收。`advisoryIds` 记录该漏洞在上游的全部编号。
- **受影响版本范围**：OSV 把 `ECOSYSTEM`、`SEMVER` 范围的事件转成与 AI-Infra-Guard `rule` 相同的语法：`introduced` 为下界（`0` 表示无下界），`fixed` 转成 `<`，`last_affected` 转成 `<=`；没有范围时用显式版本列表。任一边界版本无法解析的公告不收。AI-Infra-Guard 条目与 OSV 公告同包同编号时，范围以 OSV 为准（见「去重口径」第 6 条）；只有 OSV 没有可用范围时才用 AI-Infra-Guard 的原始 `rule`。
- **严重度**：统一为 CRITICAL、HIGH、MEDIUM、LOW、UNKNOWN。OSV 取 GHSA 给出的等级，PYSEC 公告没有等级时记 UNKNOWN，不推算。**AI-Infra-Guard 与 GHSA 重叠的条目，严重度取 AI-Infra-Guard 的**；GHSA 给出的等级另存在每条记录的 `ghsaSeverity` 字段（本版 2,857 条有，其中 AI-Infra-Guard 条目 1,435 条、与 AI-Infra-Guard 等级不同的 294 条），不参与匹配和展示。
- **标题、详情**：保留上游原文。AI-Infra-Guard 为中文，OSV 为英文；OSV 详情超过 4,000 字截断，全文见 osv.dev 链接。
- **修复建议**：AI-Infra-Guard 保留原文。OSV 只复述上游给出的修复版本，例如「升级 langchain-core 至 0.1.30 或更高版本（以上游公告为准）」；上游没有修复版本时写「上游公告未给出修复版本，请关注官方公告」。

## 去重口径

按「编号 + 组件」去重：

1. 组件口径：有包名时为「生态:包名」（PyPI 包名按 PEP 503 规整，npm 包名转小写），PyPI 与 npm 的同名包（如 `langsmith`、`langchain`）是两个组件；没有包名时用 AI-Infra-Guard 的组件目录名，统一小写，`-`、`_`、`.` 和空白统一为 `-`，同一产品的不同叫法按 `sources.ts` 中的别名表归一（如目录 `Chuanhugpt` 与 PyPI 包 `chuanhuchatgpt`）。
2. 同一组件下，任一编号（CVE、GHSA、PYSEC）相同即视为同一条漏洞。
3. 保留顺序：AI-Infra-Guard（中文，带修复建议）优先，其次 OSV 的 GHSA 公告，最后 PYSEC 公告。被去掉的条目只把尚未归属其他条目的编号并入保留条目。
4. OSV 上游的别名会传递连成一片，个别公告的别名里有多个 CVE，说不清对应哪一个。这类公告只用来判重，不并编号、不改范围；公告自身是 PYSEC 的不收。
5. AI-Infra-Guard 条目没有包名、而 OSV 同编号的同名包给出了包名时（同名指包名与目录名按第 1 条规整后相同）：
   - 目录在 `packages.ts` 中没有包名映射的，用 OSV 的包名补上映射（本版 66 条，如 jupyter-server、jupyterlab）；
   - 目录有映射、但条目被判为不属于该包的，不因 OSV 改判，OSV 那条单独保留（本版 3 条：npm `langchain` 的 CVE-2024-7774、CVE-2025-68665，PyPI `gradio` 的 CVE-2024-4253）。
6. 同包同编号时，版本范围以 OSV 为准：先到的 GHSA 公告定范围，没有 GHSA 时用 PYSEC；标题、详情、修复建议、严重度仍用 AI-Infra-Guard 的。AI-Infra-Guard 同一漏洞分成 CVE、GHSA 两个文件的，两条都改用该公告的范围。改用的范围在记录的 `ruleSourcePath` 里写明出自哪条公告。两边判定不同的组数记在 `meta.counts.ruleConflicts`：在两条规则出现的各个边界版本及其末位加一、减一的版本上逐一求值，有任何一个版本判定不同即算冲突（版本 `0` 不算，写法不同但判定相同不算）。

本版统计：

| 项目 | 数量 |
|---|---:|
| AI-Infra-Guard YAML 文件 | 2,738 |
| 跳过：规则为空 | 87 |
| 跳过：部署提示类规则（`is_internal`） | 7 |
| 跳过：没有 CVE 或 GHSA 编号（`SUPPLY-CHAIN-2025-LITELLM`） | 1 |
| AI-Infra-Guard 内部重复（`openwebui` 与 `open-webui` 两个目录都有 CVE-2025-46719） | 1 |
| OSV PyPI：读入 GHSA、PYSEC 公告 / 已撤回 / 涉及收录包 | 14,967 / 616 / 3,740 |
| OSV PyPI：没有 CVE 或 GHSA 编号 / 别名不确定的 PYSEC / 范围无法转换 | 2 / 16 / 18 |
| OSV npm：读入公告 / 范围无法转换 | 932 / 2 |
| 合并时去掉的重复条目 | 3,236 |
| AI-Infra-Guard 条目借 OSV 补上包名 | 66 |
| AI-Infra-Guard 判为不属于该包、OSV 条目单独保留 | 3 |
| AI-Infra-Guard 条目改用 OSV 范围 / 其中判定不同 | 1,475 / 260 |
| 最终条数 | 4,130 |

## 重新生成

在能访问 GitHub 和 osv.dev 的机器上执行（需要 git、python3 + PyYAML）：

```bash
cd apps/api
node --import tsx scripts/update-aig-vulns.ts --raw-dir <原始数据目录>
```

- `--raw-dir` 存放拉下来的原始数据：`aig-repo/`（AI-Infra-Guard 稀疏检出）、`osv/PyPI-all.zip`、`osv/npm/*.json`，以及各自的拉取记录。该目录不进仓库。
- 加 `--offline` 不联网，用目录里已有的数据重新生成；`--reuse aig,osv-pypi` 只对列出的来源不联网。同一份原始数据重复运行，得到的记录完全一致。
- 请求 `api.osv.dev` 超时（Node 默认的地址族自动选择在部分网络下连不上，home 上就是这样）时，加 `--no-network-family-autoselection`：`node --no-network-family-autoselection --import tsx scripts/update-aig-vulns.ts …`。
- 拉取失败时脚本直接报错退出，不会用旧数据或其他来源补齐。
- 数据文件里 `meta` 缩进排版，`records` 每条一行，便于看两版之间的差异。
- 本版用的是 2026-11-21 拉取的原始数据（AI-Infra-Guard 仍钉在上表的 commit），用 `--offline` 生成。
- 生成后跑 `test/ai-component-vulndb-sources.test.ts` 和 `test/ai-component-vulndb.test.ts`，后者里的跳过数是本版快照，换版本时同步更新。
