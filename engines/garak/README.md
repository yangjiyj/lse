# garak sidecar

把 [NVIDIA/garak](https://github.com/NVIDIA/garak)（Apache-2.0）的越狱 / 提示注入 /
数据泄漏等深度 probes 封装成**任务级**安全引擎 sidecar，供平台的 `garak` 引擎适配器
（`apps/api/src/modules/engines/garak.ts`）通过 HTTP 调用。

## 为什么是 sidecar（许可证与体积隔离）

garak 携带 **torch / transformers 等重型 ML 依赖**，体积可达数 GB。这些依赖：

- 只存在于本 sidecar 容器，**不进入闭源产品二进制**；
- 经 HTTP 接口与产品解耦，产品仓库只包含 TS 适配器（纯 HTTP 客户端）；
- 因此 garak 及其传递依赖的许可证不污染闭源产品（与 ai-infra-guard 同一隔离边界）。

产品默认**不启用**该引擎；需用户显式部署 sidecar 并打开开关。

## HTTP 契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | `{status, engine}` |
| `POST` | `/scan` | 入参 `{target:{base_url,api_key,model}, probes?, generations?, prompt_seeds?}`，返回 `{job_id}` |
| `GET` | `/scan/{job_id}` | 返回 `{state:'running'\|'done'\|'failed', report?, message?}` |

`report` 形状：

```json
{"probes": [
  {"probe": "dan.Dan_11_0", "detector": "mitigation.MitigationBypass",
   "total": 10, "passed": 6, "failed": 4, "failure_rate": 0.4}
]}
```

`failed>0`（或 `failure_rate>0`）的 probe 会被适配器判为 FAIL 风险项；全通过则汇总为一条 PASS。

## 代码结构

- `report.py` —— **纯 stdlib 逻辑核心**：把 garak `report.jsonl` 的 `eval` 行聚合成上述 `report` 形状。可在宿主机直接单测，与重型 ML 依赖解耦。
- `app.py` —— 薄 I/O 胶水：FastAPI 异步任务封装，子进程拉起 garak，结束后调用 `report.py` 聚合。
- `requirements.txt` / `Dockerfile` —— 容器化（node:22-bookworm-slim + apt python3 + 清华 pip 镜像）。

## 本地开发 / 测试

逻辑核心无需安装 garak / torch 即可测：

```bash
cd engines/garak
python3 -m unittest test_report test_seed_probe -v
```

平台 `prompt_seeds`（中文题库种子）会经 `seed_probe.py` 生成一个 garak 自定义 probe
（附加在标准 probe 之后）；生成逻辑可宿主机单测，真实 garak 加载需部署后端到端验证，
不可加载时 `app.py` 静默回退标准 probe。

## 在 Docker Compose 中启用

```bash
# 构建并启动 garak sidecar（独立 profile，默认不随主栈启动）
docker compose --profile garak up -d garak

# 打开开关后重启 api / worker，使其把 garak 纳入引擎选择
GARAK_ENABLED=true docker compose up -d api worker
```

任务创建时在 `engines[]` 勾选 `garak` 才会真正执行。

### 离线 / 受限环境

garak 镜像构建需联网拉取重型 ML 依赖。若构建机受限，可改用预构建镜像：

```bash
GARAK_IMAGE=<your-registry>/lse-garak:offline docker compose --profile garak up -d garak
```

> 说明：garak 真实扫描依赖可用的 GPU/CPU 算力与目标模型配额；本仓库已用 fake-sidecar
> 对 TS 适配器做了契约级测试，但**未在 CI 内跑真实 garak**（重型依赖 + 外呼模型）。
