# AI 服务安全核验命令证据

## 第一阶段门禁

执行时间：2026-08-30T13:42:43+08:00

执行提交：f9b3497c（feat(服务核验): 重建客户工作台与结果表达）

### 数据模型与迁移契约

命令：

- pnpm exec prisma validate --schema apps/api/prisma/schema.prisma
- pnpm exec prisma generate --schema apps/api/prisma/schema.prisma

结果：

- Prisma schema valid，退出码 0。
- Prisma Client 6.19.3 生成成功，退出码 0。
- CLI 输出 package.json Prisma 配置弃用警告；该警告未改变本阶段模型验证结果。

### API、权限、范围与安全检查

API 测试只连接专用容器 lse-service-assurance-test-postgres 的
sa_persist_test_20260830。数据库口令在 home 进程内读取并 URL 编码，测试 JWT 使用
临时哨兵值；两者均未打印或写入文件。

命令：

- node --import tsx --import ./test/test-db-safety-preload.ts --test
  --test-concurrency=1 --test-force-exit test/service-assurance-*.test.ts
  test/scanner-scope.test.ts test/relay-audit-scope.test.ts test/permissions.test.ts

结果：56/56 通过，0 失败、0 跳过，退出码 0。

覆盖的可观察行为：

- BOLA/BFLA、任务所有者边界、历史无创建人任务只读。
- URL 协议、特殊 IP、云元数据、全部 DNS 地址、CIDR、重定向和连接前锁定地址。
- 固定 sidecar 路由、无重定向、响应上限、超时中止、版本与 digest 漂移拒绝。
- 正样本形成配置风险；负样本不形成风险；弱 Triton 指纹只形成待核验线索。
- 部分 JSON、未完成执行和过期规则库均形成覆盖不完整结论。
- 未知严重度保持空值；不默认中危或 P2。
- 持久化事务、重复执行幂等、旧 EngineRun 不被覆盖。
- 客户与技术证据分离、取消幂等、哨兵字符串先脱敏再截断。

依赖检查命令：

- rg -n "ai-infra-guard" apps/api/src/modules/engines/relay-audit.ts

结果：零命中；relay-audit 已不依赖 AIG 范围或脱敏模块。

### Worker 与 Web

命令：

- pnpm --filter @lse/worker test
- pnpm --filter @lse/web test -- ServiceAssurancePage.test.tsx AppShell.test.tsx
  RolesPage.test.tsx
- pnpm typecheck
- pnpm --filter @lse/web build

结果：

- Worker：2/2 通过，退出码 0。
- Web：13/13 通过，退出码 0。
- 全仓 5 个可执行 workspace 项目 typecheck 完成，退出码 0。
- Web production build 转换 1703 个模块并生成产物，退出码 0。
- Vite 报告单个 JS chunk 大于 500 kB；这是性能提示，不作为构建通过之外的性能验收。
- Vitest 输出 React Router v7 future flag 提示；没有测试失败。

### 客户契约检查

命令：

- 对 ServiceAssurancePage.tsx 与 components/service-assurance 执行客户禁词扫描，模式为
  AI-Infra-Guard、AIG、Nuclei、Trivy、ZAP、rawOutput、session ID 和容器字段。

结果：生产客户页零命中。页面测试同时检查可见文本无 UUID、内部工具名、原始字段和
横向表格，并覆盖 /component-scan 到 /service-assurance 的替换式重定向。

### 失败尝试与修正

第一次组合门禁没有给独立进程注入测试 JWT 和 Prisma 校验 URL：

- 5 个需加载应用配置的 API 测试文件在断言前退出；
- Prisma validate 在读取 schema 时报告 DATABASE_URL 缺失；
- 已启动的 API 断言为 36 通过、0 断言失败。

补齐专用测试环境后完整重跑，得到上述 API 56/56 和 Prisma 退出码 0。首次失败不计入
绿灯，也未通过跳过测试或降低配置校验处理。

### 阶段边界

- sidecar 实体尚未实现，默认 readiness 仍诚实返回模式未就绪。
- Playwright 真登录、桌面与 390x844 截图属于第三阶段靶场视觉门禁，本阶段未执行。
- Trivy、SBOM、VEX 和正式专项报告在第二阶段实现，本文件没有将其声明为已通过。
- AIG 仍保留历史只读与旧代码；本阶段不满足退役十项门禁。

## 第二阶段 TDD 证据

### SBOM、版本与 Trivy 红灯

执行时间：2026-08-30T14:08:00+08:00

命令：

- env --chdir=<service-assurance-worktree> LSE_TEST=1 LICENSE_ENFORCE=false
  pnpm exec node --import tsx --test
  apps/api/test/service-assurance-sbom.test.ts
  apps/api/test/service-assurance-trivy.test.ts

结果：0/2 测试文件通过，退出码 1。两个测试文件分别因
`src/modules/service-assurance/sbom.js` 和
`src/modules/service-assurance/adapters/trivy.js` 尚不存在而产生
`ERR_MODULE_NOT_FOUND`。这是功能缺失导致的预期红灯；此前两次 pnpm 调用只暴露
Corepack 工作目录和参数传递错误，未计为 TDD 红灯。

### SBOM 通道、契约与编排红灯

任务 6 续接前保存的红灯分别为：

- 纯模块组 15 通过、2 失败：创建契约尚未接受 `sbom`，一次性通道模块尚不存在。
- 数据库集成组 13 通过、3 失败：SBOM Worker 编排、路由基线契约和上传接收尚未接通。

新增取消清理测试后，定向用例 0/1 通过，断言明确为消费次数 `0 !== 1`。新增规则集和
漏洞库漂移测试后，定向用例 0/2 通过；未校验基线时流程错误进入下游并只得到泛化失败。
这些均是缺少目标行为导致的有效红灯，不是环境或语法错误。

### SBOM、Trivy 与精确版本绿灯

执行时间：2026-08-30T15:11:15+08:00

