#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[fail] $*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

for file in \
  sidecars/service-assurance/go.mod \
  sidecars/service-assurance/go.sum \
  sidecars/service-assurance/advisory.go \
  sidecars/service-assurance/advisory_test.go \
  sidecars/service-assurance/vendor/modules.txt \
  sidecars/service-assurance/gateway.go \
  sidecars/service-assurance/main.go \
  sidecars/service-assurance/policy.go \
  sidecars/service-assurance/runner.go \
  sidecars/service-assurance/Dockerfile.nuclei \
  sidecars/service-assurance/Dockerfile.trivy \
  sidecars/service-assurance/Dockerfile.zap \
  sidecars/service-assurance/versions.env \
  service-assurance/rules/nuclei/safe/http-security-headers.yaml \
  service-assurance/rules/nuclei/safe/triton-version-lead.yaml \
  service-assurance/rules/nuclei/deep/openapi-authorization-readonly.yaml \
  service-assurance/rules/zap/active-rules-2.16.1.txt \
  service-assurance/rules/zap/safe.conf \
  service-assurance/rules/zap/deep.conf \
  service-assurance/rules/manifest.json \
  service-assurance/vulndb/manifest.json \
  scripts/sign-service-assurance-artifacts.sh; do
  assert_file "$file"
done

grep -Eq '^# go\.etcd\.io/bbolt v1\.4\.3$' sidecars/service-assurance/vendor/modules.txt ||
  fail "vendor manifest must pin go.etcd.io/bbolt v1.4.3"
grep -Eq '^go\.etcd\.io/bbolt v1\.4\.3 ' sidecars/service-assurance/go.sum ||
  fail "go.sum must authenticate go.etcd.io/bbolt v1.4.3"
grep -Eq 'go -C sidecars/service-assurance test -mod=vendor ./\.\.\.$' "$0" ||
  fail "sidecar tests must use the vendored dependency graph"

env PATH=/usr/local/go/bin:$PATH GOPROXY=off \
  go -C sidecars/service-assurance test -mod=vendor ./...

for dockerfile in sidecars/service-assurance/Dockerfile.*; do
  if grep -E '^FROM ' "$dockerfile" |
    grep -Ev '^FROM [^ ]+:[^ @]+@sha256:[a-f0-9]{64}( AS [A-Za-z0-9_-]+)?$'; then
    fail "$dockerfile must pin every runtime image by tag and digest"
  fi
  ! grep -Eiq '(^|[/:])latest([ @]|$)' "$dockerfile" ||
    fail "$dockerfile must not use latest"
  ! grep -Eiq '\b(curl|wget|apk add|apt-get|dnf|yum)\b' "$dockerfile" ||
    fail "$dockerfile must not download runtime dependencies"
done

for manifest in service-assurance/rules/manifest.json service-assurance/vulndb/manifest.json; do
  jq -e '
    .schemaVersion == 1 and
    (.version | type == "string" and length > 0) and
    (.source.uri | type == "string" and length > 0) and
    (.source.manifestDigest | type == "string") and
    (.source.layerDigest | type == "string") and
    (.license | type == "string" and length > 0) and
    (.updatedAt | fromdateiso8601 > 0) and
    (.sha256 | test("^sha256:[a-f0-9]{64}$")) and
    (.files | type == "array" and length > 0) and
    .signature.required == true and
    .signature.algorithm == "rsa-sha256"
  ' "$manifest" >/dev/null || fail "invalid signed artifact manifest: $manifest"
done

grep -Eq '^RUN install -d -m 0755 /zap/wrk$' sidecars/service-assurance/Dockerfile.zap ||
  fail "ZAP image must provide its fixed work directory before the root filesystem becomes read-only"

grep -Eq '^HEALTHCHECK NONE$' sidecars/service-assurance/Dockerfile.zap ||
  fail "ZAP image must clear the inherited daemon health check; the orchestrator probes /healthz"

for config in service-assurance/rules/zap/safe.conf service-assurance/rules/zap/deep.conf; do
  awk -F "\t" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    NF < 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^(IGNORE|INFO|WARN|FAIL)$/ || $3 == "" { exit 1 }
  ' "$config" || fail "$config must use the three-column ZAP 2.16.1 policy format"
done

