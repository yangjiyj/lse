# 现场排障说明

“AI 服务安全核验”的三种模式、固定制品和回滚边界见
[AI 服务安全核验离线运行手册](./service-assurance-offline.md)。

当离线机器部署后登录页打不开时，不要先反复重装。请在离线包目录执行诊断脚本，把生成的压缩包发回。

## 一键采集

```bash
cd /path/to/llm-safety-eval-platform-offline/customer
chmod +x diagnose.sh
./diagnose.sh
ls -lh lse-diagnostics-*.tar.gz
```

把最新生成的 `lse-diagnostics-*.tar.gz` 发回即可。

诊断脚本只在本机执行，不联网、不安装依赖。脚本会采集 Docker / Compose 状态、容器日志、端口监听、登录页和健康检查响应，并对常见密码、密钥、Token、许可证字段做脱敏。

诊断包还会收集默认核验模式和可选深度核验模式的状态与最近日志。若任一模式未就绪，应保留“核验未完成”或“覆盖不完整”状态，不能用核心服务健康替代模式就绪证据。

## 快速判断

```bash
docker compose --env-file .env ps
curl -k -i https://127.0.0.1:10443/api/health
curl -k -i https://127.0.0.1:10443/login
curl -i http://127.0.0.1:8090/login
```

- 本机 `curl` 能返回登录页，但其他电脑打不开：优先查服务器防火墙、客户网络 ACL、安全组、端口映射，放通 `8090/tcp` 和 `10443/tcp`。
- `https://服务器IP:10443/login` 支持使用服务器任意可达 IP 或主机名访问，不依赖安装时的固定地址。
- 浏览器提示证书不受信任：这是离线包内置本地证书的正常现象，先选择继续访问；继续后登录页必须正常显示，生产环境再替换为客户自己的证书。
- `/api/health` 不通：重点看 `api`、`migrate`、`postgres`、`valkey` 日志。
- 登录页 HTML 能返回，但页面空白：重点看静态资源是否 404、Web 容器日志、浏览器控制台报错。
- 容器没起来或一直重启：重点看镜像是否导入成功、`.env` 是否完整、端口是否被占用。

## 默认访问地址

- HTTP：`http://服务器IP:8090/login`
- HTTPS：`https://服务器IP:10443/login`

如果 `.env` 里改过 `WEB_HTTP_PORT` 或 `WEB_HTTPS_PORT`，以 `.env` 为准。