命令：

- `node --import tsx --test` 运行 SBOM、一次性通道、Trivy 和创建契约四个测试文件。
- `node --import tsx --import ./apps/api/test/test-db-safety-preload.ts --test`
  串行运行 routes、orchestrator 和 persist 三个数据库测试文件。
- `pnpm --filter @lse/api typecheck`。
- `trivy --version`，并用 `jq` 检查受影响和修复输出夹具。
- 以无网络、只读挂载的临时容器读取本地 Trivy DB `metadata.json`。

数据库测试只连接专用容器 `lse-service-assurance-test-postgres` 的
`sa_persist_test_20260830`。口令在 home 进程内读取并 URL 编码，未打印、未写入文件。

结果：

- 纯模块：18/18 通过，0 失败、0 跳过，退出码 0。
- 数据库集成：19/19 通过，0 失败、0 跳过，退出码 0。
- API typecheck：退出码 0。
- 取消清理 1/1、规则集和漏洞库漂移 2/2 定向绿灯。
- Trivy 版本为 0.70.0；真实受影响输出为 Log4j Core 2.14.1、
  `CVE-2021-44228`、CRITICAL、修复版本 `2.15.0, 2.3.1, 2.12.2`；
  修复样本 2.25.4 的漏洞条目数为 0。
- 本地 Trivy DB schema 2，更新时间为 2026-05-22T19:06:39.311922687Z，
  下一更新时间为 2026-05-23T19:06:39.311922437Z；相对本次执行时间已过期，
  因此产品契约必须显示 `PARTIAL / INCOMPLETE`，不能形成完整覆盖结论。

覆盖的可观察行为：

- CycloneDX JSON、SPDX JSON 和 SPDX tag-value 解析；压缩包、路径、二进制、超限、
  过深结构、错误类型和错误 purl 失败关闭。
- 上传原文只进入 10 分钟 `SET EX NX` 通道，由 Worker `GETDEL` 一次消费；取消同样清理，
  摘要、长度或格式漂移时拒绝执行。
- BullMQ 只携带 `runId`；EngineRun、数据库、审计、客户响应和 `rawOutput` 均无上传原文
  或哨兵内容。
- 创建时固定的规则集或漏洞库与 Worker 运行时不一致时，在解析目标、消费 SBOM 和调用
  sidecar 前以稳定错误失败关闭。
- 精确 purl 加版本命中生成 `AFFECTED + VERSION_MATCH`；缺版本、错误 purl 和弱名称保持
  `UNDER_INVESTIGATION + LEAD`；未知严重度保持空值，严重度、可信度和优先级分开。

### VEX、正式报告与权限红绿证据

执行时间：2026-08-30T16:43:01+08:00 至 2026-08-30T16:52:27+08:00

红灯命令：

- `node --import tsx --test --test-name-pattern="服务核验报告查询只读取归一化客户字段"
  apps/api/test/service-assurance-report.test.ts`

红灯结果：0/1 通过，退出码 1。新增 `NOT_READY` 客户口径断言时，实际
`skippedItems=[]`，预期为“核验模式未就绪”。失败来自缺少目标状态映射，不是环境、
语法或测试数据库问题。

最小实现只在服务核验报告快照映射中把 `coverageStatus=NOT_READY` 转为客户可读跳过项。
同一用例随后 1/1 通过，退出码 0。

任务 7 完整命令：

- `node --import tsx --test` 运行 VEX、服务核验报告、专项报告和报告结论 4 个测试文件。
- `node --import tsx --import ./apps/api/test/test-db-safety-preload.ts --test
  --test-concurrency=1 --test-force-exit apps/api/test/reports.test.ts`。
- `pnpm --filter @lse/web test -- ServiceAssurancePage.test.tsx ReportsPage.test.tsx`。
- `pnpm --filter @lse/api typecheck`。
- `pnpm --filter @lse/web typecheck`。

数据库集成仍只连接 `127.0.0.1:55433/sa_persist_test_20260830`，并在加载应用前执行
`test-db-safety-preload.ts`。数据库口令在 home 进程内读取和编码，未打印、未写入文件。

结果：

- 纯模块：56/56 通过，0 失败、0 跳过，退出码 0。
- 数据库集成：39/39 通过，0 失败、0 跳过，退出码 0。
- Web：19/19 通过，0 失败，退出码 0；仅有既有 React Router v7 future flag 提示。
- API 和 Web typecheck 均退出 0。
- VEX 只接受 5 个 OpenVEX 不受影响理由；`FIXED` 拒绝跨任务、错误复测来源、
  非完整执行、无结束时间和残留正式风险。
- 只有非 `LEAD` 且关联正式 Finding 的 `AFFECTED` 判断进入报告正式风险；异常孤立
  判断和弱证据判断降为待核验。
- 生成、列表、详情、下载、删除和趋势接口同时验证报告操作权限与评估任务对象边界；
  他人详情和下载为 404，写操作为 403，列表与趋势不返回他人的服务核验报告。

### 正式报告制品检查

使用当前工作树重新生成制品，目录：
`/tmp/lse-service-report-gate-v4.4Aa5au`。

SHA-256：

- Markdown：`647aa748f31256b023954630ca0ec61d89d344166e947931a6e79b57569f09cc`
- HTML：`f745e9ca00f7eca27ffffada914acd99ed4af1cf7dbac0259a093a5e32493f6e`
- HTML/Chromium PDF：`0b70c34c137f1edc12e73ce7b50dfe6e3837cd8cbe7959f919b7a6517974c89f`
- PDFKit/CJK 回退 PDF：`52ad12c7fa176b37b0f7c7d93ebcaa6957f17933230c12565e2b61f665c4a313`

Markdown、HTML 和两份 PDF 提取文本都包含报告标题、“核验未完成”、正式风险与整改动作。
四份文本对数据库 UUID、原始字段、内部引擎名、内部模块名、执行标识、内部路径和密钥
哨兵执行扫描，均为零命中。

