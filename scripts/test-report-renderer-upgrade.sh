#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/report-renderer-env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[fail] $*" >&2; exit 1; }
fixture() {
  printf '%s\n' '# customer header' 'JWT_SECRET=fixture-secret$with-special-bytes' \
    'CUSTOM_VALUE="spaces # preserved"' 'REPORT_RENDERER=pdfkit' \
    'REPORT_CHROMIUM_PATH=/usr/bin/chromium' >"$1"
}
fixture "$TMP/legacy.env"
sed -e 's/^REPORT_RENDERER=pdfkit$/REPORT_RENDERER=html/' \
  -e 's|^REPORT_CHROMIUM_PATH=/usr/bin/chromium$|REPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome|' \
  "$TMP/legacy.env" >"$TMP/expected.env"
normalize_report_renderer_env "$TMP/legacy.env" >"$TMP/normalized.env"
cmp -s "$TMP/expected.env" "$TMP/normalized.env" || fail 'known legacy pair was not normalized'
cp "$TMP/legacy.env" "$TMP/active.env"
chmod 0600 "$TMP/active.env"
migrate_report_renderer_env "$TMP/active.env" "$TMP/receipt.env"
cmp -s "$TMP/expected.env" "$TMP/active.env" || fail 'legacy upgrade did not migrate both values'
[[ "$(stat -c %a "$TMP/active.env")" == 600 ]] || fail '.env permissions changed'
[[ "$(wc -l <"$TMP/receipt.env")" -eq 2 ]] || fail 'receipt must contain only two report settings'
! grep -q 'SECRET' "$TMP/receipt.env" || fail 'receipt includes unrelated configuration'
before="$(sha256sum "$TMP/active.env")"
migrate_report_renderer_env "$TMP/active.env" "$TMP/receipt.env"
[[ "$before" == "$(sha256sum "$TMP/active.env")" ]] || fail 'migration is not idempotent'
printf '%s\n' 'NEW_CUSTOM_SECRET=changed-after-upgrade' >>"$TMP/active.env"
restore_report_renderer_env "$TMP/active.env" "$TMP/receipt.env"
{ cat "$TMP/legacy.env"; printf '%s\n' 'NEW_CUSTOM_SECRET=changed-after-upgrade'; } >"$TMP/restored.env"
cmp -s "$TMP/restored.env" "$TMP/active.env" || fail 'rollback changed unrelated settings'
cp "$TMP/expected.env" "$TMP/active.env"
sed -i 's|/opt/lse-chromium/chrome|/customer/chrome|' "$TMP/active.env"
before="$(sha256sum "$TMP/active.env")"
restore_report_renderer_env "$TMP/active.env" "$TMP/receipt.env"
[[ "$before" == "$(sha256sum "$TMP/active.env")" ]] || fail 'rollback overwrote later custom browser'
sed 's/^REPORT_RENDERER=pdfkit$/REPORT_RENDERER=html/' "$TMP/legacy.env" >"$TMP/html-old.env"
migrate_report_renderer_env "$TMP/html-old.env" "$TMP/html-receipt.env"
cmp -s "$TMP/expected.env" "$TMP/html-old.env" || fail 'HTML old path not migrated'
restore_report_renderer_env "$TMP/html-old.env" "$TMP/html-receipt.env"
grep -qx 'REPORT_RENDERER=html' "$TMP/html-old.env" || fail 'HTML rollback changed renderer'
grep -qx 'REPORT_CHROMIUM_PATH=/usr/bin/chromium' "$TMP/html-old.env" || fail 'HTML path rollback failed'
for variant in custom explicit missing duplicate comment export_override indented_override; do
  fixture "$TMP/$variant.env"
  case "$variant" in
    custom) sed -i 's|/usr/bin/chromium|/customer/chrome|' "$TMP/$variant.env" ;;
    explicit) sed -i 's|/usr/bin/chromium|/opt/lse-chromium/chrome|' "$TMP/$variant.env" ;;
    missing) sed -i '/^REPORT_CHROMIUM_PATH=/d' "$TMP/$variant.env" ;;
    duplicate) printf '%s\n' 'REPORT_RENDERER=pdfkit' >>"$TMP/$variant.env" ;;
    export_override) printf '%s\n' 'export REPORT_RENDERER=pdfkit' >>"$TMP/$variant.env" ;;
    indented_override) printf '%s\n' ' REPORT_CHROMIUM_PATH=/customer/chrome' >>"$TMP/$variant.env" ;;
    comment) sed -i 's/REPORT_RENDERER=pdfkit/REPORT_RENDERER=pdfkit # intentional/' "$TMP/$variant.env" ;;
  esac
  cp "$TMP/$variant.env" "$TMP/$variant.before"
  migrate_report_renderer_env "$TMP/$variant.env" "$TMP/$variant.receipt"
  cmp -s "$TMP/$variant.env" "$TMP/$variant.before" || fail "$variant changed"
  [[ ! -e "$TMP/$variant.receipt" ]] || fail "$variant created receipt"
