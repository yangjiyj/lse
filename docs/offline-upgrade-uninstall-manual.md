# 鉴盾 大模型安全评估平台离线部署升级与卸载手册

服务安全核验镜像、规则基线、漏洞库和三种模式的专门说明见
[AI 服务安全核验离线运行手册](./service-assurance-offline.md)。

本文用于客户现场或离线环境操作大模型安全评估平台。重点说明三件事：

- 新版离线包如何直接升级旧版部署。
- 旧版必须重装时如何先备份、再卸载。
- 旧安装目录丢失时如何按固定容器名清理残留资源。

## 先看结论

升级优先使用新版离线包里的升级入口，不要先卸载旧版本。

```bash
tar -xzf llm-safety-eval-platform-offline-*.tar.gz
cd llm-safety-eval-platform-offline-*
./upgrade.sh --install-dir /path/to/current-install
```

如果只是升级，**不要为了升级执行彻底卸载**，尤其不要执行会删除数据卷的命令。彻底卸载只用于以下场景：

- 旧版部署已经损坏，无法通过新版 `upgrade.sh` 接管。
- 现场明确要求清空数据后重装。
- 测试环境需要完全回到空白状态。

## 重要数据在哪里

离线部署至少有两类状态需要保护：

- 安装目录里的 `.env`：包含数据库密码、管理员初始配置、集成密钥和端口设置。
- Docker volume：默认是 `lse_pgdata` 和 `lse_valkeydata`，其中 `lse_pgdata` 是 Postgres 数据库。

因此，在任何卸载或清理动作之前，先完成数据库和 `.env` 备份。

## 判断当前该走哪条路

| 目标 | 推荐操作 |
| --- | --- |
| 首次安装 | 解压新版包后执行 `./install.sh` |
| 保留数据升级 | 执行 `./upgrade.sh --install-dir /path/to/current-install` |
| 临时停服 | 在安装目录执行 `docker compose --env-file .env down` |
| 停服但保留数据 | 新版包中执行 `./uninstall.sh` |
| 清空数据重装 | 备份后执行“旧版彻底卸载” |

## 找到旧版安装目录

如果你知道旧版离线包目录，直接进入该目录：

```bash
cd /path/to/旧版离线包目录
```

如果不确定目录，可以在常见位置查找带有 `lse-postgres` 的 Compose 文件：

```bash
find "$HOME" /opt /data -maxdepth 4 -name docker-compose.yml \
  -exec grep -l 'container_name: lse-postgres' {} \; 2>/dev/null
```

找到后进入 `docker-compose.yml` 所在目录。

## 升级流程

在新版离线包解压目录执行：

```bash
cd llm-safety-eval-platform-offline-*
./upgrade.sh --install-dir /path/to/current-install
```

脚本会做这些事：

1. 把新版脚本、Compose 文件、文档和镜像包复制到旧安装目录。
2. 保留旧安装目录里的 `.env`。
3. 自动执行 `./backup-db.sh` 备份数据库和 `.env`。
4. 校验并加载离线镜像。
5. 启动 Postgres/Valkey，执行数据库迁移。
6. 重建 api、worker、web 容器。

升级完成后检查：

```bash
cd /path/to/current-install
./status.sh
```

## 旧版彻底卸载

以下步骤会删除旧版容器和默认数据卷。执行前必须确认备份文件已经拿到。

### 1. 备份数据库和 .env

在旧版安装目录执行：

```bash
cd /path/to/旧版离线包目录
mkdir -p backups

docker compose --env-file .env up -d postgres

set -a
. ./.env
set +a

docker compose --env-file .env exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-lse}" -d "${POSTGRES_DB:-lse}" \
  > "backups/lse-${POSTGRES_DB:-lse}-$(date +%Y%m%d-%H%M%S).sql"

cp .env "backups/.env-$(date +%Y%m%d-%H%M%S)"
ls -lh backups
```

确认 `backups/` 里有 `.sql` 和 `.env-*` 文件后，再继续。

### 2. 停止并删除 Compose 资源

