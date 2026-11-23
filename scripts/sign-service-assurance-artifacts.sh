#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="${SERVICE_ASSURANCE_MANIFEST_SIGNING_KEY_FILE:-}"
OUTPUT_DIR="${1:-$ROOT_DIR/dist/service-assurance-signatures}"

[[ -n "$KEY_FILE" && -f "$KEY_FILE" ]] || {
  echo "[error] SERVICE_ASSURANCE_MANIFEST_SIGNING_KEY_FILE must reference an RSA signing key" >&2
  exit 1
}
openssl rsa -in "$KEY_FILE" -check -noout >/dev/null 2>&1 || {
  echo "[error] service assurance signing key is not a valid RSA private key" >&2
  exit 1
}

umask 077
install -d -m 0700 "$OUTPUT_DIR/rules" "$OUTPUT_DIR/vulndb"
openssl pkey -in "$KEY_FILE" -pubout -out "$OUTPUT_DIR/manifest.pub" >/dev/null 2>&1

for artifact in rules vulndb; do
  manifest="$ROOT_DIR/service-assurance/$artifact/manifest.json"
  signature="$OUTPUT_DIR/$artifact/manifest.sig"
  [[ -f "$manifest" ]] || {
    echo "[error] artifact manifest is missing: $artifact" >&2
    exit 1
  }
  openssl dgst -sha256 -sign "$KEY_FILE" -out "$signature" "$manifest"
  openssl dgst -sha256 -verify "$OUTPUT_DIR/manifest.pub" -signature "$signature" "$manifest" >/dev/null
done

chmod 0644 "$OUTPUT_DIR/manifest.pub" "$OUTPUT_DIR/rules/manifest.sig" "$OUTPUT_DIR/vulndb/manifest.sig"
chmod 0755 "$OUTPUT_DIR" "$OUTPUT_DIR/rules" "$OUTPUT_DIR/vulndb"
echo "[ok] service assurance manifests signed; private key was not copied"
