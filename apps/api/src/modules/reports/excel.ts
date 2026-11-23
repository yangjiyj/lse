import ExcelJS from 'exceljs';
import type { Severity, Verdict } from '@lse/shared';
import {
  SEVERITY_LABELS,
  VERDICT_LABELS,
  riskLabel,
  engineLabel,
  localizeFindingTag,
  formatDateTime,
  evidenceStrengthLabel,
  executionOutcomeLabel,
  remediationStatusLabel,
} from './labels.js';
import { localizeLanguagePromptForDisplay } from '../generator/core/language-profiles.js';
import { PRODUCT_NAME } from '../../lib/product-name.js';

export interface WrongAnswerExcelRow {
  questionContent: string;
  assessmentTarget?: string | null;
  assessmentVersion?: string | null;
  assessmentScope?: string | null;
  riskCategory: string | null;
  severity: Severity | null;
  verdict: string;
  engine: string | null;
  modelResponse: string | null;
  reason: string | null;
  reviewStatus: string | null;
  evidenceStrength: string | null;
  executionOutcome: string | null;
  title?: string;
  action?: string;
  verification?: string;
  responsibility?: string;
  verificationScope?: string;
  status?: string | null;
  owner?: string | null;
  team?: string | null;
  controlLocation?: string | null;
  dueAt?: Date | string | null;
  record?: string | null;
  retestTaskId?: string | null;
  acceptanceCriteria?: string | null;
  closureEvidence?: string | null;
  closedAt?: Date | string | null;
  createdAt: Date;
}

/** 构造样本集 Excel 工作簿（exceljs，MIT，闭源合规）。 */
export function buildWrongAnswerWorkbook(
  taskName: string,
  rows: WrongAnswerExcelRow[],
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = PRODUCT_NAME;
  wb.created = new Date();
  const ws = wb.addWorksheet('样本集');
  ws.columns = [
    { header: '序号', key: 'idx', width: 6 },
    { header: '测试样本', key: 'question', width: 48 },
    { header: '评估对象', key: 'assessmentTarget', width: 28 },
    { header: '对象版本/模型', key: 'assessmentVersion', width: 24 },
    { header: '评估范围', key: 'assessmentScope', width: 42 },
    { header: '风险类别', key: 'risk', width: 16 },
    { header: '严重等级', key: 'severity', width: 12 },
    { header: '判定', key: 'verdict', width: 10 },
    { header: '引擎', key: 'engine', width: 16 },
    { header: '评估对象响应', key: 'response', width: 48 },
    { header: '原因/说明', key: 'reason', width: 36 },
    { header: '复核状态', key: 'reviewStatus', width: 14 },
    { header: '证据强度', key: 'evidenceStrength', width: 16 },
    { header: '执行结果', key: 'executionOutcome', width: 16 },
    { header: '整改标题', key: 'remediationTitle', width: 24 },
    { header: '整改措施', key: 'remediationAction', width: 42 },
    { header: '验收条件', key: 'remediationVerification', width: 42 },
    { header: '责任归属', key: 'responsibility', width: 32 },
    { header: '复测范围', key: 'verificationScope', width: 42 },
    { header: '整改状态', key: 'remediationStatus', width: 16 },
    { header: '责任人', key: 'owner', width: 18 },
    { header: '责任团队', key: 'team', width: 18 },
    { header: '控制位置', key: 'controlLocation', width: 28 },
    { header: '截止时间', key: 'dueAt', width: 22 },
    { header: '整改记录', key: 'record', width: 38 },
    { header: '复测任务', key: 'retestTaskId', width: 38 },
    { header: '关闭证据', key: 'closureEvidence', width: 38 },
    { header: '关闭时间', key: 'closedAt', width: 22 },
    { header: '创建时间', key: 'createdAt', width: 22 },
  ];
  rows.forEach((r, i) => {
    ws.addRow({
      idx: i + 1,
      question: localizeLanguagePromptForDisplay(r.questionContent),
      assessmentTarget: r.assessmentTarget ?? '-',
      assessmentVersion: r.assessmentVersion ?? '-',
      assessmentScope: r.assessmentScope || '-',
      risk: r.riskCategory ? riskLabel(r.riskCategory, r.engine ?? undefined) : '-',
      severity: r.severity ? SEVERITY_LABELS[r.severity] : '-',
      verdict: VERDICT_LABELS[r.verdict as Verdict] ?? r.verdict,
      engine: engineLabel(r.engine),
      response: r.modelResponse ?? '-',
      reason: r.reason ? localizeFindingTag(r.reason) : '-',
      reviewStatus: r.reviewStatus ?? '未记录',
      evidenceStrength: evidenceStrengthLabel(r.evidenceStrength),
      executionOutcome: executionOutcomeLabel(r.executionOutcome),
      remediationTitle: r.title ?? '-',
      remediationAction: r.action ?? '-',
      remediationVerification: r.verification ?? '-',
      responsibility: r.responsibility ?? '-',
      verificationScope: r.verificationScope ?? '-',
      remediationStatus: remediationStatusLabel(r.status),
      owner: r.owner ?? '-',
      team: r.team ?? '-',
      controlLocation: r.controlLocation ?? '-',
      dueAt: r.dueAt ? formatDateTime(new Date(r.dueAt)) : '—',
      record: r.record ?? '-',
      retestTaskId: r.retestTaskId ?? '-',
      closureEvidence: r.closureEvidence ?? '-',
      closedAt: r.closedAt ? formatDateTime(new Date(r.closedAt)) : '—',
      createdAt: formatDateTime(r.createdAt),
    });
  });
  ws.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
  });
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.pageSetup = { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 };
  ws.properties.defaultRowHeight = 30;
  void taskName;
  return wb;
}
