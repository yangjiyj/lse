# 鉴盾 · 自管终端接入 部署与运维指南

> 版本：v1（2026-10-22）。读者：现场交付与运维工程师。
> 依据：`protocol-subset.md`、`protocol-implementation.md`、`admin-api.md`、`probe-sharing-design.md`，服务端代码（`apps/api/src/modules/fleet-agent|fleet-admin`），以及采集器仓库 `scripts/endpoint-platform/` 下的文档与脚本（只读核对，分支 `v2/20261020/lse-endpoint-runner`，提交 `acee45ad`）。
> 标注「待确认」的内容没有在真实环境完整验证，上线前请先在测试环境走一遍。文末附验证状态汇总。

---

## 1. 适用范围与部署情形

「自管终端接入」让鉴盾直接管理员工电脑上的采集器（探针）：登记终端、收配置体检、下发真机测评（管理员发起即下发，不需要审批）。采集器与服务端之间走固定的 `/agent/v1/*` 协议，鉴盾实现了其中的最小子集。

不在范围内：行为审计、受管配置、凭据下发、模型中继、网关联动、采集器自动升级。这些是智能体安全平台的能力，鉴盾不提供，端点返回 404 或空结果。

### 1.1 三种部署情形对照

| | 情形 1：仅鉴盾 | 情形 2：仅智能体安全平台 | 情形 3：两者都有 |
|---|---|---|---|
| 终端听谁 | 鉴盾 | 智能体安全平台 | 智能体安全平台 |
| 接入码来源 | 鉴盾（前缀 `jdc_`） | 智能体安全平台 | 智能体安全平台 |
| 是否用本指南 | 是 | 否，本指南不适用 | 否，按现有「连接器」方式 |
| 终端清单 | 鉴盾「终端」页 | 智能体安全平台 | 智能体安全平台；鉴盾经连接器复用 |
| 配置体检 | 有 | 有（平台侧） | 有 |
| 真机测评 | 管理员在鉴盾发起，直连下发 | 平台审批 | 平台审批，鉴盾经连接器发起 |
| 行为审计/受管配置/凭据下发/升级 | 无 | 有 | 有 |
| 采集器升级 | 手工（安装器 `upgrade`） | 平台自动升级通道 | 平台自动升级通道 |

选择建议：

- 客户没有智能体安全平台、只要配置体检与真机测评：选情形 1，用本指南。
- 客户已有智能体安全平台：不要再用鉴盾接入码接入同一批终端，走情形 3（现状，不动）。
- 客户之后采购智能体安全平台：先迁移（见 §6.3），不要两边同时登记。

### 1.2 一台终端同一时刻只听一个服务端

这是硬规则：令牌、审计、责任边界（以及联动版里的测评审批）只能有一个来源。

- **已被智能体安全平台接管的终端，不要再用鉴盾接入码。** 采集器本地已有登记身份，再次登记会被拒绝（`already_enrolled`）；强行清除状态目录重新登记会让原平台上的该终端变成「失联」，且平台侧不知情。
- 换服务端的唯一正确做法：先在原服务端吊销，再清除终端本地状态目录，再用新服务端的接入码登记（§6.3）。
- 同一台服务器上同时部署鉴盾和智能体安全平台时，接入码前缀不同（鉴盾为 `jdc_`），端口也不要混用，避免现场人员填错对象。（设计稿中还规划了采集器侧校验前缀与 `server_kind`，当前采集器版本是否已实现：**待确认**，不要依赖它。）

---

## 2. 服务端配置

### 2.1 环境变量

以下变量均在代码中核对过（`grep` 确认存在），没有列入的变量不要配置。

| 变量 | 默认 | 含义与取值 | 依据 |
|---|---|---|---|
| `FLEET_AGENT_ENABLED` | `false` | 总开关。只有字面值 `true` 才开启。关闭时 `/agent/v1/*` 与 `/api/fleet/*` 一律返回 404。每次请求读取，改后需让容器重新加载环境（`docker compose up -d`）。 | `fleet-agent/config.ts`、`fleet-admin/config.ts` |
| `FLEET_PUBLIC_BASE_URL` | 空 | 终端访问鉴盾的 HTTPS 地址，只能是 `https://主机[:端口]`，不能带路径、查询串、用户信息。必须与证书 SAN、终端 `--server` 参数完全一致。 | `fleet-admin/deployment.ts` |
| `FLEET_KIT_DIR` | 空 | **容器内**探针包目录（AgentShield 构建产物的 `collectors/`：`catalog.json` + `linux-amd64.tar.gz`、`linux-arm64.tar.gz`）。配置后提供 Linux 一键安装和 Windows 安装包（Windows 的 `*.exe` 也放在这个目录），见 `deployment-quickstart.md` 与 `admin-api.md` §7；未配置不影响 `ready`。 | `fleet-admin/kits.ts` |
| `FLEET_KIT_BASE_URL` | 空 | 终端下载一键脚本与探针包使用的鉴盾地址（可 http），默认取 `LSE_PUBLIC_BASE_URL`。 | `fleet-admin/install-script.ts` |
| `FLEET_TLS_CERT_PEM_PATH` | 空 | **容器内**的自签叶子证书 PEM 路径。文件里只能放证书（出现私钥会被拒绝），且恰好 1 张、≤ 4096 字节。 | `fleet-admin/deployment.ts` |
| `LSE_PUBLIC_BASE_URL` | 空 | 诱饵落点基地址，场景包里的 `sink_base_url` 为 `<它>/sink/<runToken>`。只能是 `http(s)://主机[:端口]`，无路径。真机测评创建任务时必需。 | `fleet-admin/service.ts`、`endpoint-evals/routes.ts` |
| `LSE_ENDPOINT_EVAL_ENABLED` | `false` | 字面值 `true` 才开启。现有落点 `/sink/<runToken>/exfil` 只在它开启时记录命中；自管终端复用这套落点，所以做真机测评也要开。 | `endpoint-evals/config.ts` |
| `LSE_ENDPOINT_EVAL_MCP_ALLOWLIST` | 空 | 配置体检的 MCP 外联白名单，与现有体检共用。 | `fleet-admin/posture.ts` |
| `FLEET_AGENT_IP_RATE_PER_MIN` | `600` | 每个来源 IP 每分钟请求数（鉴权之前计数）。 | `fleet-agent/config.ts` |
| `FLEET_AGENT_REGISTER_RATE_PER_MIN` | `20` | 每个来源 IP 每分钟登记次数，用于防接入码爆破。 | 同上 |
| `FLEET_AGENT_ENDPOINT_RATE_PER_MIN` | `120` | 每个终端每分钟请求数；采集器正常约 4 次/分钟。 | 同上 |

