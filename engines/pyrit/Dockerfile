# PyRIT sidecar 镜像。基于已缓存的 node:22-bookworm-slim（Docker Hub 直连在本环境被墙），
# 通过 apt 装 python3（bookworm=py3.11）+ 清华 pip 镜像装依赖。
# 注意：PyRIT 会拉取 torch/transformers 等重型 ML 依赖，镜像可达数 GB、构建较慢。
# 离线/受限环境可改用预构建镜像：PYRIT_IMAGE=<your-registry>/lse-pyrit:offline
FROM node:22-bookworm-slim AS pyrit
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY engines/pyrit/requirements.txt ./requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY engines/pyrit/report.py ./report.py
COPY engines/pyrit/app.py ./app.py
RUN chown -R node:node /app
USER node
EXPOSE 8093
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8093/health',timeout=3).status==200 else 1)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8093"]