仍然在旧版安装目录执行：

```bash
docker compose --env-file .env down -v --remove-orphans
```

### 3. 清理固定名称残留

早期包使用了固定容器名。即使 Compose 已经 down，仍建议执行一次残留清理：

```bash
docker rm -f lse-web lse-api lse-worker lse-migrate lse-postgres lse-valkey 2>/dev/null || true
docker volume rm lse_pgdata lse_valkeydata 2>/dev/null || true
docker network rm lse_default 2>/dev/null || true
docker image rm lse-app:latest lse-web:latest 2>/dev/null || true
```

不要随手删除 `postgres:17-alpine` 和 `valkey/valkey:8-alpine`。这两个是基础镜像，可能被其他部署复用。只有确认该机器没有其他服务依赖时再删除：

```bash
docker image rm postgres:17-alpine valkey/valkey:8-alpine
```

### 4. 验证清理结果

```bash
docker ps -a | grep lse || true
docker volume ls | grep lse || true
docker network ls | grep lse || true
docker images | grep -E 'lse-app|lse-web' || true
```

如果以上命令没有输出，说明 LSE 相关容器、卷、网络和业务镜像已经清理干净。

## 旧安装目录丢失时的应急清理

如果旧版目录找不到，但容器还在，可以先用固定容器名备份默认数据库：

```bash
docker exec lse-postgres pg_dump -U lse -d lse > "lse-backup-$(date +%Y%m%d-%H%M%S).sql"
ls -lh lse-backup-*.sql
```

如果旧版曾经自定义 `POSTGRES_USER` 或 `POSTGRES_DB`，应先找到 `.env` 或从现场记录确认后再备份。默认离线包使用的是 `POSTGRES_USER=lse`、`POSTGRES_DB=lse`。

备份完成后再清理固定名称资源：

```bash
docker rm -f lse-web lse-api lse-worker lse-migrate lse-postgres lse-valkey 2>/dev/null || true
docker volume rm lse_pgdata lse_valkeydata 2>/dev/null || true
docker network rm lse_default 2>/dev/null || true
docker image rm lse-app:latest lse-web:latest 2>/dev/null || true
```

## 重装

清理完成后，使用新版离线包重新安装：

```bash
tar -xzf llm-safety-eval-platform-offline-*.tar.gz
cd llm-safety-eval-platform-offline-*
./install.sh
```

安装完成后查看状态：

```bash
./status.sh
```

首次安装会生成 `.env` 和 `INITIAL_CREDENTIALS.txt`。请妥善保存这两个文件，后续升级会继续复用 `.env`。

## 新版包自带的卸载脚本

新版包中 `./uninstall.sh` 默认只停止并删除容器，保留数据卷：

```bash
./uninstall.sh
```

只有明确要清空数据库和队列数据时，才使用下面的命令：

```bash
LSE_CONFIRM_DELETE_DATA=YES ./uninstall.sh --delete-data
```

这条命令会删除 Docker volume。执行前必须确认已经备份。

### 报告配置迁移与验收

新版安装默认使用 HTML 报告和镜像内 /opt/lse-chromium/chrome。
升级只自动修复旧安装生成的精确组合：REPORT_RENDERER=pdfkit（或 html）且
REPORT_CHROMIUM_PATH=/usr/bin/chromium。其它配置、凭据、自定义浏览器路径保持原样。
如需明确保留 PDFKit，可使用 REPORT_RENDERER=pdfkit 配合
REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome，该组合不会自动迁移。

迁移只记录这两项报告设置，随回滚快照校验。回滚仅在报告设置仍是自动迁移结果时恢复原值；
升级后另行修改的客户配置与凭据继续保留。
安装和升级健康检查后会用无敏感内容的报告模板执行真实 HTML → PDF 验收，
核对封面、结束页、Chromium 输出及分页；失败时安装命令明确失败，不以 PDFKit 替代验收。
显式选择 PDFKit 时仍会验证镜像内 HTML 能力，不改变所选渲染器。