### 第二阶段当前边界

- ZAP sidecar、人工复核/复测 API、三模式受控靶场和 Playwright 截图属于第三阶段，
  尚未执行。
- 离线新装、升级、断网、diagnose 和回滚属于第四阶段，尚未执行。
- AIG 代码、历史运行和只读能力完整保留；当前不满足十项退役门禁。

### 任务 7 安全与暂存区审查

命令：

- 对本任务触及的 React 文件扫描 HTML 注入、动态代码、开放跳转、`postMessage`、
  Web Storage 和 `VITE_*` 敏感变量模式。
- 核对服务报告 Prisma `select`、报告路由对象权限分支及客户快照出站字段。
- `gitleaks protect --staged --no-banner --redact`。
- 对 staged patch 扫描私钥头、常见云密钥和代码托管令牌模式。
- `git diff --cached --check`，并统计暂存文件大小。

结果：

- React 高风险模式零命中；报告 ID 只进入同源固定路由参数，不控制外部 URL。
- 服务报告查询不选择 `rawOutput`、`requestPayload`、`sourceTool`、内部 digest、
  凭据引用或原始响应；通用旧报告路径仍保留原行为，但服务报告生成分支不执行该路径。
- 生成、读取、下载、删除和趋势均有报告操作权限及任务对象边界；对应集成用例已覆盖
  403/404 和列表/趋势过滤。
- gitleaks：扫描完成，零泄露，退出码 0。
- 私钥和常见真实令牌模式零命中；暂存区无镜像、依赖目录、日志或报告二进制，
  最大文件为既有报告构建源文件 113080 字节。
- Prettier 对全部任务文件检查通过，`git diff --check` 退出 0。

审查结论：未发现 Critical 或 Important 问题；`NOT_READY` 客户口径缺口已按上述
红绿过程修复。该结论只覆盖任务 7 暂存差异，不替代第三、第四阶段的 sidecar、靶场、
密钥哨兵和离线安全门禁。

## 第一、第二阶段联合门禁

执行时间：2026-08-30T17:04:27+08:00

执行提交：a334bd64（feat(服务核验): 形成 VEX 状态与正式报告闭环）

测试数据库仍为专用容器 `lse-service-assurance-test-postgres` 的
`sa_persist_test_20260830`。连接信息只在 home 进程内读取和 URL 编码，未打印、未写入
文件；测试 JWT 为进程内随机值。

命令：

- `pnpm exec prisma validate --schema apps/api/prisma/schema.prisma`
- `pnpm exec prisma generate --schema apps/api/prisma/schema.prisma`
- 加载 `apps/api/test/test-db-safety-preload.ts`，串行运行第一、第二阶段全部
  `service-assurance-*.test.ts`、范围、权限、专项报告、报告结论和报告接口测试。
- `pnpm --filter @lse/worker test`
- `pnpm --filter @lse/web test -- ServiceAssurancePage.test.tsx AppShell.test.tsx
  RolesPage.test.tsx ReportsPage.test.tsx`
- `pnpm typecheck`
- `pnpm --filter @lse/web build`
- `git diff --check` 和 `git status --short --branch`

结果：

- Prisma validate 和 generate 均退出 0，Prisma Client 版本为 6.19.3。
- API 与数据库集成：170/170 通过，0 失败、0 跳过，退出码 0。
- Worker：2/2 通过，0 失败、0 跳过，退出码 0。
- Web：26/26 通过，0 失败，退出码 0。
- 全仓 5 个可执行 workspace 项目 typecheck 完成，退出码 0。
- Web production build 转换 1703 个模块并完成产物构建，退出码 0。
- `git diff --check` 退出 0，门禁结束时 worktree 干净。
- Prisma 配置弃用、React Router v7 future flag 和 500 kB chunk 为现有警告；没有将警告
  写成失败或静默删除。

### 报告制品复核

任务 7 提交前由同一暂存代码生成的报告制品未被提交或夹带到仓库；提交过程没有改变其
生产代码。联合门禁后重新校验文件类型、页数、SHA-256，并用 `pdftotext` 重新提取两份
PDF 文本：

- Markdown：`647aa748f31256b023954630ca0ec61d89d344166e947931a6e79b57569f09cc`
- HTML：`f745e9ca00f7eca27ffffada914acd99ed4af1cf7dbac0259a093a5e32493f6e`
- Chromium PDF：5 页，
  `0b70c34c137f1edc12e73ce7b50dfe6e3837cd8cbe7959f919b7a6517974c89f`
- PDFKit/CJK PDF：3 页，
  `52ad12c7fa176b37b0f7c7d93ebcaa6957f17933230c12565e2b61f665c4a313`

四种文本均包含报告标题、核验未完成口径、正式风险和整改动作。对 UUID、内部引擎与
模块名、原始字段、执行标识、内部路径、私钥/常见真实令牌模式和测试哨兵扫描，均为
零命中。至此第一、第二阶段门禁有新鲜证据，可以进入第三阶段；这不代表第三、第四阶段
或 AIG 退役条件已经通过。

## 第三阶段任务 8：固定 sidecar 与真实 ZAP 网关

执行时间：2026-08-30T21:12:13+08:00

执行分支：codex/service-assurance；本节记录的是未提交任务 8 工作树，未 push、未合并、
未部署。

### Go 网关 TDD

有效红灯命令：

- `env PATH=/usr/local/go/bin:$PATH GOTELEMETRY=off
  GOCACHE=/tmp/lse-go-cache-task8-red go -C sidecars/service-assurance test ./...`

红灯结果：退出码 1。编译器明确报告 `buildZapArgs` 不接受受控入口参数，以及
`startPinnedTargetGateway` 不存在。此前从仓库根运行 `go test` 只得到 module
边界错误，未计为 TDD 红灯。

