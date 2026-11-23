import { createElement, useState } from 'react';
import { PostureChecksModal } from '@/components/fleet/PostureChecksModal';
import type { FleetEndpoint } from '@/lib/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type ModelTarget } from '@/lib/api';
import { fleetEndpointIdOf } from '@/lib/fleet';
import { useToast } from '@/components/ui/toast';

export type EndpointEvalMode = 'posture' | 'run';

export const ENDPOINT_EVAL_MODE_LABELS: Record<EndpointEvalMode, string> = {
  posture: '配置体检',
  run: '真机测评',
};

type LaunchResult = { taskId: string } | { showParameters: true };

/**
 * 发起终端智能体的「配置体检 / 真机测评」：评估对象页与新建评估共用，行为与文案保持一致。
 * 自管终端生成的对象走 /fleet 接口（它们的接入配置里没有智能体安全平台的连接信息，
 * 走连接器会被参数校验拒绝）；其余对象走智能体安全平台连接器。
 * 调用方没传 target 时按 id 读取一次，读取失败按连接器对象处理。
 */
export function useEndpointEvalLauncher() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [request, setRequest] = useState<FleetEndpoint | null>(null);
  const mutation = useMutation({
    mutationFn: async ({
      id,
      mode,
      target,
    }: {
      id: string;
      mode: EndpointEvalMode;
      target?: Pick<ModelTarget, 'provider' | 'accessConfig'>;
    }): Promise<LaunchResult> => {
      let known = target;
      if (!known) {
        try {
          known = await api.modelTargets.get(id);
        } catch {
          known = undefined;
        }
      }
      const fleetId = known ? fleetEndpointIdOf(known) : null;
      if (!fleetId) {
        if (mode === 'run')
          throw new Error(
            '旧连接器尚未提供智能体登记和风险范围选择，请通过「终端」接入该电脑后再发起真机测评；当前不会在终端运行任何测试。',
          );
        return api.endpointEvals.posture(id);
      }
      if (mode === 'run') {
        navigate(`/agent-evals/new?endpoint=${encodeURIComponent(fleetId)}`);
        return { showParameters: true };
      }
      setRequest(await api.fleet.endpoint(fleetId));
      return { showParameters: true };
    },
    onSuccess: (result) => {
      if ('showParameters' in result) return;
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      navigate(`/eval-tasks/${result.taskId}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '终端测评发起失败'),
  });
  return {
    ...mutation,
    dialog: request
      ? createElement(PostureChecksModal, {
          endpoint: request,
          onClose: () => setRequest(null),
          onStarted: (taskId: string) => {
            setRequest(null);
            void qc.invalidateQueries({ queryKey: ['eval-tasks'] });
            navigate(`/eval-tasks/${taskId}`);
          },
        })
      : null,
  };
}
