import {
  FLEET_LIVE_PRODUCTS,
  type FleetLiveProduct,
  type LiveRiskType,
} from '../../../../../packages/shared/src/fleet-live-eval';
import type { CheckCatalog, FleetEndpointAgent } from '@/lib/api';
import { productLabel } from '@/lib/endpoint-agents';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { NoteBox } from '@/components/page-kit/NoteBox';

export interface LiveEvalSelection {
  product: string;
  riskTypes: LiveRiskType[];
  confirmed: boolean;
}

/** 终端页与新建评估共用的真机测评参数，登记缺失时不推定可执行。 */
export function LiveEvalParameters({
  agents,
  catalog,
  value,
  onChange,
  disabled = false,
}: {
  agents: FleetEndpointAgent[];
  catalog: CheckCatalog;
  value: LiveEvalSelection;
  onChange: (next: LiveEvalSelection) => void;
  disabled?: boolean;
}) {
  const risks = catalog.liveRiskTypes ?? [];
  const change = (next: Partial<LiveEvalSelection>) =>
    onChange({ ...value, ...next, confirmed: false });
  return (
    <div className="space-y-4">
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-medium">测评的智能体</legend>
        {!agents.length && <p>终端尚未上报智能体清单，请更新探针并等待上报后再试。</p>}
        {agents.length > 0 && !agents.some((a) => typeof a.liveEvalRegistered === 'boolean') && (
          <p>尚未上报智能体登记信息，请更新探针，并由终端管理员登记允许测评的智能体后等待上报。</p>
        )}
        {agents.map((agent, index) => {
          const available =
            agent.liveEvalRegistered === true &&
            agent.liveEvalSupported === true &&
            FLEET_LIVE_PRODUCTS.includes(agent.product as FleetLiveProduct);
          return (
            <Card key={`${agent.product}-${agent.version}-${index}`} className="p-4 text-sm">
              <label className="flex gap-2">
                <input
                  type="radio"
                  name="live-eval-product"
                  checked={value.product === agent.product}
                  disabled={!available}
                  onChange={() => change({ product: agent.product })}
                />
                {agent.displayName || productLabel(agent.product)} · {agent.version || '版本未知'}
              </label>
              <div className="my-2 ml-5"><Badge tone={available ? 'info' : 'neutral'}>{available ? '可发起真机测评' : '暂不能发起真机测评'}</Badge></div>
              {!available && (
                <p className="ml-5 text-ink-3">
                  {agent.liveEvalBlockedReason ||
                    (agent.liveEvalRegistered !== true
                      ? '终端尚未登记此智能体。请终端管理员登记允许测评的智能体，并等待探针上报后再试。'
                      : '当前执行器不支持此智能体，请更新终端测评执行器后再试。')}
                </p>
              )}
            </Card>
          );
        })}
      </fieldset>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-medium">选择要检查的风险类型</legend>
        {!risks.length && <p>平台尚未提供风险类型清单，请联系平台管理员更新后再发起真机测评。</p>}
        {risks.map((risk) => (
          <label key={risk.id} className="block rounded-card border border-line bg-white p-5 text-sm shadow-card">
            <span className="flex gap-2">
              <input
                type="checkbox"
                checked={value.riskTypes.includes(risk.id)}
                onChange={() =>
                  change({
                    riskTypes: value.riskTypes.includes(risk.id)
                      ? value.riskTypes.filter((id) => id !== risk.id)
                      : [...value.riskTypes, risk.id],
                  })
                }
              />
              {risk.label}
            </span>
            <span className="mt-1 block">让它做什么：{risk.what}</span>
            <span className="block text-ink-3">如何判断：{risk.howJudged}</span>
          </label>
        ))}
      </fieldset>
      <NoteBox tone="warning" className="space-y-2">
        <strong>{catalog.liveSummary.title}</strong>
        <ol className="list-inside list-decimal">
          {catalog.liveSummary.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p>{catalog.liveSummary.consumesQuota}</p>
        <p>{catalog.liveSummary.isolationNote}</p>
        <p>{catalog.liveSummary.cleanup}</p>
        <p>
          会在被测电脑的临时测试目录启动真实智能体并记录操作；测试文件可清理，已消耗的模型额度及已产生的调用记录不能撤销。
        </p>
      </NoteBox>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.confirmed}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, confirmed: e.target.checked })}
        />
        我已了解以上影响
      </label>
    </div>
  );
}

export function liveSelectionReady(
  agents: FleetEndpointAgent[],
  value: LiveEvalSelection,
): boolean {
  return (
    value.confirmed &&
    value.riskTypes.length > 0 &&
    agents.some(
      (agent) =>
        agent.product === value.product &&
        agent.liveEvalRegistered === true &&
        agent.liveEvalSupported === true &&
        FLEET_LIVE_PRODUCTS.includes(agent.product as FleetLiveProduct),
    )
  );
}