最小实现增加任务级 loopback 网关后，HTTPS 用例第一次仍失败：期望
`Host=example.com:<port>`，实际为 `127.0.0.1:<port>`。根因是网关保存固定 IP URL
时丢失了原 authority；保留测试并只修正该数据流。随后同一 Go 测试命令退出 0。

覆盖的可观察行为：

- ZAP argv 只接收 `127.0.0.1` 任务入口，并用固定 `-O` 覆盖 OpenAPI 服务器。
- 每次上游连接只拨已授权固定 IP；HTTPS 证书校验和 SNI 使用原域名，HTTP Host 恢复
  原 authority。
- 跨域重定向不暴露可跟随 Location，请求数和并发超限会标记覆盖不完整。
- 返回前结构化重写 ZAP JSON 的站点、Host、端口、TLS 标志和 URI，不泄露随机 loopback
  端口。

### ZAP policy 真实解析红绿

同镜像内直接执行 ZAP 2.16.1 固定命令时，首次退出 3，原始错误为 policy 每行只有两列，
而 2.16.1 要求至少三列 Tab 分隔字段。新增供应链格式断言后，
`scripts/test-service-assurance-sidecars.sh` 按预期退出 1：

`[fail] service-assurance/rules/zap/safe.conf must use the three-column ZAP 2.16.1 policy format`

两份 policy 机械补齐第三列说明，未改变 SAFE 全禁用或 DEEP 仅允许
`6, 40012, 40018` 的状态。规则集随内容变化提升为：

- 版本：`lse-rules-2026.08.30.2`
- 聚合摘要：`sha256:a462ce8a664ef23560fd75549c8f6f41a76d31cb5f75d802c0a97281203e453e`
- SAFE policy：`sha256:0c937ad5f9715c9c1ae12b2656f287775c0192aa3f31b4e22ead7dfa7369613e`
- DEEP policy：`sha256:4636338dff06ab43c040876466357b6395cbee81a6b848c996470821feb54466`

修正旧断言对第三列的误报后，供应链脚本退出 0，终行为
`[ok] service assurance sidecar policies are pinned and testable`。脚本同时验证三列格式、
规则允许列表、文件与聚合摘要、detached RSA-SHA256 签名、公钥目录权限、固定镜像
tag+digest、无 latest、无运行时下载及生产文件无 Docker Socket/数据库/云元数据能力。

### 镜像和真实本地靶场

命令：

- `docker build --network=none -f sidecars/service-assurance/Dockerfile.zap
  -t lse-service-assurance-zap:task8-gateway .`
- 以非 root、只读根文件系统、`cap-drop ALL`、`no-new-privileges` 和独立 tmpfs
  启动 ZAP sidecar，再 POST 固定 SAFE JSON 契约。

构建退出 0；最终测试镜像 ID 为
`sha256:12c353489ed5075a3d62dece6b996a58f4a496e5aeb86ee5737565fe8cc72baa`。
容器 `/healthz` 返回 `ready=true`。

HTTP OpenAPI 正样本结果：

- `completed=true`，ZAP JSON 4542 字节。
- 授权目标收到 2 次请求，其中 `/probe` 1 次；规范内陷阱服务器 0 次。
- 报告 URI 恢复为 `target.example.test`，不含 loopback、云元数据或陷阱地址。
- 输出 SHA-256：`c2d582c6d7420db134f6baf0712b7b98be10bac26df28bc8754728fe0796765b`。

HTTPS OpenAPI 正样本结果：

- 使用只在 `/tmp` 生成的临时测试 CA；sidecar 只挂载公有 CA 证书，未挂载 CA 私钥或
  服务端私钥。
- `completed=true`，ZAP JSON 4546 字节；目标收到 2 次请求，其中 `/probe` 1 次，
  陷阱服务器 0 次。
- 靶场观测 `SNI=target.example.test`，
  `Host=target.example.test:18093`；报告站点恢复为 HTTPS、原域名和原端口。
- 输出 SHA-256：`ec1ad38e8b68aebcd5403b41729f63108e1065fd48b0303ed726804d3591699f`。

基础路径样本把 OpenAPI server 写为陷阱地址下的 `/api/v1`。实际授权目标收到
`/openapi.json` 和 `/api/v1/probe`，陷阱 0 次，证明固定 `-O` 没有丢失合法
server 基础路径。

上述靶场响应、临时签名和测试证书不进入 Git；本节只保留脱敏计数、状态和摘要。
本证据只完成任务 8 的 sidecar/真实 SAFE 边界，不代表人工复核、复测、DEEP 端到端、
Playwright、离线交付或 AIG 退役门禁已完成。

### 最终 `.3` 基线、健康探针与重建边界

执行时间：2026-08-30T22:00:22+08:00。

最终规则基线：

- 版本：`lse-rules-2026.08.30.3`。
- 聚合摘要：
  `sha256:124509fdacc43314287589194b0cb1acf67ea4f6133daf6776e00be250ea6f73`。
- 更新时间：`2026-08-30T13:21:26Z`。

ZAP 基础镜像继承的健康探针仍检查旧 daemon 端口，虽然新 sidecar 的 `/healthz`
已返回 200，Docker 状态仍为 `unhealthy`。先在供应链脚本加入清除继承探针的断言，
同一脚本按预期退出 1：

`[fail] ZAP image must clear the inherited daemon health check; the orchestrator probes /healthz`

最小实现仅增加 `HEALTHCHECK NONE`，不引入下载工具或额外运行时依赖。脚本随后退出 0，
最终 ZAP Dockerfile 使用固定 digest 在 `--network=none` 下重建成功。三个最终镜像 ID：

- Nuclei 等价本地镜像：
  `sha256:9ea324171c6e7a1438d29381eef4d486d44f3c4a1a9e55b2982f3330b85c6f93`。
- Trivy：
  `sha256:a752c5c10318064a8fc36eb8c1f0f5c0e49a3984ad291558ba134498ab956cae`。
- ZAP：
  `sha256:7dde1d400edb48b1d755d655ed2cc306dd22a89ff355df1bb33e465622a51ded`。

