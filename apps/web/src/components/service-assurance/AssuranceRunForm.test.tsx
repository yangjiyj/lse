import type { ServiceAssuranceReadinessResponse } from '@lse/shared';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { EvalTask, ServiceAssuranceCreateRequest } from '@/lib/api';
import { AssuranceRunForm } from './AssuranceRunForm';

function task(id: string, name: string, baseUrl?: string): EvalTask {
  return {
    id,
    name,
    description: null,
    status: 'COMPLETED',
    modelTarget: {
      id: `target-${id}`,
      name: `${name}模型`,
      provider: 'openai-compatible',
      ...(baseUrl === undefined ? {} : { baseUrl }),
      model: 'qwen-test',
    } as EvalTask['modelTarget'],
    engines: [],
    dimensions: [],
    concurrency: 1,
    totalQuestions: 0,
    processedQuestions: 0,
    passedCount: 0,
    failedCount: 0,
    errorCount: 0,
    progress: 1,
    questionSetCount: 0,
    resultCount: 0,
    logCount: 0,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

const taskA = task('task-a', '任务 A', 'https://model-a.example.test/v1');
const taskB = task('task-b', '任务 B', 'https://model-b.example.test:8443/v1');
const scopes = [
  {
    ref: 'all-test-targets',
    name: '测试授权范围',
    origins: [
      'https://model-a.example.test',
      'https://model-b.example.test:8443',
      'https://gateway.example.test',
    ],
    cidrs: [],
    allowPrivate: false,
    allowPublic: true,
    isDefault: true,
  },
];

function renderForm(
  tasks: EvalTask[] = [taskA, taskB],
  initialTaskId = tasks[0]?.id ?? '',
  onSubmit = vi.fn<(body: ServiceAssuranceCreateRequest) => void>(),
  readiness: ServiceAssuranceReadinessResponse = {
    modes: [
      { mode: 'SAFE', ready: true, message: '基础检查已就绪。', baselineUpdatedAt: null },
      { mode: 'SBOM', ready: true, message: '组件清单核验已就绪。', baselineUpdatedAt: null },
    ],
  },
) {
  function Harness() {
    const [selectedTaskId, setSelectedTaskId] = useState(initialTaskId);
    return (
      <MemoryRouter>
        <AssuranceRunForm
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onTaskChange={setSelectedTaskId}
          readiness={readiness}
          scopePolicies={scopes}
          canScan={true}
          canVerify={true}
          canManageScopes={false}
          submitting={false}
          onSubmit={onSubmit}
        />
      </MemoryRouter>
    );
  }

  return { ...render(<Harness />), onSubmit };
}

describe('AssuranceRunForm 归属评估任务', () => {
  it('用所选任务的模型地址初始化目标，并在仍为旧默认值时随任务切换', async () => {
    renderForm();

    expect(screen.getByLabelText('归属评估任务（可选）')).toBeInTheDocument();
    expect(
      screen.getByText(
        '默认不关联。需要纳入某个评估任务的汇总报告时再选择，也可在核验完成后关联。',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('目标地址')).toHaveValue('https://model-a.example.test/v1'),
    );

    await userEvent.selectOptions(screen.getByLabelText('归属评估任务（可选）'), taskB.id);

    await waitFor(() =>
      expect(screen.getByLabelText('目标地址')).toHaveValue('https://model-b.example.test:8443/v1'),
    );
  });

  it('用户手动修改目标后切换任务不会覆盖脏值', async () => {
    renderForm();
    const targetInput = screen.getByLabelText('目标地址');
    await waitFor(() => expect(targetInput).toHaveValue('https://model-a.example.test/v1'));

    await userEvent.clear(targetInput);
    await userEvent.type(targetInput, 'https://gateway.example.test/v1');
    await userEvent.selectOptions(screen.getByLabelText('归属评估任务（可选）'), taskB.id);

    expect(targetInput).toHaveValue('https://gateway.example.test/v1');
  });

  it('只按 origin 软提醒不一致，同 origin 不提醒且不阻断提交', async () => {
    const { onSubmit } = renderForm();
    const targetInput = screen.getByLabelText('目标地址');
    await waitFor(() => expect(targetInput).toHaveValue('https://model-a.example.test/v1'));

    await userEvent.clear(targetInput);
    await userEvent.type(targetInput, 'https://model-a.example.test/other?query=1');
    expect(
      screen.queryByText('该地址与所选任务的模型服务地址不一致；结果仍会记入该任务。'),
    ).not.toBeInTheDocument();

    await userEvent.clear(targetInput);
    await userEvent.type(targetInput, 'https://gateway.example.test/v1');
    expect(
      screen.getByText('该地址与所选任务的模型服务地址不一致；结果仍会记入该任务。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起核验' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: taskA.id,
        targetUrl: 'https://gateway.example.test/v1',
      }),
    );
  });

  it.each([
    ['缺失', task('task-missing', '无地址任务')],
    ['非法', task('task-invalid', '非法地址任务', 'not a url')],
  ])('baseUrl %s时不显示不一致提示且不抛错', async (_label, selectedTask) => {
    renderForm([selectedTask]);
    const targetInput = screen.getByLabelText('目标地址');
    await userEvent.clear(targetInput);
    await userEvent.type(targetInput, 'https://gateway.example.test/v1');

    expect(
      screen.queryByText('该地址与所选任务的模型服务地址不一致；结果仍会记入该任务。'),
    ).not.toBeInTheDocument();
  });

  it('SBOM 模式切换归属任务不提交或校验目标地址', async () => {
    const taskWithoutUrl = task('task-empty', '空地址任务');
    const { onSubmit } = renderForm([taskWithoutUrl, taskB], taskWithoutUrl.id);
    await userEvent.click(screen.getByRole('button', { name: '组件清单核验' }));
    await userEvent.selectOptions(screen.getByLabelText('归属评估任务（可选）'), taskB.id);
    expect(screen.queryByLabelText('目标地址')).not.toBeInTheDocument();

    const file = new File(['{"bomFormat":"CycloneDX","components":[]}'], 'sbom.json', {
      type: 'application/json',
    });
    await userEvent.upload(screen.getByLabelText('组件清单文件'), file);
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('targetUrl');
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ taskId: taskB.id, mode: 'SBOM' });
  });
  it('归属任务可选：默认不关联且无任务时也能发起，提交不含 taskId', async () => {
    const onSubmit = vi.fn<(body: ServiceAssuranceCreateRequest) => void>();
    renderForm([], '', onSubmit);
    expect(screen.getByLabelText('归属评估任务（可选）')).toHaveValue('');
    expect(screen.getByRole('option', { name: '不关联' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('目标地址'), 'https://model-a.example.test/v1');
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('taskId');
  });

  it('默认基础检查并按主机命名，MCP 不能作为新建目标', async () => {
    const { onSubmit } = renderForm();
    await waitFor(() =>
      expect(screen.getByLabelText('目标名称')).toHaveValue('model-a.example.test'),
    );
    expect(screen.getByRole('option', { name: 'MCP 服务（专项检查暂未支持）' })).toBeDisabled();
    // MCP 的出路：指向 AI 组件漏洞扫描，且不再重复写“暂未支持”
    const mcpLink = screen.getByRole('link', { name: /AI 组件漏洞扫描/ });
    expect(mcpLink).toHaveAttribute('href', '/ai-asset-scan');
    expect(screen.getByText(/MCP 服务请使用/)).toBeInTheDocument();
    expect(screen.queryByText(/已有 MCP 核验记录仍可查看/)).not.toBeInTheDocument();
    expect(screen.getByText('响应类型防护头检查')).toBeInTheDocument();
    expect(screen.getByText('Triton 服务识别')).toBeInTheDocument();
    expect(screen.getByText(/访问身份：未携带凭据/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: 'model-a.example.test',
      }),
    );
  });

  it('按 OpenAPI 目标可用状态阻止提交，不将模型地址当作接口描述', async () => {
    renderForm([taskA], taskA.id, vi.fn(), {
      modes: [{ mode: 'SAFE', ready: true, message: '基础检查可用', baselineUpdatedAt: null }],
      targets: [
        {
          mode: 'SAFE',
          targetKind: 'ENDPOINT',
          ready: true,
          message: '普通服务检查可用',
          baselineUpdatedAt: null,
        },
        {
          mode: 'SAFE',
          targetKind: 'OPENAPI',
          ready: false,
          message: '接口描述检查尚未就绪',
          baselineUpdatedAt: null,
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByLabelText('目标地址')).toHaveValue(taskA.modelTarget?.baseUrl),
    );
    await userEvent.selectOptions(screen.getByLabelText('目标类型'), 'OPENAPI');
    expect(screen.getByLabelText('目标地址')).toHaveValue('');
    expect(
      screen.getByPlaceholderText('https://service.example.com/openapi.json'),
    ).toBeInTheDocument();
    expect(screen.getByText('接口描述检查尚未就绪')).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText('目标地址'),
      'https://model-a.example.test/openapi.json',
    );
    expect(screen.getByRole('button', { name: '发起核验' })).toBeDisabled();
  });

  it('附加检查保留基础清单并要求显式授权', async () => {
    const { onSubmit } = renderForm([taskA], taskA.id, vi.fn(), {
      modes: [
        { mode: 'SAFE', ready: true, message: '基础检查已就绪', baselineUpdatedAt: null },
        { mode: 'DEEP', ready: true, message: '附加检查已就绪', baselineUpdatedAt: null },
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: '基础及附加授权检查' }));
    expect(screen.getByText('响应类型防护头检查')).toBeInTheDocument();
    expect(screen.getByText('管理状态接口未授权检查')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起核验' })).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: '我确认已取得该目标的附加检查授权' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '发起核验' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'DEEP', authorizationConfirmed: true }),
    );
  });
});
