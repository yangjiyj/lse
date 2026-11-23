#!/usr/bin/env bash
# Parse only exact legacy assignments. Never execute customer .env content.
report_renderer_env_values() {
  awk '
    { line=$0; sub(/\r$/, "", line) }
    line ~ /^[ \t]*(export[ \t]+)?REPORT_(RENDERER|CHROMIUM_PATH)[ \t]*=/ &&
      line !~ /^REPORT_RENDERER=/ && line !~ /^REPORT_CHROMIUM_PATH=/ { alternative=1 }
    line ~ /^REPORT_RENDERER=/ { r=substr(line,17); nr++ }
    line ~ /^REPORT_CHROMIUM_PATH=/ { p=substr(line,22); np++ }
    END { if (!alternative && nr==1 && np==1) printf "%s\n%s\n", r, p }
  ' "$1"
}

rewrite_report_renderer_env() {
  local file="$1" renderer="$2" browser="$3" final_byte
  final_byte="$(tail -c 1 -- "$file" | od -An -tu1 | tr -d '[:space:]')"
  awk -v renderer="$renderer" -v browser="$browser" -v newline="$([[ "$final_byte" == 10 ]] && echo 1 || echo 0)" '
    {
      line=$0; ending=(line ~ /\r$/ ? "\r" : "")
      if (line ~ /^REPORT_RENDERER=/) line="REPORT_RENDERER=" renderer ending
      if (line ~ /^REPORT_CHROMIUM_PATH=/) line="REPORT_CHROMIUM_PATH=" browser ending
      if (NR>1) printf "%s\n", previous
      previous=line
    }
    END { if (NR>0) printf "%s%s", previous, (newline ? "\n" : "") }
  ' "$file"
}

normalize_report_renderer_env() {
  local file="$1" pair
  [[ -f "$file" && ! -L "$file" ]] || { echo '[error] regular .env required' >&2; return 1; }
  pair="$(report_renderer_env_values "$file")"
  case "$pair" in
    $'pdfkit\n/usr/bin/chromium'|$'html\n/usr/bin/chromium')
      rewrite_report_renderer_env "$file" html /opt/lse-chromium/chrome ;;
    *) cat -- "$file" ;;
  esac
}

replace_report_renderer_env() {
  local file="$1" renderer="$2" browser="$3" staged
  staged="$(mktemp "$file.report.XXXXXX")" || return 1
  if ! cp -p -- "$file" "$staged" ||
     ! rewrite_report_renderer_env "$file" "$renderer" "$browser" >"$staged" ||
     ! mv -f -- "$staged" "$file"; then
    rm -f -- "$staged"
    return 1
  fi
}

migrate_report_renderer_env() {
  local file="$1" receipt="$2" pair staged
  [[ -f "$file" && ! -L "$file" ]] || { echo '[error] regular .env required' >&2; return 1; }
  pair="$(report_renderer_env_values "$file")"
  case "$pair" in
    $'pdfkit\n/usr/bin/chromium'|$'html\n/usr/bin/chromium') ;;
    *) return 0 ;;
  esac
  [[ ! -e "$receipt" && ! -L "$receipt" ]] || {
    echo '[error] report renderer migration receipt already exists' >&2; return 1;
  }
  staged="$(mktemp "$receipt.XXXXXX")" || return 1
  printf 'REPORT_RENDERER=%s\nREPORT_CHROMIUM_PATH=/usr/bin/chromium\n' "${pair%%$'\n'*}" >"$staged"
  chmod 0600 "$staged"
  mv -- "$staged" "$receipt"
  replace_report_renderer_env "$file" html /opt/lse-chromium/chrome || return 1
  echo '[ok] migrated the known legacy report renderer settings'
}

restore_report_renderer_env() {
  local file="$1" receipt="$2" pair previous
  [[ -e "$receipt" ]] || return 0
  [[ -f "$file" && ! -L "$file" && -f "$receipt" && ! -L "$receipt" ]] || {
    echo '[error] regular report renderer rollback files required' >&2; return 1;
  }
  pair="$(report_renderer_env_values "$file")"
  [[ "$pair" == $'html\n/opt/lse-chromium/chrome' ]] || {
    echo '[info] report renderer changed after upgrade; keeping customer settings'; return 0;
  }
  previous="$(report_renderer_env_values "$receipt")"
  case "$previous" in
    $'pdfkit\n/usr/bin/chromium'|$'html\n/usr/bin/chromium') ;;
    *) echo '[error] invalid report renderer migration receipt' >&2; return 1 ;;
  esac
  replace_report_renderer_env "$file" "${previous%%$'\n'*}" /usr/bin/chromium || return 1
  echo '[ok] restored only the automatically migrated report renderer settings'
}
