// 探针包托管：读取 FLEET_KIT_DIR 下 AgentShield 构建产物的 catalog.json，校验后只开放 catalog 里列出的文件。
// 包本身不含秘密（完整性靠 catalog 里的 sha256 + 一键脚本里写死的散列保证），所以下载接口无需登录。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** catalog.json 最大读取字节数（样例约 3 KiB）。 */
export const MAX_CATALOG_BYTES = 256 * 1024;
/** 单个条目允许的最大包体（防止配置错文件）。 */
export const MAX_KIT_BYTES = 1024 * 1024 * 1024;
/** catalog 最多接受的条目数。 */
export const MAX_CATALOG_ITEMS = 32;

const HEX64 = /^[0-9a-f]{64}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** 一键脚本支持的目标。Windows / macOS 只列出，不提供一键脚本。 */
export const ONECLICK_TARGETS = ['linux-amd64', 'linux-arm64'] as const;
export type OneclickTarget = (typeof ONECLICK_TARGETS)[number];

/** 提供安装包（exe）下载的 Windows 目标。 */
export const INSTALLER_TARGETS = ['windows-amd64', 'windows-arm64'] as const;
export type InstallerTarget = (typeof INSTALLER_TARGETS)[number];
/** 安装包清单里表示「支持本平台」的服务端类型（与探针安装器的 server_kind 取值一致）。 */
export const INSTALLER_SERVER_KIND = 'jiandun';
/** 单个安装包体上限（防止配置错文件）；与探针仓库的安装器下载上限一致。 */
export const MAX_SETUP_BYTES = 256 * 1024 * 1024;

/** Windows 安装包（探针 exe）的 catalog 条目：只有带 setup_filename / setup_sha256 的 Windows 目标才有。 */
export interface KitSetup {
  filename: string;
  sha256: string;
  bytes: number | null;
  /** 安装器支持的服务端类型（setup_server_kinds）；旧清单没有这个字段，视为空。 */
  serverKinds: string[];
}

export interface KitItem {
  target: string;
  os: string;
  arch: string;
  version: string;
  filename: string;
  sha256: string;
  manifestSha256: string;
  bytes: number | null;
  /** 是否属于一键脚本支持的目标（linux-amd64 / linux-arm64）。 */
  oneclick: boolean;
  /** Windows 安装包；没有则为 null。 */
  setup: KitSetup | null;
}

export type KitFileStatus =
  | 'ok'
  | 'missing'
  | 'size_mismatch'
  | 'sha_mismatch'
  | 'unreadable'
  | 'not_supported';

export interface KitItemStatus extends KitItem {
  status: KitFileStatus;
}

export interface KitCatalog {
  /** 目录是否已配置。 */
  configured: boolean;
  /** catalog 是否读取并校验成功。 */
  loaded: boolean;
  sourceRevision: string | null;
  items: KitItem[];
  /** 读取或校验 catalog 时的问题（中文）；非致命，仅用于告警。 */
  problems: string[];
}

export function kitDir(): string | null {
  const dir = process.env.FLEET_KIT_DIR?.trim();
  return dir ? dir : null;
}

