import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBlast } from './blast.js';
const agent = (name: string) => ({
  kind: 'cli_agent',
  name,
  evidence: {
    posture: [
      {
        key: 'blast.docker_socket',
        scope: 'host',
        status: 'finding',
        subject_hash: 'docker',
        count: 1,
        label: '/private/secret',
      },
      {
        key: 'blast.ssh_key_unencrypted',
        scope: 'user',
        status: 'finding',
        subject_hash: 'ssh',
        count: 2,
      },
      {
        key: 'blast.ssh_private_key',
        scope: 'user',
        status: 'finding',
        subject_hash: 'ssh',
        count: 2,
      },
      { key: 'data.transcripts_present', scope: 'user', status: 'finding', count: 10 },
    ],
  },
});
test('跨智能体按指纹去重，主机权限合并为一行并保留涉及账号数量', () => {
  const rows = aggregateBlast({ assets: [agent('claude-code'), agent('codex')] });
  assert.equal(rows.length, 2);
  const docker = rows.find((r) => r.id.includes('docker'))!;
  assert.equal(docker.level, 'HIGH');
  assert.equal(docker.involved, '2 个智能体所在账号');
  assert.equal(docker.subjectCount, 1);
  const ssh = rows.find((r) => r.id.includes('ssh'))!;
  assert.equal(ssh.title, '2 把 SSH 私钥没有设口令');
  assert.equal(ssh.subjectCount, 2);
  assert.doesNotMatch(JSON.stringify(rows), /private|secret|subject_hash/);
});
test('无命中和仅有会话记录不构成风险；普通私钥记录不能证明未设口令', () => {
  assert.deepEqual(aggregateBlast(null), []);
  assert.deepEqual(
    aggregateBlast({
      assets: [
        {
          kind: 'cli_agent',
          name: 'codex',
          evidence: {
            posture: [
              { key: 'data.transcripts_present', status: 'finding' },
              { key: 'blast.ssh_private_key', status: 'finding' },
              { key: 'cred.plaintext_key', status: 'pass' },
            ],
          },
        },
      ],
    }),
    [],
  );
});
test('其余受控风险给出等级、依据和建议', () => {
  const rows = aggregateBlast({
    assets: [
      {
        kind: 'cli_agent',
        name: 'codex',
        evidence: {
          posture: [
            { key: 'config.bypass_prompt_accepted', status: 'finding' },
            { key: 'cred.plaintext_key', status: 'finding' },
            { key: 'data.transcript_secret', status: 'finding' },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.level),
    ['HIGH', 'MEDIUM', 'MEDIUM'],
  );
  assert.ok(rows.every((r) => r.title && r.basis && r.advice));
});
