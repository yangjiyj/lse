# ADR 与 LSE 的产品融合决策

## 结论

LSE 不直接内嵌或整仓复制 Uber ADR Detector。生产能力采用 **LSE 原生判定 + ADR-compatible 轨迹导入**；ADR Sensor 只是可选采集器，不是 LSE 必装端点。

首个产品闭环：用户把 ADR Sensor JSON 或同结构的轨迹文件上传到 LSE，LSE 在请求内存中归一和分析，随后只把匿名会话指纹、统计量和脱敏风险发现写入现有 `EvalTask`、`Finding`、`EngineRun`，因此可以直接复用任务详情、风险列表和智能体专项报告。

## 为什么不整仓搬 Detector

审计基线：Uber ADR `d0e62f9c6e840442ce90c299a031d5a53075dacc`。

- `Detection` README 将 ADR-Bench 标为 alpha / research，并明确写明不用于生产；其固定依赖含已知 CVE，只接受在隔离基准环境中运行。
- ADR baseline 先调用 OpenAI 模型做 triage，再通过子进程调用 Claude Code CLI 做推理；默认还要启动源码、威胁情报、策略三个 MCP 上下文服务。
- 运行时会写 `.mcp.json`、原始调试 JSON，并读取 `~/.claude/projects` 会话文件。这与 LSE 的服务端隔离、凭据治理和证据留存策略冲突。
- 全量 Benchmark 包含恶意 MCP 服务、合成凭据、提示注入夹具及多种第三方数据许可。把它随生产镜像交付会显著增加依赖、镜像、漏洞和合规工作量。
- LSE 已有规则判定、裁判、任务、发现、报告和审计链；再嵌一套双模型 Detector 会形成平行架构。

## 复用边界

| ADR 部分 | LSE 处理 | 产品定位 |
| --- | --- | --- |
| Sensor JSON 数据结构 | 兼容读取，不复制其运行时代码 | 可选导入格式 |
| Sensor 端点采集 | 客户自愿使用；LSE 不要求安装 | 可选连接器 |
| Detector | 不进入生产包 | 仅作算法研究参考 |
| ADR-Bench 数据集/MCP 服务 | 不进入生产包 | 隔离研发与回归校准 |
| DetectionResult 思路 | 映射到 LSE `Finding`/`EngineRun` | 统一证据模型 |

当前实现没有复制 ADR 上游源码，因此无需把 ADR Python 依赖带进 LSE。未来若分发修改后的 ADR 代码，须遵守 Apache-2.0：附许可证、保留 NOTICE/版权声明并标注修改；ADR 仓库内的第三方夹具还需逐项遵守各自许可。

## 数据与隐私边界

- 上传内容只在 API 请求内存中处理，不保存完整消息、工具原始结果、主机名、用户名、项目路径或原始日志路径。
- 原始 `session_id` 用 `source + session_id` 生成 24 位 SHA-256 指纹后丢弃。
- 工具参数、结果、风险证据继续复用 LSE 的 secret redaction。
- 持久化入口强制关闭提示词/回复摘录，即使上传文件要求开启也会覆盖为关闭。
- 保存会话数、消息数、工具调用数、截断标记和脱敏风险发现，供覆盖率判断与报告引用。

## 后续产品路线

1. 先交付手工上传 JSON 的无端模式，验证客户需求和格式覆盖率。
2. 增加通用 webhook / OpenTelemetry / OpenInference 轨迹适配，不把产品绑定在 ADR Sensor 上。
3. 对必须实时监测的客户，再提供可选 Sensor、网关日志或 SDK 连接器；这些连接器只负责采集，不承载 LSE 判定。
4. ADR-Bench 仅放入隔离的研发流水线，用于离线校准 LSE 规则和裁判，不随生产制品发布。
