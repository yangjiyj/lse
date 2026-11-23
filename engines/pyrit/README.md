# PyRIT Sidecar（多轮自动化红队）

> 引擎归属：**二期 · 引擎增强（M13）**。kind = `task-level`（整模型扫描，不针对单条问答）。
> 上游：[microsoft/PyRIT](https://github.com/Azure/PyRIT)（Python Risk Identification Tool for LLMs，**MIT**）。

## 为什么做成 sidecar（而不是进 worker 进程）

PyRIT 携带重型 ML 传递依赖（torch / transformers / openai 等），整体可达数 GB。
若直接装进 Node worker 同机环境，会让闭源产品被迫吞下这些依赖与其许可证传递面。

因此采取**进程隔离 + HTTP 契约**：

- 重型依赖只存在于本 sidecar 容器内；
- 闭源产品侧只保留一个**纯 HTTP 客户端 TS 适配器**（`apps/api/src/modules/engines/pyrit.ts`），
  不 import 任何 PyRIT 代码，传递依赖不进入产品二进制；
- 默认关闭，需显式 `PYRIT_ENABLED=true` 且部署本 sidecar 才会被调用。

## HTTP 契约（异步任务式，被 `apps/api/test/pyrit-engine.test.ts` 锁定）

| 方法 | 路径 | 入参 / 出参 |
| --- | --- | --- |
| GET | `/health` | → `{"status":"ok","engine":"pyrit"}` |
| POST | `/scan` | `{target:{base_url,api_key,model}, strategies?, max_turns?, prompt_seeds?}` → `{"job_id":"..."}` |
| GET | `/scan/{job_id}` | → `{"state":"running"\|"done"\|"failed", "report"?, "message"?}` |

`report` 形状（由 `report.aggregate_report` 产出）：

```json
{
  "attacks": [
    {"objective":"...", "strategy":"red_teaming", "turns":3,
     "succeeded":true, "score":0.9, "last_response":"..."}
  ],
  "summary": {"total":2, "succeeded":1, "failure_rate":0.5}
}
```

**语义校准（与 garak 相反）：** PyRIT 的 `succeeded=true` 表示**攻击得手 = 模型被攻破**，
映射到平台侧即 **FAIL**；全部未得手 → 单条 PASS（`riskCategory=redteam_attack`，severity=INFO）。
（garak 是 probe 视角，无信号默认判模型失败；二者默认值刻意相反。）

## 代码结构

| 文件 | 角色 | 是否单测 |
| --- | --- | --- |
| `report.py` | 纯标准库逻辑核心：把 PyRIT 原始记录聚合成 `report` 形状 | ✅ `test_report.py` 6/6 |
| `app.py` | 薄 FastAPI I/O 胶水：异步任务表 + 驱动 PyRIT 编排器 | ⛔ 胶水层不单测（契约由 TS fake-sidecar 测试覆盖） |
| `Dockerfile` | 基于 `node:22-bookworm-slim` + apt python3 + 清华 pip 镜像 | — |
| `requirements.txt` | `fastapi` / `uvicorn` / `pyrit` 固定版本 | — |

逻辑核心（聚合 / 判定）走 TDD；I/O 胶水与编排驱动是薄层，由 TS 适配器的契约测试间接覆盖。

## 本地单测（逻辑核心）

```bash
cd engines/pyrit
python3 -m unittest test_report -v
```

## 在 Docker Compose 中启用

```bash
# 1) 构建并起 pyrit sidecar（独立 profile，默认不随主栈启动）
docker compose --profile pyrit up -d pyrit

# 2) 给 api / worker 开开关后重启，使其把 pyrit 纳入可选引擎
PYRIT_ENABLED=true docker compose up -d api worker
```

之后在任务的 `engines[]` 勾选 `pyrit` 即会触发多轮红队扫描。

## 对抗模型 / 打分模型

PyRIT 的多轮攻击需要一个**对抗模型**（生成攻击话术）和**打分模型**（判定是否得手）。
本 sidecar 默认**复用被测目标**充当对抗 / 打分模型（最省配置，但强度有限）。
生产建议用独立强模型，通过环境变量覆盖：

```bash
PYRIT_ADVERSARY_BASE_URL=https://api.example.com/v1
PYRIT_ADVERSARY_API_KEY=sk-xxx
PYRIT_ADVERSARY_MODEL=gpt-4o
```

## 离线 / 受限环境

本环境 Docker Hub 直连受限，PyRIT 又会拉取大体积 ML 依赖。可预构建镜像后注入：

```bash
PYRIT_IMAGE=<your-registry>/lse-pyrit:offline docker compose --profile pyrit up -d pyrit
```

离线镜像需自行完成 PyRIT 传递依赖的许可证审查（确保无 GPL/AGPL/SSPL 进入分发物）。

## 说明 / 边界

- 本仓库**未在 CI 内跑真实 PyRIT**（重型依赖 + 需外呼可达模型与配额）。
  `report.py` 已单测；`pyrit.ts` 适配器以 fake-sidecar 做契约级测试；
  `app.py` 的真实编排驱动需在具备算力 / 模型配额的环境验证。
- `app.py` 对 PyRIT 不同版本的结果对象做了防御式字段提取（`getattr` 兜底）；
  升级 `pyrit` 版本时建议复跑一次真实扫描确认字段映射仍然成立。
