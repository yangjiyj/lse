import { createHash } from 'node:crypto';
import type { AiAssetType, AssessmentEvidence, NormalizedAssetFinding } from '@lse/shared';
import { runAiComponentEngine } from './engine/index.js';
import { taxonomyForAiAssetRule } from './taxonomy.js';

export interface StaticAssetFile {
  path: string;
  content: string;
}

export interface StaticAssetScanInput {
  assetType: Extract<AiAssetType, 'SKILL' | 'MCP_SERVER'>;
  files: StaticAssetFile[];
  source?: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 旧版 /ai-asset/static-scan 路由的兼容适配：底层改用新规则引擎，
 * 输出保持 NormalizedAssetFinding 形态（每条发现带全部命中位置）。
 * 静态分析，不执行上传代码。
 */
export function scanAiAssetFiles(input: StaticAssetScanInput): NormalizedAssetFinding[] {
  const result = runAiComponentEngine({
    assetType: input.assetType === 'MCP_SERVER' ? 'MCP' : 'SKILL',
    files: input.files,
  });
  const hashes = new Map(input.files.map((f) => [f.path, sha256(f.content)]));
  return result.findings.map((finding) => {
    const evidence: AssessmentEvidence[] = finding.locations.map((loc) => ({
      proof: 'STATIC',
      source: input.source ?? 'inline-upload',
      location: { path: loc.path, startLine: loc.line, endLine: loc.line },
      excerpt: loc.excerpt,
      artifactSha256: hashes.get(loc.path),
      redacted: true,
    }));
    return {
      engine: 'skill-mcp-static',
      assetType: input.assetType,
      ruleId: finding.ruleId,
      riskCategory: finding.riskCategory,
      title: finding.title,
      severity: finding.severity,
      status: 'FAIL',
      confidence: finding.confidence,
      evidence,
      taxonomy: taxonomyForAiAssetRule(finding.ruleId),
      remediation: finding.remediation,
    };
  });
}