while IFS= read -r rule_id; do
  [[ -z "$rule_id" || "$rule_id" == \#* ]] && continue
  grep -Eq "^${rule_id}[[:space:]]+IGNORE[[:space:]]+[^[:space:]].*$" service-assurance/rules/zap/safe.conf ||
    fail "safe ZAP policy does not disable active rule $rule_id"
  grep -Eq "^${rule_id}[[:space:]]+(IGNORE|WARN)[[:space:]]+[^[:space:]].*$" service-assurance/rules/zap/deep.conf ||
    fail "deep ZAP policy does not close active rule $rule_id"
done <service-assurance/rules/zap/active-rules-2.16.1.txt

deep_enabled="$(awk '$2 == "WARN" { print $1 }' service-assurance/rules/zap/deep.conf | sort -n | xargs)"
[[ "$deep_enabled" == "6 40012 40018" ]] ||
  fail "deep ZAP policy must enable only reviewed rules 6, 40012 and 40018"

while IFS=$'\t' read -r relative expected; do
  [[ -n "$relative" && -n "$expected" ]] || fail "invalid rules manifest file entry"
  actual="sha256:$(sha256sum "service-assurance/rules/$relative" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "rules manifest digest mismatch: $relative"
done < <(jq -r '.files[] | [.path, .sha256] | @tsv' service-assurance/rules/manifest.json)

aggregate="sha256:$(jq -jr '.files | sort_by(.path)[] | .path, "\u0000", .sha256, "\n"' service-assurance/rules/manifest.json | sha256sum | awk '{print $1}')"
[[ "$aggregate" == "$(jq -r .sha256 service-assurance/rules/manifest.json)" ]] ||
  fail "rules manifest aggregate digest mismatch"

jq -e '
  .artifact == "trivy-db" and
  .source.manifestDigest == "sha256:9d3b66601a0d6dc18dc7f5ab59257fcc9b1f7f73f64e632f303a0594967a4d3a" and
  .source.layerDigest == "sha256:96b6b47116c081fdf033f809b93b43686894b708acc5f9f177f2f6986e48d1fb" and
  ([.files[].path] | sort) == ["db/metadata.json", "db/trivy.db"]
' service-assurance/vulndb/manifest.json >/dev/null || fail "Trivy DB manifest is not the reviewed snapshot"

if [[ -n "${SERVICE_ASSURANCE_TRIVY_DB_CACHE_DIR:-}" ]]; then
  while IFS=$'\t' read -r relative expected; do
    cached_file="$SERVICE_ASSURANCE_TRIVY_DB_CACHE_DIR/${relative#db/}"
    assert_file "$cached_file"
    actual="sha256:$(sha256sum "$cached_file" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || fail "cached Trivy DB digest mismatch: $relative"
  done < <(jq -r '.files[] | [.path, .sha256] | @tsv' service-assurance/vulndb/manifest.json)
fi

signature_tmp="$(mktemp -d)"
trap 'rm -rf "$signature_tmp"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$signature_tmp/signing.key" >/dev/null 2>&1
SERVICE_ASSURANCE_MANIFEST_SIGNING_KEY_FILE="$signature_tmp/signing.key" \
  bash scripts/sign-service-assurance-artifacts.sh "$signature_tmp/output" >/dev/null
for public_dir in "$signature_tmp/output" "$signature_tmp/output/rules" "$signature_tmp/output/vulndb"; do
  [[ "$(stat -c %a "$public_dir")" == "755" ]] ||
    fail "public signature directory must be readable by non-root sidecars: $public_dir"
done
for artifact in rules vulndb; do
  openssl dgst -sha256 -verify "$signature_tmp/output/manifest.pub" \
    -signature "$signature_tmp/output/$artifact/manifest.sig" \
    "service-assurance/$artifact/manifest.json" >/dev/null ||
    fail "detached manifest signature verification failed: $artifact"
done

if rg --glob '!**/*_test.go' --glob '!**/vendor/**' -n -i 'latest|runtime.*download|auto[-_ ]?update|docker\.sock|/var/run/docker|DATABASE_URL|REDIS_URL|169\.254\.169\.254' \
  sidecars/service-assurance service-assurance/rules service-assurance/vulndb; then
  fail "forbidden runtime or supply-chain capability found"
fi

echo "[ok] service assurance sidecar policies are pinned and testable"