说明：

- `LSE_ENDPOINT_EVAL_HMAC_SECRET`、`LSE_AGENTSHIELD_BASE_URL` 是**连接器（情形 3）**用的，纯自管终端不需要。
- 上面前五个变量在仓库的 `docker-compose.yml` 里，只有 `LSE_ENDPOINT_EVAL_ENABLED`、`LSE_PUBLIC_BASE_URL`、`LSE_ENDPOINT_EVAL_MCP_ALLOWLIST` 已声明；`FLEET_*` **没有**写进 `docker-compose.yml`，需要用 compose override 加入（§2.3）。

### 2.2 为什么要独立端口，以及证书必须是自签叶子证书

现有 web 容器（`lse-web`，Caddy）的状态，读自 `apps/web/Caddyfile` 与 `docker-compose.yml`：

- 宿主 `${WEB_HTTP_PORT:-8090}` → 容器 80，`${WEB_HTTPS_PORT:-10443}` → 容器 443；离线包安装器从 8090、10443 起自动顺延选择空闲端口，最终以安装目录的 `.env` 为准。
- 443 站点用 `tls internal`（Caddy 内部 CA 签发的叶子证书）。
- 路由只代理 `/api/*` 和 `/sink/*` 到 `api:8090`，其余走前端页面。**`/agent/v1/*` 不会被转发。**

所以必须另开一个独立端口，专门对终端提供 `/agent/v1/*`，并且使用**自签叶子证书**：

- 采集器把服务端证书当作唯一信任锚，并按 SHA-256 精确钉扎。
- **CA 签发的叶子证书会握手失败**（协议规格实测：采集器报 `connection_failed`）。所以不能直接用 `tls internal`，也不能用企业 CA 或公网 CA 签发的证书。
- 证书必须不带 `CA:TRUE`、在有效期内，SAN 必须覆盖终端访问鉴盾所用的主机名或 IP（域名放 DNS，IP 放 IP）。SAN 与 `--server` 里的主机不一致，握手同样失败。
- 采集器对 `server` 的要求：`https://主机[:端口]`，无路径/查询/用户信息；不跟随重定向，不走代理，TLS ≥ 1.2。

### 2.3 一步步做

**(1) 生成证书与 `tls-deployment.json`**（任意一台有 openssl 的机器；私钥只放到 TLS 终止处）：

```bash
scripts/fleet-gen-cert.sh \
  --server https://192.168.31.182:18443 \
  --ip 192.168.31.182 --dns lse.example.local \
  --out ./fleet-certs
```

- `--server` 必填，格式 `https://主机[:端口]`；`--ip`/`--dns` 可重复，至少一个，且必须覆盖 `--server` 中的主机。
- 默认 EC P-256、有效期 825 天（`--days` 可改）、私钥 `0600`；已有文件不覆盖，需 `--force`。
- 产物：`fleet-server.key`（私钥）、`fleet-server.crt`（证书，不含私钥）、`tls-deployment.json`（键恰好 `server`、`tls_server_cert_pem`、`tls_server_cert_sha256`）。
- 示例里的 IP、域名、端口 `18443` 仅为示例，换成客户实际值。端口选一个未被占用的（用 `ss -ltn` 确认）。

**(2) 加一个独立端口的 TLS 入口，并让 API 读到证书。** 在 lse 安装目录（有 `docker-compose.yml` 与 `.env` 的目录）新增两个文件。下面的服务名 `api`、`web` 镜像变量 `LSE_WEB_IMAGE`、API 容器内端口 `8090` 来自现有 `docker-compose.yml`。

`docker-compose.override.yml`：

```yaml
services:
  api:
    environment:
      FLEET_AGENT_ENABLED: ${FLEET_AGENT_ENABLED:-false}
      FLEET_PUBLIC_BASE_URL: ${FLEET_PUBLIC_BASE_URL:-}
      FLEET_TLS_CERT_PEM_PATH: /certs/fleet-server.crt
      # 一键安装（可选，见 deployment-quickstart.md）：探针包目录与终端下载地址
      FLEET_KIT_DIR: ${FLEET_KIT_DIR:-}
      FLEET_KIT_BASE_URL: ${FLEET_KIT_BASE_URL:-}
    volumes:
      - ./fleet-certs/fleet-server.crt:/certs/fleet-server.crt:ro
      - ./fleet-kits:/fleet-kits:ro
  fleet-tls:
    image: ${LSE_WEB_IMAGE:-lse-web:dev}
    container_name: lse-fleet-tls
    ports:
      - "${FLEET_HTTPS_PORT:-18443}:8443"
    volumes:
      - ./Caddyfile.fleet:/etc/caddy/Caddyfile:ro
      - ./fleet-certs/fleet-server.crt:/certs/fleet-server.crt:ro
      - ./fleet-certs/fleet-server.key:/certs/fleet-server.key:ro
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped
```

`Caddyfile.fleet`（只转发 `/agent/v1/*`，其余一律 404，不暴露管理接口和前端）：

```
{
	admin off
	auto_https off
}
https://:8443 {
	tls /certs/fleet-server.crt /certs/fleet-server.key
	@agent path /agent/v1/*
	handle @agent {
		reverse_proxy api:8090
	}
	handle {
		respond 404
	}
	log {
		output stdout
		format console
	}
}
```

`.env` 追加（按现场实际值；路径 `./fleet-certs` 要与上面挂载一致）：

