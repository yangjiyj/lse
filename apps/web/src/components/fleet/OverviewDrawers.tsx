import type {
  EndpointAgentRow,
  EndpointMcpRow,
  EndpointRiskRow,
  EndpointSkillRow,
  OverviewAssetState,
} from '../../../../../packages/shared/src/endpoint-overview';
import {
  CONFIG_DEFAULT_NOTE,
  NOT_CHECKED_CAUSES,
  agentConfigCauses,
  type NotCheckedCauseKey,
} from '../../../../../packages/shared/src/not-checked';
import { Badge } from '@/components/ui/badge';
import {
  CauseBlock,
  DrawerSection,
  NotCheckedGroup,
  OwnerChip,
  StateBadge,
  SubjectList,
  causeOf,
} from './DrawerParts';
import {
  configItemLabels,
  configItemStates,
  contextLabels,
  levelLabels,
  stateLabels,
} from './overview-labels';

/** 风险行详情：没检查的按成因分组，每组自带原因和办法；其余是对象、依据、建议。 */
export function RiskDetails({ risk }: { risk: EndpointRiskRow }) {
  if (risk.level === 'NOT_CHECKED') {
    // 旧响应没有分组：退回原来的“对象 / 原因 / 办法”。
    if (!risk.groups?.length)
      return (
        <CauseBlock basis={risk.basis} advice={risk.advice}>
          {risk.subjects.length > 0 && (
            <SubjectList
              subjects={risk.subjects.map((subject) => ({
                name: subject.name,
                // 说明与上面的原因是同一句时不再逐个重复，只留名称
                detail: subject.detail && subject.detail !== risk.basis ? subject.detail : '',
              }))}
              moreCount={risk.moreCount}
            />
          )}
        </CauseBlock>
      );
    const single = risk.groups.length === 1;
    return (
      <>
        {risk.groups.map((group) => (
          <NotCheckedGroup key={group.cause} group={group} bare={single} />
        ))}
      </>
    );
  }
  return (
    <>
      <DrawerSection title="涉及对象">
        <SubjectList
          subjects={risk.subjects.map((s) => ({
            name: s.name,
            // 说明与下方“依据”是同一句时不再逐个重复，只留名称
            detail: s.detail && s.detail !== risk.basis ? s.detail : '',
          }))}
          moreCount={risk.moreCount}
        />
      </DrawerSection>
      <DrawerSection title={risk.level === 'REVIEW' ? '为什么要确认' : '依据'}>
        <p>{risk.basis}</p>
      </DrawerSection>
      <DrawerSection title="处理建议">
        <p>{risk.advice}</p>
      </DrawerSection>
    </>
  );
}

export function riskSubtitle(risk: EndpointRiskRow) {
  return (
    <>
      <Badge
        className={risk.level === 'HIGH' ? 'bg-[#FDECEA] text-[#B42318]' : undefined}
        tone={risk.level === 'HIGH' ? 'danger' : risk.level === 'MEDIUM' ? 'warning' : 'neutral'}
      >
        {levelLabels[risk.level]}
      </Badge>
      {risk.level === 'NOT_CHECKED' && risk.owner && <OwnerChip owner={risk.owner} />}
      <span>{risk.involved}</span>
    </>
  );
}

