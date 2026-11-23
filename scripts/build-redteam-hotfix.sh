#!/usr/bin/env bash
# 红队自适应恢复热修包构建器：产出 linux/amd64 自解压 .run，只替换 lse-app 镜像。
# 产物：lse-redteam-adaptive-hotfix-<version>-amd64.run + .sha256
set -Eeuo pipefail

IMAGE_TAR=""
IMAGE_NAME=""
IMAGE_MANIFEST=""
SIGNING_KEY=""
SBOM_SOURCE_DIR=""
OUTPUT=""
VERSION=""

usage() {
  cat <<'USAGE'
Usage: build-redteam-hotfix.sh --image-tar FILE --image-name NAME --image-manifest FILE \
  --signing-key FILE --sbom-source-dir DIR --output DIR --version VERSION
USAGE
}

while (($#)); do
  case "$1" in
    --image-tar) IMAGE_TAR="${2:?}"; shift 2 ;;
    --image-name) IMAGE_NAME="${2:?}"; shift 2 ;;
    --image-manifest) IMAGE_MANIFEST="${2:?}"; shift 2 ;;
    --signing-key) SIGNING_KEY="${2:?}"; shift 2 ;;
    --sbom-source-dir) SBOM_SOURCE_DIR="${2:?}"; shift 2 ;;
    --output) OUTPUT="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[error] unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ -f "$IMAGE_TAR" ]] || { echo "[error] image-tar not found" >&2; exit 1; }