```
FLEET_AGENT_ENABLED=true
FLEET_PUBLIC_BASE_URL=https://192.168.31.182:18443
FLEET_HTTPS_PORT=18443
LSE_ENDPOINT_EVAL_ENABLED=true
LSE_PUBLIC_BASE_URL=<见下文说明>
```

- 容器内的 Caddy 需要能读取私钥：私钥文件对容器内用户可读，同时把宿主上的 `fleet-certs/` 目录收紧到仅管理员可访问；不要把私钥放进镜像或仓库。具体的文件属主/权限组合**待确认**（测试时用的是文件 0644 的方式）。
- `LSE_PUBLIC_BASE_URL` 是被测智能体回传诱饵的落点地址（`/sink/*`），由**被测智能体**访问，而不是采集器。web 容器的 443 用的是 Caddy 内部 CA 证书，员工电脑默认不信任；如果走 HTTPS，智能体访问会因证书不受信失败。内网可用 `http://<主机>:<WEB_HTTP_PORT>`（代码允许 http）；采集器侧 bwrap 沙箱是否放行该出站、结果是否能被命中记录，**待确认**，请在测试终端先跑一次再交付。

**(3) 启动并确认**（不需要重新构建镜像；compose 会按新环境变量重建 `api` 容器并创建 `fleet-tls`）：

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
docker compose -f docker-compose.yml -f docker-compose.override.yml ps
```

确认点：

- `lse-fleet-tls` 在运行，宿主 `18443` 在监听。
- 用管理员账号登录鉴盾，查看部署信息接口 `GET /api/fleet/deployment-info`（需 `model_target:create` 权限）：`ready` 应为 `true`，`issues` 为空。常见 `issues`：未配置变量、证书不是自签、证书不在有效期、SAN 未覆盖主机、PEM 超 4096 字节、文件含私钥。
- `GET /api/fleet/deployment-info/tls-deployment.json` 下载的文件，其 `tls_server_cert_sha256` 应与 `fleet-gen-cert.sh` 输出的指纹一致。
- 未带令牌访问 `https://<主机>:18443/agent/v1/policy` 应得到 `401`（开关已开）。

**离线包安装的客户**：compose 文件由 `package-offline-bundle.sh` 生成（web 镜像为 `__WEB_IMAGE__` 占位后替换），服务名与端口与源码 `docker-compose.yml` 一致，override 的写法同样适用；但没有在离线包安装目录实测过，**待确认**。

### 2.4 证书到期与轮换

- 证书有效期内才能握手，到期后所有终端报 `connection_failed`。建议到期前 60 天开始轮换，并在客户运维日历里登记到期日（`openssl x509 -in fleet-server.crt -noout -enddate`）。
- **同主机、同端口**轮换：用 `fleet-gen-cert.sh --force` 生成新证书（`--server` 与原来完全一致，SAN 覆盖同样的主机），替换 `fleet-certs/` 里的文件，重启 `api` 与 `fleet-tls`；然后在**每台终端**用新的 `tls-deployment.json` 执行：

  ```bash
  sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> set-https \
    --kit <kit 目录> --server https://192.168.31.182:18443 --tls-config <新 tls-deployment.json>
  ```

  `set-https` 会先用**新**证书对 `GET /agent/v1/policy` 做一次认证请求，通过才保存；所以服务端必须先换好证书，再让终端执行。换证书的窗口内，尚未执行 `set-https` 的终端会暂时 `connection_failed`，换完即恢复，已排队的报告不丢。
- **换主机名/IP 或换端口**：`set-https` 不允许（主机必须相同，且端口必须相同），终端必须重新接入（§6.3）。所以首次规划时就把对终端的地址固定下来，优先使用域名并长期保持。

---

## 3. 反向代理 / 负载均衡注意事项

如果终端到鉴盾之间还有反向代理、负载均衡、WAF 或 API 网关：

1. **代理必须可信，且必须透传真实客户端 IP。** 服务端设置了 `trustProxy: true`（`app.ts`），来源 IP 取自 `X-Forwarded-For`，限流（按 IP 的 600/分钟与登记 20/分钟）和日志都用它。**因此 API 容器不能被终端直接访问**——否则任何人伪造 `X-Forwarded-For` 就能绕过按 IP 限流。compose 里 `api` 只 `expose` 8090、不发布端口，保持这个状态。
2. **代理必须覆盖而不是追加客户端自带的 `X-Forwarded-For`。** 实测（Caddy 2，默认配置）会把客户端发来的 `X-Forwarded-For: 6.6.6.6` 覆盖成真实对端 IP `127.0.0.1`；其他代理（Nginx、F5、云 LB 等）的行为**待确认**，上线前用 `curl -H 'X-Forwarded-For: 6.6.6.6'` 自测。
3. **代理的访问日志不要记录 `Authorization` 头。** 终端令牌、接入码都放在这个头里。实测 Caddy 的 `log` 默认把 `Authorization` 记为 `REDACTED`；Nginx 默认访问日志不含请求头，但自定义 `log_format` 若加了 `$http_authorization` 就会泄露。上线前对代理日志 grep 一遍。
4. **TLS 在哪里终止？** 采集器钉扎的是它**看到的**那张叶子证书。若 TLS 终止在 LB 上，LB 上的证书必须是 §2.2 的自签叶子证书，`tls_server_cert_sha256` 必须与 LB 实际出示的证书一致；若 LB 与 API 之间再走一层 HTTPS，那一层与终端无关，可按企业内部习惯处理。
5. **不要在代理上做重定向、改写路径或要求客户端证书**：采集器不跟随重定向（3xx 当作错误），不提供客户端证书。
6. **多副本时限流只在单进程内有效。** 令牌桶是每个 API 进程各自的内存计数（`fleet-agent/rate-limit.ts`）。N 个副本时，实际阈值约为配置值的 N 倍；需要严格限流时，在代理/WAF 层再做一层（按来源 IP 限制 `/agent/v1/endpoints/register`）。
7. 请求体上限：登记/心跳 64 KiB，体检报告 8 MiB，测评结果 2 MiB。代理的 `client_max_body_size` 等限制不得低于这些值，否则体检报告大的终端会被代理拒绝（`413`）。