三只容器均以非 root、只读根、`cap-drop ALL`、`no-new-privileges`、独立 tmpfs 和
只读签名/漏洞库挂载启动；三个 `/healthz` 均返回
`{"ready":true,"status":"ok"}`。ZAP 镜像的 Docker Healthcheck 明确为 `NONE`，
不再产生错误的 daemon 健康状态。

用最终 `.3` 签名基线重新运行真实 ZAP 2.16.1 SAFE：

- `completed=true`，耗时 9610 ms，输出 2601 字节。
- 输出 SHA-256：
  `325d4bf0ceb626fd00e1e0ea99e71ebb4625bed7804dfb9611c5065d31cce0f9`。
- 授权目标共 2 次请求，保留的 OpenAPI 基础路径 `/trap/probe` 1 次；恶意
  `servers` Origin 请求 0 次。
- 两次授权请求的 Host 均为 `target.example.test:18091`；报告恢复授权域名，且不含
  loopback、云元数据或陷阱 Origin。

原始 `Dockerfile.nuclei` 同固定 digest 再次重建时退出 1。失败边界仍是 Daocloud 对
固定 manifest digest 的 HEAD 请求返回 403；未更换 tag 或 digest。保留的等价本地镜像
基于同一 `projectdiscovery/nuclei:v3.4.10@sha256:aeb5...b97`，以只读根、非 root 和
临时 HOME 分别验证三份最终模板，三次均输出
`All templates validated successfully`。因此可证明最终模板由真实 Nuclei 3.4.10
解析，但不能声称本轮原始 Nuclei Dockerfile 新鲜重建成功。

验证结束后删除三只健康检查容器、真实扫描容器和本地靶场进程；精确删除
`/tmp/lse-sidecar-health.8wK9jM` 后复查目录不存在，临时签名私钥未保留。

任务 8 提交前新鲜门禁：

- `go -C sidecars/service-assurance test -count=1 ./...`：退出 0，13 项测试通过。
- `go -C sidecars/service-assurance vet ./...`：退出 0，无诊断。
- `node --import tsx --test apps/api/test/service-assurance-zap.test.ts`：退出 0，
  7/7 通过。
- `pnpm --filter @lse/api typecheck`：退出 0。
- 配置 1.3 GB 固定 Trivy DB 缓存后执行完整
  `scripts/test-service-assurance-sidecars.sh`：退出 0，终行为
  `[ok] service assurance sidecar policies are pinned and testable`。
- 任务 8 的 TS/JSON/YAML/Markdown Prettier 检查、Go `gofmt -d`、脚本
  `bash -n` 和 ShellCheck 均退出 0。

从仓库根直接执行 `go test ./sidecars/service-assurance/...` 和 `go vet` 会因嵌套 Go
module 边界在 setup 阶段退出 1；该错误调用未运行测试，计划已改为上述 `go -C` 命令。

提交前安全审计新增敏感查询参数回归。红灯中 `password`、`client_secret`、`session`
和 `x-api-key` 的固定测试哨兵仍出现在 `matchedLocation`，定向测试退出 1；普通
`page=2` 同时存在。最小实现让 ZAP URI 复用公共 `SENSITIVE_KEY_RE`，不再维护较窄的
本地正则。相同定向测试随后退出 0，7/7 通过；4 个哨兵零明文命中，`page=2` 保留。

## 第三阶段任务 9：复核、复测、取消与安全回归红灯

执行时间：2026-08-30T23:05:45+08:00。

测试数据库只使用专用容器 `lse-service-assurance-test-postgres`。连接口令在 home
进程内读取并 URL 编码，测试 JWT 在进程内随机生成；二者均未打印、未写入文件。

有效红灯命令加载 `apps/api/test/test-db-safety-preload.ts`，以单并发执行：

- `apps/api/test/service-assurance-review.test.ts`
- `apps/api/test/service-assurance-retest.test.ts`
- `apps/api/test/service-assurance-security.test.ts`
- `apps/api/test/service-assurance-secret-sentinel.test.ts`

结果：3/13 通过、10/13 失败，退出码 1。失败均来自目标行为尚未实现：

- 人工复核和复测接口返回 404，共 8 项失败。
- 运行中取消后状态仍为 `RUNNING`，预期为 `CANCELED`。
- AuditLog 仍保留明文哨兵；同次输出还显示 ZAP 版本被误记到
  `engineVersions.nuclei`。

此前两次调用分别因缺少 `DATABASE_URL` 和 `JWT_SECRET` 在应用启动前退出，没有
执行测试断言，不计作 TDD 红灯。随后只补齐上述隔离测试环境变量，未绕过测试库安全门禁。

## 第三阶段任务 9：复核、复测、取消与安全回归绿灯

执行时间：2026-08-31T00:00:09+08:00。

执行分支：`codex/service-assurance`；本节记录未提交任务 9 工作树，未 push、未合并、
未部署。

### API、数据库与范围门禁

专用数据库容器为 `lse-service-assurance-test-postgres`，端口只绑定
`127.0.0.1:55433`。测试连接使用容器登记的 `lse_test` 用户和
`sa_persist_test_20260830` 数据库；口令只在 home 进程内读取和 URL 编码，随机测试
JWT 只存在于命令进程，均未打印或写入文件。

有效命令加载 `apps/api/test/test-db-safety-preload.ts`，以单并发执行全部
`apps/api/test/service-assurance-*.test.ts`。结果为 97/97 通过，0 失败、0 跳过，
退出码 0，覆盖：

- 三种模式契约、固定 sidecar 请求、基线 digest 漂移和严格响应解析。
- 组件版本、弱线索、正式 Finding、VEX、未知严重度和客户报告。
- OpenAPI 双引擎合并、部分失败、取消后到结果和 EngineRun 终态。
- 复核、复测、BOLA/BFLA、请求字段门禁、密钥哨兵和审计脱敏。

