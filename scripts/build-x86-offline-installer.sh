#!/usr/bin/env bash
set -Eeuo pipefail

CORE_DIR=""
DOCKER_PACK=""
OUTPUT=""
VERSION=""

usage() {
  cat <<'USAGE'
Usage: build-x86-offline-installer.sh --core-dir DIR --docker-pack DIR --output DIR --version VERSION
USAGE
}

while (($#)); do
  case "$1" in
    --core-dir) CORE_DIR="${2:?missing --core-dir value}"; shift 2 ;;
    --docker-pack) DOCKER_PACK="${2:?missing --docker-pack value}"; shift 2 ;;
    --output) OUTPUT="${2:?missing --output value}"; shift 2 ;;
    --version) VERSION="${2:?missing --version value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[error] unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ -d "$CORE_DIR" ]] || { echo "[error] core-dir not found: $CORE_DIR" >&2; exit 1; }
[[ -d "$DOCKER_PACK" ]] || { echo "[error] docker-pack not found: $DOCKER_PACK" >&2; exit 1; }
[[ -n "$OUTPUT" && -n "$VERSION" ]] || { usage >&2; exit 64; }
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || { echo '[error] unsafe version string' >&2; exit 1; }
[[ "$(cat "$DOCKER_PACK/ARCH" 2>/dev/null || true)" == x86_64 ]] || {
  echo '[error] docker-pack must declare ARCH=x86_64' >&2
  exit 1
}
for required in manifest.json manifest.sig manifest.pub image-lock.json checksums.sha256 install.sh upgrade.sh rollback.sh; do
  [[ -f "$CORE_DIR/$required" ]] || { echo "[error] core payload missing: $required" >&2; exit 1; }
