import { fleetAgentDisplayName } from '../../../../../packages/shared/src/fleet-agent-display.js';
import { redactString } from '../../lib/redact.js';
import {
  FLEET_LIVE_PRODUCTS,
  LIVE_EVAL_BLOCKED_REASONS,
} from '../../../../../packages/shared/src/fleet-live-eval.js';
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
export interface EndpointAgent {
  product: string;
  displayName: string;
  version: string | null;
  headlessCapable: boolean;
  liveEvalSupported: boolean;
  liveEvalRegistered: boolean;
  scripted: boolean;
  /** 仅 claude-code 且终端心跳上报了 eval_sandbox_v2 时为真：可以发起运行态测评（suite=runtime_v2）。 */
  runtimeV2: boolean;
  liveEvalBlockedReason?: string;
}
/** 不从执行器版本或已安装产品推断登记状态；登记信息缺失时明确阻止运行。 */
export function runnerProducts(health: unknown): Rec[] {
  const h = rec(health),
    caps = rec(h.capabilities);
  if (Object.hasOwn(h, 'live_eval')) {
    return list(rec(h.live_eval).products).map((entry) => ({
      ...entry,
      registered: entry.liveEvalRegistered === true,
      runnable: entry.liveEvalRunnable === true,
      supported: entry.liveEvalSupported,
    }));
  }
  return list(caps.eval_products ?? rec(h.evalRunner).products ?? rec(h.eval_runner).products);
}
export function registryComplete(health: unknown): boolean {
  return (
    Object.hasOwn(rec(health), 'live_eval') ||
    rec(rec(health).capabilities).eval_registry_complete === true
  );
}
/** 只展示脱敏后的中文原因，不将本机路径、地址或凭据带到管理界面。 */
function terminalBlockedReason(cap: Rec | undefined): string | undefined {
  const raw = str(cap?.liveEvalBlockedReason).trim();
  if (raw && /[\u3400-\u9fff]/u.test(raw)) {
    return redactString(raw)
      .replace(/(?:[a-z]:[\\/]|\\\\|~\/|\/)[^\s，。；;、（）()<>"']+/giu, '［路径已隐藏］')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '［地址已隐藏］')
      .replace(/\b(?:[a-f\d]{2}:){5}[a-f\d]{2}\b/gi, '［地址已隐藏］')
      .replace(/\b(?:[a-f\d]{0,4}:){2,}[a-f\d:]{0,39}\b/gi, '［地址已隐藏］')
      .replace(/[\r\n\t\x00-\x1f]+/g, ' ')
      .slice(0, 500);
  }
  return LIVE_EVAL_BLOCKED_REASONS[str(cap?.reasonCode)];
}
export function endpointAgents(
  report: unknown,
  health: unknown,
  runner: string | null,
): EndpointAgent[] {
  const h = rec(health),
    assets = list(rec(report).assets).filter((a) => a.kind === 'cli_agent');
  const inventory: Rec[] = assets.length
    ? assets.map((a) => ({ ...a, product: a.name }))
    : list(h.agents ?? rec(h.collector).agents);
  const capabilities = runnerProducts(health);
  return inventory
    .filter((a) => str(a.product))
    .map((a) => {
      const product = str(a.product),
        cap =
          capabilities.find((c) => c.product === product) ??
          (registryComplete(health) ? { registered: false, runnable: false } : undefined);
      const supported =
        (FLEET_LIVE_PRODUCTS as readonly string[]).includes(product) && cap?.supported !== false;
      const registered = cap?.registered === true;
      const fallbackReason = !supported
        ? '平台暂不支持运行该智能体的真机测评。'
        : !runner
          ? '这台电脑尚未上报测评执行器，请更新探针并开启测评能力。'
          : !cap
            ? '终端尚未上报该智能体的测评登记情况，请更新探针并上报登记及可运行状态。'
            : !registered
              ? `这台电脑没有登记 ${fleetAgentDisplayName(product)} 的测评，无法运行。请在终端上登记后再测，或改选已登记的智能体。`
              : cap.runnable !== true
                ? '该智能体已登记，但终端未确认可以运行。请终端管理员检查启动命令、登录状态和运行权限后重新上报。'
                : undefined;
      const reason = fallbackReason ? (terminalBlockedReason(cap) ?? fallbackReason) : undefined;
      const version = str(a.version);
      return {
        product,
        displayName: fleetAgentDisplayName(product),
        version: version && version !== 'version_unknown' ? version : null,
        headlessCapable: a.headless_capable === true || a.headlessCapable === true,
        liveEvalSupported: supported,
        liveEvalRegistered: registered,
        scripted: scriptedSupported(health),
        runtimeV2: product === 'claude-code' && runtimeV2Supported(health),
        ...(reason ? { liveEvalBlockedReason: reason } : {}),
      };
    });
}

/** 不用版本号或模型登记状态推断固定脚本执行能力。 */
export function scriptedSupported(health: unknown): boolean {
  return rec(rec(health).capabilities).eval_scripted === '1';
}

/** 终端心跳 capabilities.eval_sandbox_v2 === '1' 才支持运行态测评（沙箱 v2）；同样不用版本号推断。 */
export function runtimeV2Supported(health: unknown): boolean {
  return rec(rec(health).capabilities).eval_sandbox_v2 === '1';
}