直接使用 Node 测试运行器执行 `scanner-scope.test.ts` 与
`relay-audit-scope.test.ts`，9/9 通过，退出码 0。覆盖协议、URL 凭据、异常端口、
特殊 IP、云元数据、混合 DNS、TTL、CIDR、重定向、连接前实际 IP 和服务端范围映射。

一次无效命令错误使用 `postgres` 用户，得到 61/102 纯模块通过、41 个数据库用例在
鉴权阶段失败；另一次误用 `pnpm --filter @lse/api test -- ...` 被包脚本扩展为整个
API 测试集，并因未设置数据库 URL 被测试安全预加载拒绝。两次均未作为产品测试结论，
修正环境和精确测试入口后才记录上述绿灯。

### Web、Worker 与类型门禁

- 页面 TDD 红灯：`ServiceAssurancePage.test.tsx` 为 9/12 通过、3/12 失败，缺少
  “复核结论”“发起复测”和组件清单文件入口。
- 最小实现后同文件 12/12 通过；与 `AppShell.test.tsx` 联合运行 18/18 通过。
- `@lse/worker` 测试 2/2 通过；Worker 并发保持服务端固定范围。
- `@lse/api`、`@lse/web`、`@lse/worker` typecheck 均退出 0。
- 任务 9 的 Web TypeScript 文件 Prettier 检查和 `git diff --check` 均退出 0。

客户动作只显示中文业务字段。普通复测请求体为 `{}`，服务端复制原目标、范围、
凭据引用、授权状态和预算；组件清单复测只提交新文件的类型与内容。客户端只接受
CycloneDX JSON、SPDX JSON 或 SPDX 文本并限制 2 MB，服务端仍执行独立类型、结构、
深度、数量、二进制、压缩包和大小校验。

### 提交前安全审计

- 复核、复测和取消均先执行操作权限，再通过 assessment/run 反查 task 执行对象权限；
  定向集成用例覆盖缺权限、跨用户、跨任务和错误模式。
- 复测不接受目标、范围、凭据、命令、模板、并发或超时；执行时仍重新解析 DNS、
  校验全部实际 IP、CIDR、重定向和锁定地址。
- React 差异未新增原始 HTML、动态代码、跨窗口消息、外部导航或文件预览执行面；
  文件类型和大小检查只用于客户反馈，安全结论仍由服务端严格解析。
- `writeAudit` 对所有结构化 detail 统一脱敏；哨兵测试检查 API、专用表、
  EngineRun、Finding、AuditLog 和报告，97 项联合测试中零明文命中。
- staged gitleaks 扫描 1 组未提交差异，零泄露，退出码 0；私钥头、常见云密钥、
  代码托管令牌和危险前端模式的新增行扫描零命中。
- staged 差异没有删除文件、AIG 代码或历史数据路径，没有镜像、依赖目录、日志、
  数据库副本或二进制制品；最大文件为既有前端 API 客户端 49386 字节。

安全审计未发现 Critical 或 Important 问题。结论只覆盖任务 9 staged 差异，不替代
任务 10 的真实靶场、浏览器、sidecar 日志和第三阶段联合门禁。

## 第三阶段任务 10：三模式端到端、负向证据与视觉验收

执行时间：2026-08-31T06:34:24+08:00 至 2026-08-31T06:42:00+08:00。

执行分支：`codex/service-assurance`，HEAD 起点
`556cee4ab39116d8b2d85890ee94f208f6e2c779`；本节记录尚未提交的任务 10 差异，
未 push、未合并、未部署。

### TDD 红绿证据与 Trivy 负向结论门禁

实现前先增加定向断言并观察 exit 1：旧实现会把 Trivy
`Results[].Packages` 误当成完整漏洞公告覆盖，未知包可能形成不受影响结论；修复版本
没有绑定同一次固定数据库查询返回的具体公告范围；静态 `CURRENT` 也不能反映
`metadata.json.NextUpdate` 已到期。Go 红灯同时缺少只读 Bolt 公告查询契约。

最小实现只读打开已签名基线中的 `db/trivy.db`，按精确生态、purl、包名和版本查询公告，
并把原始扫描摘要、公告记录摘要和固定数据库摘要共同绑定到负向证据。未观察组件、
不支持生态、非法输出、查询不完整或过期数据库均失败关闭为
`INCOMPLETE + UNDER_INVESTIGATION`，不会生成绿色结论。

绿灯结果：

- 隔离数据库全套 `apps/api/test/service-assurance-*.test.ts`：109/109 通过，exit 0，
  日志保留于 `/tmp/lse-sa-task10-precommit.PITeBm`。
- `go -C sidecars/service-assurance test -count=1 ./...`：exit 0。
- `go -C sidecars/service-assurance test -race -count=1 ./...`：exit 0。
- `go -C sidecars/service-assurance vet -mod=vendor ./...`：exit 0，无诊断。
- `scripts/test-service-assurance-sidecars.sh`：exit 0，终行为
  `[ok] service assurance sidecar policies are pinned and testable`。
- API、Web、Worker typecheck 均 exit 0；任务 10 文件 Prettier、`bash -n`、
  `gofmt -l` 和 `git diff --check` 均 exit 0。
- 受控靶场固定使用三个本地 sidecar 镜像 ID：
  `sha256:4e74692cbcdfeb65c2f71159db70706241f12ce9cde2163600893c33bd2be336`、
  `sha256:12589460e404c70e127eaf35641319ccca57f8c9c8db1ae9c9c450adbffd2307`、
  `sha256:2d9b7d50daca5d3a4aedabeea44d99ebf03f8ae6a2db996a3c15c8452f35625f`；
  未使用 `latest`。

### 隔离 E2E、三模式与持久化边界

新鲜执行 `bash scripts/test-service-assurance-e2e.sh`，exit 0。脚本输出依次确认：

