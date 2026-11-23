# 自管终端接入（endpoint-fleet）文档索引

鉴盾直接管理员工电脑上的采集器（探针）：登记终端、收配置体检、下发真机测评（管理员发起即下发，不需要审批）；Linux 一条命令、Windows 一个安装包即可接入。

| 文档 | 内容 | 读者 |
|---|---|---|
| [`probe-sharing-design.md`](probe-sharing-design.md) | 设计：探针在「仅鉴盾 / 仅智能体安全平台 / 两者」下怎么共用，一台终端只听一个服务端 | 设计、评审 |
| [`protocol-subset.md`](protocol-subset.md) | 协议规格：鉴盾实现的 `/agent/v1/*` 最小子集、checksum 算法、安全要求 | 开发 |
| [`protocol-implementation.md`](protocol-implementation.md) | 协议服务端实现说明：端点、错误码、环境变量、与规格的取舍 | 开发、运维 |
| [`admin-api.md`](admin-api.md) | 管理接口 `/api/fleet/*`：权限、接口、任务状态流转，以及 §7 **Windows 安装包**（接口、尾部配置格式、预检规则、静默安装、未签名提示） | 开发、前端、运维 |
| [`deployment-guide.md`](deployment-guide.md) | **部署与运维指南**：三种部署情形、独立端口与自签证书、反向代理、终端安装、日常运维、安全清单、故障排查 | 现场交付、运维 |
| [`deployment-quickstart.md`](deployment-quickstart.md) | **快速开始**：Linux 一条命令 / Windows 安装包的最短路径 | 现场交付 |
| [`../../scripts/fleet-gen-cert.sh`](../../scripts/fleet-gen-cert.sh) | 证书脚本：生成自签叶子证书（EC P-256）与 `tls-deployment.json` | 现场交付 |

## 联调与参考脚本（本目录内）

| 文件 | 作用 |
|---|---|
| `stub_server.reference.py` | 协议参考实现（Python 替身服务端），可用真实采集器联调 |
| `checksum_vectors.py` | 用采集器的 checksum 函数复核测试向量（用法见 `protocol-subset.md` §6.1） |
| `canonical_ref.mjs` | Node 版 canonical/checksum 参考实现 |

真实采集器的源码与文档在 AgentShield 仓库（`scripts/endpoint-platform/`，分支 `v2/20261020/lse-endpoint-runner`），本仓库不包含；联调的证据文件（`evidence/`）也不在本仓库内，位置**待确认**。

## 证书脚本测试说明

`scripts/fleet-gen-cert.sh` 没有放进仓库的自动化测试。手工验证步骤：

1. `T=$(mktemp -d)`，`scripts/fleet-gen-cert.sh --server https://192.0.2.10:18443 --ip 192.0.2.10 --dns lse.example.local --out "$T"`。
2. 再运行一次同样命令应失败（不覆盖）；加 `--force` 应成功。
3. 用 Python 校验：`tls-deployment.json` 键恰好 `server`、`tls_server_cert_pem`、`tls_server_cert_sha256`；PEM ≤ 4096 字节且仅 1 张证书；`tls_server_cert_sha256` 等于 `ssl.PEM_cert_to_DER_cert(pem)` 的 SHA-256 小写 hex；`fleet-server.key` 权限为 0600。
4. 非法 `--server`（`http://`、带路径/查询/用户信息、端口越界）和 SAN 未覆盖主机应以非零状态退出，且不留下输出文件。
5. 用完删除临时目录。
