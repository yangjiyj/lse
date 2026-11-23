import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, type ModelTarget, type GatewayDrillScenario } from '@/lib/api';

interface GatewayDrillModalProps {
  target: ModelTarget | null;
  onClose: () => void;
}

// mode3 honeytoken 无害化演练：一键生成「假诱饵 + 投毒工件 + 建议网关规则」。

// 网关规则动作的用户可读标签。
function ruleActionLabel(action: string): string {
  const map: Record<string, string> = { audit: '仅记录', block: '拦截' };
  return map[action] ?? '仅记录';
}

// 投毒工件的投递渠道 → 中文场景名，避免直接显示英文 id。
function channelLabel(channel: string): string {
  const map: Record<string, string> = {
    email: '邮件',
    web: '网页',
    file: '文档',
    document: '文档',
    im: '即时消息',
  };
  return map[channel] ?? channel;
}

export function GatewayDrillModal({ target, onClose }: GatewayDrillModalProps) {
  const toast = useToast();
  const [drill, setDrill] = useState<GatewayDrillScenario | null>(null);

  useEffect(() => {
    if (!target) setDrill(null);
  }, [target]);

  const mutation = useMutation({
    mutationFn: () => api.gatewayLogs.drillPrepare({}),
    onSuccess: (res) => setDrill(res.drill),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '生成演练失败'),
  });

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toast.success('已复制');
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title="诱饵数据外发演练"
      size="md"
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs leading-6 text-sky-900">
          平台生成一段<b>诱饵数据</b>，用于验证评估对象是否发生非授权外发。
          <b>演练不使用真实敏感数据，建议规则默认仅记录不拦截。</b>
        </div>

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-6 text-slate-700">
          <p className="mb-1 text-sm font-semibold text-slate-800">演练步骤</p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>平台生成包含诱饵数据的测试文件；</li>
            <li>由业务部门使用目标 AI 应用处理该文件；</li>
            <li>返回平台分析日志，确认诱饵数据是否发生外发。</li>
          </ol>
          <p className="mt-1 text-slate-500">全程只记录不拦截，不影响正常业务。</p>
          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-slate-600">查看技术细节</summary>
            <p className="mt-1 leading-6 text-slate-500">
              平台生成诱饵数据、测试工件和建议网关规则。业务部门使用目标智能体处理工件后，
              通过网关审计日志核验诱饵数据是否外发。
            </p>
          </details>
        </div>

        {!drill ? (
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? '生成中…' : '生成测试文件'}
          </Button>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                本次追踪码（用于分析日志中的外发核验）
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
                  {drill.canaryToken}
                </code>
                <Button variant="ghost" size="sm" onClick={() => copy(drill.canaryToken)}>
                  复制
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                追踪码已嵌入测试文件。若评估对象将其外发，可在网关日志中进行精确匹配。
              </p>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground">
                建议在安全网关加的监控规则（只记录、不拦截）
              </div>
              <code className="mt-1 block rounded bg-muted px-2 py-1 font-mono text-xs">
                {`当出现「${drill.gatewayRule.pattern}」时：${ruleActionLabel(drill.gatewayRule.action)}并留证`}
              </code>
              <p className="mt-1 text-xs text-muted-foreground">复制后交给网关管理员添加即可。</p>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground">
                测试文件（由业务部门使用目标 AI 应用处理）
              </div>
              <div className="mt-1 space-y-2">
                {drill.artifacts.map((artifact) => (
                  <div key={artifact.channel} className="rounded-md border border-border p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-medium text-foreground">
                        {artifact.title}（{channelLabel(artifact.channel)}）
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => copy(artifact.content)}>
                        复制
                      </Button>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs leading-5 text-foreground">
                      {artifact.content}
                    </pre>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">
              <p>
                <b>成功判定条件：</b>
                {drill.successSignal}
              </p>
              <p className="mt-1">
                若分析日志确认追踪码外发，则本次演练已观察到非授权数据外发，应核查调用链路并完善防护。
              </p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
