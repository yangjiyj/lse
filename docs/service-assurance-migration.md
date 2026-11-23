# AI 服务安全核验历史数据迁移

本文说明如何预览、应用和回滚旧组件扫描结果迁移。命令只在授权的 `home` 主机执行，
源码工作目录为功能分支 worktree。不要在 Mac 保存业务源码副本，也不要把 receipt 写入
Git 工作区。

## 迁移边界

迁移只处理能确定来自旧组件误归一化链路的 Finding：

- 整个 `resultUpdate` 被误写成正式风险的记录标记为 `FALSE_POSITIVE`，理由固定为
  “历史扫描结果解析错误”。
- 只取得 NVIDIA Triton 产品名、没有版本或验证证据的记录，另存为“疑似组件、待核验
  线索”，状态为 `UNDER_INVESTIGATION + LEAD`。
- 已有明确版本的历史记录不自动确认或降级，留给人工复核。
- 旧红队、提示注入等非组件 Finding 不在迁移范围。

迁移不删除或改写 `EngineRun`、`rawOutput`、旧 Finding、`AuditLog`、报告、日志卷和数据卷。
回滚只恢复旧 Finding 的复核状态与理由；迁移生成的审计记录和线索继续保留，便于追溯。

## 前置检查

1. 确认当前分支和工作区，没有把其他任务改动带入本次操作。
2. 使用数据库副本先执行预览和回滚演练。
3. 现网应用前完成数据库备份，并确认 receipt 目录位于源码树外、权限为 `0700`。
4. 通过受保护的进程环境提供 `DATABASE_URL`；不要把连接串写进命令历史、文档或 receipt。

预览命令：

```bash
cd <repo>/service-assurance
bash scripts/preview-service-assurance-aig-migration.sh
```

脚本默认为只读，不接受 apply 参数。输出只包含变更数量、固定枚举的跳过原因计数和以下
引用统计。跳过原因分别表示非本次组件误归一化范围、已执行过迁移和已有版本需人工复核；
输出不包含 Finding 内容、目标地址或内部 ID。

- `configuredTaskCount`：`EvalTask.engines` 中仍配置旧引擎的任务数。
- `activeEngineRunCount`：旧引擎 `PENDING/RUNNING` 运行数。
- `historicalEngineRunCount`：必须保留的历史运行数。
- `historicalFindingCount`：必须保留的历史 Finding 数。
- `relayAuditImportCount`：`relay-audit` 对旧引擎源码的直接依赖数。

每次预览都会重新查询数据库和源码，不能沿用旧统计。存在任务配置、运行中任务或源码依赖
时，`hasBlockingReferences=true`；这会阻止 AIG 退役，但不阻止只读预览。

## 应用迁移

选择一个不存在的绝对 receipt 路径。脚本以 `0600` 创建 receipt，已有文件不会覆盖：

```bash
umask 077
pnpm exec tsx apps/api/scripts/service-assurance-migrate-aig.ts \
  --apply \
  --source-root "$PWD" \
  --receipt /var/lib/lse/migration-receipts/service-assurance-aig-20260831.json
```

数据库变更在单个事务内执行。receipt 记录 Finding ID、旧/新复核状态、内容 SHA-256、
事务时间和引用计数；旧复核理由经公共文本脱敏后才保存，回滚也只恢复脱敏值。receipt
不保存 `detail`、`rawOutput`、目标地址、凭据或原始响应。重复执行会得到零项变更，不创建
重复运行、组件、判断或证据。

`state=APPLIED` 才表示事务提交；`PREPARED` 或 `FAILED` 只表示失败证据，必须保留并调查，
不能删除后重跑来掩盖问题。

## 回滚

先只读检查当前记录是否仍与迁移后的状态一致：

```bash
pnpm exec tsx apps/api/scripts/service-assurance-rollback-aig.ts \
  --preview \
  --receipt /var/lib/lse/migration-receipts/service-assurance-aig-20260831.json
```

只有 `restorableCount` 与原 receipt 变更数一致且 `conflictCount=0` 时，才执行回滚。应用回滚
必须提供新的、尚不存在的回滚 receipt：

```bash
umask 077
pnpm exec tsx apps/api/scripts/service-assurance-rollback-aig.ts \
  --apply \
  --receipt /var/lib/lse/migration-receipts/service-assurance-aig-20260831.json \
  --rollback-receipt /var/lib/lse/migration-receipts/service-assurance-aig-20260831.rollback.json
```

回滚前会校验 receipt 大小、结构和 SHA-256。若记录在迁移后被人工修改，则计入冲突且不
覆盖人工状态。回滚完成后，旧证据、迁移线索和新增审计仍可查询。

## AIG 退役关系

历史迁移成功不等于 AIG 已达到删除条件。本步骤只提供数据纠偏、引用复查和回滚能力。
只有误报、正负样本、三模式、报告、安全、视觉、离线和回滚十项门禁全部为新鲜 `MET`，
并再次确认任务配置数、运行中引用数和 `relay-audit` 依赖数均为零后，才允许在独立提交中
移除 AIG 新任务链路。历史数据、审计、日志卷和数据卷始终保留。
