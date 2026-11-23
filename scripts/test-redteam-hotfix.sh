#!/usr/bin/env bash
# 红队热修包构建器契约测试（TDD：先于构建器写，验证产物行为）。
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDER="$ROOT_DIR/scripts/build-redteam-hotfix.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[fail] $*" >&2; exit 1; }
assert_contains() {
  local file="$1" value="$2"
  grep -Fq -- "$value" "$file" || fail "$file missing: $value"
}
assert_not_contains() {
  local file="$1" value="$2"
  ! grep -Fq -- "$value" "$file" || fail "$file unexpectedly contains: $value"
}

[[ -x "$BUILDER" ]] || fail "builder not executable: $BUILDER"

# 用 fake 镜像 tar + 签名 key 构造产物（不依赖真实 docker build）。
mkdir -p "$TMP/image"
echo "fake-lse-app-image-archive" >"$TMP/image/lse-app.tar"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP/signing.key" >/dev/null 2>&1
cat >"$TMP/image/manifest.json" <<'JSON'
{"schema":"redteam-hotfix/v1","product":"llm-safety-eval-platform","image":"lse-app:latest"}
JSON

VERSION="0.0.0-test"
bash "$BUILDER" \
  --image-tar "$TMP/image/lse-app.tar" \
  --image-name "lse-app:latest" \
  --image-manifest "$TMP/image/manifest.json" \
  --signing-key "$TMP/signing.key" \
  --sbom-source-dir "$TMP/image" \
  --output "$TMP/out" \
  --version "$VERSION"

RUN="$TMP/out/lse-redteam-adaptive-hotfix-${VERSION}-amd64.run"
[[ -x "$RUN" ]] || fail "run file not executable"
[[ -f "$RUN.sha256" ]] || fail "checksum missing"
(cd "$TMP/out" && sha256sum -c "$(basename "$RUN").sha256")

# --inspect 输出元信息
INSPECT="$TMP/inspect.txt"
bash "$RUN" --inspect >"$INSPECT"
assert_contains "$INSPECT" 'product=llm-safety-eval-platform'
assert_contains "$INSPECT" 'arch=x86_64'
assert_contains "$INSPECT" "version=$VERSION"
assert_contains "$INSPECT" 'payload_image=lse-app:latest'
assert_contains "$INSPECT" 'sha256='

# run 体内必须包含的行为门禁（grep 自解压引导器）
assert_contains "$RUN" '仅支持 x86_64'
assert_contains "$RUN" '必须使用 root'
assert_contains "$RUN" '载荷 SHA-256 校验失败'
assert_contains "$RUN" 'manifest'
assert_contains "$RUN" 'backup-db.sh'
assert_contains "$RUN" 'rollback'
assert_contains "$RUN" 'docker tag'
assert_contains "$RUN" 'docker compose'   # 重建 api/worker
assert_contains "$RUN" 'up -d --force-recreate --no-deps api worker'
assert_contains "$RUN" '/api/health'
assert_contains "$RUN" 'lse-app:latest'
# 安全：不内嵌私钥/密钥
assert_not_contains "$RUN" 'BEGIN RSA PRIVATE KEY'
assert_not_contains "$RUN" 'BEGIN PRIVATE KEY'

echo '[ok] 红队热修包构建器契约通过'
