import { useEffect, useState } from 'react';
import type { AssuranceImpactStatus, ServiceAssuranceAssessmentItem } from '@lse/shared';
import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  ServiceAssuranceNotAffectedJustification,
  ServiceAssuranceReviewRequest,
} from '@/lib/api';

type ReviewableImpactStatus = Exclude<AssuranceImpactStatus, 'FIXED'>;

const JUSTIFICATION_OPTIONS: Array<{
  value: ServiceAssuranceNotAffectedJustification;
  label: string;
}> = [
  { value: 'component_not_present', label: '目标中不存在该组件' },
  { value: 'vulnerable_code_not_present', label: '组件中不包含易受影响代码' },
  { value: 'vulnerable_code_not_in_execute_path', label: '易受影响代码不在可执行路径' },
  {
    value: 'vulnerable_code_cannot_be_controlled_by_adversary',
    label: '攻击者无法控制易受影响代码',
  },
  { value: 'inline_mitigations_already_exist', label: '已有不可绕过的缓解措施' },
];

interface AssuranceReviewDialogProps {
  open: boolean;
  assessment: ServiceAssuranceAssessmentItem | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: ServiceAssuranceReviewRequest) => void;
}

export function AssuranceReviewDialog({
  open,
  assessment,
  submitting,
  onClose,
  onSubmit,
}: AssuranceReviewDialogProps) {
  const initialStatus: ReviewableImpactStatus =
    assessment?.impactStatus === 'AFFECTED' || assessment?.impactStatus === 'NOT_AFFECTED'
      ? assessment.impactStatus
      : 'UNDER_INVESTIGATION';
  const [impactStatus, setImpactStatus] = useState<ReviewableImpactStatus>(initialStatus);
  const [justification, setJustification] =
    useState<ServiceAssuranceNotAffectedJustification>('component_not_present');
  const [statement, setStatement] = useState('');

  useEffect(() => {
    if (!open || !assessment) return;
    setImpactStatus(
      assessment.impactStatus === 'AFFECTED' || assessment.impactStatus === 'NOT_AFFECTED'
        ? assessment.impactStatus
        : 'UNDER_INVESTIGATION',
    );
    setJustification('component_not_present');
    setStatement('');
  }, [assessment, open]);

  if (!assessment) return null;

  const canKeepAffected =
    assessment.impactStatus === 'AFFECTED' && assessment.evidenceLabel !== '待核验线索';
  const normalizedStatement = statement.trim();

  const submit = () => {
    if (!normalizedStatement) return;
    if (impactStatus === 'NOT_AFFECTED') {
      onSubmit({ impactStatus, justification, statement: normalizedStatement });
      return;
    }
    onSubmit({ impactStatus, statement: normalizedStatement });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="复核结论"
      description={assessment.title}
      size="md"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            type="submit"
            form="assurance-review-form"
            disabled={submitting || !normalizedStatement}
          >
            <ClipboardCheck className="h-4 w-4" />
            {submitting ? '保存中' : '保存复核'}
          </Button>
        </>
      }
    >
      <form
        id="assurance-review-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="assurance-review-status" className="text-sm font-medium text-ink">
            复核结论
          </label>
          <Select
            id="assurance-review-status"
            value={impactStatus}
            onChange={(event) => setImpactStatus(event.target.value as ReviewableImpactStatus)}
          >
            {canKeepAffected && <option value="AFFECTED">已确认风险</option>}
            <option value="UNDER_INVESTIGATION">证据不足，继续核验</option>
            <option value="NOT_AFFECTED">不受影响</option>
          </Select>
        </div>

        {impactStatus === 'NOT_AFFECTED' && (
          <div className="space-y-1.5">
            <label
              htmlFor="assurance-review-justification"
              className="text-sm font-medium text-ink"
            >
              不受影响依据
            </label>
            <Select
              id="assurance-review-justification"
              value={justification}
              onChange={(event) =>
                setJustification(event.target.value as ServiceAssuranceNotAffectedJustification)
              }
            >
              {JUSTIFICATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="assurance-review-statement" className="text-sm font-medium text-ink">
            复核说明
          </label>
          <Textarea
            id="assurance-review-statement"
            value={statement}
            maxLength={1000}
            onChange={(event) => setStatement(event.target.value)}
            placeholder="填写已核对的部署、版本、配置或缓解措施证据"
          />
          <div className="text-right text-xs text-ink-3">{statement.length}/1000</div>
        </div>
      </form>
    </Modal>
  );
}
