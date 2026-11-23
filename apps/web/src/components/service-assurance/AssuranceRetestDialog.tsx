import { useEffect, useState } from 'react';
import type { ServiceAssuranceAssessmentItem, ServiceAssuranceMode } from '@lse/shared';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import type { ServiceAssuranceRetestRequest } from '@/lib/api';
import {
  readServiceAssuranceSbomFile,
  serviceAssuranceSbomContentType,
  serviceAssuranceSbomFileError,
} from './sbom-file';

interface AssuranceRetestDialogProps {
  open: boolean;
  mode: ServiceAssuranceMode;
  assessment: ServiceAssuranceAssessmentItem | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: ServiceAssuranceRetestRequest) => Promise<void>;
}

export function AssuranceRetestDialog({
  open,
  mode,
  assessment,
  submitting,
  onClose,
  onSubmit,
}: AssuranceRetestDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setFileError(null);
  }, [assessment, open]);

  if (!assessment) return null;

  const requiresSbom = mode === 'SBOM';

  const selectFile = (selected: File | null) => {
    setFileError(null);
    setFile(selected);
    if (!selected) return;
    setFileError(serviceAssuranceSbomFileError(selected));
  };

  const submit = async () => {
    if (!requiresSbom) {
      await onSubmit({});
      return;
    }
    if (!file || fileError) return;
    const contentType = serviceAssuranceSbomContentType(file);
    if (!contentType) return;
    await onSubmit({
      sbom: {
        contentType,
        content: await readServiceAssuranceSbomFile(file),
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="发起复测"
      description={assessment.title}
      size="sm"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || (requiresSbom && (!file || !!fileError))}
          >
            <RotateCcw className="h-4 w-4" />
            {submitting ? '提交中' : '开始复测'}
          </Button>
        </>
      }
    >
      {requiresSbom ? (
        <div className="space-y-2">
          <label htmlFor="assurance-retest-sbom" className="text-sm font-medium text-ink">
            新的组件清单
          </label>
          <Input
            id="assurance-retest-sbom"
            type="file"
            accept=".json,.spdx,application/json,application/vnd.cyclonedx+json,application/spdx+json,text/spdx"
            onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
          />
          {fileError ? (
            <p role="alert" className="text-sm text-red-700">
              {fileError}
            </p>
          ) : (
            <p className="text-xs leading-5 text-ink-3">
              提交新的 CycloneDX 或 SPDX 清单，文件上限 2 MB。
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm leading-6 text-ink-2">
          将沿用原目标、授权范围和平台预算重新核验，并根据本问题对应的证据判断是否修复。
        </p>
      )}
    </Modal>
  );
}