/** 智能体抽屉：三项设置的读取情况；有没读到的就说原因和办法；真机测评只在不可用时出现。 */
export function AgentDetails({ agent }: { agent: EndpointAgentRow }) {
  const items = agent.configItems ?? [];
  const causes: NotCheckedCauseKey[] = agentConfigCauses(items);
  const evalReady = agent.liveEval.registered && agent.liveEval.supported;
  return (
    <>
      {agent.configState !== 'unrecorded' && (
        <section>
          <dl className="divide-y divide-line">
            {(['permission', 'auto_approval', 'sandbox'] as const).map((item) => {
              const entries = items.filter((entry) => entry.item === item);
              return (
                <div key={item} className="flex items-start justify-between gap-4 py-1.5">
                  <dt className="text-ink-3">{configItemLabels[item]}</dt>
                  <dd className="flex flex-wrap justify-end gap-x-3 text-right">
                    {entries.length ? (
                      entries.map((entry) => (
                        <span
                          key={entry.state}
                          className={
                            entry.state === 'explicit' || entry.state === 'default'
                              ? undefined
                              : 'text-ink-2'
                          }
                        >
                          {configItemStates[entry.state]}
                          {entry.installs !== agent.installs ? ` ${entry.installs} 处` : ''}
                        </span>
                      ))
                    ) : (
                      <span>没读到</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {items.some((entry) => entry.state === 'default') && (
            <p className="mt-2 text-xs text-ink-3">{CONFIG_DEFAULT_NOTE}</p>
          )}
        </section>
      )}
      {causes.map((key) => {
        const cause = NOT_CHECKED_CAUSES[key];
        return (
          <CauseBlock
            key={key}
            title={cause.title}
            basis={cause.basis}
            advice={cause.advice}
            owner={cause.owner}
          />
        );
      })}
      {!!agent.ignoredAccounts?.length && (
        <DrawerSection title="没有计入的账号">
          <p className="text-ink-2">
            同一份程序在 {agent.ignoredAccounts.join('、')}{' '}
            下也被发现，但这些系统账号没有配置，不算单独的安装。
          </p>
        </DrawerSection>
      )}
      {!evalReady && (
        <DrawerSection title="真机测评条件">
          <p>{agent.liveEval.reason || '还没有登记，请联系终端管理员登记后重新上报。'}</p>
        </DrawerSection>
      )}
    </>
  );
}

const SKILL_BADGE_FALLBACK = '终端没检查';
/** 技能列表里的状态徽标短语：没检查的按成因写得具体，其余沿用状态名。 */
export function skillBadgeLabel(skill: EndpointSkillRow, state: OverviewAssetState): string {
  if (state !== 'not_checked') return stateLabels[state];
  return causeOf(skill.cause).badge ?? SKILL_BADGE_FALLBACK;
}

/** 技能抽屉：状态、命中位置；没检查的说明原因和办法，不让人去做做不到的事。 */
export function SkillDetails({
  skill,
  state,
}: {
  skill: EndpointSkillRow;
  state: OverviewAssetState;
}) {
  const documentOnly =
    skill.hits.length > 0 && skill.hits.every((h) => h.contextType === 'document');
  const cause = skill.cause ? causeOf(skill.cause) : null;
  return (
    <>
      {documentOnly && (
        <p className="rounded-lg bg-slate-100 p-3 text-slate-600">
          待确认：命中出现在说明文档里，不是可执行脚本
        </p>
      )}
      {skill.hits.length > 0 && (
        <DrawerSection title="命中详情">
          {skill.hits.map((h, j) => (
            <details key={j} className="border-b border-line py-2">
              <summary className="cursor-pointer">{h.label}</summary>
              <p className="text-ink-3">
                {h.file || '文件未上报'} · {h.line ? `第 ${h.line} 行` : '行号未上报'} ·{' '}
                {contextLabels[h.contextType]}
              </p>
            </details>
          ))}
        </DrawerSection>
      )}
      {state === 'clear' && <p>本次已检查无风险</p>}
      {state === 'risk' && skill.hits.length === 0 && (
        <p>终端没有上报命中的位置，重新采集后会补上。</p>
      )}
      {cause && (
        <CauseBlock
          title={skill.hits.length > 0 ? cause.title : undefined}
          basis={cause.basis}
          advice={cause.advice}
          owner={cause.owner}
        />
      )}
      {state === 'not_checked' && !cause && (
        <CauseBlock
          basis={NOT_CHECKED_CAUSES.check_missing.basis}
          advice={NOT_CHECKED_CAUSES.check_missing.advice}
        />
      )}
    </>
  );
}

/** MCP 列表与抽屉标题下的状态短语：没检查的写明几项，其余沿用状态名。 */
export function mcpBadgeLabel(mcp: EndpointMcpRow): string {
  if (mcp.state !== 'not_checked') return stateLabels[mcp.state];
  const unknown = mcp.checks.filter((c) => c.state === 'unknown').length;
  return unknown ? `${unknown} 项没检查` : stateLabels.not_checked;
}

/** MCP 抽屉：逐项检查结果；没检查的项按成因分组，说明谁来核对、怎么核对。 */
export function McpDetails({ mcp }: { mcp: EndpointMcpRow }) {
  const unknown = mcp.checks.filter((c) => c.state === 'unknown');
  const groups = new Map<string, string[]>();
  for (const check of unknown) {
    const key = check.cause ?? 'mcp_check_missing';
    groups.set(key, [...(groups.get(key) ?? []), check.label]);
  }
  return (
    <>
      <DrawerSection title="检查项目">
        <ul className="divide-y divide-line">
          {mcp.checks.map((check, j) => (
            <li key={j} className="flex items-center justify-between gap-3 py-2">
              <span>{check.label}</span>
              <Badge
                tone={
                  check.state === 'finding'
                    ? 'danger'
                    : check.state === 'pass'
                      ? 'success'
                      : 'neutral'
                }
              >
                {check.state === 'finding'
                  ? '发现风险'
                  : check.state === 'pass'
                    ? '已检查无风险'
                    : '终端没检查'}
              </Badge>
            </li>
          ))}
        </ul>
      </DrawerSection>
      {[...groups].map(([key, labels]) => {
        const cause = causeOf(key);
        return (
          <CauseBlock
            key={key}
            title={cause.title}
            meta={labels.length > 1 || key === 'mcp_check_missing' ? labels.join('、') : undefined}
            basis={cause.basis}
            advice={cause.advice}
            owner={cause.owner}
          />
        );
      })}
    </>
  );
}

export { StateBadge };
