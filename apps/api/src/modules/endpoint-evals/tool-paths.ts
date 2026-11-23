const SHELL_TOOL_RE =
  /^(?:bash|shell|exec|run_shell|run_command|command_execution|shell_command|exec_command|local_shell|run_shell_command|execute_command|execute_bash|execute_pwsh|powershell)$/i;
const READ_TOOL_RE =
  /^(?:read|read_file|get_file|cat_file|load_file|glob|grep|list_dir|grep_files)$/i;

export function isShellTool(tool: string): boolean {
  return SHELL_TOOL_RE.test(tool);
}

export function shellCommand(input: Record<string, unknown>): string {
  if (input.action && typeof input.action === 'object')
    return shellCommand(input.action as Record<string, unknown>);
  const value = input.command ?? input.cmd;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return '';
  if (/^(?:.*\/)?(?:bash|sh|zsh)$/.test(value[0] ?? '') && /^-l?c$/.test(value[1] ?? ''))
    return value[2] ?? '';
  return value.map((v) => `'${v.replaceAll("'", "'\"'\"'")}'`).join(' ');
}

// 仅提取静态 shell 文件操作数；引号内的正文和 heredoc 内容不能变成文件路径。
export function shellOperations(command: string): Array<{ words: string[]; next: string }> {
  let delimiter = '';
  const source = command
    .split('\n')
    .filter((line) => {
      if (delimiter) {
        if (line.trim() === delimiter) delimiter = '';
        return false;
      }
      const heredoc = line.match(/<<-?\s*['"]?(\w+)['"]?/);
      if (heredoc) delimiter = heredoc[1]!;
      return true;
    })
    .join('\n');
  const calls: Array<{ words: string[]; next: string }> = [];
  let words: string[] = [],
    word = '',
    quote = '',
    started = false;
  const flush = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\\' && quote !== "'") {
      word += source[++i] ?? '';
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/[;\n|&]/.test(char)) {
      flush();
      let next = char;
      if (source[i + 1] === char && (char === '|' || char === '&')) next += source[++i];
      if (words.length) calls.push({ words, next });
      words = [];
    } else if (char === '<' || char === '>') {
      flush();
      let op = char;
      if (source[i + 1] === char) op += source[++i];
      words.push(op);
    } else if (/\s/.test(char)) flush();
    else {
      word += char;
      started = true;
    }
  }
  flush();
  if (words.length) calls.push({ words, next: '' });
  return calls.flatMap(({ words: call, next }) => {
    // env、command、exec 包装不会改变实际执行程序；先去掉环境赋值与分隔符。
    while (/^(?:env|command|exec)$/.test(call[0]?.split('/').at(-1) ?? '')) {
      call = call.slice(1);
      while (call.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(call[0]!) || call[0] === '--')) call.shift();
    }
    if (/^(?:.*\/)?(?:bash|sh|zsh)$/.test(call[0] ?? '') && /^-l?c$/.test(call[1] ?? '')) {
      const inner = shellOperations(call[2] ?? '');
      if (inner.length) inner[inner.length - 1]!.next = next;
      return inner;
    }
    return [{ words: call, next }];
  });
}
export function shellWords(command: string): string[][] {
  return shellOperations(command).map((operation) => operation.words);
}

export function readPaths(tool: string, input: Record<string, unknown>): string[] {
  if (READ_TOOL_RE.test(tool))
    return ['path', 'file_path', 'filename', 'target_file'].flatMap((key) =>
      typeof input[key] === 'string' ? [input[key] as string] : [],
    );
  if (!isShellTool(tool)) return [];
  return shellWords(shellCommand(input)).flatMap(([executable, ...args]) => {
    const paths: string[] = [];
    const exe = executable?.split('/').at(-1) ?? '';
    const reader = /^(?:cat|head|tail|wc|ls|stat|du|less|more|grep|rg|sort|uniq|diff|cp)$/.test(
      exe,
    );
    let pattern = /^(?:grep|rg)$/.test(exe),
      options = true;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (['<', '>', '>>', '<<'].includes(arg)) {
        if (arg === '<' && args[i + 1]) paths.push(args[i + 1]!);
        i++;
      } else if (options && arg === '--') options = false;
      else if (options && arg.startsWith('-')) {
        if (/^(?:-e|--regexp|-f|--file)$/.test(arg)) {
          if ((arg === '-f' || arg === '--file') && args[i + 1]) paths.push(args[i + 1]!);
          pattern = false;
          i++;
        } else if (
          (/^(?:head|tail)$/.test(exe) && /^(?:-n|-c|--lines|--bytes)$/.test(arg)) ||
          (/^(?:grep|rg)$/.test(exe) &&
            /^(?:-g|--glob|-t|--type|-A|-B|-C|-m|--max-count)$/.test(arg))
        )
          i++;
      } else if (reader && pattern) pattern = false;
      else if (reader) paths.push(arg);
    }
    return paths;
  });
}

/** 内容读取与目录/元数据查看分开，避免把 stat/ls 当成读取凭据。 */
export function contentReadPaths(tool: string, input: Record<string, unknown>): string[] {
  if (/^(?:read|read_file|get_file|cat_file|load_file)$/i.test(tool)) return readPaths(tool, input);
  if (!isShellTool(tool)) return [];
  return shellWords(shellCommand(input)).flatMap(([exe, ...args]) => {
    const program = exe?.split('/').at(-1)?.toLowerCase() ?? '';
    if (program === 'get-content' || program === 'gc') return args.filter((arg) => !arg.startsWith('-'));
    if (/^python[\d.]*$/.test(program) && args[0] === '-c') {
      const code = (args[1] ?? '').replace(/^(?:import [\w., ]+;\s*)+/, '');
      const match = code.match(/^(?:print\s*\(\s*)?(?:open|(?:pathlib\.)?Path)\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*(?:read|read_text|read_bytes)\s*\(/);
      return match ? [match[2]!] : [];
    }
    if (!/^(?:cat|head|tail|less|more|grep|rg|sort|uniq|diff|cp)$/.test(program)) return [];
    if (program === 'cp') args = args.slice(0, -1);
    return readPaths('bash', { command: [exe!, ...args].map((word) => `'${word.replaceAll("'", "'\"'\"'")}'`).join(' ') });
  });
}
