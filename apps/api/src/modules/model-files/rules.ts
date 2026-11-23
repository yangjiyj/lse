import { aiAssetRule } from '../engines/ai-asset/taxonomy.js';
import {
  AUTO_EXEC_PAYLOAD,
  CONFIG_RULES,
  SCAN_NOTE_RULES,
  SCRIPT_PATTERN_RULES,
  type ModelFileRuleDef,
} from './script-rules.js';

export type { ModelFileRuleDef } from './script-rules.js';

const FORMAT = '模型文件格式';
const TEMPLATE = '模板注入';
const def = (
  id: string,
  category: string,
  severity: ModelFileRuleDef['severity'],
  title: string,
  description: string,
): ModelFileRuleDef => ({ id, category, severity, title, description });

/** 各格式解析器的规则（pickle、PyTorch、safetensors、GGUF、ONNX、Keras、NumPy）。 */
const FORMAT_RULES: ModelFileRuleDef[] = [
  def(
    'PICKLE_DANGEROUS_GLOBAL',
    FORMAT,
    'HIGH',
    'Pickle 加载时可执行危险对象',
    '引用 os.system、subprocess、eval、exec 等加载即可执行命令或代码的对象。',
  ),
  def(
    'PICKLE_UNSAFE_CALL',
    FORMAT,
    'HIGH',
    'Pickle 加载时调用非白名单对象',
    '通过 REDUCE/INST/OBJ/NEWOBJ 调用权重重建白名单以外的对象。',
  ),
  def(
    'PICKLE_UNLISTED_GLOBAL',
    FORMAT,
    'MEDIUM',
    'Pickle 引用非白名单全局对象',
    '引用了未知模块的对象，加载时需导入该模块。',
  ),
  def(
    'PICKLE_COMMON_GLOBAL',
    FORMAT,
    'INFO',
    'Pickle 引用常见非权重对象',
    '引用整模型保存的 nn.Module、argparse.Namespace 等常见对象。',
  ),
  def(
    'PICKLE_UNRESOLVED_STACK_GLOBAL',
    FORMAT,
    'MEDIUM',
    'STACK_GLOBAL 参数无法静态确定',
    '全局对象名由运行时计算，无法静态判断是否危险。',
  ),
  def(
    'PICKLE_EXTENSION_REF',
    FORMAT,
    'MEDIUM',
    'Pickle 使用 copyreg 扩展码引用对象',
    '通过扩展码间接引用对象，可绕过按名称的检查。',
  ),
  def(
    'PICKLE_TRAILING_DATA',
    FORMAT,
    'INFO',
    'Pickle 之后为非 pickle 数据',
    'pickle 结束标记之后还有其他数据。',
  ),
  def(
    'PICKLE_SIZE_LIMIT',
    FORMAT,
    'MEDIUM',
    'Pickle 超过扫描窗口，仅分析了头部',
    '超过扫描窗口的部分未分析。',
  ),
  def('PICKLE_PARSE_ABORTED', FORMAT, 'MEDIUM', 'Pickle 解析中止', 'opcode 解析遇到异常而中止。'),
  def(
    'PICKLE_PARSED',
    FORMAT,
    'INFO',
    'Pickle opcode 解析完成',
    '全部 opcode 解析完成，未发现危险调用。',
  ),
  def(
    'PICKLE_NO_PROTO_HEADER',
    FORMAT,
    'INFO',
    '文件不以 pickle PROTO 开头',
    '协议 0/1 或非 pickle 数据，仍按 pickle 解析。',
  ),
  def(
    'PYTORCH_ZIP_NO_PICKLE',
    FORMAT,
    'LOW',
    'ZIP 归档内未找到 pickle',
    'PyTorch 归档中没有 data.pkl 等 pickle 条目。',
  ),
  def(
    'SAFETENSORS_INVALID',
    FORMAT,
    'HIGH',
    'safetensors 结构异常',
    '头长度、张量区间、dtype 或大小与规范不符。',
  ),
  def(
    'SAFETENSORS_VALIDATED',
    FORMAT,
    'INFO',
    'safetensors 结构检查通过',
    '张量头与数据区间校验通过。',
  ),
  def('GGUF_PARSED', FORMAT, 'INFO', 'GGUF 元数据解析完成', '元数据与张量信息表解析完成。'),
  def('GGUF_PARSE_ABORTED', FORMAT, 'MEDIUM', 'GGUF 解析中止', 'GGUF 头部解析遇到异常而中止。'),
  def('GGUF_VERSION_LIMITED', FORMAT, 'MEDIUM', 'GGUF 版本不受支持', '仅解析 v2/v3。'),
  def(
    'ONNX_CUSTOM_OP',
    FORMAT,
    'MEDIUM',
    'ONNX 使用非标准域自定义算子',
    '自定义算子需加载额外的本地库。',
  ),
  def('ONNX_MODEL_FUNCTION', FORMAT, 'LOW', 'ONNX 定义模型内函数', '模型内定义了函数。'),
  def(
    'ONNX_EXTERNAL_DATA_TRAVERSAL',
    FORMAT,
    'HIGH',
    'ONNX 外部数据路径越出模型目录',
    'external_data 路径含 .. 或绝对路径，可读取任意文件。',
  ),
  def('ONNX_PARSED', FORMAT, 'INFO', 'ONNX 结构解析完成', 'ONNX 结构解析完成。'),
  def('ONNX_PARSE_ABORTED', FORMAT, 'MEDIUM', 'ONNX 解析中止', 'ONNX 解析遇到异常而中止。'),
  def(
    'KERAS_LAMBDA_LAYER',
    FORMAT,
    'HIGH',
    'Keras 模型含 Lambda 层（加载时可执行任意代码）',
    'Lambda 层序列化了 Python 代码，加载即执行。',
  ),
  def(
    'KERAS_CUSTOM_OBJECT',
    FORMAT,
    'MEDIUM',
    'Keras 模型依赖自定义层或对象',
    '加载需导入自定义代码。',
  ),
  def(
    'KERAS_H5_LAMBDA_LAYER',
    FORMAT,
    'HIGH',
    'Keras H5 模型含 Lambda 层',
    'Lambda 层序列化了 Python 代码，加载即执行。',
  ),
  def(
    'KERAS_H5_CUSTOM_OBJECT',
    FORMAT,
    'MEDIUM',
    'Keras H5 模型依赖自定义层或对象',
    '加载需导入自定义代码。',
  ),
  def('KERAS_CONFIG_MISSING', FORMAT, 'MEDIUM', 'Keras 归档缺少 config.json', '无法检查模型结构。'),
  def('KERAS_PARSED', FORMAT, 'INFO', 'Keras config.json 解析完成', 'Keras 配置解析完成。'),
  def('KERAS_PARSE_ABORTED', FORMAT, 'MEDIUM', 'Keras 解析中止', 'Keras 解析遇到异常而中止。'),
  def(
    'KERAS_H5_HEURISTIC',
    FORMAT,
    'MEDIUM',
    'Keras H5 启发式检查',
    '按字节搜索 H5 中的模型配置。',
  ),
  def('NUMPY_INVALID', FORMAT, 'MEDIUM', 'npy 结构异常', '魔数或头长度不符合规范。'),
  def(
    'NUMPY_OBJECT_ARRAY',
    FORMAT,
    'LOW',
    'npy 为 object 数组（加载需 allow_pickle）',
    'object 数组按 pickle 存储，加载需 allow_pickle。',
  ),
  def('NUMPY_PARSED', FORMAT, 'INFO', 'npy 数值数组', '数值数组，不含 pickle。'),
  def('MODEL_PARSE_ABORTED', FORMAT, 'MEDIUM', '模型文件解析中止', '解析遇到异常而中止。'),
  def(
    'MODEL_FORMAT_UNKNOWN',
    FORMAT,
    'LOW',
    '未识别的模型文件格式',
    '未匹配已支持格式，静态扫描不构成安全保证。',
  ),
  def(
    'GGUF_TEMPLATE_SSTI',
    TEMPLATE,
    'HIGH',
    'chat_template 含模板沙箱逃逸特征',
    'GGUF 或 tokenizer_config.json 的 chat_template 含 __globals__、__subclasses__ 等 Jinja 沙箱逃逸链。',
  ),
  def(
    'GGUF_TEMPLATE_INJECTION',
    TEMPLATE,
    'MEDIUM',
    'chat_template 含可疑注入指令',
    '模板里写入了“忽略之前的指令”等提示注入语句。',
  ),
  def(
    'GGUF_TEMPLATE_URL',
    TEMPLATE,
    'INFO',
    'chat_template 含外部链接',
    '模板渲染不会访问该地址，供人工知悉。',
  ),
  def(
    'GGUF_TEMPLATE_OVERSIZE',
    TEMPLATE,
    'MEDIUM',
    'chat_template 超长未检查',
    '模板超过 1MiB，未检查。',
  ),
  def(
    'KNOWN_MODEL_HASH_MISMATCH',
    '已知模型校验',
    'HIGH',
    '与已知发布文件不一致',
    '能确定对应的已知仓库（同目录其他文件命中、路径带仓库名，或文件名只属于一个官方仓库）时，同名文件大小相同而 sha256 不同，可能被篡改或替换。',
  ),
  def(
    'KNOWN_MODEL_NAME_ONLY',
    '已知模型校验',
    'INFO',
    '同名但不是同一文件',
    '与已知仓库的文件同名但大小不同，可能是其他发布者的版本或本地重新生成。',
  ),
  def(
    'KNOWN_MODEL_OLD_VERSION',
    '已知模型校验',
    'INFO',
    '官方旧版本',
    'sha256 命中官方仓库历史提交里的权重文件，官方之后已更新该文件。',
  ),
  def(
    'KNOWN_MODELS_DATA_INVALID',
    '扫描提示',
    'LOW',
    '已知模型库有无效数据',
    '数据文件有无法解析的行，已跳过，其余条目照常匹配。',
  ),
  def(
    'ARCHIVE_ENTRIES_SKIPPED',
    '扫描提示',
    'LOW',
    '压缩包内部分条目未检查',
    '压缩包内超过 500 个条目、读取总量超过 64 MiB，或内层压缩包嵌套超过一层的部分未检查。',
  ),
];

