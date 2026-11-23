import type { FleetEndpoint } from '@/lib/api';
import { RunChecksModal } from './RunChecksModal';

/** 保留旧入口，统一经过检测清单和影响确认。 */
export function RequestEvalJobModal({
  endpoint,
  onClose,
}: {
  endpoint: FleetEndpoint | null;
  onClose: () => void;
}) {
  return <RunChecksModal endpoint={endpoint} onClose={onClose} initialMode="live" />;
}
