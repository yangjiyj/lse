#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT="${SERVICE_ASSURANCE_GATE_INPUT:-$ROOT_DIR/docs/superpowers/evidence/service-assurance/gate-input.tsv}"
REPORT="${SERVICE_ASSURANCE_GATE_REPORT:-$ROOT_DIR/docs/superpowers/evidence/service-assurance/gate-report.md}"
AIG_AUDIT="${SERVICE_ASSURANCE_AIG_AUDIT_JSON:-}"
MAX_AGE_SECONDS="${SERVICE_ASSURANCE_GATE_MAX_AGE_SECONDS:-86400}"

[[ -f "$INPUT" && ! -L "$INPUT" ]] || { echo "[error] gate input missing: $INPUT" >&2; exit 1; }
[[ "$MAX_AGE_SECONDS" =~ ^[0-9]+$ ]] || { echo '[error] invalid max evidence age' >&2; exit 1; }

now_epoch="$(date -u +%s)"
overall=MET
rows=''
count=0
while IFS=$'\t' read -r gate status rc checked_at evidence note; do
  [[ -n "$gate" && "$gate" != gate ]] || continue
  count=$((count + 1))
  [[ "$status" == MET || "$status" == NOT_MET ]] || status=NOT_MET
  [[ "$rc" =~ ^[0-9]+$ ]] || rc=1
  checked_epoch="$(date -u -d "$checked_at" +%s 2>/dev/null || echo 0)"
  age=$((now_epoch - checked_epoch))
  if ((checked_epoch <= 0 || age < 0 || age > MAX_AGE_SECONDS)); then
    status=NOT_MET
    note="${note}; evidence timestamp is stale or invalid"
  fi
  if [[ "$status" == MET && "$rc" != 0 ]]; then
    status=NOT_MET
    note="${note}; MET requires rc=0"
  fi
  [[ "$status" == MET ]] || overall=NOT_MET
  rows+="| $gate | $status | $rc | $checked_at | \`$evidence\` | $note |"$'\n'
done <"$INPUT"
[[ "$count" == 10 ]] || { echo "[error] expected 10 gates, got $count" >&2; exit 1; }

aig_summary='AIG audit was not supplied.'
if [[ -n "$AIG_AUDIT" && -f "$AIG_AUDIT" && ! -L "$AIG_AUDIT" ]]; then
  command -v jq >/dev/null 2>&1 || { echo '[error] jq required for AIG audit' >&2; exit 1; }
  configured="$(jq -er '.referenceAudit.configuredTaskCount' "$AIG_AUDIT")"
  active="$(jq -er '.referenceAudit.activeEngineRunCount' "$AIG_AUDIT")"
  historical_runs="$(jq -er '.referenceAudit.historicalEngineRunCount' "$AIG_AUDIT")"
  historical_findings="$(jq -er '.referenceAudit.historicalFindingCount' "$AIG_AUDIT")"
  relay_imports="$(jq -er '.referenceAudit.relayAuditImportCount' "$AIG_AUDIT")"
  aig_summary="configured tasks=$configured; active runs=$active; historical runs=$historical_runs; historical findings=$historical_findings; relay imports=$relay_imports."
  if ((configured != 0 || active != 0 || relay_imports != 0)); then overall=NOT_MET; fi
fi

tmp="${REPORT}.tmp.$$"
{
  echo '# AI 服务安全核验十项门禁报告'
  echo
  echo "- 生成时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- 总体状态：**$overall**"
  echo "- AIG 引用审计：$aig_summary"
  echo
  echo '| 门禁 | 状态 | RC | 检查时间 | 证据 | 说明 |'
  echo '| --- | --- | ---: | --- | --- | --- |'
  printf '%s' "$rows"
  echo
  if [[ "$overall" == MET ]]; then
    echo '全部门禁满足；仍须单独审批 AIG 代码与运行服务退役，历史数据、日志和卷不得删除。'
  else
    echo '任一门禁未满足：AIG 保持停止新增、历史只读；不得删除 AIG 代码、服务、历史数据、日志卷或数据卷。'
  fi
} >"$tmp"
mv "$tmp" "$REPORT"
echo "[result] $overall -> $REPORT"
[[ "$overall" == MET ]]
