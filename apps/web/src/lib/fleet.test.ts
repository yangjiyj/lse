import { describe, expect, it } from 'vitest';
import {
  FLEET_JOB_STATUS_LABELS,
  fleetEndpointIdOf,
  formatInstalledAgents,
  shortProbeVersion,
  targetDisplayName,
} from './fleet';

describe('shortProbeVersion', () => {
  it('40 位提交号只留前 8 位', () => {
    expect(shortProbeVersion('50ba8d3a9a01c1fe02541ba98f89f2a5ccc992b9')).toBe('50ba8d3a');
  });
  it('普通版本号和空值', () => {
    expect(shortProbeVersion('1.8.2')).toBe('1.8.2');
    expect(shortProbeVersion('v2026.10.23')).toBe('v2026.10.23');
    expect(shortProbeVersion('')).toBe('—');
    expect(shortProbeVersion(null)).toBe('—');
    expect(shortProbeVersion(undefined)).toBe('—');
  });
});

describe('formatInstalledAgents', () => {
  it('同名同版本去重，version_unknown / 空版本显示「版本未知」', () => {
    expect(
      formatInstalledAgents([
        { name: 'claude-code', version: '2.1.126' },
        { name: 'claude-code', version: '2.1.126' },
        { name: 'claude-code', version: '2.1.126' },
        { name: 'claude-code', version: '2.1.308' },
        { name: 'codex', version: '0.160.1' },
        { name: 'hermes', version: 'version_unknown' },
        { name: 'opencode', version: null },
        { name: 'opencode', version: 'version_unknown' },
        { name: 'openclaw', version: '2026.9.5' },
      ]),
    ).toEqual([
      'Claude Code 2.1.126',
      'Claude Code 2.1.308',
      'Codex 0.160.1',
      'Hermes 版本未知',
      'OpenCode 版本未知',
      'OpenClaw 2026.9.5',
    ]);
  });
  it('空列表', () => {
    expect(formatInstalledAgents([])).toEqual([]);
  });
});

describe('fleetEndpointIdOf', () => {
  it('只认 provider 为 jiandun-fleet 且带 fleetEndpointId 的对象', () => {
    expect(
      fleetEndpointIdOf({ provider: 'jiandun-fleet', accessConfig: { fleetEndpointId: 'u1' } }),
    ).toBe('u1');
    expect(
      fleetEndpointIdOf({ provider: 'agentshield', accessConfig: { fleetEndpointId: 'u1' } }),
    ).toBeNull();
    expect(fleetEndpointIdOf({ provider: 'jiandun-fleet', accessConfig: {} })).toBeNull();
    expect(fleetEndpointIdOf({ provider: 'jiandun-fleet', accessConfig: null })).toBeNull();
    expect(fleetEndpointIdOf({})).toBeNull();
  });
});

describe('targetDisplayName', () => {
  const base = { provider: 'jiandun-fleet', accessConfig: null };
  it('旧版自动名称去掉终端编号', () => {
    expect(
      targetDisplayName({ ...base, name: '自管终端 demo-host（ep_b63c2fe6363d0b502894）' }),
    ).toBe('demo-host');
  });
  it('新格式、手改过的名称、其他 provider 原样显示', () => {
    expect(targetDisplayName({ ...base, name: 'demo-host（Linux）' })).toBe('demo-host（Linux）');
    expect(targetDisplayName({ ...base, name: '财务部演示机' })).toBe('财务部演示机');
    expect(
      targetDisplayName({
        provider: 'agentshield',
        name: '自管终端 demo-host（ep_b63c2fe6363d0b502894）',
      }),
    ).toBe('自管终端 demo-host（ep_b63c2fe6363d0b502894）');
  });
});

describe('历史审批状态仍可显示', () => {
  it('PENDING_APPROVAL 标明「历史」，REJECTED 保留', () => {
    expect(FLEET_JOB_STATUS_LABELS.PENDING_APPROVAL).toBe('待审批（历史）');
    expect(FLEET_JOB_STATUS_LABELS.REJECTED).toBe('已驳回');
  });
});

it('排队状态统一为待终端领取', () => {
  expect(FLEET_JOB_STATUS_LABELS.QUEUED).toBe('待终端领取');
});

it('未知智能体显示人话名称并保留次要的原始标识', () => {
  expect(formatInstalledAgents([{ name: 'other', version: null }])).toEqual([
    '未识别的智能体（原始标识：other） 版本未知',
  ]);
});

it('报告已经使用产品显示名称时保持名称，不误判成未知产品', () => {
  expect(formatInstalledAgents([{ name: 'Claude Code', version: '2.1.0' }])).toEqual([
    'Claude Code 2.1.0',
  ]);
});
