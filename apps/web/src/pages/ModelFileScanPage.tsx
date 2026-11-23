import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { RuleCatalog } from '@/components/model-files/RuleCatalog';
import { ScanLauncher } from '@/components/model-files/ScanLauncher';
import { ScanDetail, ScanList } from '@/components/model-files/ScanResults';

/** 专项核验 / 模型文件扫描：安全检查与结构校验，不运行模型文件。 */
export function ModelFileScanPage() {
  const { hasPermission } = useAuth();
  const [searchParams] = useSearchParams();
  // 从检测任务总览跳来时带 ?scan=，直接打开这次扫描的明细。
  const [selected, setSelected] = useState<string | null>(() => searchParams.get('scan'));
  const canScan = hasPermission('engine:scan');
  return (
    <div className="space-y-5">
      <PageHeader
        title="模型文件扫描"
        description="对模型文件做安全检查与结构校验，不运行模型文件。"
        actions={<RuleCatalog />}
      />
      {canScan && (
        <SectionCard
          title="发起扫描"
          description="管理上传的模型文件，或浏览服务器上的模型目录后扫描。"
        >
          <ScanLauncher onDone={setSelected} />
        </SectionCard>
      )}
      <SectionCard title="扫描记录">
        <ScanList selected={selected} onSelect={setSelected} />
      </SectionCard>
      {selected && (
        <SectionCard
          title="扫描明细"
          extra={
            <button
              type="button"
              className="text-sm font-medium text-brand-600 hover:underline"
              onClick={() => setSelected(null)}
            >
              收起
            </button>
          }
        >
          <ScanDetail id={selected} />
        </SectionCard>
      )}
    </div>
  );
}
