# 安装推理环境（常见写法）
$ErrorActionPreference = "Stop"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
if (-not (Test-Path ".venv")) { python -m venv .venv }
& .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$url = "https://hf-mirror.com/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf"
Invoke-WebRequest -Uri $url -OutFile "models\qwen2.5-7b-instruct-q4_k_m.gguf"
$env:CUDA_VISIBLE_DEVICES = "0"
Start-Process -FilePath "python" -ArgumentList "server.py --port 8000" -NoNewWindow
Write-Host "done"
