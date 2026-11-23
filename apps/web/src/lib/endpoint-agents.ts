import { FLEET_LIVE_PRODUCTS, FLEET_LIVE_PRODUCT_LABELS, type FleetLiveProduct } from '../../../../packages/shared/src/fleet-live-eval';
import type { EndpointInfo } from '@/lib/api';

export type EndpointProduct = FleetLiveProduct;

export const ENDPOINT_PRODUCT_LABELS: Record<string, string> = {
  ...FLEET_LIVE_PRODUCT_LABELS,
  gemini: 'Gemini',
  cursor: 'Cursor',
};

export const ENDPOINT_OS_LABELS: Record<string, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  darwin: 'macOS',
};

/** 超过该时长没有上线记录，就在界面上标为离线。 */
export const ENDPOINT_OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000;

export function productLabel(product: string | undefined | null): string {
  return ENDPOINT_PRODUCT_LABELS[product as EndpointProduct] ?? product ?? '名称未上报';
}

export function osLabel(os: string | undefined | null): string {
  if (!os) return '未知系统';
  return ENDPOINT_OS_LABELS[os.toLowerCase()] ?? os;
}

/** 终端是否在线：以最近上线时间为准，超过 24 小时或缺失视为离线。 */
export function isEndpointOnline(
  endpoint: Pick<EndpointInfo, 'last_seen_at'>,
  now: number = Date.now(),
): boolean {
  if (!endpoint.last_seen_at) return false;
  const seen = new Date(endpoint.last_seen_at).getTime();
  if (Number.isNaN(seen)) return false;
  return now - seen <= ENDPOINT_OFFLINE_AFTER_MS;
}

/** 该终端上指定产品是否能做真机测评：需有评估执行器且该产品支持无界面运行（与后端校验一致）。 */
export function supportsLiveEval(
  endpoint: Pick<EndpointInfo, 'eval_runner_version' | 'agents'>,
  product: string,
): boolean {
  return Boolean(
    endpoint.eval_runner_version &&
    endpoint.agents.some((a) => a.product === product && a.headless_capable),
  );
}

export function suggestedEndpointTargetName(hostname: string, product: string): string {
  return `${hostname} 终端(${productLabel(product)})`;
}

/** 保留已登记产品的真实标识，编辑表单不能将新产品强制改成默认产品。 */
export function endpointProduct(value: unknown): EndpointProduct | undefined {
  return typeof value === 'string' && (FLEET_LIVE_PRODUCTS as readonly string[]).includes(value) ? value as EndpointProduct : undefined;
}