function parseItem(raw: unknown, index: number, problems: string[]): KitItem | null {
  const tag = `catalog.json 第 ${index + 1} 项`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${tag}不是对象，已忽略`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const target = str('target');
  const os = str('os');
  const arch = str('arch');
  const version = str('version');
  const filename = str('filename');
  const sha256 = str('sha256').toLowerCase();
  const manifestSha256 = str('manifest_sha256').toLowerCase();
  if (!TOKEN.test(target) || !TOKEN.test(os) || !TOKEN.test(arch)) {
    problems.push(`${tag}的 target/os/arch 不合法，已忽略`);
    return null;
  }
  if (!VERSION.test(version)) {
    problems.push(`${tag}（${target}）的 version 不合法，已忽略`);
    return null;
  }
  if (!FILENAME.test(filename) || filename.includes('..')) {
    problems.push(`${tag}（${target}）的 filename 不合法，已忽略`);
    return null;
  }
  if (!HEX64.test(sha256) || !HEX64.test(manifestSha256)) {
    problems.push(`${tag}（${target}）的 sha256 / manifest_sha256 不是 64 位十六进制，已忽略`);
    return null;
  }
  let bytes: number | null = null;
  if (o.bytes !== undefined) {
    if (
      typeof o.bytes !== 'number' ||
      !Number.isInteger(o.bytes) ||
      o.bytes <= 0 ||
      o.bytes > MAX_KIT_BYTES
    ) {
      problems.push(`${tag}（${target}）的 bytes 不合法，已忽略`);
      return null;
    }
    bytes = o.bytes;
  }
  const oneclick = (ONECLICK_TARGETS as readonly string[]).includes(target);
  if (oneclick && (os !== 'linux' || `linux-${arch}` !== target || !filename.endsWith('.tar.gz'))) {
    problems.push(`${tag}（${target}）的 os/arch/文件类型与目标不符，已忽略`);
    return null;
  }
  const setup = parseSetup(o, tag, target, os, arch, problems);
  return { target, os, arch, version, filename, sha256, manifestSha256, bytes, oneclick, setup };
}

/**
 * 解析 Windows 安装包字段。安装包是附加能力：字段不合法只丢弃安装包、不连累整个条目
 * （条目本身的 zip 仍照常列出），问题记进 problems。
 */
function parseSetup(
  o: Record<string, unknown>,
  tag: string,
  target: string,
  os: string,
  arch: string,
  problems: string[],
): KitSetup | null {
  if (o.setup_filename === undefined && o.setup_sha256 === undefined) return null;
  if (!(INSTALLER_TARGETS as readonly string[]).includes(target)) return null;
  const drop = (why: string) => {
    problems.push(`${tag}（${target}）的${why}，该条目的安装包已忽略`);
    return null;
  };
  if (os !== 'windows' || `windows-${arch}` !== target) return drop('安装包 os/arch 与目标不符');
  const filename = typeof o.setup_filename === 'string' ? o.setup_filename : '';
  if (
    !FILENAME.test(filename) ||
    filename.includes('..') ||
    !filename.toLowerCase().endsWith('.exe')
  )
    return drop('setup_filename 不合法（须为不含路径的 .exe 文件名）');
  const sha256 = typeof o.setup_sha256 === 'string' ? o.setup_sha256.toLowerCase() : '';
  if (!HEX64.test(sha256)) return drop('setup_sha256 不是 64 位十六进制');
  let bytes: number | null = null;
  if (o.setup_bytes !== undefined) {
    if (
      typeof o.setup_bytes !== 'number' ||
      !Number.isInteger(o.setup_bytes) ||
      o.setup_bytes <= 0 ||
      o.setup_bytes > MAX_SETUP_BYTES
    )
      return drop('setup_bytes 不合法');
    bytes = o.setup_bytes;
  }
  let serverKinds: string[] = [];
  if (o.setup_server_kinds !== undefined) {
    if (
      !Array.isArray(o.setup_server_kinds) ||
      o.setup_server_kinds.length > 8 ||
      !o.setup_server_kinds.every((k) => typeof k === 'string' && TOKEN.test(k))
    )
      return drop('setup_server_kinds 不合法');
    serverKinds = [...new Set(o.setup_server_kinds as string[])];
  }
  return { filename, sha256, bytes, serverKinds };
}

/** 读取并校验 catalog.json。永不抛错：问题放进 problems。 */
export async function loadKitCatalog(): Promise<KitCatalog> {
  const dir = kitDir();
  const empty = (problems: string[]): KitCatalog => ({
    configured: Boolean(dir),
    loaded: false,
    sourceRevision: null,
    items: [],
    problems,
  });
  if (!dir) return empty([]);
  const file = join(dir, 'catalog.json');
  let text: string;
  try {
    const st = await stat(file);
    if (!st.isFile()) return empty(['FLEET_KIT_DIR 下的 catalog.json 不是普通文件']);
    if (st.size > MAX_CATALOG_BYTES)
      return empty([`catalog.json 超过 ${MAX_CATALOG_BYTES / 1024} KiB，已拒绝读取`]);
    text = await readFile(file, 'utf8');
  } catch {
    return empty(['FLEET_KIT_DIR 下缺少 catalog.json（或无法读取）']);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty(['catalog.json 不是有效的 JSON']);
  }
  const root = json as { source_revision?: unknown; items?: unknown } | null;
  if (!root || typeof root !== 'object' || !Array.isArray(root.items))
    return empty(['catalog.json 缺少 items 数组']);
  const problems: string[] = [];
  const rawItems = root.items.slice(0, MAX_CATALOG_ITEMS);
  if (root.items.length > MAX_CATALOG_ITEMS)
    problems.push(`catalog.json 条目超过 ${MAX_CATALOG_ITEMS} 项，多余部分已忽略`);
  const items: KitItem[] = [];
  const seenTargets = new Set<string>();
  const seenFiles = new Set<string>();
  rawItems.forEach((raw, i) => {
    const item = parseItem(raw, i, problems);
    if (!item) return;
    if (seenTargets.has(item.target) || seenFiles.has(item.filename)) {
      problems.push(`catalog.json 中 ${item.target} / ${item.filename} 重复，后者已忽略`);
      return;
    }
    if (
      item.setup &&
      (seenFiles.has(item.setup.filename) || item.setup.filename === item.filename)
    ) {
      problems.push(
        `catalog.json 中 ${item.target} 的安装包文件名 ${item.setup.filename} 重复，已忽略安装包`,
      );
      item.setup = null;
    }
    seenTargets.add(item.target);
    seenFiles.add(item.filename);
    if (item.setup) seenFiles.add(item.setup.filename);
    items.push(item);
  });
  const sourceRevision =
    typeof root.source_revision === 'string' && VERSION.test(root.source_revision)
      ? root.source_revision
      : null;
  return { configured: true, loaded: true, sourceRevision, items, problems };
}

// 文件散列缓存：键含 mtime 与大小，文件被替换后自动失效。
const hashCache = new Map<string, string>();

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** 按 路径+大小+mtime 缓存散列：同一个文件不重复读取几十 MB，文件一被替换（大小或 mtime 变）立即重算。 */
async function cachedSha256(path: string, size: number, mtimeMs: number): Promise<string> {
  const key = `${path}:${size}:${mtimeMs}`;
  let digest = hashCache.get(key);
  if (!digest) {
    digest = await sha256File(path);
    if (hashCache.size > 64) hashCache.clear();
    hashCache.set(key, digest);
  }
  return digest;
}

/** 逐项检查包文件是否在、大小与 sha256 是否和 catalog 一致。 */
export async function checkKitItems(catalog: KitCatalog): Promise<KitItemStatus[]> {
  const dir = kitDir();
  const out: KitItemStatus[] = [];
  for (const item of catalog.items) {
    if (!item.oneclick || !dir) {
      out.push({ ...item, status: 'not_supported' });
      continue;
    }
    const path = join(dir, item.filename);
    try {
      await lstat(path);
    } catch {
      out.push({ ...item, status: 'missing' });
      continue;
    }
    try {
      const real = await stat(path);
      if (!real.isFile()) {
        out.push({ ...item, status: 'unreadable' });
        continue;
      }
      if (item.bytes !== null && real.size !== item.bytes) {
        out.push({ ...item, status: 'size_mismatch' });
        continue;
      }
      const digest = await cachedSha256(path, real.size, real.mtimeMs);
      out.push({ ...item, status: digest === item.sha256 ? 'ok' : 'sha_mismatch' });
    } catch {
      out.push({ ...item, status: 'unreadable' });
    }
  }
  return out;
}

const STATUS_TEXT: Record<Exclude<KitFileStatus, 'ok' | 'not_supported'>, string> = {
  missing: '文件不存在',
  size_mismatch: '文件大小与 catalog.json 不符',
  sha_mismatch: 'SHA-256 与 catalog.json 不符',
  unreadable: '无法读取',
};

/** 生成给管理员看的告警（不影响 deployment-info 的 ready）。 */
export function kitWarnings(catalog: KitCatalog, items: KitItemStatus[]): string[] {
  if (!catalog.configured)
    return ['未配置 FLEET_KIT_DIR：暂时不能提供一键安装（仍可按手工安装步骤接入）'];
  const out = [...catalog.problems];
  if (!catalog.loaded) return out;
  const linux = items.filter((i) => i.oneclick);
  if (linux.length === 0)
    out.push('探针包目录里没有 linux-amd64 / linux-arm64 条目：暂时不能提供一键安装');
  for (const i of linux) {
    if (i.status !== 'ok' && i.status !== 'not_supported')
      out.push(`探针包 ${i.filename}（${i.target}）${STATUS_TEXT[i.status]}，该架构暂不能一键安装`);
  }
  return out;
}

export interface ResolvedKitFile {
  path: string;
  size: number;
  item: KitItem;
}

/**
 * 按文件名解析要下载的包。只认 catalog 里列出的、属于一键脚本目标的文件名；
 * 文件名先过白名单正则，再用 realpath 确认没有逃出目录。
 */
export async function resolveKitFile(filename: string): Promise<ResolvedKitFile | null> {
  const dir = kitDir();
  if (!dir || !FILENAME.test(filename)) return null;
  const catalog = await loadKitCatalog();
  const item = catalog.items.find((i) => i.oneclick && i.filename === filename);
  if (!item) return null;
  try {
    const realDir = await realpath(dir);
    const realFile = await realpath(join(dir, item.filename));
    if (!realFile.startsWith(realDir + sep)) return null;
    const st = await stat(realFile);
    if (!st.isFile()) return null;
    return { path: realFile, size: st.size, item };
  } catch {
    return null;
  }
}

// ───────────────────────── Windows 安装包 ─────────────────────────

/** 安装包不可用的原因（中文）。ok 表示可以提供下载。 */
export type InstallerState =
  | { ok: true; path: string; size: number; item: KitItem; setup: KitSetup }
  | { ok: false; reason: string };

/** 检查某个 Windows 目标的安装包能否提供：清单声明支持本平台、文件在、大小与 sha256 和清单一致。 */
export async function checkInstaller(
  catalog: KitCatalog,
  target: string,
  productName: string,
): Promise<InstallerState> {
  const dir = kitDir();
  if (!dir || !catalog.configured)
    return { ok: false, reason: '未配置探针包目录，暂不能提供安装包' };
  if (!catalog.loaded) return { ok: false, reason: '探针包清单无法读取，暂不能提供安装包' };
  const item = catalog.items.find((i) => i.target === target);
  if (!item?.setup) return { ok: false, reason: '探针包清单中没有该架构的 Windows 安装包' };
  const setup = item.setup;
  // 旧安装器解析配置时会拒绝未知字段，给它追加 server_kind 必然装不上：清单必须明确声明支持。
  if (!setup.serverKinds.includes(INSTALLER_SERVER_KIND))
    return { ok: false, reason: `当前探针包版本不支持${productName}安装包，请更新探针包` };
  const missing: InstallerState = { ok: false, reason: '探针包目录缺少 Windows 安装包文件' };
  try {
    const realDir = await realpath(dir);
    const path = join(dir, setup.filename);
    try {
      await lstat(path);
    } catch {
      return missing;
    }
    const realFile = await realpath(path);
    if (!realFile.startsWith(realDir + sep)) return missing;
    const st = await stat(realFile);
    if (!st.isFile()) return { ok: false, reason: 'Windows 安装包文件无法读取' };
    if (st.size < 2 || st.size > MAX_SETUP_BYTES)
      return { ok: false, reason: 'Windows 安装包文件大小异常' };
    if (setup.bytes !== null && st.size !== setup.bytes)
      return { ok: false, reason: 'Windows 安装包的文件大小与探针包清单不符' };
    const digest = await cachedSha256(realFile, st.size, st.mtimeMs);
    if (digest !== setup.sha256)
      return { ok: false, reason: 'Windows 安装包的 SHA-256 校验与探针包清单不一致' };
    return { ok: true, path: realFile, size: st.size, item, setup };
  } catch {
    return { ok: false, reason: 'Windows 安装包文件无法读取' };
  }
}