done
[[ -x "$DOCKER_PACK/install-docker.sh" ]] || { echo '[error] docker pack missing executable install-docker.sh' >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/payload" "$OUTPUT"
cp -a "$CORE_DIR" "$TMP/payload/lse-platform"
cp -a "$DOCKER_PACK" "$TMP/payload/docker-offline"
tar -czf "$TMP/payload.tar.gz" -C "$TMP/payload" lse-platform docker-offline
PAYLOAD_SHA="$(sha256sum "$TMP/payload.tar.gz" | awk '{print $1}')"
RUN_FILE="${OUTPUT%/}/lse-x86-offline-${VERSION}.run"

cat >"$RUN_FILE" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PRODUCT='llm-safety-eval-platform'
VERSION='__VERSION__'
ARCH='x86_64'
PAYLOAD_SHA='__PAYLOAD_SHA__'
INSTALL_DIR='/opt/lse/platform'
MARKER='__LSE_PAYLOAD_BELOW__'

if [[ "${1:-}" == '--inspect' ]]; then
  printf 'product=%s\nversion=%s\narch=%s\nsha256=%s\n' "$PRODUCT" "$VERSION" "$ARCH" "$PAYLOAD_SHA"
  exit 0
fi

if [[ "${1:-}" == '--rollback' ]]; then
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || {
    echo '[失败] 回滚必须使用 root 运行' >&2
    exit 1
  }
  shift
  command -v lsectl >/dev/null 2>&1 || {
    echo '[失败] 未发现已安装的 lsectl' >&2
    exit 1
  }
  exec lsectl rollback "$@"
fi

if [[ "${1:-}" == '--diagnose' ]]; then
  shift
  command -v lsectl >/dev/null 2>&1 || {
    echo '[失败] 未发现已安装的 lsectl' >&2
    exit 1
  }
  exec lsectl diagnose "$@"
fi

die() { echo "[失败] $*" >&2; exit 1; }
step() { echo "[步骤] $*"; }

# openssl 可用性用实际能力探测判定：临时生成一对 RSA 2048 密钥，签一次、验一次。
# 不解析 openssl version 字符串，也不只看 command -v。
openssl_signing_usable() {
  command -v openssl >/dev/null 2>&1 || return 1
  local probe status=1
  probe="$(mktemp -d 2>/dev/null)" || return 1
  if printf 'lse-openssl-capability-probe\n' >"$probe/data" 2>/dev/null &&
    { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$probe/key.pem" >/dev/null 2>&1 ||
      openssl genrsa -out "$probe/key.pem" 2048 >/dev/null 2>&1; } &&
    openssl pkey -in "$probe/key.pem" -pubout -out "$probe/key.pub" >/dev/null 2>&1 &&
    openssl dgst -sha256 -sign "$probe/key.pem" -out "$probe/data.sig" "$probe/data" >/dev/null 2>&1 &&
    openssl dgst -sha256 -verify "$probe/key.pub" -signature "$probe/data.sig" "$probe/data" >/dev/null 2>&1; then
    status=0
  fi
  rm -rf "$probe"
  return "$status"
}

# 前置检查一次说清所有依赖，包括后面 upgrade.sh 才会用到的 openssl。
# openssl 缺失不拒绝安装，只提示本次将以降级模式安装。
check_runtime_dependencies() {
  command -v systemctl >/dev/null 2>&1 || die '仅支持使用 systemd 的 Linux'
  command -v tar >/dev/null 2>&1 || die '缺少 tar，无法解包'
  command -v gzip >/dev/null 2>&1 || die '缺少 gzip，无法解包'
  command -v sha256sum >/dev/null 2>&1 || die '缺少 sha256sum，无法校验交付物'
  if openssl_signing_usable; then
    step '已检测到可用的 openssl，本次将执行完整数字签名校验'
  else
    echo '[提示] 本机没有可用的 openssl 命令行工具（只装了 libssl 库不算）。'
    echo '[提示] 本次将以降级模式安装：跳过数字签名校验，改用 SHA-256 完整性校验，安装会正常继续。'
    echo '[提示] 载荷 SHA-256 与包内 checksums.sha256 校验仍然强制执行，校验不通过会立即终止安装。'
    echo '[提示] 如需完整防篡改验签，请先在本机安装 openssl 命令行工具，再重新运行本安装包。'
  fi
}

verify_payload_integrity() {
  PAYLOAD_LINE="$(awk -v marker="$MARKER" '$0 == marker { print NR + 1; exit }' "$0")"
  [[ -n "$PAYLOAD_LINE" ]] || die '安装包载荷边界损坏'
  tail -n +"$PAYLOAD_LINE" "$0" >"$TMP/payload.tar.gz"
  ACTUAL_SHA="$(sha256sum "$TMP/payload.tar.gz" | awk '{print $1}')"
  [[ "$ACTUAL_SHA" == "$PAYLOAD_SHA" ]] || die '载荷 SHA-256 校验失败'
}

# --check-env：不需要 root，装机前先看这台机器缺什么、本次会不会降级。
if [[ "${1:-}" == '--check-env' ]]; then
  check_runtime_dependencies
  exit 0
fi

# --verify-payload：不需要 root，单独校验载荷完整性（传输是否损坏、是否被改动）。
if [[ "${1:-}" == '--verify-payload' ]]; then
  command -v sha256sum >/dev/null 2>&1 || die '缺少 sha256sum，无法校验交付物'
  TMP="$(mktemp -d /tmp/lse-installer.XXXXXX)"
  trap 'rm -rf "$TMP"' EXIT INT TERM
  verify_payload_integrity
  echo '[完成] 载荷 SHA-256 校验通过'
  exit 0
fi

[[ "$(uname -m)" == x86_64 || "$(uname -m)" == amd64 ]] || die '本安装包仅支持 x86_64 Linux'
[[ "${EUID:-$(id -u)}" -eq 0 ]] || die '必须使用 root 运行：sudo bash lse-x86-offline-*.run'
check_runtime_dependencies

available_kb="$(df -Pk /opt 2>/dev/null | awk 'NR==2 {print $4}')"
[[ "${available_kb:-0}" -ge 8388608 ]] || die '安装目录可用空间不足 8 GiB'
[[ ! -L /opt/lse ]] || die '/opt/lse 不允许是符号链接'
[[ ! -L "$INSTALL_DIR" ]] || die "$INSTALL_DIR 不允许是符号链接"

TMP="$(mktemp -d /tmp/lse-installer.XXXXXX)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
verify_payload_integrity
tar -xzf "$TMP/payload.tar.gz" -C "$TMP"

docker_ready() {
  command -v docker >/dev/null 2>&1 &&
    docker compose version >/dev/null 2>&1 &&
    docker info >/dev/null 2>&1
}

if docker_ready; then
  step '复用本机已有 Docker Engine 与 Compose v2'
else
  step '未发现可用 Docker，安装包内 x86_64 离线运行时'
  (cd "$TMP/docker-offline" && bash ./install-docker.sh)
  systemctl daemon-reload
  systemctl enable --now docker >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do docker_ready && break; sleep 1; done
  docker_ready || die '包内 Docker 运行时安装后仍不可用'
fi

systemctl enable docker >/dev/null 2>&1 || die '无法设置 Docker 开机启动'

write_lsectl() {
  cat >/usr/local/bin/lsectl <<'CTL'
#!/usr/bin/env bash
set -Eeuo pipefail
DIR=/opt/lse/platform
cd "$DIR"
case "${1:-status}" in
  status) exec bash ./status.sh ;;
  start) exec docker compose --env-file .env up -d ;;
  stop) exec bash ./stop.sh ;;
  restart) docker compose --env-file .env restart; exec bash ./status.sh ;;
  backup) exec bash ./backup-db.sh ;;
  rollback) shift; exec bash ./rollback.sh "$@" ;;
  deep-start) exec docker compose --profile service-assurance-deep --env-file .env up -d service-assurance-zap ;;
  deep-stop) exec docker compose --profile service-assurance-deep --env-file .env stop service-assurance-zap ;;
  diagnose) exec bash ./diagnose.sh ;;
  *) echo '用法：sudo lsectl status|start|stop|restart|backup|rollback|deep-start|deep-stop|diagnose' >&2; exit 64 ;;
