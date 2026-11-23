# python-judge sidecar 镜像
# 说明：当前环境 registry-1.docker.io 不可达，但 node:22-bookworm-slim 已在本地缓存
# （主应用镜像同样基于它），故直接 FROM 它，再 apt 装 Debian bookworm 自带的 Python 3.11，
# pip 走清华镜像。仅安装纯 Python 依赖（FastAPI/Uvicorn/Pydantic），不引入 torch。
FROM node:22-bookworm-slim AS python-judge

ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY engines/python-judge/requirements.txt ./requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY engines/python-judge/scanner.py ./scanner.py
COPY engines/python-judge/app.py ./app.py
RUN chown -R node:node /app
USER node

EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8091/health',timeout=3).status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091"]