- SAFE、DEEP、SBOM、权限、SSRF 和报告场景通过。
- 部分失败、过期基线和取消均到达要求的终态。
- Playwright 使用 1 个 worker 完成桌面与 390x844 两项真实页面流程，2/2 通过，
  耗时 43.5 秒。
- 数据库中 15 次运行、59 条证据和 17 条 Finding；`EngineRun.rawOutput` 非空数为 0，
  哨兵明文匹配数为 0，专项报告 1 份。
- 成功运行日志保留于 `/tmp/lse-service-assurance-e2e.5hdJ7C`；失败运行、失败数据库、
  `test-results/` 和既有历史证据没有删除。

三模式固定客户证据文件及 SHA-256：

- SAFE：`mode-safe.txt`，
  `adda1f785e2ff7ce42268b59b30cb5b0fce7937511a720e464bfe864fee0ae74`。
- DEEP：`mode-deep.txt`，
  `f7c31e9856142554405afbc595dfc2fc7c6bb4bc6aaa42b256b15e5719a24319`。
- SBOM：`mode-sbom.txt`，
  `b4249c930ef02ebf3410f2a5b6e15df22221cb18266fae0c8c1b75d3ac8f4f29`。

SAFE 负样本没有把普通 JSON 错误识别为 Triton；配置命中形成 1 条正式风险，
仅名称证据形成 1 条待核验线索。DEEP 授权正样本形成主动验证风险，认证有效负样本为
0 风险，可选服务失败为覆盖不完整。SBOM 受影响版本形成正式风险，修复版本只在具体公告
范围与三重摘要齐全时形成不受影响结论；不支持生态保留已确认风险并把覆盖标为不完整，
缺版本只形成线索。

### Web 与视觉证据

`ServiceAssurancePage.test.tsx` 与 `AppShell.test.tsx` 联合运行 19/19 通过，exit 0。
输出仍包含两条既有 React Router v7 future-flag 告警；没有 console error 或 pageerror。

- 桌面截图：1440x1000，SHA-256
  `56e6dc040a85c3b45387cd14238f13c169caf61288e61065ccb2ccafe1cf1bfc`。
- 移动截图：390x844，SHA-256
  `9814faef961c121e86ea731ba1a8e6765b4161b91f0cb942cdcd6e70e8b694e7`。

两张最新截图已人工检查：未见横向溢出、遮挡、空白或客户默认视图中的 UUID、原始
JSON、session、容器名和内部工具名。桌面最近运行状态在窄列内正常换行；移动首屏保持
单列，控件未越界。

### 无效命令、工具缺口与证据边界

- 首次误在 Mac 直接执行远端脚本，因文件不存在 exit 127；未触碰源码。
- 一组远端定向命令的 SSH 多行 `cd` 拼接错误，exit 2；测试未启动。
- 一次 API 组合测试缺少隔离 `DATABASE_URL`，被测试安全预加载拒绝；不计产品失败。
- 本次恢复后两次数据库包装尝试分别使用了不存在的 `postgres` 角色和默认数据库，
  均在建库前 exit 2；第三次因未显式声明隔离演练，被测试安全门禁拒绝，22 个测试文件
  在加载阶段失败、0 条断言执行。失败数据库和日志保留于
  `/tmp/lse-sa-task10-precommit.DVoj61`。最终以新建随机角色、新建专用数据库和
  `ALLOW_LIVE_TEST_DB=1` 明确限定该隔离演练，才取得上述 109/109 绿灯。
- home 未安装 ShellCheck，`command -v shellcheck` exit 1；本轮不能把 ShellCheck
  记为通过。`bash -n` 已通过，但不替代 ShellCheck。

### 任务 10 提交前安全审计

- `gitleaks protect --staged --redact --no-banner` 新鲜执行 exit 0，输出
  `no leaks found`。
- staged 新增行的私钥头、云密钥、代码托管令牌和带字面量口令数据库 URL 扫描零命中。
  唯一数据库 URL 形态来自隔离 E2E 脚本的 `${DB_ROLE}`、`${DB_PASSWORD}` 变量模板，
  不含凭据字面量。
- staged 生产代码的原始 HTML、动态代码执行、shell 调用、不安全 TLS、无超时默认 HTTP
  客户端等高风险 sink 扫描零命中。Docker Socket 与云元数据地址只出现在拒绝断言和
  受控负样本中。
- staged 删除清单为空，`test-results/` 未暂存；最大新增文件为固定 vendor 中
  945502 字节的生成平台常量文件，没有单文件超过 1 MB。
- `git diff --cached --check` 最初只报告两处上游 vendor 空白格式；删除末尾空行和
  尾随制表符后重新执行 exit 0，Go vendor 测试仍 exit 0。
- 固定离线模块清单为 `go.etcd.io/bbolt v1.4.3` 和
  `golang.org/x/sys v0.29.0`；`GOSUMDB=sum.golang.org`，未关闭公共模块校验。
  `go mod verify` 因访问 `proxy.golang.org` 超时 exit 1，未取得在线模块缓存验证；
  不得记为通过。离线 `-mod=vendor` 测试、vet 和 race 已通过。
- home 未安装 `govulncheck`，本轮没有 Go 漏洞调用图扫描证据；此缺口必须保留到最终
  依赖/制品检查报告，不以普通测试替代。

本节只证明第三阶段受控靶场、归一化结论、浏览器和持久化边界。生产 Compose 网络隔离、
离线新装/升级/回滚和十项退役门禁仍属于任务 12-13；在这些门禁完成前不能宣称可交付，
也不能删除 AIG。

## 任务 11：旧 AIG 数据迁移与回滚

TDD 红灯证据：

- `/tmp/lse-sa-task11-classify-red.F18dek`：首次远程补丁引号导致测试语法错误，未进入断言；
  文件保留。