[[ -n "$IMAGE_NAME" ]] || { echo "[error] image-name required" >&2; exit 1; }
[[ -f "$IMAGE_MANIFEST" ]] || { echo "[error] image-manifest not found" >&2; exit 1; }
[[ -f "$SIGNING_KEY" ]] || { echo "[error] signing-key not found" >&2; exit 1; }
[[ -d "$SBOM_SOURCE_DIR" ]] || { echo "[error] sbom-source-dir not found" >&2; exit 1; }
[[ -n "$OUTPUT" && -n "$VERSION" ]] || { usage >&2; exit 64; }
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || { echo '[error] unsafe version string' >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || { echo "[error] openssl required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "[error] sha256sum required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "[error] tar required" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/payload" "$OUTPUT"

# 载荷：镜像 tar + manifest + 签名 + sbom
safe_image="$(printf '%s' "$IMAGE_NAME" | sed 's#[/:@]#_#g')"
cp "$IMAGE_TAR" "$TMP/payload/${safe_image}.tar"
cp "$IMAGE_MANIFEST" "$TMP/payload/manifest.json"
openssl pkey -in "$SIGNING_KEY" -pubout -out "$TMP/payload/manifest.pub" >/dev/null 2>&1
openssl dgst -sha256 -sign "$SIGNING_KEY" -out "$TMP/payload/manifest.sig" "$TMP/payload/manifest.json"

# 镜像 SBOM：若 sbom-source-dir 含 .spdx.json 则取之，否则写一份 SBOM-MISSING 说明。
mkdir -p "$TMP/payload/sbom-images"
if ls "$SBOM_SOURCE_DIR"/*.spdx.json >/dev/null 2>&1; then
  cp "$SBOM_SOURCE_DIR"/*.spdx.json "$TMP/payload/sbom-images/" 2>/dev/null || true
elif command -v syft >/dev/null 2>&1; then
  syft "dir:$SBOM_SOURCE_DIR" -o spdx-json >"$TMP/payload/sbom-images/source.spdx.json" 2>/dev/null || true
fi
[[ "$(ls -A "$TMP/payload/sbom-images" 2>/dev/null)" ]] || \
  echo "SBOM unavailable: syft not found; source provenance = build context hash." >"$TMP/payload/sbom-images/SBOM-NOTE.txt"

tar -czf "$TMP/payload.tar.gz" -C "$TMP/payload" .
PAYLOAD_SHA="$(sha256sum "$TMP/payload.tar.gz" | awk '{print $1}')"
RUN_FILE="${OUTPUT%/}/lse-redteam-adaptive-hotfix-${VERSION}-amd64.run"

cat >"$RUN_FILE" <<RUN
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PRODUCT='llm-safety-eval-platform'
VERSION='__VERSION__'
ARCH='x86_64'
IMAGE_NAME='__IMAGE_NAME__'
PAYLOAD_SHA='__PAYLOAD_SHA__'
INSTALL_DIR='__INSTALL_DIR__'
MARKER='__LSE_HOTFIX_PAYLOAD_BELOW__'

if [[ "\${1:-}" == '--inspect' ]]; then
  printf 'product=%s\nversion=%s\narch=%s\npayload_image=%s\nsha256=%s\n' "\$PRODUCT" "\$VERSION" "\$ARCH" "\$IMAGE_NAME" "\$PAYLOAD_SHA"
  exit 0
fi

die() { echo "[失败] \$*" >&2; exit 1; }
step() { echo "[步骤] \$*"; }

[[ "\$(uname -m)" == x86_64 || "\$(uname -m)" == amd64 ]] || die '本热修包仅支持 x86_64 Linux'
[[ "\${EUID:-\$(id -u)}" -eq 0 ]] || die '必须使用 root 运行：sudo bash lse-redteam-adaptive-hotfix-*.run'
command -v docker >/dev/null 2>&1 || die '未找到 docker'
docker compose version >/dev/null 2>&1 || die '需要 docker compose v2'
command -v sha256sum >/dev/null 2>&1 || die '缺少 sha256sum'
command -v openssl >/dev/null 2>&1 || die '缺少 openssl'
command -v tar >/dev/null 2>&1 || die '缺少 tar'
command -v gzip >/dev/null 2>&1 || die '缺少 gzip'

[[ -f "\$INSTALL_DIR/.env" ]] || die "未找到安装目录 \$INSTALL_DIR/.env；请用 --install-dir 指定 LSE 安装目录"
[[ ! -L "\$INSTALL_DIR" ]] || die "\$INSTALL_DIR 不允许是符号链接"
available_kb="\$(df -Pk "\$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {print \$4}')"
[[ "\${available_kb:-0}" -ge 2097152 ]] || die '安装目录可用空间不足 2 GiB'

TMP="\$(mktemp -d /tmp/lse-hotfix.XXXXXX)"
cleanup() { rm -rf "\$TMP"; }
trap cleanup EXIT INT TERM
PAYLOAD_LINE="\$(awk -v marker="\$MARKER" '\$0 == marker { print NR + 1; exit }' "\$0")"
[[ -n "\$PAYLOAD_LINE" ]] || die '热修包载荷边界损坏'
tail -n +"\$PAYLOAD_LINE" "\$0" >"\$TMP/payload.tar.gz"
ACTUAL_SHA="\$(sha256sum "\$TMP/payload.tar.gz" | awk '{print \$1}')"
[[ "\$ACTUAL_SHA" == "\$PAYLOAD_SHA" ]] || die '载荷 SHA-256 校验失败'
tar -xzf "\$TMP/payload.tar.gz" -C "\$TMP"

# manifest 签名校验（嵌入公钥，无私钥）
openssl dgst -sha256 -verify "\$TMP/manifest.pub" -signature "\$TMP/manifest.sig" "\$TMP/manifest.json" >/dev/null || die 'manifest 签名校验失败'
echo "[ok] manifest 签名校验通过"

cd "\$INSTALL_DIR"

# 1) 备份数据库（失败即停）
step '调用 backup-db.sh 备份数据库'
bash ./backup-db.sh || die 'backup-db.sh 失败，已中止热修（数据库未改动）'

# 2) 给当前 lse-app 镜像建立不可变回滚标签
ROLLBACK_TAG="lse-app:rollback-pre-hotfix-\$(date +%Y%m%d-%H%M%S)"
OLD_IMAGE_ID="\$(docker images --filter 'reference=lse-app:latest' --format '{{.ID}}' | head -1)"
if [[ -n "\$OLD_IMAGE_ID" ]]; then
  docker tag "\$OLD_IMAGE_ID" "\$ROLLBACK_TAG" || die '无法建立回滚标签'
  echo "[回滚] 旧镜像已标签：\$ROLLBACK_TAG (id=\$OLD_IMAGE_ID)"
else
  echo "[警告] 未找到现有 lse-app:latest，跳过回滚标签"
fi

ROLLBACK_SH="\$INSTALL_DIR/rollback-hotfix.sh"
cat >"\$ROLLBACK_SH" <<RB
#!/usr/bin/env bash
# 回滚到热修前镜像：\$ROLLBACK_TAG
set -Eeuo pipefail
cd "\$INSTALL_DIR"
[[ -n "\$OLD_IMAGE_ID" ]] || { echo '[失败] 无旧镜像可回滚' >&2; exit 1; }
docker tag "\$ROLLBACK_TAG" lse-app:latest
docker compose --env-file .env up -d --force-recreate --no-deps api worker
echo "[ok] 已回滚到 \$ROLLBACK_TAG"
RB
chmod +x "\$ROLLBACK_SH"

# 3) 加载新镜像
step '加载新 lse-app 镜像'
docker load -i "\$TMP/${safe_image}.tar" || die 'docker load 失败'
NEW_IMAGE_ID="\$(docker images --filter 'reference=\$IMAGE_NAME' --format '{{.ID}}' | head -1)"

# 4) 只重建 api 与 worker
step '重建 api 与 worker'
rollback_and_die() {
  echo "[失败] \$*；正在自动回滚到旧镜像" >&2
  if [[ -n "\$OLD_IMAGE_ID" ]]; then
    docker tag "\$ROLLBACK_TAG" lse-app:latest || true
    docker compose --env-file .env up -d --force-recreate --no-deps api worker || true
  fi
  exit 1
}
docker compose --env-file .env up -d --force-recreate --no-deps api worker || rollback_and_die '重建 api/worker 失败'

# 5) 等待 api 健康（/api/health 门禁）
step '等待 api 健康（最长 120s）'
http_port="\$(awk -F= '\$1=="WEB_HTTP_PORT" {print \$2}' .env | tail -1)"
http_port="\${http_port:-8090}"
for _ in \$(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:\${http_port}/api/health" >/dev/null 2>&1; then
    echo "[ok] /api/health 健康"
    break
  fi
  if docker compose --env-file .env exec -T api node -e "fetch('http://127.0.0.1:8090/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "[ok] /api/health 健康（容器探针）"
    break
  fi
  sleep 2
done
curl -fsS --max-time 3 "http://127.0.0.1:\${http_port}/api/health" >/dev/null 2>&1 \
  || docker compose --env-file .env exec -T api node -e "fetch('http://127.0.0.1:8090/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 \
  || rollback_and_die 'api 健康检查超时'

echo
echo '热修成功'
echo "升级前镜像 ID：\${OLD_IMAGE_ID:-(无)}"
echo "升级后镜像 ID：\$NEW_IMAGE_ID"
echo "数据库备份：\$INSTALL_DIR/backups/"
echo "回滚命令：sudo bash \$ROLLBACK_SH"
exit 0
__LSE_HOTFIX_PAYLOAD_BELOW__
RUN

INSTALL_DIR_DEFAULT="/opt/lse/platform"
sed -i "s/__VERSION__/$VERSION/g; s/__IMAGE_NAME__/$IMAGE_NAME/g; s/__PAYLOAD_SHA__/$PAYLOAD_SHA/g; s#__INSTALL_DIR__#${INSTALL_DIR_DEFAULT}#g" "$RUN_FILE"
cat "$TMP/payload.tar.gz" >>"$RUN_FILE"
chmod 0755 "$RUN_FILE"
(
  cd "$OUTPUT"
  sha256sum "$(basename "$RUN_FILE")" >"$(basename "$RUN_FILE").sha256"
)
echo "[ok] 热修包: $RUN_FILE"
echo "[ok] 校验: $RUN_FILE.sha256"
