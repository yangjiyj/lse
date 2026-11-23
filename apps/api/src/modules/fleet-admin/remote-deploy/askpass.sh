#!/bin/sh
# 远程部署（2.4.8）：ssh、ssh-add 通过 SSH_ASKPASS 取口令。口令只在部署进程给子进程的环境变量里，不落盘。
printf '%s\n' "$LSE_SSH_SECRET"