- `/tmp/lse-sa-task11-classify-red2.O7NtqQ`：迁移模块不存在，exit 1，符合首个功能红灯。
- `/tmp/lse-sa-task11-transaction-red.lEITyy`：事务函数尚未导出，exit 1，符合第二个功能红灯。
- `/tmp/lse-sa-task11-rollback-preview-red.1r5m7x`：回滚预览函数尚未导出，exit 1，符合第三个
  功能红灯。

隔离包装与失败证据：

- `/tmp/lse-sa-task11-transaction-green.DhoigO` 对应隔离数据库
  `sa_task11_test_20260830T231219Z_2187079`；18 条迁移成功，测试因缺少测试 JWT 在应用
  加载前退出，0 条断言执行。
- `/tmp/lse-sa-task11-transaction-green2.tK0rBX` 对应隔离数据库
  `sa_task11_test_20260830T231316Z_2190546`；定位到置信度 `0.67` 被宽泛文本规则误作版本，
  3 项通过、1 项失败。
- 上述数据库、日志和失败 receipt 均保留，没有删除或覆盖。

绿灯证据：

- `/tmp/lse-sa-task11-transaction-green3.ukmTCb`：隔离数据库
  `sa_task11_test_20260830T231533Z_2199493` 完成 18 条迁移，4/4 通过，exit 0。
- `/tmp/lse-sa-task11-rollback-preview-green.SNFtcj`：隔离数据库
  `sa_task11_test_20260830T231904Z_2212394` 完成 18 条迁移，4/4 通过，exit 0；新增断言覆盖
  回滚预览和 receipt 篡改拒绝。
- `/tmp/lse-sa-task11-skip-reasons-red.20260830T233038Z_2256217.log`：新增跳过原因聚合断言后，
  实际值为 `undefined`，3/4 通过、1/4 失败，exit 1，符合功能红灯；隔离数据库保留。
- `/tmp/lse-sa-task11-skip-reasons-green.20260830T233158Z_2261224.log`：最小实现后 4/4 通过，
  exit 0；预览只返回固定枚举计数，不返回历史内容。
- `/tmp/lse-sa-task11-absolute-path-red.20260830T234150Z_2298080.log`：绝对路径校验函数尚未
  导出，测试加载阶段 exit 1，符合安全边界红灯；隔离数据库保留。
- `/tmp/lse-sa-task11-absolute-path-green.20260830T234236Z_2301076.log`：迁移与回滚共用原始
  参数绝对路径校验，5/5 通过，exit 0。
- `/tmp/lse-sa-task11-receipt-reason-red.20260830T234312Z_2303455.log`：旧复核理由中的哨兵
  明文进入 receipt，4/5 通过、1/5 失败，exit 1；失败 receipt 与数据库保留。
- `/tmp/lse-sa-task11-receipt-reason-green.20260830T234400Z_2306674.log`：事务并发校验继续使用
  原始理由，receipt 和回滚只使用公共模块脱敏后的理由，5/5 通过，exit 0。
- `/tmp/lse-sa-task11-relative-cli-rejection.20260830T234447Z_2309653.log`：迁移和回滚 CLI 对
  相对 receipt 路径均 exit 1，未创建文件，也未加载数据库环境。
- `/tmp/lse-sa-task11-precommit.20260830T233531Z_2274871.log`：当时的 4/4 测试、空库 CLI、
  receipt `0600` 和 API typecheck 已执行；组合命令因把 Shell 脚本误交给 Prettier 而
  exit 2，不计为完整提交前绿灯。Shell 脚本改由 `bash -n` 独立检查。
- `/tmp/lse-sa-task11-final-precommit.20260830T234650Z_2317539.log`：新隔离数据库完成 18 条
  空库迁移；5/5 测试、预览、应用、回滚、API typecheck、任务文件 Prettier、`bash -n`
  和 staged diff 均 exit 0。两份 receipt 权限均为 `0600`；迁移与回滚 CLI 对相对路径均
  exit 1，且未创建相对路径文件。

提交前安全审计：

- `gitleaks protect --staged --redact --no-banner` exit 0，输出 `no leaks found`。
- 暂存生产文件的私钥头、云密钥、代码托管令牌和带口令数据库 URL 扫描零命中；
  `child_process`、动态代码执行、shell 模式、外部 HTTP、Docker Socket、云元数据和不安全
  TLS 等危险 sink 扫描零命中。
- 暂存删除项为 0，单文件均不超过 1 MB；`test-results/` 未暂存。迁移脚本为普通文件，
  只读预览包装脚本保持 `100755`。

现网只读导出副本预览：

- 副本数据库为 `sa_task11_copy_reasons_20260830T233158Z_2261223`；先从运行中数据库执行
  `pg_dump`，在隔离 PostgreSQL 中恢复，再补齐 2 条 service-assurance 迁移；没有对现网
  执行迁移或写操作。
- `/tmp/lse-sa-task11-production-copy-zero-write.20260830T233158Z_2261223.log`：任务配置 0、
  运行中旧引擎 0、历史 EngineRun 3、历史 Finding 2、`relay-audit` import 0；迁移候选 0，
  两条跳过记录均为 `OUT_OF_SCOPE`，已有迁移 0，需版本人工复核 0。
- 预览前后 Finding 复核摘要、EngineRun、AuditLog、ServiceAssuranceRun 和
  VulnerabilityAssessment 计数完全一致，`preview_write_check=UNCHANGED`；脱敏状态摘要
  SHA-256 为 `14345a2065230e2ada70d3d0e2f2f92acdc0eabcdea033f86ce063d976d06ad8`。

测试实际验证：预览零写入；应用只修改目标 Finding 的复核状态；无版本 Triton 只新增
`UNDER_INVESTIGATION + LEAD`，严重度为空且不创建正式 Finding；receipt 不含旧原始输出、
目标地址、CVE 关联项或哨兵；重复应用零新增；回滚恢复旧复核状态并保留迁移线索和审计；
`EngineRun`、`rawOutput` 和旧 Finding 计数不减少；任务配置、运行中引用、历史运行、历史
Finding 和 `relay-audit` 依赖每次重新查询。
