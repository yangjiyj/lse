@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
call .venv\Scripts\activate.bat
python server.py --model models\qwen2.5-7b-instruct-q4_k_m.gguf --port 8000
pause
