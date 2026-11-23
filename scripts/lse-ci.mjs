#!/usr/bin/env node
// lse-ci：把 LSE 评估接入 CI/CD 流水线。纯 Node 18+，零依赖（仅用内置 fetch）。
//
// 环境变量：LSE_URL（平台地址）、LSE_TOKEN（API 令牌，勿打印）。
// 退出码：0 门禁通过 / 1 门禁未通过 / 2 评估执行失败或超时 / 3 用法或认证错误。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  EXIT,
  classifyTaskStatus,
  describeHttpError,
  evaluateGateResponse,
  exitCodeForHttp,
  formatTaskProgress,
  maskToken,
  parseArgs,
} from './lib/lse-ci-core.mjs';

const USAGE = `用法：lse-ci.mjs <子命令> [参数]

子命令：
  run     --plan <评估计划ID> | --task <已有任务ID>  [--wait] [--task-file <文件>]
          触发评估计划（或接入已有任务），输出任务 ID；加 --wait 则继续等待并读取门禁
  wait    --task <任务ID> [--timeout 秒] [--interval 秒]   轮询到任务结束
  gate    --task <任务ID> [--allow-no-gate]                读取门禁结果并按结果退出
  export  --task <任务ID> --format junit|sarif|json --out <文件>

通用：--task 缺省时读取 --task-file 或环境变量 LSE_TASK_ID
环境变量：LSE_URL、LSE_TOKEN
退出码：0 门禁通过 / 1 门禁未通过 / 2 评估执行失败或超时 / 3 用法或认证错误
自签证书：设置 NODE_EXTRA_CA_CERTS=<CA 文件>（推荐）`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(msg);

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function getEnv() {
  const url = (process.env.LSE_URL ?? '').trim().replace(/\/+$/, '');
  const token = (process.env.LSE_TOKEN ?? '').trim();
  if (!url) throw new CliError('未设置环境变量 LSE_URL', EXIT.USAGE);
  if (!token) throw new CliError('未设置环境变量 LSE_TOKEN', EXIT.USAGE);
  return { url, token };
}

async function api(env, method, path, { raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${env.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.token}`, Accept: raw ? '*/*' : 'application/json' },
    });
  } catch (err) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
    throw new CliError(`无法连接 ${env.url}：${maskToken(cause, env.token)}`, EXIT.EVAL_FAILED);
  }
  const text = await res.text();
  if (!res.ok) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON 响应 */
    }
    throw new CliError(describeHttpError(res.status, body), exitCodeForHttp(res.status));
  }
  if (raw) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('接口返回内容不是有效 JSON，请检查 LSE_URL 是否正确', EXIT.EVAL_FAILED);
  }
}

function resolveTaskId(options) {
  if (options.task) return options.task;
  if (options['task-file']) {
    try {
      return readFileSync(options['task-file'], 'utf8').trim();
    } catch {
      throw new CliError(`无法读取任务文件：${options['task-file']}`, EXIT.USAGE);
    }
  }
  if (process.env.LSE_TASK_ID) return process.env.LSE_TASK_ID.trim();
  throw new CliError('缺少任务 ID：请用 --task、--task-file 或环境变量 LSE_TASK_ID', EXIT.USAGE);
}

const byTask = (env, taskId) =>
  api(env, 'GET', `/api/gates/evaluations/by-task/${encodeURIComponent(taskId)}`);

async function cmdRun(env, options) {
  let taskId;
  if (options.plan) {
    let res;
    try {
      res = await fetch(`${env.url}/api/eval-plans/${encodeURIComponent(options.plan)}/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.token}`, Accept: 'application/json' },
      });
    } catch (err) {
      throw new CliError(
        `无法连接 ${env.url}：${maskToken(err?.cause?.code ?? err?.message, env.token)}`,
        EXIT.EVAL_FAILED,
      );
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.taskId) {
      throw new CliError(
        `评估计划未触发：${describeHttpError(res.status, body)}`,
        res.ok ? EXIT.EVAL_FAILED : exitCodeForHttp(res.status),
      );
    }
    taskId = body.taskId;
    log(`已触发评估计划 ${options.plan}，生成任务 ${taskId}`);
  } else {
    taskId = options.task;
    await byTask(env, taskId); // 校验任务存在、令牌有效
    log(`使用已有任务 ${taskId}`);
  }
  if (options['task-file']) writeFileSync(options['task-file'], `${taskId}\n`);
  log(`taskId=${taskId}`);
  if (!options.wait) return EXIT.PASS;
  await cmdWait(env, { ...options, task: taskId });
  return cmdGate(env, { ...options, task: taskId });
}

async function cmdWait(env, options) {
  const taskId = resolveTaskId(options);
  const timeout = options.timeout ?? DEFAULTS.timeout;
  const interval = (options.interval ?? DEFAULTS.interval) * 1000;
  const deadline = Date.now() + timeout * 1000;
  let last = '';
  for (;;) {
    const resp = await byTask(env, taskId);
    const line = formatTaskProgress(resp);
    if (line !== last) log(line);
    last = line;
    const kind = classifyTaskStatus(resp.taskStatus);
    if (kind === 'done') return EXIT.PASS;
    if (kind === 'failed')
      throw new CliError(`评估任务未正常完成（${resp.taskStatus}）`, EXIT.EVAL_FAILED);
    if (Date.now() + interval > deadline)
      throw new CliError(
        `等待评估超时（${timeout} 秒），任务仍在运行：${taskId}`,
        EXIT.EVAL_FAILED,
      );
    await sleep(interval);
  }
}

async function cmdGate(env, options) {
  const taskId = resolveTaskId(options);
  const grace = (options['gate-grace'] ?? DEFAULTS.gateGrace) * 1000;
  const deadline = Date.now() + grace;
  for (;;) {
    const resp = await byTask(env, taskId);
    const r = evaluateGateResponse(resp, { allowNoGate: options['allow-no-gate'] });
    // 任务刚完成时门禁判定可能略有延迟：在宽限期内重试
    if (r.pending && classifyTaskStatus(resp.taskStatus) === 'done' && Date.now() < deadline) {
      await sleep(Math.min(5000, Math.max(500, deadline - Date.now())));
      continue;
    }
    log(formatTaskProgress(resp));
    for (const l of r.lines) log(l);
    log(
      r.code === EXIT.PASS
        ? '结论：门禁通过'
        : r.code === EXIT.GATE_FAILED
          ? '结论：门禁未通过，流水线应失败'
          : '结论：未能得出门禁结论',
    );
    log('提示：门禁结论是平台评分，不是认证结论。');
    return r.code;
  }
}

async function cmdExport(env, options) {
  const taskId = resolveTaskId(options);
  const text = await api(
    env,
    'GET',
    `/api/eval-tasks/${encodeURIComponent(taskId)}/export?format=${options.format}`,
    { raw: true },
  );
  writeFileSync(options.out, text);
  log(`已导出 ${options.format} 到 ${options.out}（${Buffer.byteLength(text)} 字节）`);
  return EXIT.PASS;
}

export async function main(argv) {
  const { command, options, error } = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return EXIT.PASS;
  }
  if (error) {
    console.error(`参数错误：${error}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  try {
    const env = getEnv();
    if (command === 'run') return await cmdRun(env, options);
    if (command === 'wait') return await cmdWait(env, options);
    if (command === 'gate') return await cmdGate(env, options);
    return await cmdExport(env, options);
  } catch (err) {
    const msg = maskToken(err?.message ?? String(err), process.env.LSE_TOKEN);
    console.error(`错误：${msg}`);
    return err instanceof CliError ? err.code : EXIT.EVAL_FAILED;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
