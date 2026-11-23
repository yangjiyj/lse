import type { EndpointTaskSummary, FleetPostureFinding } from '@/lib/api';
import {
  REVIEW_ROW,
  skillHitFromCheck,
  type EndpointOverview,
  type EndpointRiskRow,
  type EndpointSkillHit,
  type EndpointSkillRow,
  type OverviewAssetState,
} from '../../../../../packages/shared/src/endpoint-overview';
import {
  SKILL_CAUSE_ORDER,
  buildNotCheckedRows,
  notCheckedAdminRows,
  notCheckedSubjectLabel,
  type NotCheckedEntry,
} from '../../../../../packages/shared/src/not-checked';
import { productLabel } from '@/lib/endpoint-agents';

type Finding = FleetPostureFinding;
type Subject = NonNullable<Finding['subjects']>[number];
type Group = EndpointTaskSummary['groups'][number];

const SUBJECT_LIMIT = 50;
const NO_REASON = '终端没有提供检查信息';
const DEFAULT_CHECK_ADVICE = '把终端探针升级到最新版本后重新检测。';
const ASSET_STATES: readonly OverviewAssetState[] = ['risk', 'review', 'clear', 'not_checked'];
/** 同一技能有多个对象时取最该说的：需处理 > 待确认 > 没检查 > 已检查无风险（与终端页同一顺序）。 */
const STATE_PRIORITY: Record<OverviewAssetState, number> = {
  clear: 0,
  not_checked: 1,
  review: 2,
  risk: 3,
};
const LEVEL_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** 对象状态原样采用；缺失或不认识的按没检查处理，既不当成无风险，也不当成有风险。 */
const subjectState = (s: Subject): OverviewAssetState =>
  ASSET_STATES.includes(s.state) ? s.state : 'not_checked';

/** 检查项状态以接口给的为准；没给才按结论推。 */
function findingState(f: Finding): OverviewAssetState {
  if (f.state && ASSET_STATES.includes(f.state)) return f.state;
  return f.verdict === 'FAIL' ? 'risk' : f.verdict === 'PASS' ? 'clear' : 'not_checked';
}

/** 同一句话只算一条；原因里用“；”拼出的多条按条拆开。 */
function distinctSentences(texts: string[]): string[] {
  return [
    ...new Set(
      texts
        .flatMap((text) => text.split('；'))
        .map((text) => text.trim())
        .filter(Boolean),
    ),
  ];
}

/** 同名对象只算一个，说明不同的并列；一个技能命中几条规则，也只是一个技能。 */
function distinctSubjects(
  subjects: ReadonlyArray<{ name: string; detail: string }>,
): Array<{ name: string; detail: string }> {
  const details = new Map<string, string[]>();
  for (const s of subjects) details.set(s.name, [...(details.get(s.name) ?? []), s.detail]);
  return [...details].map(([name, texts]) => ({
    name,
    detail: distinctSentences(texts).join('；'),
  }));
}

/** 列表里的“依据”只给一句：第一条原因，后面还有就标明数量；逐对象的完整说明在抽屉里。 */
function firstSentence(details: string[], fallback: string, counted: boolean): string {
  const sentences = distinctSentences(details);
  if (!sentences.length) return fallback;
  return counted && sentences.length > 1
    ? `${sentences[0]}等 ${sentences.length} 项原因`
    : sentences[0]!;
}

/** 与终端页同一口径：按规则编号归类；没检查的统一归“检查覆盖”。 */
function riskCategory(ruleId: string): EndpointRiskRow['category'] {
  if (ruleId.startsWith('skill')) return 'skill';
  if (ruleId.startsWith('mcp')) return 'mcp';
  if (ruleId === 'credentials') return 'credential';
  return 'permission';
}

/** 带成因键的没检查对象：按共享词表归类说明；没有成因键的是旧任务，沿用原来的整句原因。 */
const hasCause = (s: Subject) => subjectState(s) === 'not_checked' && !!s.cause;
const causeRank = (key: string) => {
  const index = SKILL_CAUSE_ORDER.indexOf(key as (typeof SKILL_CAUSE_ORDER)[number]);
  return index < 0 ? SKILL_CAUSE_ORDER.length : index;
};
/** 同一技能有多个成因时取最先该说的。 */
const pickCause = (a: string | undefined, b: string | undefined) =>
  a && b ? (causeRank(b) < causeRank(a) ? b : a) : (a ?? b);

/** 技能的命中位置：说明取受控词表，与终端页同一份，不回显脚本内容。 */
function subjectHits(subject: Subject): EndpointSkillHit[] {
  const raw = subject.hits?.length ? subject.hits : subject.rule_id ? [subject] : [];
  return raw.map(skillHitFromCheck);
}

