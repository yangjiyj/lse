# LSE x86_64 离线安装与升级

## 适用范围

- 64 位 x86 Linux，使用 systemd。
- 已在 Ubuntu 22.04 x86_64 验收。
- 需要 root 或 sudo 权限。
- 安装与升级过程不访问互联网，也不修改软件源。
- 不要求预装 Docker；安装包会在需要时部署自带的 Docker Engine 和 Compose v2。

## 安装和升级

先核对同目录校验文件，然后执行同一条命令：

```bash
sha256sum -c lse-x86-offline-<版本>.run.sha256
sudo bash lse-x86-offline-<版本>.run
```

首次执行会完成安装。以后执行新版 `.run` 文件会自动备份数据库、保留现有配置并原地升级。

成功后，终端会显示访问地址、管理员账号和初始密码文件位置。

## 日常运维

```bash
sudo lsectl status
sudo lsectl start
sudo lsectl stop
sudo lsectl restart
sudo lsectl backup
sudo lsectl diagnose
```

诊断文件由 `lsectl diagnose` 生成，敏感配置会脱敏。客户无需操作容器 ID、数据库字段或内部工程配置。

## 数据和配置

- 安装目录：`/opt/lse/platform`
- 配置文件：`/opt/lse/platform/.env`
- 初始凭据：`/opt/lse/platform/INITIAL_CREDENTIALS.txt`
- 数据库备份：`/opt/lse/platform/backups/`
- 升级日志：`/opt/lse/platform/upgrade-logs/`

PostgreSQL、Valkey 和 Docker Socket 不对外发布。Web 端口以安装成功后的终端输出为准。

### 模型文件扫描目录

- 把待扫描的模型（含 HuggingFace 缓存 `hub/` 目录）放到宿主机 `/opt/lse/models`，或在 `.env` 设置 `MODEL_SCAN_HOST_DIR=<宿主机目录>`；api 与 worker 以只读方式挂载到容器内 `/models`，目录需在启动前存在。
- 目录扫描白名单默认即 `/models`（`MODEL_SCAN_ROOTS`，逗号分隔的容器内路径），管理员在「模型文件扫描 → 目录扫描 → 管理目录」里添加的根与之取并集；页面会同时显示容器内路径和对应的服务器路径（`MODEL_SCAN_HOST_DIR`，compose 已同时传给 api 与 worker，与挂载用同一个变量）。
- 管理员只能添加已经挂载进容器的目录；要扫描服务器上别的目录，最简单的做法是把模型放进 `MODEL_SCAN_HOST_DIR`，或请运维把该目录只读挂载进来后再添加。`/`、`/proc`、`/sys`、`/dev`、`/etc` 等系统目录不允许添加。
- 单次扫描总量上限默认 1 TiB（最大可设 16 TiB），文件数上限默认 10000：目录扫描会把选中的每个文件完整读一遍来计算 SHA-256，读取速度取决于磁盘，几百 GB 的模型目录需要按磁盘速度预留相应时间。
- 浏览器上传单文件上限默认 2GiB（`MODEL_SCAN_UPLOAD_MAX_BYTES`），上传暂存在命名卷 `model_scan_uploads`，扫描结束即删除；更大的模型请走目录扫描。
- 扫描由 worker 后台执行，worker 未运行时任务停留在“排队中”。

## 不支持范围

本交付物不支持 ARM、32 位 Linux、非 systemd Linux、无 root 安装、Kubernetes 和 Windows。ARM 客户必须使用单独构建并真实验收的 ARM64 交付包。