---

## 4. 网络与防火墙

- **`/agent/v1/*` 只对终端网段开放。** 在宿主防火墙/安全组/网络策略上，只允许终端所在网段访问 `FLEET_HTTPS_PORT`（示例 18443）。终端只需要**出站**连这个端口，不需要入站监听。
- 管理接口 `/api/fleet/*` 走平台登录 JWT，应只通过现有管理入口（web 的 80/443）访问；不要经 `Caddyfile.fleet` 暴露（上文的配置已把其余路径固定为 404）。
- 终端 EDR/防火墙策略按 `--server` 里的端口放行出站（与采集器文档 `ENTERPRISE_LINUX.md` 的要求一致）。采集器不使用系统代理环境变量。

---

## 5. 终端侧安装

**推荐路径（不用看本章其余内容）**：在鉴盾「终端 → 接入终端」页签创建接入码，然后——

- **Linux**：复制卡片里的一条命令到终端执行（见 `deployment-quickstart.md`）。
- **Windows**：在卡片里选 Windows，下载安装包，双击运行并允许管理员权限；批量下发用 `安装包.exe /quiet` 静默安装（见 §5.3 与 `admin-api.md` §7）。

下面的 §5.0–§5.2、§5.4 是**手工安装**的参考，仅在一键路径不适用（无法联网下载探针包、macOS、需要逐步排错）时使用；页面上已不再提供手工安装的入口，需要时由现场工程师按本章操作。

### 5.0 先分清两件事：Linux 企业安装器暂不能直接用于鉴盾

读采集器安装器代码得到的结论（**未实机验证**）：

- `install-enterprise-linux.py` 的 `install` 内部调用 `platform-collector.py enroll` 时，只传 `--server` 与 `--token-stdin`，**没有传 `--tls-config`**。没有钉扎配置时，采集器按系统 CA 校验服务端证书，自签证书会失败（`connection_failed`）。
- Windows 安装器 `enterprise-install.ps1` 有 `-TLSConfigFile` 参数，可传 `tls-deployment.json`。
- macOS 安装器 `install-enterprise-macos.py` 的参数里没有 TLS 配置项（与 Linux 同样的问题），未实机验证。

因此 Linux 终端目前用**手工 enroll + 用户级服务**的路径（§5.1，也是协议规格与 `GET /api/fleet/deployment-info` 的 `installCommands` 采用的形态）。企业安装器要支持钉扎证书，需要采集器侧后续补一个 `--tls-config` 参数——这属于采集器仓库的改动，本指南不涉及，**待确认排期**。

### 5.1 Linux（手工登记）

前提：已有采集器 kit 目录（解压后的发布包，含 `tools/platform-collector.py`、`manifest.json`、`aiprobe` 等）；Python ≥ 3.8；已把 `tls-deployment.json` 拷到终端；接入码已在鉴盾创建（§6.1）。

```bash
# 1) 接入码写入只有本人可读的文件，不要放进命令行
umask 077
printf '%s\n' '<粘贴接入码>' > ~/jd-enroll.txt

# 2) 登记（接入码从标准输入读取，不出现在 ps/历史里）
python3 <kit 目录>/tools/platform-collector.py --state <状态目录> enroll \
  --kit <kit 目录> --server https://192.168.31.182:18443 \
  --tls-config <tls-deployment.json 路径> --token-stdin < ~/jd-enroll.txt
shred -u ~/jd-enroll.txt 2>/dev/null || rm -f ~/jd-enroll.txt
```

- `--server` 必须与 `tls-deployment.json` 里的 `server` 相同。
- 采集器的 `enroll` 只有 `--token-stdin`，没有 `--token-file`（`--token-file` 是企业安装器的参数）；用文件重定向到标准输入，效果相同，接入码不入命令行。
- 登记成功输出 `{"status": "enrolled", ...}`。状态目录里的 `endpoint.json` 保存终端令牌与钉扎证书，权限为私有，不要拷贝给别的终端。

**合并推荐的 `collector.json` 片段**（`enroll` 已生成该文件，不要覆盖其中的 `kit`、`allow_http`、`source_revision` 等字段）：

```bash
python3 - <state-dir>/collector.json <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c.update({"managed_config": False, "system_audit": False,
          "eval_jobs_enabled": True, "eval_user": "<登录用户>"})
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2)
PY
```

四项含义（协议规格 §7）：

| 键 | 取值 | 作用 |
|---|---|---|
| `managed_config` | `false` | 不再请求受管配置（鉴盾对该视图返回 404）。 |
| `system_audit` | `false` | 不产生系统审计报告（鉴盾不收 `behavior-reports`）。 |
| `eval_jobs_enabled` | `true` | 开启拉取测评任务。默认关闭；只想做配置体检就设为 `false` 或不设。 |
| `eval_user` | 登录用户名 | 真机测评以哪个本机用户的 HOME 运行。root 常驻服务必须指定；普通用户进程只能指定自己。 |

写入后，在**该终端**上执行一次采集验证：

```bash
python3 <kit 目录>/tools/platform-collector.py --state <状态目录> run --once
python3 <kit 目录>/tools/platform-collector.py --state <状态目录> status
```

正常情况下一个周期只有 4 个请求：`probe-reports`、`credential-deliveries`、`eval-jobs`（开了测评才有）、`heartbeat`。`credential-deliveries` 鉴盾固定返回 `{"items":[]}`，`status.json` 里不会留下错误。

**常驻运行**：按采集器 `COLLECTOR.md`，用 `python3 <kit>/tools/collector-service.py install --state <状态目录>` 安装用户级服务（Linux 为用户 systemd 服务，开机常驻需要该用户已有 linger；脚本不会提权或开启 linger）。用户级服务以登录用户身份运行，真机测评自然以该用户执行，不会以 root 启动智能体。若要让 root 常驻服务采集，需另行评估，本指南不展开，**待确认**。

### 5.2 真机测评的 root 前置条件（Linux）

真机测评在员工电脑上让本机真实的 Claude Code / Codex 执行提示词。必须满足：

