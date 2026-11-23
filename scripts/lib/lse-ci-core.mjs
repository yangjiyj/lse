// lse-ci 的纯函数部分：参数解析、退出码映射、结果汇总。零依赖，便于 node:test 测试。

/** 退出码约定（流水线据此判断）。 */
export const EXIT = Object.freeze({
  PASS: 0, // 门禁通过
  GATE_FAILED: 1, // 门禁未通过
  EVAL_FAILED: 2, // 评估执行失败 / 触发被跳过 / 等待超时 / 服务端异常
  USAGE: 3, // 用法错误或认证/权限/资源不存在
});

export const COMMANDS = ['run', 'wait', 'gate', 'export'];
export const FORMATS = ['junit', 'sarif', 'json'];

const VALUE_OPTIONS = new Set([
  'plan',
  'task',
  'format',
  'out',
  'timeout',
  'interval',
  'gate-grace',
  'task-file',
]);
const FLAG_OPTIONS = new Set(['wait', 'allow-no-gate', 'help']);

export const DEFAULTS = Object.freeze({ timeout: 3600, interval: 15, gateGrace: 60 });

/** 解析命令行：返回 { command, options, error }。error 非空表示用法错误。 */
export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      options.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) return { command: null, options, error: `未知参数：--${name}` };
    let value;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        return { command: null, options, error: `参数 --${name} 缺少取值` };
    }
    options[name] = value;
  }
  if (options.help) return { command: null, options, error: null };
  const command = positional[0];
  if (!command)
    return { command: null, options, error: '缺少子命令（run / wait / gate / export）' };
  if (!COMMANDS.includes(command))
    return { command: null, options, error: `未知子命令：${command}` };
  if (positional.length > 1) return { command, options, error: `多余的参数：${positional[1]}` };

  for (const key of ['timeout', 'interval', 'gate-grace']) {
    if (options[key] === undefined) continue;
    const n = Number(options[key]);
    if (!Number.isFinite(n) || n <= 0 || (key !== 'gate-grace' && !Number.isInteger(n)))
      return { command, options, error: `参数 --${key} 必须是正数` };
    options[key] = n;
  }
  if (command === 'run') {
    if (options.plan && options.task)
      return { command, options, error: 'run 只能指定 --plan 或 --task 之一' };
    if (!options.plan && !options.task)
      return { command, options, error: 'run 需要 --plan <评估计划ID> 或 --task <已有任务ID>' };
  }
  if (command === 'export') {
    if (!options.format)
      return { command, options, error: 'export 需要 --format junit|sarif|json' };
    if (!FORMATS.includes(options.format))
      return {
        command,
        options,
        error: `不支持的格式：${options.format}（可选 junit / sarif / json）`,
      };
    if (!options.out) return { command, options, error: 'export 需要 --out <输出文件>' };
  }
  return { command, options, error: null };
}

/** 评估任务状态归类：done 正常结束 / failed 失败或取消 / running 仍在进行。 */
export function classifyTaskStatus(status) {
  if (status === 'COMPLETED') return 'done';
  if (status === 'FAILED' || status === 'CANCELED') return 'failed';
  return 'running';
}

export const TASK_STATUS_TEXT = {
  PENDING: '排队中',
  RUNNING: '执行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELED: '已取消',
};

/** HTTP 状态码 → 退出码。401/403/404/400 视为用法/认证问题；其余（含 409 跳过、5xx）视为执行失败。 */
export function exitCodeForHttp(status) {
  if (status === 401 || status === 403 || status === 404 || status === 400) return EXIT.USAGE;
  return EXIT.EVAL_FAILED;
}

/** 把接口返回的错误转成中文提示。 */
export function describeHttpError(status, body) {
  const detail = body && typeof body === 'object' ? (body.reason ?? body.message ?? '') : '';
  if (status === 401) return `认证失败：令牌无效、已过期或已吊销${detail ? `（${detail}）` : ''}`;
  if (status === 403) return `权限不足：${detail || '令牌缺少所需的权限范围'}`;
  if (status === 404) return `资源不存在：${detail || '请检查计划/任务 ID'}`;
  if (status === 409) return `本次触发被跳过：${detail || '上一次任务未结束或间隔不足'}`;
  return `接口返回 ${status}${detail ? `：${detail}` : ''}`;
}

/**
 * 根据 /api/gates/evaluations/by-task/:taskId 的响应得出门禁结论。
 * 返回 { code, lines }；response.evaluated=false 时 pending=true，由调用方决定是否继续等待。
 */
export function evaluateGateResponse(resp, { allowNoGate = false } = {}) {
  const lines = [];
  const kind = classifyTaskStatus(resp.taskStatus);
  if (kind === 'failed') {
    return {
      code: EXIT.EVAL_FAILED,
      pending: false,
      lines: [`评估任务${TASK_STATUS_TEXT[resp.taskStatus] ?? resp.taskStatus}，未产生门禁判定`],
    };
  }
  if (kind === 'running') {
    return { code: EXIT.EVAL_FAILED, pending: true, lines: ['评估任务尚未结束'] };
  }
  if (!resp.evaluated) {
    if (allowNoGate)
      return { code: EXIT.PASS, pending: false, lines: ['没有匹配的门禁判定（已允许跳过）'] };
    return {
      code: EXIT.USAGE,
      pending: true,
      lines: ['任务已完成，但没有匹配的门禁判定；请确认已为该评估对象/计划配置并启用门禁'],
    };
  }
  for (const g of resp.items ?? []) {
    lines.push(`门禁「${g.gateName ?? g.gateId}」：${g.passed ? '通过' : '未通过'}`);
    if (!g.passed) for (const r of g.reasons ?? []) lines.push(`  - ${r}`);
    const m = g.metrics;
    if (m && typeof m === 'object' && typeof m.score === 'number')
      lines.push(
        `  得分 ${m.score}${typeof m.highRiskCount === 'number' ? `，高危发现 ${m.highRiskCount}` : ''}`,
      );
  }
  return { code: resp.passed ? EXIT.PASS : EXIT.GATE_FAILED, pending: false, lines };
}

/** 任务进度摘要（一行）。 */
export function formatTaskProgress(resp) {
  const status = TASK_STATUS_TEXT[resp.taskStatus] ?? resp.taskStatus;
  const done = resp.processedQuestions ?? 0;
  const total = resp.totalQuestions ?? 0;
  return `任务 ${resp.taskId}：${status}，进度 ${done}/${total}（通过 ${resp.passedCount ?? 0}，未通过 ${resp.failedCount ?? 0}，出错 ${resp.errorCount ?? 0}）`;
}

/** 日志兜底：把文本里出现的令牌明文替换掉，避免误打印。 */
export function maskToken(text, token) {
  let out = String(text);
  if (token) out = out.split(token).join('lse_***');
  return out.replace(/lse_[0-9a-f]{8}_[0-9a-f]{32}/g, 'lse_***');
}
