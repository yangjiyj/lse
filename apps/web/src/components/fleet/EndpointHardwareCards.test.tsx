import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { EndpointHardware } from '../../../../../packages/shared/src/endpoint-hardware';
import { EndpointHardwareCards } from './EndpointHardwareCards';

const hardware: EndpointHardware = {
  collectedAt: '2026-11-21T08:00:00Z',
  os: 'linux',
  osVersion: 'Ubuntu 22.04.4 LTS',
  platform: 'ubuntu',
  platformVersion: '22.04',
  kernelVersion: '5.15.0-105-generic',
  arch: 'amd64',
  cpuModel: 'Intel(R) Xeon(R) Platinum 8480+',
  cpuCores: 112,
  cpuCountLogical: 224,
  memoryTotalMB: 2063679,
  disks: [
    {
      mountpoint: '/',
      fsType: 'ext4',
      totalBytes: 1_000_000_000_000,
      freeBytes: 300_000_000_000,
      usedPct: 70,
    },
  ],
  accelerators: [
    {
      vendor: 'nvidia',
      model: 'NVIDIA H100 80GB HBM3',
      memoryMB: 81559,
      driverVersion: '580.65.06',
      index: 0,
      busId: '0000:42:00.0',
      source: 'nvidia-smi',
    },
    { vendor: 'cambricon', model: 'PCI cabc:0590', busId: '0000:81:00.0', source: 'pci' },
  ],
  acceleratorErrors: null,
  aiComponentErrors: null,
  aiComponents: [
    {
      id: 'torch',
      name: 'PyTorch',
      category: 'training',
      version: '2.3.1+cu121',
      source: 'python_package',
      package: 'torch',
      env: 'venv',
    },
    {
      id: 'vllm',
      name: 'vLLM',
      category: 'inference',
      version: '0.6.1',
      source: 'python_package',
      package: 'vllm',
      env: 'conda',
    },
    {
      id: 'milvus',
      name: 'Milvus',
      category: 'vector_db',
      source: 'container_image',
      package: 'milvusdb/milvus',
      version: 'v2.4.5',
    },
  ],
};

it('有算力卡时渲染算力卡表格，框架按类别分组', () => {
  render(<EndpointHardwareCards hardware={hardware} />);
  const card = screen.getByRole('region', { name: '硬件' });
  expect(card).toHaveTextContent('Intel(R) Xeon(R) Platinum 8480+');
  expect(card).toHaveTextContent('112 核 224 线程');
  expect(card).toHaveTextContent('5.15.0-105-generic');
  const table = within(card).getByRole('table', { name: '算力卡' });
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(rows[1]).toHaveTextContent('NVIDIA');
  expect(rows[1]).toHaveTextContent('NVIDIA H100 80GB HBM3');
  expect(rows[1]).toHaveTextContent('79.6 GB');
  expect(rows[1]).toHaveTextContent('580.65.06');
  expect(rows[2]).toHaveTextContent('寒武纪');
  expect(rows[2]).toHaveTextContent('PCI 设备');

  const components = screen.getByRole('region', { name: '框架与组件' });
  const groups = within(components)
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent);
  expect(groups).toEqual(['训练框架', '推理框架', '向量数据库']);
  expect(within(components).getByRole('table', { name: '训练框架' })).toHaveTextContent(
    '2.3.1+cu121',
  );
  expect(within(components).getByRole('table', { name: '向量数据库' })).toHaveTextContent(
    '容器镜像',
  );
});

it('旧探针没有算力卡和框架字段时显示「—」', () => {
  render(
    <EndpointHardwareCards hardware={{ ...hardware, accelerators: null, aiComponents: null }} />,
  );
  const card = screen.getByRole('region', { name: '硬件' });
  expect(within(card).queryByRole('table')).toBeNull();
  expect(within(card).getByTestId('accelerators')).toHaveTextContent(/^—$/);
  const components = screen.getByRole('region', { name: '框架与组件' });
  expect(within(components).queryByRole('table')).toBeNull();
  expect(components).toHaveTextContent('—');
});

it('采集不完整时写明原因，完整时不加说明', () => {
  render(
    <EndpointHardwareCards
      hardware={{
        ...hardware,
        accelerators: [],
        acceleratorErrors: ['accelerators_unavailable', 'accelerator_tool_untrusted'],
        aiComponentErrors: ['python_env_limit_exceeded', 'new_code'],
      }}
    />,
  );
  const card = screen.getByRole('region', { name: '硬件' });
  expect(within(card).getByTestId('incomplete')).toHaveTextContent(
    '采集不完整：未能读取设备列表；厂商命令文件权限不安全，未执行',
  );
  expect(within(card).getByTestId('accelerators')).toHaveTextContent(/^—$/);
  const components = screen.getByRole('region', { name: '框架与组件' });
  expect(within(components).getByTestId('incomplete')).toHaveTextContent(
    '采集不完整：Python 环境过多，未全部识别；new_code',
  );
});

it('完整上报不显示采集不完整', () => {
  render(
    <EndpointHardwareCards
      hardware={{ ...hardware, acceleratorErrors: [], aiComponentErrors: [] }}
    />,
  );
  expect(screen.queryByTestId('incomplete')).toBeNull();
});

it('没有任何上报时各项都显示「—」', () => {
  render(<EndpointHardwareCards hardware={null} />);
  const card = screen.getByRole('region', { name: '硬件' });
  for (const label of ['CPU', '内存', '磁盘', '系统', '内核']) {
    expect(within(card).getByText(label).nextElementSibling).toHaveTextContent(/^—$/);
  }
  expect(within(card).getByTestId('accelerators')).toHaveTextContent(/^—$/);
});