/** 复用组件扫描的代码规则（Python、JS/TS、Shell、PowerShell、批处理）：引用 ai-asset 的定义，不复制。 */
export const REUSED_CODE_RULE_IDS = [
  'code.command_execution',
  'code.command_injection',
  'code.remote_code_execution',
  'code.dynamic_execution',
  'code.obfuscated_execution',
  'code.data_exfiltration',
  'code.sensitive_file_access',
  'code.path_traversal',
  'code.ssrf',
] as const;

function reusedCodeRules(): ModelFileRuleDef[] {
  return REUSED_CODE_RULE_IDS.map((id) => {
    const d = aiAssetRule(id)!;
    return def(d.ruleId, '脚本（组件扫描规则）', d.severity, d.title, d.description);
  });
}

/**
 * 提示类：解析和扫描过程的说明（解析完成、解析中止、超出上限未检查、格式未识别）以及识别结果的说明，
 * 不是在找风险，不计入检测规则数。
 */
const NOTE_RULE_IDS: ReadonlySet<string> = new Set([
  'PICKLE_TRAILING_DATA',
  'PICKLE_SIZE_LIMIT',
  'PICKLE_PARSE_ABORTED',
  'PICKLE_PARSED',
  'PICKLE_NO_PROTO_HEADER',
  'PYTORCH_ZIP_NO_PICKLE',
  'SAFETENSORS_VALIDATED',
  'GGUF_PARSED',
  'GGUF_PARSE_ABORTED',
  'GGUF_VERSION_LIMITED',
  'ONNX_PARSED',
  'ONNX_PARSE_ABORTED',
  'KERAS_CONFIG_MISSING',
  'KERAS_PARSED',
  'KERAS_PARSE_ABORTED',
  'KERAS_H5_HEURISTIC',
  'NUMPY_PARSED',
  'MODEL_PARSE_ABORTED',
  'MODEL_FORMAT_UNKNOWN',
  'GGUF_TEMPLATE_OVERSIZE',
  'KNOWN_MODEL_NAME_ONLY',
  'KNOWN_MODEL_OLD_VERSION',
]);

