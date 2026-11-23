import type { TargetType } from '@prisma/client';
import { badRequest } from '../../lib/errors.js';

export interface RedTeamTarget {
  id: string;
  targetType: TargetType;
  isActive: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

type ComparableModelTarget = Pick<RedTeamTarget, 'id' | 'baseUrl' | 'model'>;

function normalizeModelBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function assertCallableRedTeamTarget(
  target: RedTeamTarget | null | undefined,
  role: 'attacker' | 'judge',
): asserts target is RedTeamTarget {
  const label = role === 'attacker' ? '攻击模型' : '判定模型';
  if (!target) {
    throw badRequest(`所选${label}不存在，请重新选择。`, 'RED_TEAM_TARGET_NOT_FOUND');
  }
  if (!target.isActive) {
    throw badRequest(`所选${label}已停用，请先启用后再保存。`, 'RED_TEAM_TARGET_INACTIVE');
  }
  if (!['MODEL', 'JUDGE'].includes(target.targetType)) {
    throw badRequest(
      `所选${label}不是可直接调用的模型，请重新选择。`,
      'RED_TEAM_TARGET_NOT_CALLABLE',
    );
  }
  if (![target.baseUrl, target.apiKey, target.model].every((value) => value.trim().length > 0)) {
    throw badRequest(`所选${label}配置不完整，请到平台设置检查。`, 'RED_TEAM_TARGET_NOT_CALLABLE');
  }
}

export function assertExternalAttackerTarget(
  attacker: ComparableModelTarget,
  evaluationTarget: ComparableModelTarget,
): void {
  const sameRow = attacker.id === evaluationTarget.id;
  const sameEndpointModel =
    normalizeModelBaseUrl(attacker.baseUrl) === normalizeModelBaseUrl(evaluationTarget.baseUrl) &&
    attacker.model.trim() === evaluationTarget.model.trim();
  if (sameRow || sameEndpointModel) {
    throw badRequest(
      '攻击模型不能与评估对象相同，请选择独立模型。',
      'RED_TEAM_ATTACKER_MUST_DIFFER',
    );
  }
}

/** 被测对象可为应用黑盒，攻击模型与判官的限制仍由 assertCallableRedTeamTarget 管理。 */
export function assertRedTeamEvaluationTarget(target: RedTeamTarget): void {
  if (!['MODEL', 'PLATFORM_APP'].includes(target.targetType)) {
    throw badRequest('主评估对象必须是模型或平台智能体', 'RED_TEAM_TARGET_NOT_MODEL');
  }
}