1. `collector.json` 中 `eval_jobs_enabled: true`，且（root 服务时）`eval_user` 指向非 root 的登录用户。
2. **`/etc/agent-platform-managed/eval-registry.json` 必须由 root 创建：属主 root、权限 `0644`、普通文件（不能是符号链接）、内容是有效 JSON 对象。** 否则：采集器不会在心跳里上报 `eval_runner`，鉴盾侧「发起真机测评」会报 `FLEET_EVAL_RUNNER_UNAVAILABLE`；测试入口产生的结果会带 `registry_untrusted: true`。
3. registry 内容结构（摘自 `EVAL-RUNNER.md`，**`argv[0]` 与 `hookd_path` 必须是绝对路径**）：

```json
{
  "claude-code": {
    "argv": ["/usr/local/bin/claude", "-p", "--output-format", "stream-json", "--verbose"],
    "hookd_path": "/usr/local/lib/agent-platform/hookd",
    "prompt_via": "stdin",
    "env_passthrough": ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
  },
  "codex": {
    "argv": ["/usr/local/bin/codex", "exec", "--json"],
    "hookd_path": "/usr/local/lib/agent-platform/hookd",
    "prompt_via": "stdin",
    "env_passthrough": ["OPENAI_BASE_URL", "OPENAI_API_KEY"]
  }
}
```

   - 只登记终端上实际安装的产品；未登记的产品，任务会得到 `skipped`。
   - `hookd_path` 必须是 root 属主的可执行普通文件，且不能被组或其他用户写；未配置时不会注入拦截钩子，不能据此宣称钩子生效。
   - `env_passthrough` 只写变量**名**，不写凭据值；模型路由/认证所需变量需管理员显式列出，否则智能体拿不到。
4. 隔离方式取决于终端：Linux 有 bwrap 且探测成功时用 `bwrap`，否则降级为 `hook-only`（不是操作系统沙箱）；`hook_inactive` 表示钩子日志为空，鉴盾判 UNKNOWN，不判通过。
5. 终端要求 Python ≥ 3.8，同一时间最多执行一个任务。

### 5.3 Windows

**推荐：下载 Windows 安装包（内置接入码）。**

1. 「终端 → 接入终端」页签创建接入码，选 Windows，点「下载安装包（x64）」或「下载安装包（ARM64）」。
2. 把安装包拷到终端，**双击运行**，按提示允许管理员权限，安装为系统服务并自动登记。
3. 批量下发（EDR / 软件分发）：`安装包.exe /quiet` 静默安装。
4. 安装包**暂未做代码签名**：首次运行如果出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
5. 安装包里内置了接入码，按带密码的文件对待，不要通过聊天或公开网盘传播。

安装包只在服务端部署和探针包都满足条件时才能下载：服务地址是 `https` + **IP**、证书是自签叶子（`CA:FALSE`、SAN 恰好一个 IP）、探针包目录里有 `.exe` 且清单声明支持鉴盾（`setup_server_kinds` 含 `jiandun`）。不满足时按钮置灰并写明原因，完整规则见 `admin-api.md` §7.3、§7.4。

**真机测评**：Windows 终端与其他系统一样，**是否支持由终端上报的测评执行器决定**——终端本机装有 Claude Code 或 Codex，并在安装探针时开启测评，心跳里就会带上 `eval_runner`，鉴盾据此显示「支持真机测评」。没有上报的终端，界面提示「终端未上报真机测评能力：需要本机装有 Claude Code 或 Codex，并在安装探针时开启测评」，只能做配置体检。Windows 没有系统级沙箱，真机测评只依靠终端钩子拦截危险操作，报告中会如实标注。

**手工安装（参考，仅在不能用安装包时）**：用 `enterprise-install.ps1`，参数形态（来自脚本与 `ENTERPRISE_WINDOWS.md`）：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\enterprise-install.ps1 `
  -Action install -KitRoot . -ManifestSha256 <受信manifest散列> `
  -Server 'https://192.168.31.182:18443' -TLSConfigFile 'C:\secure\tls-deployment.json' `
  -EnrollmentCodeFile 'C:\secure\one-time-code.txt'
```

- 接入码文件为仅 SYSTEM/管理员可读的 UTF-8 单行文件，安装器读取后删除源文件；`-TLSConfigFile` 必须与 `-Server` 一致，且不能同时用 `-AllowHttp`。
- `collector.json` 的片段在 Windows 上默认设 `managed_config: false`、`system_audit: false`、`eval_jobs_enabled: false`（需要真机测评时再开）。位置在 `%ProgramData%\AgentPlatformCollector\state`。
- **手工路径本指南没有在 Windows 上实机验证**，且 `-TLSConfigFile` 对鉴盾自签证书的完整流程**待确认**。

### 5.4 macOS

- 安装器 `install-enterprise-macos.py` 的参数：`install|upgrade|rollback|uninstall|status|set-policy-key`、`--kit`、`--manifest-sha256`、`--server`、`--python`、`--token-file`、`--token-stdin`、`--adopt-state`、`--adopt-owner`、`--allow-http`、`--policy-public-key`。**没有 TLS 配置参数**，因此对鉴盾自签证书的接入方式与 Linux 相同的限制，需要手工 `platform-collector.py enroll --tls-config`。
- 真机测评 registry 路径：`/Library/Application Support/AgentPlatform/eval-registry.json`（要求同样是 root 属主、0644）；隔离用 `sandbox-exec`。
- **未实机验证**，上线前必须先在一台 macOS 测试机走通。

---

## 6. 日常运维

界面入口：前端路由 `/fleet`，三个页签「终端清单」「测评任务」「接入终端」（菜单名称待确认）。地址栏 `?tab=endpoints|jobs|enroll` 可直接打开对应页签，评估对象页、评估方案里的「接入终端」入口都指向 `/fleet?tab=enroll`。

### 6.1 接入码

