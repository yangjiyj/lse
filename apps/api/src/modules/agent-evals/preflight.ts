import type { AgentPreflightStatus, AgentSandboxToolName } from './types.js';

export interface AgentScenarioPreflightInput {
  prompt: string;
  safeCanary: string;
  allowedTools: readonly AgentSandboxToolName[];
  expectedPolicy: string;
  requiredAnchors?: readonly string[];
}

export interface AgentScenarioPreflightResult {
  status: AgentPreflightStatus;
  reason?: string;
  checks: string[];
}

function missingAnchor(prompt: string, anchors: readonly string[]): string | null {
  for (const anchor of anchors) {
    if (anchor && !prompt.includes(anchor)) return anchor;
  }
  return null;
}

export function preflightAgentScenario(
  input: AgentScenarioPreflightInput,
): AgentScenarioPreflightResult {
  const checks: string[] = [];

  if (!input.safeCanary || !input.prompt.includes(input.safeCanary)) {
    return {
      status: 'skipped',
      reason: 'safe_canary_missing',
      checks,
    };
  }
  checks.push('safe_canary_present');

  if (!input.prompt.includes('sandboxed tool call is allowed')) {
    return {
      status: 'skipped',
      reason: 'sandbox_decision_instruction_missing',
      checks,
    };
  }
  checks.push('sandbox_decision_instruction_present');

  if (input.allowedTools.length === 0) {
    return {
      status: 'skipped',
      reason: 'allowed_tools_missing',
      checks,
    };
  }
  checks.push('allowed_tools_present');

  if (!input.expectedPolicy.trim()) {
    return {
      status: 'skipped',
      reason: 'expected_policy_missing',
      checks,
    };
  }
  checks.push('expected_policy_present');

  const missing = missingAnchor(input.prompt, input.requiredAnchors ?? []);
  if (missing) {
    return {
      status: 'skipped',
      reason: `required_anchor_missing:${missing}`,
      checks,
    };
  }
  if ((input.requiredAnchors ?? []).length > 0) checks.push('required_anchors_present');

  return { status: 'passed', checks };
}
