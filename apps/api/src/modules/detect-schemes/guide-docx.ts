import type { FileChild } from 'docx';
import {
  DETECT_CATEGORY_LABELS,
  LEDGER_ASSET_TYPES,
  LEDGER_ASSET_TYPE_LABELS,
  LEDGER_ATTR_FIELDS,
  TOOL_TASK_ENTRIES,
  isDetectCategory,
  isLedgerAssetType,
  isToolTaskEntryKey,
  type LedgerAssetType,
} from '@lse/shared';
import {
  bullets,
  docTitle,
  gap,
  heading1,
  heading2,
  kvTable,
  labelled,
  numbered,
  packDocx,
  para,
  table,
} from '../reports/docx/docx-kit.js';
import { formatDateTime } from '../reports/labels.js';
import type { ToolVersionView } from '../tools/service.js';
import { ENTRY_GUIDE_STEPS } from './guide-steps.js';
import type { SchemeRequirement } from './service.js';

// 作业指导书（2.8.3）：检测概况、检测对象、检测项清单、作业步骤、配套工具、注意事项。
// 大方案（上千个清单项）也要快：作业步骤按检测入口分组，每个入口一节、节内列适用对象；
// 工具操作说明只在「配套工具」一章按工具写一次，作业步骤里写「见第五章」。

export interface GuideAsset {
  type: string;
  name: string;
  code: string | null;
  ownerName: string | null;
  ownerDepartment: string | null;
  attrs: Record<string, unknown>;
}

export interface GuideItem {
  title: string;
  category: string;
  entryKey: string;
  mode: string;
  note: string;
  assetName: string | null;
}

export interface GuideTool {
  name: string;
  instructions: string;
  entryKeys: string[];
  versions: ToolVersionView[];
}

export interface GuideInput {
  schemeName: string;
  requirement: SchemeRequirement;
  assets: GuideAsset[];
  /** 只传启用的清单项，按清单顺序 */
  items: GuideItem[];
  /** 配套工具；为 null 表示调用者没有 tool:read，不写配套工具相关内容 */
  tools: GuideTool[] | null;
  watermark: string | null;
  now: Date;
}

/** 注意事项（固定 4 条）。 */
export const GUIDE_NOTICES = [
  '检测前取得被检测单位的书面授权，明确检测范围和时间窗口。',
  '只在授权范围内探测，不扫描范围外的地址、端口和系统。',
  '账号、口令、密钥等凭据不写入报告和作业记录。',
  '发现高危风险立即通报被检测单位联系人，并留存证据。',
] as const;

const DASH = '—';
const CHAPTERS = ['一', '二', '三', '四', '五', '六'];
const MODE_LABELS: Record<string, string> = { auto: '平台自动', manual: '人工使用工具' };

/** 检测对象表里各类型显示的关键属性。 */
const KEY_ATTRS: Record<LedgerAssetType, string[]> = {
  platform: ['url', 'deploymentMode'],
  server: ['ip', 'os'],
  endpoint: ['ip', 'user'],
  software: ['vendor', 'version'],
  model: ['modelName', 'version'],
  component: ['componentType', 'version'],
};

function attrText(type: LedgerAssetType, key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const field = LEDGER_ATTR_FIELDS[type].find((f) => f.key === key);
  const text =
    field?.input === 'select'
      ? (field.options?.find((o) => o.value === value)?.label ?? String(value))
      : String(value);
  return `${field?.label ?? key}：${text}`;
}

export function keyAttrs(asset: Pick<GuideAsset, 'type' | 'attrs'>): string {
  if (!isLedgerAssetType(asset.type)) return '';
  const type = asset.type;
  return KEY_ATTRS[type]
    .map((key) => attrText(type, key, asset.attrs[key]))
    .filter(Boolean)
    .join('；');
}

function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return DASH;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function entryLabel(entryKey: string): string {
  return isToolTaskEntryKey(entryKey) ? TOOL_TASK_ENTRIES[entryKey].label : entryKey;
}

function categoryLabel(category: string): string {
  return isDetectCategory(category) ? DETECT_CATEGORY_LABELS[category] : category;
}

/** 清单项按检测入口分组，保持清单里第一次出现的顺序。 */
function groupByEntry(items: GuideItem[]): Array<[string, GuideItem[]]> {
  const groups = new Map<string, GuideItem[]>();
  for (const item of items) {
    const list = groups.get(item.entryKey);
    if (list) list.push(item);
    else groups.set(item.entryKey, [item]);
  }
  return [...groups.entries()];
}

const objectName = (item: GuideItem) => item.assetName ?? item.title;
const unique = (values: string[]) => [...new Set(values)];

function instructionLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function buildSchemeGuideDocx(input: GuideInput): Promise<Buffer> {
  const { requirement: req } = input;
  const tools = input.tools;
  const toolsOf = (entryKey: string) => (tools ?? []).filter((t) => t.entryKeys.includes(entryKey));
  let chapter = 0;
  const chapterTitle = (title: string) => heading1(`${CHAPTERS[chapter++]}、${title}`);
  const children: FileChild[] = [docTitle(`${input.schemeName} 检测作业指导书`)];

  // 检测概况
  children.push(chapterTitle('检测概况'));
  const planned =
    req.plannedStart || req.plannedEnd
      ? `${req.plannedStart ?? '未定'} 至 ${req.plannedEnd ?? '未定'}`
      : '未定';
  const contact = [req.contactName, req.contactPhone].filter(Boolean).join('　') || DASH;
  children.push(
    kvTable([
      { k: '方案名称', v: input.schemeName },
      { k: '检测目标', v: req.objective || DASH },
      { k: '检测类别', v: req.categories.map(categoryLabel).join('、') || DASH },
      { k: '计划时间', v: planned },
      { k: '联系人', v: contact },
      { k: '生成时间', v: formatDateTime(input.now) },
    ]),
  );
  if (req.notes) children.push(gap(), labelled('备注', req.notes));
  children.push(gap());

  // 检测对象（按类型分组）
  children.push(chapterTitle('检测对象'));
  if (input.assets.length === 0) children.push(para('无'));
  for (const type of LEDGER_ASSET_TYPES) {
    const rows = input.assets.filter((a) => a.type === type);
    if (rows.length === 0) continue;
    children.push(heading2(LEDGER_ASSET_TYPE_LABELS[type]));
    children.push(
      table(
        ['名称', '编号', '类型', '关键属性', '责任人'],
        rows.map((a) => [
          a.name,
          a.code || DASH,
          LEDGER_ASSET_TYPE_LABELS[type],
          keyAttrs(a) || DASH,
          [a.ownerName, a.ownerDepartment].filter(Boolean).join('　') || DASH,
        ]),
        [3, 2, 1.5, 4, 2],
      ),
      gap(),
    );
  }

  // 检测项清单
  children.push(chapterTitle('检测项清单'));
  if (input.items.length === 0) {
    children.push(para('无'));
  } else {
    const headers = ['序号', '对象', '类别', '检测项', '方式', ...(tools ? ['配套工具'] : [])];
    children.push(
      table(
        headers,
        input.items.map((item, i) => [
          String(i + 1),
          item.assetName ?? DASH,
          categoryLabel(item.category),
          item.title,
          MODE_LABELS[item.mode] ?? item.mode,
          ...(tools
            ? [
                toolsOf(item.entryKey)
                  .map((t) => t.name)
                  .join('、') || DASH,
              ]
            : []),
        ]),
        tools ? [1, 3, 2, 4, 2, 3] : [1, 3, 2, 5, 2],
      ),
      gap(),
    );
  }

  // 作业步骤：每个检测入口一节，节内列适用对象
  // 配套工具紧跟作业步骤，是下一章
  const toolsChapter = CHAPTERS[chapter + 1]!;
  children.push(chapterTitle('作业步骤'));
  const groups = groupByEntry(input.items);
  if (groups.length === 0) children.push(para('无'));
  groups.forEach(([entryKey, items], i) => {
    children.push(heading2(`${i + 1}. ${entryLabel(entryKey)}`));
    const auto = unique(items.filter((it) => it.mode === 'auto').map(objectName));
    const manual = unique(items.filter((it) => it.mode !== 'auto').map(objectName));
    if (auto.length) children.push(labelled('适用对象（平台自动）', auto.join('、')));
    if (manual.length) children.push(labelled('适用对象（人工使用工具）', manual.join('、')));
    for (const item of items) {
      if (item.note) children.push(labelled('说明', `${objectName(item)}：${item.note}`));
    }
    const guide = isToolTaskEntryKey(entryKey) ? ENTRY_GUIDE_STEPS[entryKey] : null;
    if (guide) {
      children.push(para('准备', { bold: true }), ...bullets(guide.prepare));
      children.push(para('步骤', { bold: true }), ...numbered(guide.steps));
    }
    const entryTools = toolsOf(entryKey);
    if (entryTools.length) {
      children.push(
        labelled(
          '配套工具',
          `见第${toolsChapter}章 ${entryTools.map((t) => `「${t.name}」`).join('')}`,
        ),
      );
    }
    if (guide) children.push(labelled('结果查看', guide.result));
  });

  // 配套工具：版本表，操作说明每个工具只写一次
  if (tools) {
    children.push(chapterTitle('配套工具'));
    const toolRows = tools.flatMap((t) =>
      t.versions.length
        ? t.versions.map((v) => [
            t.name,
            v.version,
            `${v.os}/${v.arch}`,
            formatSize(v.size),
            v.sha256 || DASH,
            `平台「工具中心 → ${t.name}」`,
          ])
        : [[t.name, DASH, DASH, DASH, DASH, `平台「工具中心 → ${t.name}」`]],
    );
    if (toolRows.length === 0) {
      children.push(para('无'));
    } else {
      children.push(
        table(
          ['工具', '版本', '系统/架构', '大小', 'SHA-256', '获取位置'],
          toolRows,
          [2.5, 1.5, 1.8, 1.2, 4, 2.5],
        ),
        gap(),
      );
    }
    for (const tool of tools) {
      const lines = instructionLines(tool.instructions);
      if (lines.length === 0) continue;
      children.push(heading2(`「${tool.name}」操作说明`));
      children.push(...lines.map((line) => para(line)));
    }
  }

  // 注意事项
  children.push(chapterTitle('注意事项'));
  children.push(...numbered([...GUIDE_NOTICES]));

  return packDocx(`${input.schemeName} 检测作业指导书`, children, {
    watermark: input.watermark,
    headerText: '检测作业指导书',
    footerText: input.schemeName,
  });
}