- 创建：「接入终端」页签，填写标签、有效期（1–168 小时，默认 24）、使用次数上限（1–1000，默认 1）。**明文只在创建时显示一次**，库里只存 SHA-256 与前 8 位前缀。创建后卡片直接给出 Linux 命令和 Windows 安装包下载按钮；Windows 安装包里内置了接入码，同样要妥善保管。
- 管理：列表按状态过滤（`ACTIVE`/`EXPIRED`/`REVOKED`/`EXHAUSTED`）；不含明文与哈希。
- 撤销：「撤销」按钮（接口 `POST /api/fleet/enrollment-codes/:id/revoke`，幂等）。撤销只影响**尚未登记**的终端；已登记的终端令牌不受影响，要让它失效必须吊销终端（§6.2）。
- 过期：到期自动失效，列表里显示 `EXPIRED`。
- 次数上限按批量设备数设置；新终端占用配额，同一终端重试（相同 `installation_id`）不重复占用。
- 登记被拒（403）的所有原因（无效/过期/撤销/已满/终端已吊销）对外是同一个应答，排查时看接入码状态与终端清单。

### 6.2 终端吊销与重新接入

- **吊销**：终端清单里选中终端点「吊销」（`POST /api/fleet/endpoints/:id/revoke`）。令牌立即失效；排队中的任务变 `CANCELLED`，已下发/执行中的任务变 `FAILED(endpoint_revoked)`。
- 被吊销的终端，采集器会报 `credential_rejected`，不会自行恢复。
- **重新接入（或换服务端）**：必须先清除本地采集器状态目录，再用新的接入码登记。原因：
  - 状态目录里有 `endpoint.json`，再 `enroll` 会得到 `already_enrolled`；
  - 状态目录里的 `installation.json` 保存 `installation_id`，服务端对**已吊销终端的原 `installation_id`** 重新登记一律返回 403；清除目录才会生成新的 `installation_id`。

  步骤（Linux 用户级服务示例）：停止采集器服务（`collector-service.py uninstall --state <状态目录>`）→ 备份并移走整个状态目录（`mv <状态目录> <状态目录>.old`）→ 重新执行 §5.1 的 `enroll`（新接入码）→ 合并 `collector.json` 片段 → 重新安装服务。旧状态目录确认无用后再按留存策略删除。

### 6.3 迁移到智能体安全平台（或反向）

按设计稿的规则，一台终端同一时刻只听一个服务端：先在鉴盾吊销该终端（§6.2），停止服务并移走状态目录，再用目标平台的接入码和该平台自己的登记流程重新登记。鉴盾里该终端的历史体检与测评记录保留。联动版（情形 3）里，鉴盾通过连接器复用智能体安全平台的终端，不再直连。

### 6.4 发起真机测评与任务

流程：配置体检直接生成结论；真机测评由有管理权限的账号**直接发起，立即下发，不需要另一位管理员审批**。

1. 管理员在终端清单（或终端详情）点「真机测评」，选择产品（`claude-code` 或 `codex`），可选填「备注」（不填记为「管理员发起」），点「开始测评」。任务**直接进入 `QUEUED`**，发起人同时记为批准人，提示「已下发，等待终端领取」。创建前提：终端 `ACTIVE`、心跳上报了 `eval_runner`、最后在线不超过 24 小时、终端没有未结束任务（`QUEUED`/`DELIVERED`/`RUNNING`，以及遗留的 `PENDING_APPROVAL`）。需要 `model_target:create` 与 `eval_task:create` 两项权限，另需 `web_ai` 授权特性。
2. 终端下一次拉取（约每分钟）领取，随后 `DELIVERED` → `RUNNING` → `COMPLETED`/`FAILED`。进度在「测评任务」页签查看。
3. **任务无法远程中止**：只有 `QUEUED`（以及遗留的 `PENDING_APPROVAL`）可以取消；`DELIVERED`、`RUNNING` 返回 409（`FLEET_JOB_NOT_CANCELLABLE`），只能等它结束或超时。极端情况下可吊销终端，已执行中的任务会记为 `FAILED(endpoint_revoked)`，但终端上已经启动的智能体进程不会因此被服务端杀掉。
4. **过期是惰性的**：排队中的任务超过 deadline（默认创建后 24 小时）后，在下一次有人查询相关列表/详情时才被置为 `EXPIRED`（评估任务描述为「任务已过期，终端未领取」）。界面上看到的状态在查询前可能仍是旧的。
5. 每次状态变化都会写审计日志（`fleet.*`）并同步到对应评估任务的描述。
6. **升级前遗留的待批准任务**：旧版本创建、仍停在 `PENDING_APPROVAL` 的任务在「测评任务」里继续显示「批准 / 驳回」，任何有 `model_target:create` 的账号（包括发起人本人）都可以批准，驳回必须填原因。不再有「申请人与审批人必须是两个账号」的限制，`FLEET_SELF_APPROVAL` 错误码已取消。不处理的话它们会在 deadline 后过期。

### 6.5 看结果与注意事项

- 配置体检：终端详情的「配置体检」结果（`GET /api/fleet/endpoints/:id/posture` 的判定；`posture-eval` 会落库成一个已完成的评估任务）。没有体检报告时返回 409 `FLEET_NO_PROBE_REPORT`。采集器默认 900 秒采集一次，新接入后可 `run --once` 立即触发。
- 真机测评：结果走与现有「终端智能体测评」相同的入库路径，在对应评估任务里查看。
- **结果为 `registry_untrusted` 时，不计入正式结论。** 它表示该次测评用的是测试入口（放宽了 root 属主检查的 registry）。界面会标注「终端测评配置未经根用户签发（仅测试环境）」。正式交付前确认 registry 是 root 属主 0644 的正式文件。
- `isolation: hook_inactive` 判 UNKNOWN，不能当作通过。
- 终端上没有上报已安装智能体（`agents` 为空）时，服务端不做推断，不阻止创建；已上报但没有对应产品时返回 `FLEET_PRODUCT_UNAVAILABLE`。当前版本采集器还不上报这一项（`admin-api.md` §3）。

---

## 7. 上线前安全清单

逐项勾选，未完成不要开 `FLEET_AGENT_ENABLED`。

