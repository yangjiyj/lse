#!/usr/bin/env bash
# package-arch-full-bundle.sh — 把「LSE 核心包 + 架构匹配的静态 docker + 架构匹配的镜像」
# 拼成一个按架构命名的离线全包。发行版无关（docker 走静态二进制），仅按 CPU 架构分包。
#
# 用法:
#   scripts/package-arch-full-bundle.sh \
#     --arch x86_64|aarch64 \
#     --core-dir <lse-platform 核心包目录> \
#     --docker-pack <docker-offline 静态包目录(含 ARCH/install-docker.sh/docker-engine/cli-plugins)> \
#     [--images <该架构的 lse-core-images.tar.gz；不给则沿用 core-dir 里的>] \
#     --out-dir <输出目录> [--name <包名>] [--commit <短哈希>]
#
# 试用授权：核心包 .env 模板已置 LICENSE_ENFORCE=true，首次安装自动 90 天全功能试用，到期提示导入正式授权。
set -Eeuo pipefail

ARCH="" CORE_DIR="" DOCKER_PACK="" IMAGES="" OUT_DIR="" NAME="" COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="${2:?}"; shift 2;;
    --core-dir) CORE_DIR="${2:?}"; shift 2;;
    --docker-pack) DOCKER_PACK="${2:?}"; shift 2;;
    --images) IMAGES="${2:?}"; shift 2;;
    --out-dir) OUT_DIR="${2:?}"; shift 2;;
    --name) NAME="${2:?}"; shift 2;;
    --commit) COMMIT="${2:?}"; shift 2;;
    *) echo "[error] 未知参数: $1" >&2; exit 2;;
  esac
done
: "${ARCH:?--arch 必填}" "${CORE_DIR:?--core-dir 必填}" "${DOCKER_PACK:?--docker-pack 必填}" "${OUT_DIR:?--out-dir 必填}"
[ -d "$CORE_DIR" ] || { echo "[error] core-dir 不存在: $CORE_DIR" >&2; exit 1; }
[ -f "$DOCKER_PACK/install-docker.sh" ] || { echo "[error] docker-pack 无 install-docker.sh: $DOCKER_PACK" >&2; exit 1; }
PACK_ARCH="$(cat "$DOCKER_PACK/ARCH" 2>/dev/null || echo '?')"
[ "$PACK_ARCH" = "$ARCH" ] || { echo "[error] docker-pack 架构($PACK_ARCH) 与 --arch($ARCH) 不一致" >&2; exit 1; }

[ -n "$COMMIT" ] || COMMIT="$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo nogit)"
[ -n "$NAME" ] || NAME="lse-offline-full-${ARCH}-$(date +%Y%m%d)-${COMMIT}"

stage="$OUT_DIR/$NAME"
echo "[step] staging -> $stage"
rm -rf "$stage"; mkdir -p "$stage"
cp -a "$CORE_DIR" "$stage/lse-platform"

if [ -n "$IMAGES" ]; then
  [ -f "$IMAGES" ] || { echo "[error] images 不存在: $IMAGES" >&2; exit 1; }
  echo "[step] 替换镜像 tar 为 $ARCH 版并重算双校验和"
  cp -f "$IMAGES" "$stage/lse-platform/images/lse-core-images.tar.gz"
  ( cd "$stage/lse-platform/images" && sha256sum lse-core-images.tar.gz > checksums.sha256 )
  newsum="$(sha256sum "$stage/lse-platform/images/lse-core-images.tar.gz" | awk '{print $1}')"
  if [ -f "$stage/lse-platform/checksums.sha256" ]; then
    sed -i -E "s#^[0-9a-f]{64}(  \./images/lse-core-images\.tar\.gz)\$#${newsum}\1#" "$stage/lse-platform/checksums.sha256"
  fi
fi

echo "[step] 放入架构匹配的 docker-offline 静态包"
cp -a "$DOCKER_PACK" "$stage/docker-offline"

cat > "$stage/README-先看这里.txt" <<TXT
大模型安全评估平台 — 离线全包（$ARCH · 发行版无关）
================================================================
适用系统：任意带 systemd 的 Linux（Ubuntu 22.04/24.04/26.04、openEuler、麒麟 Kylin、CentOS 等）
适用架构：$ARCH  ——  仅按 CPU 架构分包；装错架构 install-docker.sh 会明确报错

安装步骤
----------------------------------------------------------------
1) 若目标机没有 Docker：
     cd docker-offline
     sudo sh install-docker.sh
   （静态二进制离线安装 Docker 引擎 + Compose v2；docker version && docker compose version 能打印即成功）

2) 安装平台：
     cd ../lse-platform
     sudo ./install.sh
   安装完成后 INITIAL_CREDENTIALS.txt 里是初始管理员密码。

授权说明（重要）
----------------------------------------------------------------
* 首次安装自动进入 90 天全功能试用（无需导入 license）。
* 控制台「授权」页可见"试用期剩余 N 天"。
* 到期后转为未授权，提示"试用已到期，请导入正式授权"；届时导入正式 license 即恢复。

架构/系统对照
----------------------------------------------------------------
* 本包 = $ARCH。x86_64 适配 Intel/AMD/海光/兆芯；aarch64 适配鲲鹏/飞腾。
* 同一架构下，Ubuntu/openEuler/麒麟等不同系统都用这一个包，无需区分系统版本。
TXT

echo "[step] 打包 tar.gz + sha256"
tar czf "$OUT_DIR/$NAME.tar.gz" -C "$OUT_DIR" "$NAME"
( cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
rm -rf "$stage"
echo "[ok] 生成: $OUT_DIR/$NAME.tar.gz"
ls -la "$OUT_DIR/$NAME.tar.gz" "$OUT_DIR/$NAME.tar.gz.sha256"
