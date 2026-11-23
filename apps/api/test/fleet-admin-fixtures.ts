// fleet-admin 测试夹具：最小 aiprobe.report.v1 报告。
const agentChecks = (findings: string[] = []) =>
  [
    'model.exit',
    'config.permission',
    'config.auto_approval',
    'config.sandbox',
    'config.credential',
    'proxy.route',
    'mcp.aggregate',
    'skill.aggregate',
  ].map((rule_id) => ({
    rule_id,
    status: findings.includes(rule_id) ? 'finding' : 'pass',
    severity: findings.includes(rule_id) ? 'high' : 'info',
    reason_zh: findings.includes(rule_id) ? `命中 ${rule_id}` : '未命中',
    evidence_code: 'x',
    recommendation_zh: 'y',
  }));
export function sampleReport(
  opts: { bypass?: boolean; shadowing?: boolean; httpMcp?: boolean } = {},
) {
  return {
    schema_version: 'aiprobe.report.v1',
    endpoint_id: 'ep_test',
    report_id: 'pr_x',
    probe_version: 'v1',
    scanned_at: '2026-10-22T00:00:00Z',
    status: 'complete',
    collectors: [{ name: 'agents', status: 'complete' }],
    socket_observations: [],
    assets: [
      {
        kind: 'cli_agent',
        name: 'claude-code',
        display_name: 'Claude Code',
        version: '2.1.0',
        evidence: {
          config: {
            permission_mode: opts.bypass ? 'bypassPermissions' : 'default',
            auto_approval: 'disabled',
            hooks_present: false,
            instruction_files: [],
            config_files: [],
          },
          mcp_servers: [
            {
              name: 'local',
              scope: 'user',
              transport: opts.httpMcp ? 'http' : 'stdio',
              origin: opts.httpMcp ? 'http://mcp.example' : undefined,
              static_assessment: {
                checks: opts.shadowing
                  ? [
                      {
                        rule_id: 'mcp.description_shadowing',
                        status: 'finding',
                        severity: 'high',
                        reason_zh: '工具描述试图劫持其它工具的调用顺序或指令。',
                      },
                    ]
                  : [],
              },
            },
          ],
          skills: [],
          static_assessment: { checks: agentChecks(opts.bypass ? ['config.permission'] : []) },
        },
      },
    ],
  };
}

/** 新版探针：同一终端的三处真实安装，分别检查完成、未查完、命中风险。 */
export function postureSignalsReport() {
  const base = sampleReport();
  const keys = [
    'instr.hidden_unicode',
    'instr.invisible_chars',
    'instr.secret',
    'instr.suspicious_directive',
  ];
  return {
    ...base,
    assets: ['pass', 'unknown', 'finding'].map((status, index) => ({
      ...structuredClone(base.assets[0]!),
      evidence: {
        ...structuredClone(base.assets[0]!.evidence),
        owner_account_key: `account-${index}`,
        config: {
          ...base.assets[0]!.evidence.config,
          instruction_files: [{ path_hash: `file-${index}`, scope: 'user' }],
        },
        static_assessment: {
          checks: [
            ...base.assets[0]!.evidence.static_assessment.checks,
            {
              rule_id: 'config.hooks',
              status: index === 2 ? 'finding' : 'pass',
              evidence_code: index === 2 ? 'hook_not_connected' : 'hook_user',
              severity: index === 2 ? 'medium' : 'info',
              reason_zh: '不回显的探针原文',
              recommendation_zh: '',
            },
          ],
        },
        posture: keys.map((key) => ({
          key,
          status,
          count: status === 'pass' ? 3 : 1,
          scope: 'user',
          label: 'CLAUDE.md',
          evidence_code: status === 'unknown' ? 'instruction_too_large' : 'bypass_or_conceal',
        })),
      },
    })),
  };
}
