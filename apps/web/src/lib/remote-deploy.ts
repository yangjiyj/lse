import { request } from '@/lib/api';

// 远程部署探针（2.4.8），对应 apps/api/src/modules/fleet-admin/remote-deploy。
// 口令、私钥只在提交那一次请求里出现，不进任何查询缓存。

export type RemoteDeployStatus =
  | 'PENDING'
  | 'CONNECTING'
  | 'INSTALLING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED';
export type RemoteDeployMode = 'ssh' | 'manual';

export const REMOTE_DEPLOY_STATUS_LABELS: Record<RemoteDeployStatus, string> = {
  PENDING: '等待执行',
  CONNECTING: '连接中',
  INSTALLING: '安装中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  EXPIRED: '已过期',
};

/**
 * 真正在进行中的部署（页面据此轮询）：SSH 部署在排队、连接、安装；一次性命令已有人下载了脚本、
 * 还没登记。只生成了命令、还没人执行的不算。
 */
export function isDeployActive(d: Pick<RemoteDeploy, 'mode' | 'status' | 'scriptFetchedAt'>) {
  if (d.status === 'CONNECTING' || d.status === 'INSTALLING') return true;
  if (d.status !== 'PENDING') return false;
  return d.mode === 'ssh' || Boolean(d.scriptFetchedAt);
}
/** 部署耗时目标：30 秒内完成。 */
export const REMOTE_DEPLOY_TARGET_MS = 30_000;

export interface RemoteDeployCapability {
  /** 平台上有没有 SSH 客户端 */
  ssh: boolean;
  missing: string[];
  /** 一键安装（安装脚本和探针包）是否可用 */
  oneclick: boolean;
  reasons: string[];
}

export interface RemoteDeployHostKey {
  type: string;
  fingerprint: string;
}

export interface RemoteDeploy {
  id: string;
  mode: RemoteDeployMode;
  host: string;
  port: number | null;
  username: string | null;
  authType: 'password' | 'key' | null;
  hostKeyFingerprint: string | null;
  hostKeyType: string | null;
  status: RemoteDeployStatus;
  enableEval: boolean;
  runPosture: boolean;
  endpointId: string | null;
  endpointHref: string | null;
  postureTaskId: string | null;
  postureTaskHref: string | null;
  startedAt: string | null;
  connectedAt: string | null;
  uploadedAt: string | null;
  scriptFetchedAt: string | null;
  installedAt: string | null;
  registeredAt: string | null;
  firstReportAt: string | null;
  durationMs: number | null;
  withinTarget: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  log: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RemoteDeployAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string; passphrase?: string };

export interface SshDeployInput {
  host: string;
  port: number;
  username: string;
  auth: RemoteDeployAuth;
  sudoPassword?: string;
  hostKeyFingerprint: string;
  hostKeyType: string;
  enableEval: boolean;
  runPosture: boolean;
}

export interface ManualDeployInput {
  host: string;
  enableEval: boolean;
  runPosture: boolean;
}

const BASE = '/fleet/remote-deploys';

export const remoteDeployApi = {
  capability() {
    return request<RemoteDeployCapability>('GET', `${BASE}/capability`);
  },
  hostKey(body: { host: string; port: number }) {
    return request<RemoteDeployHostKey>('POST', `${BASE}/host-key`, { body });
  },
  startSsh(input: SshDeployInput) {
    return request<RemoteDeploy>('POST', BASE, { body: { mode: 'ssh', ...input } });
  },
  /** 一次性部署命令：命令里带一次性接入码，只返回这一次。 */
  createManual(input: ManualDeployInput) {
    return request<{ item: RemoteDeploy; command: string }>('POST', BASE, {
      body: { mode: 'manual', ...input },
    });
  },
  list(query: { page?: number; pageSize?: number } = {}) {
    return request<{ items: RemoteDeploy[]; total: number; page: number; pageSize: number }>(
      'GET',
      BASE,
      { query },
    );
  },
  get(id: string) {
    return request<RemoteDeploy>('GET', `${BASE}/${encodeURIComponent(id)}`);
  },
};
