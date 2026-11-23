import { z } from 'zod';
import {
  FLEET_LIVE_PRODUCTS,
  LIVE_RISK_TYPE_IDS,
} from '../../../../../packages/shared/src/fleet-live-eval.js';
import { badRequest } from '../../lib/errors.js';

const schema = z.object({
  mode: z.enum(['posture', 'live']),
  name: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().max(500).optional(),
  product: z.enum(FLEET_LIVE_PRODUCTS).optional(),
  riskTypes: z.array(z.enum(LIVE_RISK_TYPE_IDS)).min(1).optional(),
  confirmed: z.boolean().optional(),
});
/** 所有终端任务都转入现有接口，复用登记校验、权限和真实执行链路。 */
export function endpointEntryRequest(body: unknown, config: unknown) {
  const data = schema.parse(body);
  const access = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  if (typeof access.fleetEndpointId !== 'string' || !access.fleetEndpointId)
    throw badRequest('该终端尚未接入统一检测，请在终端管理页确认接入状态。');
  if (data.mode === 'live' && data.confirmed !== true)
    throw badRequest('请先阅读终端测评影响说明，并确认已了解以上影响。');
  if (data.mode === 'live' && !data.product) throw badRequest('请选择已登记的被测智能体。');
  return {
    url: `/api/fleet/endpoints/${encodeURIComponent(access.fleetEndpointId)}/${data.mode === 'posture' ? 'posture-eval' : 'eval-jobs'}`,
    payload:
      data.mode === 'posture'
        ? { name: data.name }
        : {
            name: data.name,
            product: data.product,
            reason: data.reason,
            riskTypes: data.riskTypes,
            confirmed: true,
          },
  };
}
