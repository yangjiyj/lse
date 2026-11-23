import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { ScanDetail } from './ScanResults';
import { RuleCatalog } from './RuleCatalog';

const { scan, risks } = vi.hoisted(() => {
  const base = {
    id: 's1',
    source: 'DIRECTORY',
    path: '/models',
    targetId: null,
    target: null,
    status: 'COMPLETED',
    error: null,
    fileCount: 6,
    totalBytes: 4096,
    skippedCount: 0,
    highCount: 1,
    mediumCount: 0,
    lowCount: 0,
    hasAibom: false,
    createdBy: null,
    createdAt: '2026-11-21T00:00:00.000Z',
    progressFiles: 6,
    progressBytes: 4096,
    plannedFiles: 6,
    plannedBytes: 4096,
    truncatedCount: 0,
    truncatedReason: null,
  };
  const known = {
    repo: 'Qwen/Qwen2.5-7B-Instruct',
    name: 'Qwen2.5-7B-Instruct',
    family: 'Qwen',
    kind: 'instruct',
    kindLabel: '指令微调',
    baseModel: 'Qwen/Qwen2.5-7B',
    file: 'model-00001-of-00004.safetensors',
    source: 'https://hf-mirror.com/Qwen/Qwen2.5-7B-Instruct/tree/abc',
  };
  const file = (path: string, format: string, meta: Record<string, unknown>) => ({
    path,
    format,
    bytes: 1024,
    sha256: 'a'.repeat(64),
    meta,
  });
  return {
    scan: {
      ...base,
      files: [
        ...['model-00001-of-00004.safetensors', 'model-00002-of-00004.safetensors'].map((p) =>
          file(`qwen/${p}`, 'safetensors', {
            knownModel: known,
            knownModelLabel: '已知模型：Qwen2.5-7B-Instruct（指令微调）',
            identification: {
              verdict: 'finetuned',
              verdictLabel: '微调（全参）',
              baseModel: 'Qwen/Qwen2.5-7B',
              basis: ['sha256 命中已知模型库：Qwen/Qwen2.5-7B-Instruct'],
            },
          }),
        ),
        file('gguf/my-q4_k_m.gguf', 'gguf', {
          knownModel: null,
          knownModelLabel: '未在已知模型库中',
          identification: {
            verdict: 'quantized',
            verdictLabel: '量化',
            quantization: 'Q4_K_M',
            basis: ['GGUF general.file_type=15（Q4_K_M）'],
          },
        }),
        file('llama/model-00001-of-00004.safetensors', 'safetensors', {
          knownModel: {
            repo: 'meta-llama/Meta-Llama-3-8B',
            name: 'Meta-Llama-3-8B',
            family: 'Llama',
            kind: 'base',
            kindLabel: '基座',
            official: true,
            verifiedVia: 'NousResearch/Meta-Llama-3-8B',
            file: 'model-00001-of-00004.safetensors',
            source: 'https://huggingface.co/meta-llama/Meta-Llama-3-8B',
          },
          knownModelLabel: '已知模型：Meta-Llama-3-8B（基座）',
          identification: {
            verdict: 'original',
            verdictLabel: '原始',
            basis: ['sha256 命中已知模型库：meta-llama/Meta-Llama-3-8B'],
          },
        }),
        file('plain/model.safetensors', 'safetensors', {
          knownModel: null,
          knownModelLabel: '未在已知模型库中',
          identification: {
            verdict: 'unidentified',
            verdictLabel: '未识别',
            dtype: 'bfloat16',
            basis: ['未发现量化、适配器、合并或训练痕迹'],
          },
        }),
        file('qwen/config.json', 'config', {}),
        file('scripts/evil.py', 'python', {}),
      ],
    },
    risks: {
      groups: [
        {
          format: 'python',
          total: 1,
          items: [
            {
              id: 'r1',
              scanId: 's1',
              filePath: 'scripts/evil.py',
              format: 'python',
              severity: 'CRITICAL',
              ruleId: 'code.obfuscated_execution',
              title: '混淆后执行代码',
              evidence: "第 2 行：exec(base64.b64decode('x'))",
            },
          ],
        },
        {
          format: 'vba',
          total: 1,
          items: [
            {
              id: 'r2',
              scanId: 's1',
              filePath: 'office/evil.xlsm',
              format: 'vba',
              severity: 'CRITICAL',
              ruleId: 'vba.auto_exec_payload',
              title: '自动执行的宏调用命令或下载',
              evidence: 'xl/vbaProject.bin: 入口：Sub AutoOpen()',
            },
          ],
        },
      ],
    },
  };
});

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  modelFilesApi: {
    get: vi.fn().mockResolvedValue(scan),
    findings: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    scriptRisks: vi.fn().mockResolvedValue(risks),
    exportAibom: vi.fn(),
    cancel: vi.fn(),
    rules: vi.fn().mockResolvedValue({
      total: 4,
      detectTotal: 3,
      noteTotal: 1,
      items: [
        {
          id: 'PICKLE_DANGEROUS_GLOBAL',
          category: '模型文件格式',
          kind: 'detect',
          severity: 'HIGH',
          title: 'Pickle 加载时可执行危险对象',
          description: '引用 os.system 等。',
        },
        {
          id: 'vba.auto_exec',
          category: 'VBA 宏',
          kind: 'detect',
          severity: 'MEDIUM',
          title: '宏含自动执行入口',
          description: 'AutoOpen 等。',
        },
        {
          id: 'vba.download',
          category: 'VBA 宏',
          kind: 'detect',
          severity: 'HIGH',
          title: '宏下载网络内容',
          description: 'URLDownloadToFile 等。',
        },
        {
          id: 'SAFETENSORS_VALIDATED',
          category: '模型文件格式',
          kind: 'note',
          severity: 'INFO',
          title: 'safetensors 结构检查通过',
          description: '张量头与数据区间校验通过。',
        },
      ],
    }),
  },
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>
  );
}