/** 任务页的技能清单按对象合并：同一技能在几个检查项里出现，状态取最该说的，命中位置并在一起。 */
function collectSkill(skills: Map<string, EndpointSkillRow>, subject: Subject) {
  const previous = skills.get(subject.name);
  const next = subjectState(subject);
  const cause = pickCause(previous?.cause, next === 'not_checked' ? subject.cause : undefined);
  const hits = [...(previous?.hits ?? []), ...subjectHits(subject)].filter(
    (hit, i, all) =>
      all.findIndex(
        (x) =>
          x.rule === hit.rule &&
          x.file === hit.file &&
          x.line === hit.line &&
          x.contextType === hit.contextType,
      ) === i,
  );
  skills.set(subject.name, {
    name: subject.name,
    sourceLabel: '来源未记录',
    sourceState: 'unknown',
    installedIn: [],
    installs: 1,
    state:
      previous && STATE_PRIORITY[previous.state] > STATE_PRIORITY[next] ? previous.state : next,
    hits,
    ...(cause ? { cause } : {}),
  });
}

/** 按“规则”合并的问题行（需处理、待确认）：只列该状态的对象，同名对象只算一个。 */
function addRow(rows: Map<string, EndpointRiskRow>, row: EndpointRiskRow) {
  const existing = rows.get(row.id);
  if (!existing) {
    rows.set(row.id, row);
    return;
  }
  const merged = distinctSubjects([...existing.subjects, ...row.subjects]);
  existing.subjects = merged;
  existing.subjectCount = merged.length;
  existing.involved = `${merged.length} 个对象`;
}

/**
 * 按同一句原因合并的没检查行：
 * - 对象行：旧快照里没有成因键的没检查对象，沿用整句原因；
 * - 检查行：整项检查任务当时没有结果，也就没有对象可列，行内列检查项名称。
 */
interface ReasonBucket {
  reason: string;
  advice: string;
  titles: string[];
  subjects: Subject[];
}
function bucketOf(map: Map<string, ReasonBucket>, finding: Finding, reason: string) {
  let bucket = map.get(reason);
  if (!bucket) {
    bucket = {
      reason,
      advice: finding.howToCheck || DEFAULT_CHECK_ADVICE,
      titles: [],
      subjects: [],
    };
    map.set(reason, bucket);
  }
  const title = finding.plainTitle || finding.title;
  if (!bucket.titles.includes(title)) bucket.titles.push(title);
  return bucket;
}
const notCheckedTitle = (titles: string[]) =>
  titles.length === 1 ? `${titles[0]}没有检查` : `${titles[0]}等 ${titles.length} 项没有检查`;

const withLimit = (row: EndpointRiskRow): EndpointRiskRow => ({
  ...row,
  subjects: row.subjects.slice(0, SUBJECT_LIMIT),
  moreCount: Math.max(0, row.subjects.length - SUBJECT_LIMIT),
});

