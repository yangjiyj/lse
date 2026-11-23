export type ModelSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type ModelFinding = {
  ruleId: string;
  severity: ModelSeverity;
  title: string;
  detail: string;
  /** 命中内容所在文件的格式；压缩包里的脚本、宏用它标出语言，缺省为所在文件的格式 */
  format?: ModelFormat;
};
export type ModelFormat =
  | 'pickle'
  | 'pytorch-zip'
  | 'safetensors'
  | 'gguf'
  | 'onnx'
  | 'keras'
  | 'keras-h5'
  | 'numpy'
  | 'zip'
  | 'config'
  | 'office-macro'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'shell'
  | 'powershell'
  | 'batch'
  | 'vbscript'
  | 'vba'
  | 'unknown';
/** 模型权重文件的扩展名（目录扫描、压缩包内判断权重所在目录用）。 */
export const MODEL_FILE_EXT =
  /\.(?:pkl|pickle|pt|pth|bin|ckpt|joblib|safetensors|gguf|onnx|h5|hdf5|keras|npy|npz)$/i;
/** 随模型一起扫描、但本身不是模型的文件格式（不进 AIBOM 的模型组件）。 */
export const AUX_FORMATS: ReadonlySet<string> = new Set<ModelFormat>([
  'zip',
  'config',
  'office-macro',
  'python',
  'javascript',
  'typescript',
  'shell',
  'powershell',
  'batch',
  'vbscript',
  'vba',
]);
export interface FormatScan {
  format: ModelFormat;
  findings: ModelFinding[];
  /** 供 AIBOM 使用的参数信息（参数量、架构、张量数等），均为解析所得。 */
  meta: Record<string, unknown>;
}
export interface ScanLimits {
  /** pickle 扫描窗口：单个 pickle（含 zip 内条目解压后）实际解析的字节上限，超出部分标注未扫描。 */
  pickleMaxBytes: number;
  /** 压缩包内脚本、配置、宏文档、内层 zip 的读取总量上限，缺省 ARCHIVE_TEXT_MAX_BYTES。 */
  archiveTextMaxBytes?: number;
}
/** 压缩包内文本条目（含一层内层 zip）的读取总量上限和条目数上限。 */
export const ARCHIVE_TEXT_MAX_BYTES = 64 * 1024 * 1024;
export const ARCHIVE_TEXT_MAX_ENTRIES = 500;
export const DEFAULT_LIMITS: ScanLimits = { pickleMaxBytes: 512 * 1024 * 1024 };
