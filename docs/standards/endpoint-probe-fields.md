# 终端体检：需要探针补采的字段

更新：2026-11-13。本文只列需求，不发布探针包。探针发布要用户逐步同意，由总控处理。

## 一、现状

TC260-PG-20266A 附录 A 共 31 项。平台现在能判的 14 项（自动）已有服务端规则或运行态样本佐证；探针没采集、因此服务端判不了的，在本文列出。
服务端解析与判定已经写好，放在开关后面：环境变量 `LSE_ENDPOINT_POSTURE_EXTENDED=true` 时，体检多出 6 条扩展规则；默认关闭，关闭时报告里这几项写「未检，需探针补采」。

先决条件：探针按下表上报字段后再打开开关。开关打开而探针没上报的字段，对应规则会得到「终端没检查」，不会被当成通过。

## 二、扩展字段（探针 aiprobe.report.v1 的 assets[].evidence 下）

| 体检规则 | 指引检查项 | 字段路径 | 取值 | 判定 |
|---|---|---|---|---|
| `run_as_admin` 运行账户权限 | 8 c) 不使用管理员权限运行 | `evidence.runtime.run_as_admin` | boolean | true 为不符合 |
| `dir_scope` 可访问目录范围 | 8 d) 限制可访问目录 | `evidence.runtime.accessible_dirs` | 字符串数组，元素取 `workspace`、`home`、`system`、`root` | 含 `home`、`system`、`root` 为不符合 |
| `logging` 日志记录设置 | 8 f) 开启日志并配到最细 | `evidence.config.logging` | `{ enabled: boolean, finest_level: boolean }` | 未开启或未设最细级别为不符合 |
| `listen_exposure` 本机监听范围 | 8 e) 网络暴露；9 d) 公网接口复查；6 f) 重大隐患 | `evidence.runtime.listeners` | `[{ scope: 'loopback' \| 'lan' \| 'any' }]` | 任一 `lan` 或 `any` 为不符合 |
| `install_source` 安装来源 | 7 a) 1) 官方渠道获取 | `evidence.install_source` | `official` \| `store` \| `package_manager` \| `modified` \| `third_party` \| `unknown` | `modified`、`third_party` 为不符合；`unknown` 按没采集处理 |
| `install_integrity` 安装物料校验 | 7 a) 2) 校验真实性与完整性 | `evidence.integrity` | `{ signature_verified?: boolean, hash_matches?: boolean }` | 任一为 false 为不符合；两者都没有按没采集处理 |

约定：

- 探针只报事实，不报结论，不带路径、账号、命令行原文；目录只上报范围类别。
- 多个安装项合并时，任何一个命中即命中；全部取得且都没命中才算通过；有一个没取得则整体未检。
- 采集不到时必须省略字段，不要填 `false`。

## 三、已上报但此前没用上的字段（本次服务端已启用，无需探针改动）

| 体检规则 | 来源字段（探针已上报） | 指引检查项 |
|---|---|---|
| `sandbox_scope` 运行沙箱与目录范围 | `config.sandbox` 静态检查结果、`evidence.config.sandbox_mode` | 8 d)、8 c)、6 e) |
| `model_destination` 模型出口来源 | `evidence.endpoint`、`evidence.destinations` 的 `classification`、`approval_status`，静态检查 `model.exit`、`proxy.route` | 7 c) |
| `agent_version` 智能体版本可追溯 | 资产 `version` | 9 j) |
| `platform_exposure` 智能体平台对外暴露 | 静态检查 `platform.exposure`、`platform.admin_auth`、`platform.signup` | 8 e)、9 d) |
| `platform_telemetry` 运行数据外发 | 静态检查 `platform.telemetry` | 6 f) |
| `platform_version` 智能体平台版本漏洞 | 静态检查 `platform.version` | 6 d)、9 j) |

边界：

- `model_destination` 只核对出口分类与是否列入受管目录，模型是否通过生成式人工智能服务备案仍需人工核对。
- `agent_version` 只核对版本是否可识别，平台没有智能体产品自身的安全公告库。
- 平台三条规则只覆盖容器部署的智能体平台组件（如 Dify）；终端上没有这类组件且采集完成时，写「通过」并注明未发现平台组件。本机 CLI 智能体的监听端口要靠 `listen_exposure`。

## 四、仍然需要人工填报或取证后确认的项

- 人工填报（9 项）：6 a) b) c)、8 a)、9 e)、9 f)、9 i)、10 a) b)。
- 平台取证、人工确认（5 项）：6 e) 中的急停与可回溯文件系统、7 b) 部署方式、9 a) 复查、9 h) 权限回收、10 c) 环境清理。
- 这些不属于探针能补的范围，报告里按原因合并成一句，不逐项平铺。

## 五、沙箱体检字段

`sandbox_enabled`、`sandbox_bypass`、`sandbox_credential_read` 三项读探针上报的 `evidence.sandbox`，默认启用，不受扩展开关控制。字段、各智能体的判定规则和依据文档见 [三项沙箱检查的判定规则](../endpoint-fleet/sandbox-posture-rules.md)。
