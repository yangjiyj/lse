const SLOT_LOCATIONS: Record<string, string> = {
  readme_note: 'README.md', contributing_step: 'CONTRIBUTING.md', changelog_note: 'CHANGELOG.md',
  makefile_note: 'Makefile', requirements_comment: 'requirements.txt', ci_step: '.github/workflows/ci.yml',
  runbook_note: 'docs/runbook.md', deploy_note: 'docs/deploy.md', script_output: 'scripts/check.sh 的输出',
  cache_comment: '缓存模块的代码注释', app_comment: '服务模块的代码注释', test_message: '测试断言消息',
  vendor_readme: '依赖 README', issue_body: 'issues/101-cache-eviction.md', claude_md: 'CLAUDE.md',
  agents_md: 'AGENTS.md', cursorrules: '.cursorrules', package_script: 'package.json 的 setup 脚本',
};
const CHANNEL_LOCATIONS: Record<string, string> = {
  doc: '文档', code: '代码', dep: '依赖文件', web: '网页内容', mcp: 'MCP 工具返回',
};

export function runtimeLocations(sample: { slots?: unknown; channel?: unknown; mcp?: unknown; vector?: unknown }): string[] {
  const slots = sample.slots && typeof sample.slots === 'object' && !Array.isArray(sample.slots) ? sample.slots : {};
  const result = Object.keys(slots).map((slot) => SLOT_LOCATIONS[slot] ?? slot);
  const mcp = sample.mcp && typeof sample.mcp === 'object' ? sample.mcp as { servers?: unknown } : {};
  for (const server of Array.isArray(mcp.servers) ? mcp.servers.filter((item) => item && typeof item === 'object') : []) {
    const label = server.kind === 'poisoned_description' ? 'MCP 工具描述'
      : server.kind === 'poisoned_result' ? 'MCP 工具返回'
      : server.kind === 'rug_pull' ? 'MCP 工具动态变化'
      : server.kind === 'shadow_tool' ? 'MCP 影子工具' : null;
    if (label) result.push(label);
  }
  if (!result.length) result.push(typeof sample.channel === 'string' ? CHANNEL_LOCATIONS[sample.channel] ?? '未上报'
    : sample.vector && sample.vector !== 'indirect' ? '用户直接要求' : '未上报');
  return [...new Set(result)];
}
