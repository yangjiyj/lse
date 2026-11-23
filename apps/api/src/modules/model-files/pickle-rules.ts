/**
 * Pickle 全局引用分级（对齐 picklescan `_unsafe_globals` 与 modelscan 危险名单）。
 * - dangerous：加载时可执行代码/命令、读写文件、发起网络、嵌套反序列化 → 高危
 * - safe：PyTorch/NumPy 权重重建所需的核心对象 → 不告警
 * - common：常见但非核心的对象（整模型保存的 nn.Module 类、argparse.Namespace 等）→ 提示
 * - unknown：其他 → 仅引用为中危；被 REDUCE/INST/OBJ/NEWOBJ 调用为高危
 */
export type GlobalClass = 'dangerous' | 'safe' | 'common' | 'unknown';

/** 整个模块（含子模块）均危险。 */
const DANGEROUS_MODULES = [
  'os', 'posix', 'nt', 'posixpath', 'ntpath', 'subprocess', 'commands', 'popen2', '_posixsubprocess',
  'runpy', 'socket', 'shutil', 'pty', 'sys', 'importlib', 'imp', 'ctypes', '_ctypes', 'pickle',
  '_pickle', 'cPickle', 'marshal', 'dill', 'cloudpickle', 'asyncio', 'multiprocessing', 'code',
  'codeop', 'pdb', 'bdb', 'timeit', 'cProfile', 'profile', 'pydoc', 'webbrowser', 'http.client',
  'httplib', 'aiohttp', 'requests', 'urllib', 'urllib2', 'ftplib', 'smtplib', 'telnetlib',
  'pip', 'venv', 'ensurepip', 'distutils', 'setuptools', 'doctest', 'idlelib', 'lib2to3', 'trace',
  '_osx_support', '_aix_support', '_pyrepl', 'pexpect', 'paramiko',
];
/** 模块内的具体危险名称。 */
const DANGEROUS_NAMES: Record<string, string[]> = {
  builtins: [
    'eval', 'exec', 'execfile', 'compile', 'open', 'file', 'input', 'breakpoint', '__import__',
    'getattr', 'setattr', 'delattr', 'globals', 'locals', 'vars', 'apply', 'reload', 'help', 'memoryview',
  ],
  operator: ['attrgetter', 'methodcaller'],
  functools: ['partial', 'reduce'],
  types: ['CodeType', 'FunctionType', 'LambdaType', 'MethodType', 'ModuleType'],
  torch: ['load'],
  'torch.serialization': ['load', '_load'],
  'torch.hub': ['*'],
  'torch.jit': ['load'],
  'torch._inductor.codecache': ['compile_file', '*'],
  'torch.utils.cpp_extension': ['*'],
  numpy: ['load', 'loadtxt', 'fromfile'],
  'numpy.lib.npyio': ['load', 'loadtxt'],
  'numpy.testing._private.utils': ['runstring'],
  joblib: ['load'],
  'joblib.numpy_pickle': ['load'],
  platform: ['popen'],
};
DANGEROUS_NAMES.__builtin__ = DANGEROUS_NAMES.builtins!;

const SAFE_PATTERNS: RegExp[] = [
  /^torch\._utils\._rebuild_[A-Za-z0-9_]+$/,
  /^torch\._tensor\._rebuild_from_type(?:_v2)?$/,
  /^torch\.(?:storage\.)?(?:_?Typed|_?Untyped|[A-Za-z0-9]*)Storage$/,
  /^torch\.(?:Size|device|dtype|memory_format|layout|strided|sparse_coo|contiguous_format|channels_last|preserve_format)$/,
  /^torch\.(?:float|float16|float32|float64|bfloat16|half|double|complex32|complex64|complex128|uint8|int8|int16|int32|int64|short|int|long|bool|qint8|quint8|qint32|float8_e4m3fn|float8_e5m2)$/,
  /^torch\.nn\.parameter\.(?:Parameter|Buffer|UninitializedParameter)$/,
  /^torch\._utils\._rebuild_parameter(?:_with_state)?$/,
  /^collections\.(?:OrderedDict|defaultdict|Counter|deque)$/,
  /^numpy\.(?:_core|core)\.multiarray\.(?:_reconstruct|scalar)$/,
  /^numpy\.(?:_core|core)\.numeric\._frombuffer$/,
  /^numpy\.(?:ndarray|dtype|matrix)$/,
  /^numpy\.dtypes\.[A-Za-z0-9]+DType$/,
  /^numpy\.(?:bool_|int8|int16|int32|int64|uint8|uint16|uint32|uint64|float16|float32|float64|complex64|complex128|str_|bytes_)$/,
  /^_codecs\.encode$/,
  /^(?:builtins|__builtin__)\.(?:set|frozenset|slice|complex|bytearray|bytes|tuple|list|dict|int|float|str|bool|range|object|unicode|long)$/,
];
const COMMON_PATTERNS: RegExp[] = [
  /^torch\.nn\.(?:modules\.)?[A-Za-z0-9_.]+$/,
  /^torch\.optim\.[A-Za-z0-9_.]+$/,
  /^torch\._C\._nn\.[A-Za-z0-9_]+$/,
  /^argparse\.Namespace$/,
  /^(?:copyreg|copy_reg)\._reconstructor$/,
  /^(?:datetime|decimal|fractions|uuid)\.[A-Za-z]+$/,
  /^pathlib\.(?:Path|PosixPath|WindowsPath|PurePosixPath|PureWindowsPath)$/,
  /^enum\.Enum$/,
];

const inModule = (module: string, m: string) => module === m || module.startsWith(`${m}.`);

export function classifyGlobal(module: string, name: string): GlobalClass {
  const full = `${module}.${name}`;
  const names = DANGEROUS_NAMES[module];
  if (names && (names.includes('*') || names.includes(name))) return 'dangerous';
  if (DANGEROUS_MODULES.some((m) => inModule(module, m) || full === m)) return 'dangerous';
  if (SAFE_PATTERNS.some((re) => re.test(full))) return 'safe';
  if (COMMON_PATTERNS.some((re) => re.test(full))) return 'common';
  return 'unknown';
}

/** CPython find_class 可接受的模块/名称形态；不符合者视为非 pickle 数据。 */
export const IDENT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
