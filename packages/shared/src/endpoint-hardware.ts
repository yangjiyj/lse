/**
 * 终端硬件、算力卡与训练推理框架（探针主机快照 host 的投影）。
 * 探针上报用下划线字段（accelerators、ai_components），接口返回驼峰字段；旧探针没有的字段为 null，页面显示「—」。
 */
export interface EndpointAccelerator {
  vendor: string;
  model: string;
  memoryMB?: number;
  driverVersion?: string;
  index?: number;
  busId?: string;
  source: string;
}

export interface EndpointAIComponent {
  id: string;
  name: string;
  category: string;
  version?: string;
  source: string;
  package?: string;
  env?: string;
}

export interface EndpointDisk {
  mountpoint: string;
  fsType?: string;
  totalBytes?: number;
  freeBytes?: number;
  usedPct?: number;
}

export interface EndpointHardware {
  collectedAt: string | null;
  os: string | null;
  osVersion: string | null;
  platform: string | null;
  platformVersion: string | null;
  kernelVersion: string | null;
  arch: string | null;
  cpuModel: string | null;
  cpuCores: number | null;
  cpuCountLogical: number | null;
  memoryTotalMB: number | null;
  disks: EndpointDisk[] | null;
  accelerators: EndpointAccelerator[] | null;
  /** 算力卡采集不完整的原因代码（见 ACCELERATOR_ERROR_LABELS）；旧探针没有时为 null。 */
  acceleratorErrors: string[] | null;
  aiComponents: EndpointAIComponent[] | null;
  /** 框架与组件识别不完整的原因代码（见 AI_COMPONENT_ERROR_LABELS）；旧探针没有时为 null。 */
  aiComponentErrors: string[] | null;
}

export const ACCELERATOR_VENDOR_LABELS: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  huawei: '华为昇腾',
  hygon: '海光',
  cambricon: '寒武纪',
  iluvatar: '天数智芯',
  moorethreads: '摩尔线程',
  enflame: '燧原',
  kunlunxin: '昆仑芯',
  metax: '沐曦',
  vastai: '瀚博',
  habana: 'Habana',
  jingjia: '景嘉微',
  apple: 'Apple',
  other: '其他',
};

export const ACCELERATOR_SOURCE_LABELS: Record<string, string> = {
  'nvidia-smi': 'nvidia-smi',
  'npu-smi': 'npu-smi',
  'rocm-smi': 'rocm-smi',
  pci: 'PCI 设备',
  wmi: 'WMI',
  system_profiler: 'system_profiler',
};

export const ACCELERATOR_ERROR_LABELS: Record<string, string> = {
  accelerators_unavailable: '未能读取设备列表',
  accelerators_limit_exceeded: '超过 64 块，只列前 64 块',
  accelerator_tool_untrusted: '厂商命令文件权限不安全，未执行',
  accelerator_tool_timeout: '厂商命令超时',
};

export const AI_COMPONENT_ERROR_LABELS: Record<string, string> = {
  python_env_limit_exceeded: 'Python 环境过多，未全部识别',
  site_packages_limit_exceeded: '包目录过大，未全部识别',
  ai_component_limit_exceeded: '超过 256 条，只列前 256 条',
  ai_component_timeout: '识别超时',
  ai_component_catalog_unavailable: '指纹库不可用',
  ai_component_failed: '识别出错',
};

/** 显示顺序即分组顺序。 */
export const AI_COMPONENT_CATEGORIES = [
  'training',
  'inference',
  'app_framework',
  'vector_db',
  'model_sdk',
  'component',
] as const;

export const AI_COMPONENT_CATEGORY_LABELS: Record<string, string> = {
  training: '训练框架',
  inference: '推理框架',
  app_framework: '应用框架',
  vector_db: '向量数据库',
  model_sdk: '模型接入 SDK',
  component: '应用组件',
};

export const AI_COMPONENT_SOURCE_LABELS: Record<string, string> = {
  python_package: 'Python 包',
  process: '进程',
  container_image: '容器镜像',
};

export const AI_COMPONENT_ENV_LABELS: Record<string, string> = {
  system: '系统 Python',
  user: '用户目录',
  conda: 'conda',
  venv: 'venv',
  pyenv: 'pyenv',
};