- [ ] **开关默认关闭**：`FLEET_AGENT_ENABLED` 平时为 `false`，只在需要时开启；不用时关掉并 `up -d`。
- [ ] **令牌/接入码只存哈希**：服务端实现如此（`sha256`，明文仅签发时返回一次）。现场确认：数据库备份、日志、工单、聊天里没有接入码与终端令牌明文。
- [ ] **`/agent/v1/*` 只对终端网段开放**：防火墙/安全组仅放行终端网段访问 `FLEET_HTTPS_PORT`；`Caddyfile.fleet` 只转发 `/agent/v1/*`；API 容器不发布端口。
- [ ] **限流与反向代理可信转发**：确认代理覆盖 `X-Forwarded-For`（§3 第 2 条），多副本时在代理层补充限流。
- [ ] **日志脱敏检查**：对代理/Caddy/网关日志 grep 一遍，确认没有 `Authorization` 值、接入码（`jdc_` 前缀）、终端令牌（64 位 hex 串）。服务端 `/agent/v1` 的日志不记录请求头和请求体，登记响应体也不进日志；但外层代理的日志要自己查。
- [ ] **证书与私钥**：私钥只在 TLS 终止处，权限 0600/容器只读挂载；`FLEET_TLS_CERT_PEM_PATH` 指向的文件不含私钥；证书到期日已登记提醒。
- [ ] **备份**：数据库（含终端、令牌哈希、任务、报告表）、`fleet-certs/` 证书与私钥、`.env` 都在客户备份范围内；恢复演练时确认证书与端口不变（否则终端要重新接入）。
- [ ] **权限最小化**：管理接入码、发起真机测评、下载 Windows 安装包的账号（`model_target:create`）仅限终端管理员——**去掉审批后，这个权限就是唯一的把关点**；审计日志 `fleet.*`（含 `fleet.eval_job.create`、`fleet.installer.download`）有人定期查看。
- [ ] **真机测评等同于「远程让智能体在员工电脑上执行提示词」**：智能体使用员工真实 HOME 与凭据，bwrap 下仍可联网。**管理员账号管控与审计必须落实**——发起前先在任务详情里读场景提示词与夹具，不要批量盲发；checksum 只能防传输篡改，**不是签名**，鉴盾服务端被攻破就能让所有已接入终端执行任意提示词。服务端安全、数据库访问、管理员账号管理按此风险等级对待。
- [ ] **隐私红线**：不接收源码、对话正文；服务端不访问请求里出现的任何 URL/路径；上线前告知员工并取得客户内部授权（法务/合规由客户负责）。
- [ ] **仅在经过授权的终端登记**，不要在未告知的员工电脑上安装采集器。

---

## 8. 故障排查

先看终端 `status` 的输出（`status.json` 位于状态目录，不含凭据）。`last_error` 是主周期错误，`last_eval_job_error` 是测评周期错误。下表依据协议规格 §0、§5.5、§7 与采集器代码（`platform-collector.py` 的 `MESSAGES` 与 `eval_job_cycle`）。

