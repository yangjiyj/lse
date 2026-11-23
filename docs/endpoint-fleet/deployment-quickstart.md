# 鉴盾 · 自管终端接入 快速开始

> 仅适用「只有鉴盾」的部署（一台终端同一时刻只听一个服务端）。细节、排错与安全清单见 `deployment-guide.md`。命令中的 IP、端口、路径均为示例，换成现场实际值。

## 一键接入（Linux 一条命令 / Windows 一个安装包）

创建接入码后：Linux 终端（x86_64 / aarch64，systemd）复制一条命令即可接入；Windows 终端下载安装包双击运行即可接入。macOS 暂未提供一键安装，请按文末附录手工安装。

### 管理员一次性准备

1. **证书与独立 HTTPS 入口、开关**：按附录 A 的第 1–3 步完成（`FLEET_AGENT_ENABLED=true`、`FLEET_PUBLIC_BASE_URL`、`FLEET_TLS_CERT_PEM_PATH`，并让 `GET /api/fleet/deployment-info` 的 `ready` 为 `true`）。
2. **放探针包**：把智能体安全平台（AgentShield）构建产物的 `downloads/collectors/` 目录里的 `catalog.json`、`linux-amd64.tar.gz`、`linux-arm64.tar.gz` 拷到服务器一个目录（如 `/srv/lse-fleet-kits`）；要提供 Windows 安装包，再把 `catalog.json` 里 Windows 条目 `setup_filename` 指向的 `.exe` 一并拷进来。**只读挂载**进 api 容器，并配置：
   - `FLEET_KIT_DIR=/fleet-kits`（容器内路径；compose 里加 `- /srv/lse-fleet-kits:/fleet-kits:ro`）
   - 可选 `FLEET_KIT_BASE_URL=http://<终端能访问的鉴盾地址>`：终端下载脚本与探针包用的地址，默认取 `LSE_PUBLIC_BASE_URL`；内网用 http 也可以，包的完整性由写进脚本的 SHA-256 保证。
   - 重启 api 后，在「评估中心 → 终端 → 接入终端」页签创建一个接入码，卡片里应能看到 Linux 命令；缺 `catalog.json`、包文件缺失或散列不符会在页签顶部和 `deployment-info.warnings` 里提示原因，并提示「请联系平台管理员完成部署配置」。
   - 升级探针包时只需替换目录里的文件和 `catalog.json`，脚本会随之更新（下一条命令里的脚本散列自动变化）。

### 每台终端

1. 在「接入终端」页签点「创建接入码」，**明文只显示一次**。
2. 卡片里选终端的系统（只有 Linux / Windows 两个选项，没有勾选框）。

**Linux**

3. 卡片直接给出一条命令，复制到终端执行，形如（固定带 `--enable-eval`：本机没有 claude / codex 时脚本只提示、不报错；本机已接入别的服务端时脚本会拒绝并在终端里提示加 `--switch` 重跑）：
   ```
   curl -fsSL 'https://<鉴盾地址>/api/fleet/install/linux.sh' -o /tmp/jiandun-probe.sh && echo '<脚本sha256>  /tmp/jiandun-probe.sh' | sha256sum -c - && sudo bash /tmp/jiandun-probe.sh --code '<接入码>' --enable-eval
   ```
4. 脚本会：校验自身 SHA-256 → 下载对应架构的探针包并校验 SHA-256 与 manifest SHA-256 → 钉扎自签证书登记终端（接入码只写入 root 0600 临时文件，用完即删，不出现在进程参数里）→ 开启真机测评（本机有 claude / codex 才会生效）→ 打印中文结果。几分钟内终端出现在「终端清单」。
5. 本机已是同一鉴盾服务端时，不带 `--code` 重复运行即为升级探针包。

**Windows**

3. 卡片里点「下载安装包（x64）」或「下载安装包（ARM64）」（按钮会带登录令牌下载，安装包里已内置接入码和服务端信息）。
4. 把安装包拷到终端**双击运行**，按提示允许管理员权限即可完成接入；批量下发用 `安装包.exe /quiet` 静默安装。
5. 安装包暂未做代码签名，首次运行如出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
6. 某个架构的安装包在服务端不可用时，按钮置灰并写明原因（例如「探针包目录缺少 Windows 安装包文件」「当前探针包版本不支持鉴盾安装包，请更新探针包」），处理办法见 `admin-api.md` §7.4。证书必须是自签叶子、SAN 恰好一个 IP、服务地址必须是 IP（§7.3），`scripts/fleet-gen-cert.sh` 生成的证书满足。