esac
CTL
  chmod 0755 /usr/local/bin/lsectl
}

mkdir -p /opt/lse
if [[ -f "$INSTALL_DIR/.env" ]]; then
  step "发现已有安装，进入原地升级：$INSTALL_DIR"
  (cd "$TMP/lse-platform" && bash ./upgrade.sh --install-dir "$INSTALL_DIR")
else
  step "首次安装到：$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -a "$TMP/lse-platform/." "$INSTALL_DIR/"
  (cd "$INSTALL_DIR" && bash ./install.sh)
fi

write_lsectl
step '执行安装后健康检查'
bash /usr/local/bin/lsectl status

host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
https_port="$(awk -F= '$1=="WEB_HTTPS_PORT" {print $2}' "$INSTALL_DIR/.env" | tail -1)"
echo
echo '安装或升级成功'
echo "访问地址：https://${host_ip:-服务器IP}:${https_port:-10443}/login"
echo '管理员账号：admin'
echo "初始密码文件：$INSTALL_DIR/INITIAL_CREDENTIALS.txt"
echo '状态检查：sudo lsectl status'
exit 0
__LSE_PAYLOAD_BELOW__
RUN

sed -i "s/__VERSION__/$VERSION/g; s/__PAYLOAD_SHA__/$PAYLOAD_SHA/g" "$RUN_FILE"
cat "$TMP/payload.tar.gz" >>"$RUN_FILE"
chmod 0755 "$RUN_FILE"
(
  cd "$OUTPUT"
  sha256sum "$(basename "$RUN_FILE")" >"$(basename "$RUN_FILE").sha256"
)
echo "[ok] installer: $RUN_FILE"
echo "[ok] checksum: $RUN_FILE.sha256"
