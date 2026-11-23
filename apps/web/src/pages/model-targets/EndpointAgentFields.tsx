import { FLEET_LIVE_PRODUCTS, FLEET_LIVE_PRODUCT_LABELS, type FleetLiveProduct } from '../../../../../packages/shared/src/fleet-live-eval';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supportsLiveEval } from '@/lib/endpoint-agents';
import { FLEET_ENROLL_PATH, LIVE_EVAL_HOW_TO_ENABLE } from '@/lib/fleet';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { api, type EndpointInfo } from '@/lib/api';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';

export function EndpointAgentFields({
  product,
  endpointId,
  onProductChange,
  onEndpointChange,
}: {
  product: FleetLiveProduct;
  endpointId: string;
  onProductChange: (product: FleetLiveProduct) => void;
  onEndpointChange: (endpoint: EndpointInfo | undefined) => void;
}) {
  const endpoints = useQuery({
    queryKey: ['endpoint-evals-endpoints', product],
    queryFn: () => api.endpointEvals.endpoints(product),
    retry: false,
  });
  const selected = endpoints.data?.find((e) => e.endpoint_id === endpointId);
  return (
    <>
      <Field label="终端智能体产品" htmlFor="endpoint-product">
        <Select
          id="endpoint-product"
          value={product}
          onChange={(e) => onProductChange(e.target.value as FleetLiveProduct)}
        >
          {FLEET_LIVE_PRODUCTS.map((id) => <option key={id} value={id}>{FLEET_LIVE_PRODUCT_LABELS[id]}</option>)}
        </Select>
      </Field>
      <Field
        label="终端"
        htmlFor="endpoint-id"
        required
        hint="选择已接入终端防护平台的员工电脑，测评沿用终端上的真实配置。"
      >
        <Select
          aria-label="终端"
          id="endpoint-id"
          value={endpointId}
          onChange={(e) =>
            onEndpointChange(endpoints.data?.find((x) => x.endpoint_id === e.target.value))
          }
        >
          <option value="">{endpoints.isLoading ? '正在加载终端…' : '请选择终端'}</option>
          {(endpoints.data ?? []).map((e) => (
            <option key={e.endpoint_id} value={e.endpoint_id}>
              {e.hostname}
              {e.owner_display ? `（${e.owner_display}）` : ''}
            </option>
          ))}
        </Select>
      </Field>
      {endpoints.isError && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          终端列表加载失败：智能体安全平台地址未配置，或平台暂时无法访问。请联系部署管理员确认部署配置，然后重新打开本窗口重试。
        </p>
      )}
      {!endpoints.isLoading && !endpoints.isError && (endpoints.data ?? []).length === 0 && (
        <NoteBox tone="info" className="sm:col-span-2" data-testid="endpoint-empty-guide">
          <p className="font-semibold text-ink">还没有可选的终端</p>
          <p className="mt-1">
            尚未发现已接入的终端。已接入智能体安全平台的终端会自动出现在这里；新终端可前往「接入终端」查看如何接入。
          </p>
          <Link
            to={FLEET_ENROLL_PATH}
            className="mt-1.5 inline-block font-semibold text-primary hover:underline"
          >
            查看接入终端
          </Link>
        </NoteBox>
      )}
      {selected && !supportsLiveEval(selected, product) && (
        <p
          className="text-sm text-muted-foreground sm:col-span-2"
          data-testid="endpoint-no-live-eval"
        >
          该终端不支持真机测评，仅可做配置体检。{LIVE_EVAL_HOW_TO_ENABLE}
        </p>
      )}
      {selected &&
        selected.os === 'windows' &&
        selected.eval_runner_version &&
        selected.agents.some((a) => a.product === product && a.headless_capable) && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Windows 终端没有系统级沙箱，真机测评只依靠终端钩子拦截危险操作，报告中会如实标注。
          </p>
        )}
    </>
  );
}
const STATUS_MAX_CHARS = 80;

export function EndpointTaskStatus({
  targetType,
  description,
}: {
  targetType?: string;
  description?: string | null;
}) {
  if (targetType !== 'ENDPOINT_AGENT' || !description) return null;
  // 历史任务的 description 可能是几千字的原始日志：列表里只显示一行摘要，完整内容放 title。
  const oneLine = description.replace(/\s+/g, ' ').trim();
  const short =
    oneLine.length > STATUS_MAX_CHARS ? `${oneLine.slice(0, STATUS_MAX_CHARS)}…` : oneLine;
  return (
    <span
      className="block max-w-full truncate text-xs text-muted-foreground"
      title={description.length > 2000 ? `${description.slice(0, 2000)}…` : description}
    >
      {short}
    </span>
  );
}
