import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { aiComponentsApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { NoteBar, SectionCard } from '@/components/page-kit/SectionCard';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { ScanForm } from './ai-component/ScanForm';
import { ScanList } from './ai-component/ScanList';
import { ScanDetail } from './ai-component/ScanDetail';

const PAGE_SIZE = 20;

export function AiAssetScanPage() {
  const { hasPermission } = useAuth();
  const canScan = hasPermission('engine:scan');
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [searchParams] = useSearchParams();
  // 从检测任务总览跳来时带 ?scan=，直接打开这次扫描的详情。
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('scan'));
  const list = useQuery({
    queryKey: ['ai-components', 'scans', page, keyword],
    queryFn: () =>
      aiComponentsApi.list({ page, pageSize: PAGE_SIZE, keyword: keyword.trim() || undefined }),
  });
  const refresh = () => void list.refetch();
  const caps = list.data?.capabilities;

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 组件漏洞扫描"
        description="对第三方 Skill、MCP Server 与插件做静态安全分析，不执行被测组件。"
      />
      <NoteBar>
        两种检测方式均不执行被测组件：上传源码时静态分析代码与说明文档，不执行上传的代码；连接运行中的
        MCP 服务时只读取工具清单，不调用工具。动态行为请到
        <Link to="/eval-tasks" className="mx-1 font-medium text-brand-600 hover:underline">
          评估任务 · 智能体行为与工具
        </Link>
        评估。扫描无需预先创建评估任务，需要纳入报告时在扫描详情中“关联评估任务”。
        {caps && !caps.vulnDb ? ' 依赖漏洞库尚未启用，暂不检测已知漏洞依赖。' : ''}
      </NoteBar>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <ScanForm
          canScan={canScan}
          onCreated={(id) => {
            setPage(1);
            refresh();
            setOpenId(id);
          }}
        />
        <SectionCard
          title="扫描记录"
          description="检测工具投毒、隐藏指令、命令执行、数据外发、硬编码密钥、权限过大与工具描述变更。"
          extra={
            <Input
              aria-label="按资产名称搜索"
              className="w-56"
              placeholder="按资产名称/来源搜索"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
          }
        >
          <ScanList
            data={list.data}
            loading={list.isLoading}
            page={page}
            onPage={setPage}
            selectedId={openId}
            onOpen={setOpenId}
          />
        </SectionCard>
      </div>
      {caps?.vulnDb ? <VulnDataAttribution /> : null}
      {openId ? (
        <Modal open onClose={() => setOpenId(null)} title="扫描详情" size="xl">
          <ScanDetail
            key={openId}
            id={openId}
            canScan={canScan}
            onChanged={(id) => {
              refresh();
              setOpenId(id);
            }}
            onDeleted={() => {
              setOpenId(null);
              refresh();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

/** 依赖漏洞库数据的出处（Apache-2.0 NOTICE 与 CC BY 4.0 要求的署名）。 */
function VulnDataAttribution() {
  const link = 'text-ink-3 underline hover:text-brand-600';
  return (
    <p className="text-xs leading-5 text-ink-3">
      Based on Tencent Zhuque Lab AI-Infra-Guard. 漏洞数据部分来自{' '}
      <a
        href="https://github.com/Tencent/AI-Infra-Guard"
        target="_blank"
        rel="noreferrer"
        className={link}
      >
        Tencent Zhuque Lab AI-Infra-Guard
      </a>
      （Apache-2.0）；部分来自 GitHub Advisory Database 与 PyPI Advisory Database（经 OSV 汇总，
      <a
        href="https://creativecommons.org/licenses/by/4.0/"
        target="_blank"
        rel="noreferrer"
        className={link}
      >
        CC BY 4.0
      </a>
      ），已筛选并转换格式。
    </p>
  );
}