/** 仅转换任务保存的快照，不用终端当前状态替代历史证据。 */
export function postureTaskOverview(summary: EndpointTaskSummary): EndpointOverview {
  const risks = new Map<string, EndpointRiskRow>();
  const reviews = new Map<string, EndpointRiskRow>();
  const legacy = new Map<string, ReasonBucket>();
  const unrun = new Map<string, ReasonBucket>();
  const skills = new Map<string, EndpointSkillRow>();
  const entries: NotCheckedEntry[] = [];
  const row = (
    finding: Finding,
    group: Group,
    id: string,
    level: EndpointRiskRow['level'],
    subjects: Subject[],
    basis: string,
    advice: string,
    title = finding.plainTitle || finding.title,
  ): EndpointRiskRow => {
    const listed = distinctSubjects(subjects);
    return {
      id,
      level,
      category: riskCategory(finding.ruleId),
      title,
      involved: listed.length ? `${listed.length} 个对象` : group.label,
      basis,
      advice,
      subjectCount: listed.length,
      subjects: listed,
      moreCount: 0,
    };
  };
  for (const group of summary.groups)
    for (const finding of group.items) {
      const status = findingState(finding);
      const subjects = finding.subjects ?? [];
      for (const subject of subjects) {
        if (hasCause(subject))
          entries.push({
            cause: subject.cause!,
            name: notCheckedSubjectLabel(subject.name),
            // 词表外的兜底成因不说明是哪项检查，对象旁补上检查项标题。
            detail:
              subject.cause === 'check_missing'
                ? [finding.plainTitle || finding.title, subject.where].filter(Boolean).join(' · ')
                : (subject.where ?? ''),
            key: `${subject.cause}:${subject.name}\u0000${subject.where ?? ''}`,
          });
        if (subject.kind === 'skill') collectSkill(skills, subject);
      }
      // 人工复核判为无问题的检查项，不出风险行和待确认行。
      if (status === 'clear') continue;
      const only = (state: OverviewAssetState) => subjects.filter((s) => subjectState(s) === state);

      // 风险行只列有风险的对象；检查项判了有风险却没有逐对象明细的旧快照，仍沿用原证据文字。
      const risky = only('risk');
      if (risky.length || status === 'risk')
        addRow(
          risks,
          row(
            finding,
            group,
            finding.ruleId,
            finding.severity,
            risky,
            firstSentence(
              risky.map((s) => s.detail),
              finding.evidence || finding.plainWhy || '详情未记录',
              false,
            ),
            finding.plainFix || '请联系终端管理员复核配置。',
          ),
        );

      // 待确认：命中只出现在说明文档或缺少可执行位置，文案与终端页同一份。
      const unsure = only('review');
      if (unsure.length || status === 'review')
        addRow(
          reviews,
          row(
            finding,
            group,
            `${finding.ruleId}:review`,
            'REVIEW',
            unsure.map((s) => ({ ...s, detail: '' })),
            REVIEW_ROW.basis,
            REVIEW_ROW.advice,
            REVIEW_ROW.title,
          ),
        );

      // 没检查：带成因键的已进入按成因归类的行；没有成因键的是旧任务，沿用整句原因。
      const missing = only('not_checked').filter((s) => !s.cause);
      const reason = finding.notCheckedReason || NO_REASON;
      if (missing.length) bucketOf(legacy, finding, reason).subjects.push(...missing);
      // 整项检查当时没有结果，对象也只有“已检查无风险”或没有对象：不列对象，免得把它们写成没检查。
      else if (status === 'not_checked' && subjects.every((s) => subjectState(s) === 'clear'))
        bucketOf(unrun, finding, reason);
    }

  const legacyRows = [...legacy.values()].map((bucket): EndpointRiskRow => {
    const listed = distinctSubjects(bucket.subjects);
    return {
      id: `没检查-${bucket.reason}`,
      level: 'NOT_CHECKED',
      category: 'coverage',
      title: notCheckedTitle(bucket.titles),
      involved: `${listed.length} 个对象`,
      // 没有逐对象说明时，抽屉里没有别处可看，完整原因必须留在依据里。
      basis: firstSentence(
        bucket.subjects.map((s) => s.detail),
        bucket.reason,
        true,
      ),
      advice: bucket.advice,
      subjectCount: listed.length,
      subjects: listed,
      moreCount: 0,
    };
  });
  const unrunRows = [...unrun.values()].map(
    (bucket): EndpointRiskRow => ({
      id: `没检查项-${bucket.reason}`,
      level: 'NOT_CHECKED',
      category: 'coverage',
      title: notCheckedTitle(bucket.titles),
      involved: `${bucket.titles.length} 项检查`,
      basis: bucket.reason,
      advice: bucket.advice,
      subjectCount: bucket.titles.length,
      subjects: bucket.titles.map((name) => ({ name, detail: '' })),
      moreCount: 0,
    }),
  );
  // 有风险的在前（高危到低危），再是待确认；没检查的先放旧任务的整句原因，再放按成因归类的行（处理方、领域顺序由词表给出）。
  const open = [...risks.values()].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3),
  );
  const ordered = [
    ...open.map(withLimit),
    ...[...reviews.values()].map(withLimit),
    ...[...legacyRows, ...unrunRows].map(withLimit),
    ...buildNotCheckedRows(entries),
  ];
  const notChecked = ordered.filter((r) => r.level === 'NOT_CHECKED');
  return {
    endpointId: summary.endpointId || '',
    report: null,
    counts: {
      openRisks: open.length,
      highRisks: open.filter((r) => r.level === 'HIGH').length,
      reviewItems: reviews.size,
      agentKinds: summary.agents.length,
      agentInstalls: summary.agents.length,
      skills: skills.size,
      mcpServers: 0,
      notCheckedKinds: notChecked.length,
      notCheckedInstalls: notChecked.reduce((n, r) => n + r.subjectCount, 0),
      notCheckedAdmin: notCheckedAdminRows(notChecked),
    },
    risks: ordered,
    agents: summary.agents.map((a) => ({
      key: a.product,
      name: a.displayName || productLabel(a.product),
      version: a.version,
      installs: 1,
      // 旧任务没存读取状态：如实标“任务未记录”，不能当成终端没读到。
      configState: a.config?.state ?? 'unrecorded',
      configItems: a.config?.items ?? [],
      configNote: a.config?.note ?? null,
      location: a.location ?? null,
      account: a.account ?? null,
      issues: 0,
      liveEval: {
        supported: a.liveEvalSupported === true,
        registered: a.liveEvalRegistered === true,
        reason: a.liveEvalBlockedReason || null,
      },
    })),
    skills: [...skills.values()],
    platforms: [],
    mcp: [],
    history: [],
  };
}