> 说明：命令中的 `--code` 在执行脚本的那一刻会出现在本机进程列表里；请在可信终端上运行。也可以改用环境变量 `JD_CODE='<接入码>' sudo -E bash /tmp/jiandun-probe.sh`，或不带参数运行按提示输入。

### 接口（无需登录，开关关闭时均为 404）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/fleet/install/linux.sh` | 动态生成的一键脚本（写死服务端地址、证书、探针包地址与散列；同配置下内容稳定） |
| GET | `/api/fleet/install/linux.sh.sha256` | 脚本的 SHA-256 |
| GET | `/api/fleet/kits/:filename` | 探针包下载，只允许 `catalog.json` 里列出的 Linux 包文件名 |

另有需要登录的 `POST /api/fleet/install/windows-installer`（Windows 安装包下载，接口说明见 `admin-api.md` §7）。

---

## 附录：手工安装（高级）

适用于 macOS、无法联网下载探针包、或需要逐步排错的场景。**页面上已不再提供「高级 / 手工安装」入口**，由现场工程师按下面的步骤操作。

### 附录 A 手工步骤

1. **生成自签叶子证书**（CA 签发的证书采集器会握手失败；SAN 必须覆盖终端访问鉴盾的主机）：
   `scripts/fleet-gen-cert.sh --server https://192.168.31.182:18443 --ip 192.168.31.182 --out ./fleet-certs`
2. **加独立端口的 TLS 入口**：在 lse 安装目录放 `docker-compose.override.yml` 与 `Caddyfile.fleet`（内容见指南 §2.3），只转发 `/agent/v1/*` 到 `api:8090`。
3. **开开关、起服务**：`.env` 追加 `FLEET_AGENT_ENABLED=true`、`FLEET_PUBLIC_BASE_URL=https://192.168.31.182:18443`、`FLEET_HTTPS_PORT=18443`（真机测评另加 `LSE_ENDPOINT_EVAL_ENABLED=true`、`LSE_PUBLIC_BASE_URL=<落点地址>`），然后
   `docker compose -f docker-compose.yml -f docker-compose.override.yml up -d`
   核对：`GET /api/fleet/deployment-info` 的 `ready` 为 `true`；防火墙只对终端网段开放 18443。
4. **建接入码**：鉴盾界面 `/fleet?tab=enroll`（「接入终端」页签）→ 创建（标签、有效期、次数），**明文只显示一次**，立即复制。
5. **终端登记**（Linux，接入码走标准输入，不入命令行）：
   `python3 <kit>/tools/platform-collector.py --state <状态目录> enroll --kit <kit> --server https://192.168.31.182:18443 --tls-config tls-deployment.json --token-stdin < 接入码文件`，用完删除接入码文件。
6. **确认出现**：终端上 `run --once` 后 `status` 无 `last_error`；鉴盾「终端清单」里出现该终端且在线。
7. **配置体检**：把 `{"managed_config": false, "system_audit": false, "eval_jobs_enabled": false}` 合并进 `<状态目录>/collector.json`（保留原有字段）；`run --once` 上报后，在终端详情查看配置体检结果。
8. **（可选）真机测评前置**：以 root 创建 `/etc/agent-platform-managed/eval-registry.json`（属主 root、0644，`argv[0]`/`hookd_path` 为绝对路径，结构见指南 §5.2）；把 `collector.json` 改为 `"eval_jobs_enabled": true, "eval_user": "<登录用户>"`；等待下一次心跳，终端显示具备测评能力。
9. **发起真机测评**：管理员在终端清单点「真机测评」（选 `claude-code` 或 `codex`，备注可不填），点「开始测评」，任务直接下发，**不需要另一位管理员审批**；在「测评任务」页签看进度。
10. **看结果**：任务 `COMPLETED` 后到对应评估任务查看；结果带 `registry_untrusted` 的不计入正式结论；`DELIVERED`/`RUNNING` 的任务无法远程中止，只能等。

上线前请完成指南 §7 的安全清单。