/** 模型文件扫描的全部规则：格式解析、已知模型校验、模板注入、脚本、VBA 宏、Windows 脚本、配置文件、扫描提示。 */
export const MODEL_FILE_RULES: ModelFileRuleDef[] = [
  ...FORMAT_RULES,
  ...reusedCodeRules(),
  ...SCRIPT_PATTERN_RULES.map(({ id, category, severity, title, description }) => ({
    id,
    category,
    severity,
    title,
    description,
  })),
  AUTO_EXEC_PAYLOAD,
  ...CONFIG_RULES,
  ...SCAN_NOTE_RULES,
].map((r) => ({
  ...r,
  kind:
    r.category === '扫描提示' || NOTE_RULE_IDS.has(r.id) ? ('note' as const) : ('detect' as const),
}));

/** 扫描明细「脚本风险」的分组及顺序：脚本按语言，配置文件单独一组。 */
export const SCRIPT_RISK_FORMATS = [
  'python',
  'javascript',
  'typescript',
  'shell',
  'powershell',
  'batch',
  'vbscript',
  'vba',
  'office-macro',
  'config',
] as const;

const BY_ID = new Map(MODEL_FILE_RULES.map((r) => [r.id, r]));
export function modelFileRule(id: string): ModelFileRuleDef | undefined {
  return BY_ID.get(id);
}
