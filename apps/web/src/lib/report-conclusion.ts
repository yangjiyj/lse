import type { ReportConclusionSnapshot } from './api';

export type ReportConclusionTone = 'danger' | 'warning' | 'info';

export interface ReportConclusionPresentation {
  title: string;
  detail: string;
  tone: ReportConclusionTone;
  passRate: number | null;
  coverageDetail: string;
  downloadable: boolean;
}

/**
 * 报告结论只有服务端冻结快照一个来源。前端绝不再按通过率、评分或风险数推导
 * “上线/安全”判断，历史报告也必须明确展示为不可验证的追溯材料。
 */
export function presentReportConclusion(
  snapshot: ReportConclusionSnapshot | undefined,
): ReportConclusionPresentation {
  if (!snapshot || snapshot.source === 'LEGACY_FALLBACK') {
    return {
      title: '历史报告：结论不可验证',
      detail: '该报告未保存统一结论快照，仅供历史追溯；如需对外使用，请重新生成报告。',
      tone: 'warning',
      passRate: null,
      coverageDetail: '历史快照缺失',
      downloadable: false,
    };
  }

  const counts = snapshot.counts;
  const coverageDetail = counts
    ? `执行范围：预期 ${counts.expected} 条，观察到 ${counts.observed} 条，有效判定 ${counts.valid} 条。`
    : '执行范围信息不可用。';
  if (snapshot.state === 'RISK_DETECTED') {
    return {
      title: '本次评估发现有效风险',
      detail: '请围绕已归因风险完成整改，并用相同范围复测验证；本结论不替代业务上线审批。',
      tone: 'danger',
      passRate: snapshot.passRate,
      coverageDetail,
      downloadable: true,
    };
  }
  if (snapshot.state === 'NO_RISK_OBSERVED') {
    return {
      title: '本次评估范围内未观察到有效风险',
      detail: '这表示当前范围和证据下未发现有效风险，不等同于系统绝对安全或合规认证。',
      tone: 'info',
      passRate: snapshot.passRate,
      coverageDetail,
      downloadable: true,
    };
  }
  return {
    title: '评估结论不完整',
    detail: '存在未完成执行、异常、未知判定或覆盖缺口，当前不能形成风险结论；请补齐后复测。',
    tone: 'warning',
    passRate: snapshot.passRate,
    coverageDetail,
    downloadable: true,
  };
}
