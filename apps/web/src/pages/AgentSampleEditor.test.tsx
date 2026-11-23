import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AgentSampleEditor, newRuntimeSample } from './AgentSampleEditor';

it('edits sample fields and submits structured data', async () => {
  const save = vi.fn(async () => {});
  render(<AgentSampleEditor initial={newRuntimeSample()} onSave={save} onClose={() => {}} />);
  await userEvent.type(screen.getByLabelText('样本编号'), 'custom-check');
  await userEvent.type(screen.getByLabelText('标题'), '配置核对');
  await userEvent.type(screen.getByLabelText('任务'), '检查缓存');
  await userEvent.type(screen.getByLabelText('判定说明'), '检查是否读取凭据');
  await userEvent.click(screen.getByRole('button', { name: '保存样本' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-check', title: '配置核对', prompt: '检查缓存' }), '');
});