describe('模型文件扫描明细：模型识别与脚本风险', () => {
  it('已知模型显示名称、类型和来源仓库；同目录同结论的分片合成一行', async () => {
    render(wrap(<ScanDetail id="s1" />));
    const section = await screen.findByRole('region', { name: '模型识别' });
    const rows = within(section).getAllByRole('row');
    expect(rows).toHaveLength(5);
    const known = rows.find((r) => r.textContent?.includes('Qwen2.5-7B-Instruct（指令微调）'))!;
    expect(within(known).getByText('qwen/（2 个文件）')).toBeInTheDocument();
    expect(within(known).getByText('微调（全参）')).toBeInTheDocument();
    expect(within(known).getByText('Qwen/Qwen2.5-7B')).toBeInTheDocument();
    expect(within(known).getByRole('link', { name: 'Qwen/Qwen2.5-7B-Instruct' })).toHaveAttribute(
      'href',
      'https://hf-mirror.com/Qwen/Qwen2.5-7B-Instruct/tree/abc',
    );
  });

  it('哈希经社区转存核对的官方模型：显示官方仓库并注明核对来源；查不到且无痕迹的显示未识别', async () => {
    render(wrap(<ScanDetail id="s1" />));
    const section = await screen.findByRole('region', { name: '模型识别' });
    const llama = within(section)
      .getByText('llama/model-00001-of-00004.safetensors')
      .closest('tr')!;
    expect(
      within(llama).getByRole('link', { name: 'meta-llama/Meta-Llama-3-8B' }),
    ).toBeInTheDocument();
    expect(within(llama).getByText('哈希经 NousResearch/Meta-Llama-3-8B 核对')).toBeInTheDocument();
    const plain = within(section).getByText('plain/model.safetensors').closest('tr')!;
    expect(within(plain).getByText('未识别')).toBeInTheDocument();
    expect(within(plain).queryByText(/哈希经/)).toBeNull();
  });

  it('未知模型显示「未在已知模型库中」和按元数据识别的量化类型', async () => {
    render(wrap(<ScanDetail id="s1" />));
    const section = await screen.findByRole('region', { name: '模型识别' });
    const row = within(section).getByText('gguf/my-q4_k_m.gguf').closest('tr')!;
    expect(within(row).getByText('未在已知模型库中')).toBeInTheDocument();
    expect(within(row).getByText('量化')).toBeInTheDocument();
    expect(within(row).getByText('Q4_K_M')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(section).queryByText('qwen/config.json')).toBeNull();
  });

  it('脚本风险按语言分组', async () => {
    render(wrap(<ScanDetail id="s1" />));
    const section = await screen.findByRole('region', { name: '脚本风险' });
    const py = within(section).getByRole('group', { name: 'Python' });
    expect(within(py).getByText('scripts/evil.py')).toBeInTheDocument();
    expect(within(py).queryByText('office/evil.xlsm')).toBeNull();
    const vba = within(section).getByRole('group', { name: 'VBA 宏' });
    expect(within(vba).getByText('office/evil.xlsm')).toBeInTheDocument();
    expect(within(vba).getByText('自动执行的宏调用命令或下载')).toBeInTheDocument();
  });

  it('按钮显示检测规则数，点开按类别列出检测规则，提示类单独列', async () => {
    render(wrap(<RuleCatalog />));
    fireEvent.click(await screen.findByRole('button', { name: '检测规则 3 条' }));
    const dialog = await screen.findByRole('dialog');
    const vba = within(dialog).getByRole('group', { name: 'VBA 宏' });
    expect(within(vba).getByText('vba.auto_exec')).toBeInTheDocument();
    expect(within(vba).getByText('宏下载网络内容')).toBeInTheDocument();
    const format = within(dialog).getByRole('group', { name: '模型文件格式' });
    expect(within(format).queryByText('SAFETENSORS_VALIDATED')).toBeNull();
    const notes = within(dialog).getByRole('group', { name: '提示' });
    expect(within(notes).getByText('SAFETENSORS_VALIDATED')).toBeInTheDocument();
  });
});