done
printf 'JWT_SECRET=keep-exact\r\nREPORT_RENDERER=pdfkit\r\nREPORT_CHROMIUM_PATH=/usr/bin/chromium\r\nTAIL=unchanged' >"$TMP/crlf.env"
printf 'JWT_SECRET=keep-exact\r\nREPORT_RENDERER=html\r\nREPORT_CHROMIUM_PATH=/opt/lse-chromium/chrome\r\nTAIL=unchanged' >"$TMP/crlf.expected"
migrate_report_renderer_env "$TMP/crlf.env" "$TMP/crlf.receipt"
cmp -s "$TMP/crlf.env" "$TMP/crlf.expected" || fail 'line endings or final bytes changed'
ln -s "$TMP/legacy.env" "$TMP/link.env"
if migrate_report_renderer_env "$TMP/link.env" "$TMP/link.receipt"; then fail 'symlink accepted'; fi
echo '[ok] report renderer migration, selective rollback and byte preservation'

# Inspect the actual generated scripts, not unrelated comments or sample defaults.
awk "/^  cat >.*upgrade.sh.*<<'UPGRADE'/ {take=1; next} take && /^UPGRADE$/ {exit} take" "$ROOT_DIR/scripts/package-offline-bundle.sh" >"$TMP/upgrade.sh"
awk "/^  cat >.*rollback.sh.*<<'ROLLBACK'/ {take=1; next} take && /^ROLLBACK$/ {exit} take" "$ROOT_DIR/scripts/package-offline-bundle.sh" >"$TMP/rollback.sh"
grep -q '^verify_report_renderer() {' "$TMP/upgrade.sh" || fail 'upgrade has no real report-renderer smoke'
grep -q '^[[:space:]]*migrate_report_renderer_env ' "$TMP/upgrade.sh" || fail 'upgrade does not invoke renderer migration'
grep -q '^restore_report_renderer_env ' "$TMP/rollback.sh" || fail 'rollback does not restore migrated report settings'
bash -n "$TMP/upgrade.sh" "$TMP/rollback.sh"

backup_line="$(grep -n '^    ./backup-db.sh$' "$TMP/upgrade.sh" | cut -d: -f1)"
migration_line="$(grep -n '^[[:space:]]*migrate_report_renderer_env .env ' "$TMP/upgrade.sh" | cut -d: -f1)"
start_line="$(grep -nF '  echo "[step] starting data and default assurance services"' "$TMP/upgrade.sh" | cut -d: -f1)"
health_line="$(grep -n '^  verify_services$' "$TMP/upgrade.sh" | cut -d: -f1)"
smoke_line="$(grep -n '^  verify_report_renderer$' "$TMP/upgrade.sh" | cut -d: -f1)"
receipt_line="$(grep -n '^  write_deployment_state$' "$TMP/upgrade.sh" | cut -d: -f1)"
[[ "$backup_line" -lt "$migration_line" && "$migration_line" -lt "$start_line" ]] ||
  fail 'renderer migration is not between backup and service startup'
[[ "$health_line" -lt "$smoke_line" && "$smoke_line" -lt "$receipt_line" ]] ||
  fail 'report smoke does not gate successful deployment state'
grep -Fq 'config --images)' "$TMP/upgrade.sh" || fail 'snapshot does not resolve current Compose images'
grep -Fq '<<<"$expected_images"' "$TMP/upgrade.sh" || fail 'snapshot does not check running image references'
echo '[ok] generated upgrade lifecycle includes migration, rollback guard and PDF acceptance'
