#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export HF_ENDPOINT=https://hf-mirror.com
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
huggingface-cli download Qwen/Qwen2.5-7B-Instruct --local-dir ./model
exec python -m vllm.entrypoints.openai.api_server --model ./model --port 8000 --trust-remote-code