| 现象/取值 | 字段 | 含义 | 处置 |
|---|---|---|---|
| `connection_failed` | `last_error` | 连不上服务端、TLS 握手失败、服务端 5xx | 先查网络与端口；再查证书：是否自签叶子（CA 签发会失败）、SAN 是否覆盖 `--server` 主机、是否过期、钉扎指纹是否与服务端实际出示的一致；代理是否在重定向。 |
| `credential_rejected` | `last_error` | 401/403：终端令牌被吊销/无效，或登记时接入码被拒 | 登记时：检查接入码是否有效/未过期/未满，是否复用了已吊销终端。运行中：终端被吊销，按 §6.2 重新接入。 |
| `report_rejected` | `last_error` | 4xx（除 401/403）：报告被拒；也出现在未实现端点返回 404 的场景 | 看是否升级了采集器而协议不兼容；若是 `behavior-reports`、`managed-config` 等，检查 `collector.json` 是否按 §5.1 关闭 `system_audit`/`managed_config`；报告会保留在 outbox 重试。 |
| `invalid_response` | `last_error`/`last_eval_job_error` | 服务端返回了非 200、空体或非 JSON（例如代理插入了 HTML 错误页，或服务返回 201） | 检查代理是否改写了响应；直接用 `curl -k` 访问 `/agent/v1/policy` 看返回；确认没有 3xx 重定向。 |
| `enrollment_uncertain` | 登记时 | 登记请求可能已被服务端受理，但本地没拿到完整凭据 | 保留 `installation.json`，**不要清目录**；先到鉴盾终端清单看是否已出现该终端；确认未出现则按原命令重试（同一 `installation_id` 幂等，不重复占配额）。 |
| `already_enrolled` | 登记时 | 该状态目录已有 `endpoint.json` | 不是错误：说明已登记。要换服务端或重新接入，按 §6.2 清除状态目录。 |
| `machine_mismatch` | `last_error` | 采集机器与登记时的机器不一致 | 状态目录被复制到别的机器；不要复制 `endpoint.json`/`installation.json`，更换机器应重新登记。 |
| `kit_mismatch` | `last_error`/`last_eval_job_error` | 采集组件与交付清单不一致（文件被改、版本不一致、runner 哈希不符） | 重新从受信渠道取 kit 校验 SHA-256 后覆盖；不要手改 kit 目录内文件。 |
| `queue_full` | `last_error` | 离线队列已满（资产队列 128 份/64 MiB 等），暂停采集 | 先修复上传失败的根因（通常是上面的连接/证书问题），队列会自动清空。 |
| `insecure_transport` | `last_eval_job_error` | 测评周期要求钉扎的 HTTPS，但当前登记没有钉扎配置，或开了 `allow_http` | 重新登记并带 `--tls-config`（§5.1）；测评不能走明文或未钉扎连接。 |
| `invalid_checksum` | `last_eval_job_error` | 终端本地计算的任务 checksum 与服务端下发的不一致；终端**不 ack**，下个周期重拉同一任务 | 持续出现说明服务端存储的任务 payload 被改动或规范化实现有偏差（服务端已在下发前自检，不一致的任务会被跳过不下发）；联系研发并提供任务 ID。 |
| `expired` | `last_eval_job_error` | 任务 `deadline` 已过，终端不 ack | 任务已过期，服务端会惰性置 `EXPIRED`；重新发起即可。 |
| `pending_discarded:404` / `:409` / `:410` | `last_eval_job_error` | 回传结果时服务端返回 404/409/410，终端丢弃该待传结果 | 通常是任务已过期、状态不对或已被置为失败（结果校验不合格也返回 409，任务记为 `FAILED(invalid_result)`）。看鉴盾侧该任务的状态与 `errorCode`。 |
| 回传结果被服务端返回 400/422/500/超时 | — | 终端按 `min(3600, 2^n)` 秒退避重传，最多 20 次后丢弃，**期间这台终端不领取新任务**（累计约 10 小时） | 服务端对格式不合格的结果按设计返回 409 而不是 400；若出现持续 5xx，先恢复服务。 |
| `eval_worker_failed` | `last_eval_job_error` | 后台执行进程异常退出 | 到终端看服务日志/磁盘空间，必要时移走状态目录里的 `eval-result-pending.json` 与 `eval-job.lock`（先确认无进程在运行）。 |
| `eval_runner_failed` / `eval_result_too_large` | 结果中的场景错误 | runner 无法启动、结果超过 2 MiB | 检查 registry 路径与可执行文件；`eval_runner_failed` 说明 registry 不可信或不可读。 |
| 鉴盾提示 `FLEET_EVAL_RUNNER_UNAVAILABLE` | 服务端 | 心跳未上报 `eval_runner`：`eval_jobs_enabled` 未开，或 registry 不是 root 属主 0644 | 按 §5.2 检查 registry 的属主/权限/路径与 JSON 有效性；registry 是符号链接、非 root 属主、非 0644 都会被拒绝。 |
| 鉴盾提示 `FLEET_ENDPOINT_OFFLINE` | 服务端 | 终端离线超过 24 小时 | 恢复采集器运行后再发起。 |
| 鉴盾提示 `FLEET_JOB_IN_PROGRESS` | 服务端 | 该终端已有未结束的任务 | 等待结束，或取消处于排队中的任务。 |
| 鉴盾提示 `FLEET_CODE_UNUSABLE` | 服务端 | 下载 Windows 安装包时接入码不存在 / 已过期 / 已用完 / 已撤销 | 按提示重新创建接入码。 |
| 鉴盾提示 `FLEET_DEPLOYMENT_NOT_READY` | 服务端 | 部署信息不满足 Windows 安装包的要求（服务地址不是 https + IP、证书不满足安装器规则等），`message` 列出全部原因 | 按 `admin-api.md` §7.3 修正服务地址或重新签发证书。 |
| 鉴盾提示 `FLEET_INSTALLER_UNAVAILABLE` | 服务端 | 探针包不支持鉴盾安装包，或探针包目录缺少 / 校验不过 Windows 安装包 | 按 `admin-api.md` §7.4 更新探针包目录。 |
| `/agent/v1/*` 全部 404 | 服务端 | `FLEET_AGENT_ENABLED` 不是 `true`，或请求没有打到 `Caddyfile.fleet` 的入口 | 检查环境变量与是否重新 `up -d`；在 web 的 80/443 上访问 `/agent/v1/*` 永远是前端页面，不是接口。 |
| 部署信息 `ready:false` | 服务端 | `issues` 列出原因 | 逐项修正：变量缺失、证书不是自签、过期、SAN 未覆盖主机、含私钥、PEM 过大。 |
| 429 | 服务端 | 触发限流 | 登记爆破、代理没透传真实 IP（所有终端同一来源 IP）会让阈值被大量终端共享；先检查 §3 第 1、2 条，再按需上调 `FLEET_AGENT_*_RATE_PER_MIN`。 |

---

## 9. 验证状态汇总

已验证（在 home 的一次性临时目录里做过，现已清理）：

- `scripts/fleet-gen-cert.sh`：生成证书与 `tls-deployment.json`、参数校验、不覆盖/`--force`、失败无残留；用 Python 校验指纹等于证书 DER 的 SHA-256、PEM ≤ 4096 字节且仅 1 张证书、键恰好 3 个；用采集器自己的 `tls_deployment`/`pinned_tls`/`PinnedHTTPSConnection` 对 `openssl s_server` 完成 TLS 1.3 握手并通过钉扎；用 Node `X509Certificate`（与服务端 `deployment.ts` 同一套检查）确认自签、非 CA、IP SAN 命中。
- Caddy 以自签叶子证书在独立端口对外提供服务，指纹与 `tls-deployment.json` 一致，采集器的 `request()` 可以钉扎连通（后端用的是本地替身，不是真实 lse API）；日志里 `Authorization` 为 `REDACTED`；客户端自带的 `X-Forwarded-For` 被覆盖。
- `docker compose -f docker-compose.yml -f docker-compose.override.yml config` 能合并 §2.3 的 override，环境变量与端口映射展开正确。

未验证 / 待确认：

- 完整的端到端流程（真实 lse API + `fleet-tls` + 真实终端登记、体检、测评）。
- `Caddyfile.fleet` 反代到真实 `api:8090` 的连通性（测试用的是替身后端）；容器内 Caddy 读私钥的属主/权限组合；离线包安装目录下的 override。
- Linux 企业安装器无 `--tls-config`（读代码得出）；Windows 手工 `-TLSConfigFile` 对鉴盾自签证书的完整流程；macOS 全部。
- Windows 安装包与真实探针安装器的端到端安装（鉴盾侧已用伪造 exe 验证尾部格式、预检规则与下载行为；真实安装器由探针仓库提供，联调待确认）。
- 其他反向代理（Nginx/F5/云 LB）对 `X-Forwarded-For` 的处理。
- `LSE_PUBLIC_BASE_URL` 推荐值与被测智能体的出站放行（HTTP/HTTPS 落点）。
- 前端菜单名称；采集器是否已校验接入码前缀与 `server_kind`。
