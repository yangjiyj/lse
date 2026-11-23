import { createHash } from 'node:crypto';
import { getRedisConnection } from '../../lib/queue.js';

const RESERVE_SLOT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local rpm = math.min(tonumber(ARGV[1]), tonumber(redis.call('HGET', KEYS[1], 'rpm') or ARGV[1]))
local next = math.max(now, tonumber(redis.call('HGET', KEYS[1], 'next') or now))
redis.call('HSET', KEYS[1], 'rpm', rpm, 'next', next + math.ceil(60000 / rpm))
redis.call('PEXPIRE', KEYS[1], math.ceil(next - now + 120000))
return math.ceil(next - now)
`;

export async function acquireBatchRateSlot(
  target: { baseUrl: string; apiKey: string },
  rpm: number,
  canContinue: () => Promise<boolean>,
): Promise<boolean> {
  const account = createHash('sha256')
    .update(new URL(target.baseUrl).origin + '\n' + target.apiKey)
    .digest('hex');
  const wait = Number(
    await getRedisConnection().eval(RESERVE_SLOT, 1, `batch:rate:${account}`, rpm),
  );
  const until = Date.now() + wait;
  while (Date.now() < until) {
    if (!(await canContinue())) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(1, until - Date.now()))),
    );
  }
  return canContinue();
}
