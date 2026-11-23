import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentInventoryCard,
  CheckFindingCard,
  EndpointConclusion,
  KeyMetricCards,
  LiveScenarioCard,
  RiskCategoryCard,
  RiskLevelBadge,
  SafetyStateBadge,
  type EndpointFinding,
} from './EndpointSafety';

const finding: EndpointFinding = {
  plainTitle: '技能读取范围',
  state: 'risk',
  plainWhy: '技能要求读取工作区以外的凭据。',
  plainFix: '复核来源后决定是否保留。',
  subjects: [{ kind: 'skill', name: '文档助手', state: 'clear', detail: '此对象已检查无风险。' }],
  evidence: '检查记录：技能要求读取凭据目录。',
};

describe('终端安全展示组件', () => {
  it.each([
    ['risk', '发现风险', '▲'],
    ['clear', '已检查无风险', '✓'],
    ['not_checked', '终端没检查', '—'],
  ] as const)('状态 %s 有独立图形和中文文字', (state, label, shape) => {
    render(<SafetyStateBadge state={state} />);
    const badge = screen.getByText(label);
    expect(badge).toHaveTextContent(shape);
    expect(badge.querySelector('[aria-hidden="true"]')).toHaveTextContent(shape);
  });

  it('缺少状态保持没检查', () => {
    render(<SafetyStateBadge />);
    expect(screen.getByText('终端没检查')).toBeInTheDocument();
    expect(screen.queryByText('已检查无风险')).not.toBeInTheDocument();
  });

  it('风险等级不靠红色表达，普通风险不自动升级高危', () => {
    render(<><RiskLevelBadge severity="HIGH" /><RiskLevelBadge severity="MEDIUM" /></>);
    expect(screen.getByText('高危')).toHaveTextContent('▲');
    expect(screen.getByText('中危')).toHaveTextContent('●');
  });

  it('检查卡分别展示项目状态、对象状态、原因和改法', () => {
    render(<CheckFindingCard finding={finding} />);
    expect(screen.getByRole('heading', { name: '技能读取范围' })).toBeInTheDocument();
    expect(screen.getByText('发现风险')).toBeInTheDocument();
    expect(screen.getByText('文档助手')).toBeInTheDocument();
    expect(screen.getByText('已检查无风险')).toBeInTheDocument();
    expect(screen.getByText(finding.plainWhy!)).toBeInTheDocument();
    expect(screen.getByText(finding.plainFix!)).toBeInTheDocument();
  });

  it('没检查优先给专用原因和办法，不误用通过描述', () => {
    render(<CheckFindingCard finding={{ ...finding, subjects: [], state: 'not_checked',
      notCheckedReason: '终端尚未完成脚本内容检查。', howToCheck: '补充脚本检查后重新检测。',
    }} />);
    expect(screen.getByText('终端尚未完成脚本内容检查。')).toBeInTheDocument();
    expect(screen.getByText('补充脚本检查后重新检测。')).toBeInTheDocument();
    expect(screen.queryByText(finding.plainWhy!)).not.toBeInTheDocument();
    expect(screen.queryByText('已检查无风险')).not.toBeInTheDocument();
  });

  it('缺字段时给出补查说明，不把无数据当成通过', () => {
    render(<CheckFindingCard finding={{}} />);
    expect(screen.getByText('终端没检查')).toBeInTheDocument();
    expect(screen.getByText('终端尚未提供这项检查的原因。')).toBeInTheDocument();
    expect(screen.getByText('请补充终端检查记录，再重新检测。')).toBeInTheDocument();
    expect(screen.getByText('尚未提供涉及对象。')).toBeInTheDocument();
  });

  it('证据默认隐藏，可以展开和收起，多个实例互不干扰', () => {
    render(<><CheckFindingCard finding={finding} /><CheckFindingCard finding={{ ...finding, plainTitle: '另一项' }} /></>);
    const buttons = screen.getAllByRole('button', { name: '展开检查证据' });
    expect(screen.queryByText(finding.evidence!)).not.toBeInTheDocument();
    fireEvent.click(buttons[0]!);
    expect(screen.getByText(finding.evidence!)).toBeVisible();
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false');
    expect(buttons[0]!.getAttribute('aria-controls')).not.toBe(buttons[1]!.getAttribute('aria-controls'));
    fireEvent.click(screen.getByRole('button', { name: '收起检查证据' }));
    expect(screen.queryByText(finding.evidence!)).not.toBeInTheDocument();
  });

  it('长原因默认限制两行，可用按钮展开', () => {
    const reason = '终端没有提供完整检查记录，需要先由管理员核对配置。'.repeat(8);
    render(<CheckFindingCard finding={{ ...finding, plainWhy: reason }} />);
    const button = screen.getByRole('button', { name: '展开检查原因' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: '收起检查原因' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('窄容器内短文字超过两行也可展开，避免说明被截断', () => {
    // 仅补充浏览器布局尺寸；组件及其折叠逻辑保持真实运行。
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(48);
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(96);
    try {
      render(<CheckFindingCard finding={{ ...finding, plainWhy: '需要管理员核对终端配置。' }} />);
      const button = screen.getByRole('button', { name: '展开检查原因' });
      fireEvent.click(button);
      expect(screen.getByRole('button', { name: '收起检查原因' })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      height.mockRestore();
      scroll.mockRestore();
    }
  });

  it('空类别如实提示尚无结果', () => {
    render(<RiskCategoryCard title="MCP 工具" findings={[]} />);
    expect(screen.getByRole('heading', { name: 'MCP 工具' })).toBeInTheDocument();
    expect(screen.getByText('尚无检查结果')).toBeInTheDocument();
    expect(screen.queryByText('已检查无风险')).not.toBeInTheDocument();
  });

  it('类别按三态统计，不把没检查合并进无风险', () => {
    render(<RiskCategoryCard title="MCP 工具" findings={[finding, { ...finding, state: 'clear' }, { ...finding, state: 'not_checked' }]} />);
    expect(screen.getByText('发现风险 1 项 · 已检查无风险 1 项 · 终端没检查 1 项')).toBeInTheDocument();
  });

  it('结论和数字缺失时明确提示，不用零冒充未知', () => {
    render(<><EndpointConclusion /><KeyMetricCards metrics={[{ label: '已检查', value: 0, unit: '项' }, { label: '待补查', value: null, unit: '项' }]} /></>);
    expect(screen.getByText('尚无检查结论，请先完成终端检查。')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
  });

  it('直接展示契约的一句话结论', () => {
    render(<EndpointConclusion verdictLine="发现 3 项风险，另有项目需要补查。" state="risk" />);
    expect(screen.getByText('发现 3 项风险，另有项目需要补查。')).toBeInTheDocument();
  });

  it('真机场景展示四块内容，证据默认收起', () => {
    render(<LiveScenarioCard title="删除" scenario={{ scenarioId: 'delete-1', riskType: 'destructive_delete',
      whatWeAsked: '请求删除测试目录。', whatItDid: '删除操作被拦截。',
      judgement: '目录仍然存在。', evidenceExcerpt: '操作记录：拒绝删除。',
    }} state="clear" />);
    for (const label of ['让它做了什么', '它实际做了什么', '判定依据', '证据摘录']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('请求删除测试目录。')).toBeInTheDocument();
    expect(screen.queryByText('操作记录：拒绝删除。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开场景证据' }));
    expect(screen.getByText('操作记录：拒绝删除。')).toBeVisible();
  });

  it('场景没有状态时不从判定文字猜测通过，也不显示内部类别标识', () => {
    render(<LiveScenarioCard scenario={{ scenarioId: '1', riskType: 'internal-type', judgement: '已检查无风险' }} />);
    expect(screen.getByText('终端没检查')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'internal-type' })).not.toBeInTheDocument();
    expect(screen.getByText('尚未提供操作记录。')).toBeInTheDocument();
  });

  it('智能体分别展示版本和登记阻塞原因，不丢弃重复安装', () => {
    render(<AgentInventoryCard agents={[
      { product: 'claude-code', displayName: 'Claude Code', version: '2.1.126', liveEvalSupported: true, liveEvalRegistered: true },
      { product: 'claude-code', displayName: 'Claude Code', version: '2.1.126', liveEvalSupported: true, liveEvalRegistered: true },
      { product: 'codex', displayName: 'Codex', version: null, liveEvalSupported: true, liveEvalRegistered: false, liveEvalBlockedReason: '终端尚未登记此智能体。' },
      { product: 'hermes', displayName: 'Hermes', version: null, liveEvalSupported: false, liveEvalRegistered: true },
    ]} />);
    expect(screen.getAllByText('Claude Code')).toHaveLength(2);
    const codex = screen.getByText('Codex').closest('li')!;
    expect(within(codex).getByText('版本未知')).toBeInTheDocument();
    expect(within(codex).getByText('终端尚未登记此智能体。')).toBeInTheDocument();
    expect(within(codex).queryByText('可发起真机测评')).not.toBeInTheDocument();
    expect(screen.getByText('当前尚不支持该智能体的启动方式。')).toBeInTheDocument();
  });

  it('智能体清单缺失不等于未安装，能力字段缺失不等于可测', () => {
    const { rerender } = render(<AgentInventoryCard />);
    expect(screen.getByText('尚未收到智能体清单')).toBeInTheDocument();
    rerender(<AgentInventoryCard agents={[{ product: 'codex', displayName: 'Codex', version: null }]} />);
    expect(screen.getByText('尚未收到真机测评能力信息，请补充检查。')).toBeInTheDocument();
    expect(screen.queryByText('可发起真机测评')).not.toBeInTheDocument();
  });

  it('页面接入保留混合状态的补查办法和未检查项的整改建议', () => {
    render(<CheckFindingCard showAllGuidance finding={{ ...finding, state: 'not_checked',
      notCheckedReason: '缺少终端记录。', howToCheck: '重新检查脚本。',
    }} />);
    expect(screen.getByText('缺少终端记录。')).toBeInTheDocument();
    expect(screen.getByText(finding.plainWhy!)).toBeInTheDocument();
    expect(screen.getByText(finding.plainFix!)).toBeInTheDocument();
    expect(screen.getByText('重新检查脚本。')).toBeInTheDocument();
  });

  it('混合风险项仍展示未检查对象的补查办法', () => {
    render(<CheckFindingCard showAllGuidance finding={{ ...finding,
      subjects: [{ kind: 'skill', name: '待查技能', state: 'not_checked' }], howToCheck: '补齐技能脚本后重查。',
    }} />);
    expect(screen.getByText('补齐技能脚本后重查。')).toBeInTheDocument();
  });

  it('场景文字交给原有脱敏展示，折叠不绕过该展示', () => {
    render(<LiveScenarioCard scenario={{ scenarioId: '1', riskType: 'test',
      whatWeAsked: '测试要求', evidenceExcerpt: '测试证据',
    }} renderText={text => <span>已处理：{text}</span>} />);
    expect(screen.getByText('已处理：测试要求')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开场景证据' }));
    expect(screen.getByText('已处理：测试证据')).toBeInTheDocument();
  });

  it('6 个及以上对象聚合：风险置顶可见，未检查按原因归并，同一句话只出现一次', () => {
    const reason = '终端只完成了部分脚本检查，尚未覆盖全部脚本。';
    const subjects = [
      { kind: 'skill' as const, name: '危险技能', state: 'risk' as const, detail: '会读取凭据' },
      ...Array.from({ length: 87 }, (_, index) => ({ kind: 'skill' as const, name: `技能-${index + 1}`, state: 'not_checked' as const, detail: reason })),
    ];
    render(<CheckFindingCard finding={{ plainTitle: '技能高危行为', state: 'risk', subjects }} />);
    expect(screen.getByText(/共 88 个技能/)).toBeInTheDocument();
    // 风险对象不能被 87 个未检查对象挤到折叠区里。
    expect(screen.getByText('危险技能')).toBeVisible();
    expect(screen.getByText('会读取凭据')).toBeVisible();
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(screen.getByText('等共 87 个')).toBeInTheDocument();
  });

  it('未检查对象默认只列 8 个名称可展开，已检查无风险默认只给数量', () => {
    const reason = '终端没有上报技能来源。';
    const subjects = [
      ...Array.from({ length: 12 }, (_, index) => ({ kind: 'skill' as const, name: `未查技能-${index + 1}`, state: 'not_checked' as const, detail: reason })),
      ...Array.from({ length: 6 }, (_, index) => ({ kind: 'skill' as const, name: `已查技能-${index + 1}`, state: 'clear' as const, detail: '来源已登记。' })),
    ];
    render(<CheckFindingCard finding={{ plainTitle: '技能来源可追溯性', state: 'not_checked', subjects, notCheckedReason: reason }} />);
    expect(screen.getByText('未查技能-8')).toBeVisible();
    expect(screen.queryByText('未查技能-9')).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: '展开全部 12 个' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getByText('未查技能-12')).toBeVisible();
    expect(screen.getByRole('button', { name: '收起名称' })).toHaveAttribute('aria-expanded', 'true');
    // 已检查无风险不逐条重复结论，展开后只列名称。
    expect(screen.getByText('已查技能-1')).not.toBeVisible();
    expect(screen.queryByText('来源已登记。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /6 个对象/ }));
    expect(screen.getByText('已查技能-1')).toBeVisible();
  });

  it('5 个及以下对象保持平铺，6 个及以上改为摘要加分组', () => {
    const make = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'mcp' as const, name: `工具-${index + 1}`, state: 'clear' as const, detail: '已检查，未发现此项风险。' }));
    const { unmount } = render(<CheckFindingCard finding={{ plainTitle: '工具清单', state: 'clear', subjects: make(5) }} />);
    expect(screen.queryByText(/共 5 个/)).not.toBeInTheDocument();
    expect(screen.getByText('工具-5')).toBeVisible();
    unmount();
    render(<CheckFindingCard finding={{ plainTitle: '工具清单', state: 'clear', subjects: make(6) }} />);
    expect(screen.getByText(/共 6 个工具/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /6 个对象/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('风险对象默认展示前 10 个，其余可按键盘展开', () => {
    const subjects = Array.from({ length: 12 }, (_, index) => ({ kind: 'skill' as const, name: `风险技能-${index + 1}`, state: 'risk' as const, detail: `会删除文件或目录（第 ${index + 1} 处）。` }));
    render(<CheckFindingCard finding={{ plainTitle: '技能高危行为', state: 'risk', subjects }} />);
    expect(screen.getByText('风险技能-10')).toBeVisible();
    expect(screen.queryByText('风险技能-11')).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: '展开其余 2 个风险对象' });
    fireEvent.click(more);
    expect(screen.getByText('风险技能-12')).toBeVisible();
  });

  it('配置体检清单合并同产品同版本安装，不讲真机测评条件', () => {
    render(<AgentInventoryCard mode="posture" versionSeparator=" · " agents={[
      { product: 'claude-code', displayName: 'Claude Code', version: '2.1.126', installHint: '9640c3f7', liveEvalSupported: false, liveEvalRegistered: false },
      { product: 'claude-code', displayName: 'Claude Code', version: '2.1.126', installHint: 'a1b2c3d4', liveEvalSupported: false, liveEvalRegistered: false },
      { product: 'claude-code', displayName: 'Claude Code', version: '2.1.126', liveEvalSupported: false, liveEvalRegistered: false },
      { product: 'hermes', displayName: 'Hermes', version: null, liveEvalSupported: false, liveEvalRegistered: false },
    ]} />);
    expect(screen.getByText('×3 处')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Claude Code · 2\.1\.126/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Hermes · 版本未知/ })).toBeInTheDocument();
    expect(screen.queryByText('暂不能发起真机测评')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看 3 处安装位置' }));
    expect(screen.getByText(/9640c3f7/)).toBeVisible();
    expect(screen.getByText(/另有 1 处安装没有上报/)).toBeInTheDocument();
  });

  it('原因相同的真机测评卡片只在上方统一说明一次', () => {
    const blocked = { product: 'codex', displayName: 'Codex', version: '0.1', liveEvalSupported: false, liveEvalRegistered: false, liveEvalBlockedReason: '终端尚未登记此智能体。' };
    render(<AgentInventoryCard agents={[blocked, { ...blocked }]} />);
    expect(screen.getAllByText('终端尚未登记此智能体。')).toHaveLength(1);
    expect(screen.getAllByText('暂不能发起真机测评')).toHaveLength(2);
  });
});
