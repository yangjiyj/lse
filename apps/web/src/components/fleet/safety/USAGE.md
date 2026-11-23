# 终端安全展示组件（方向 B）

统一入口：`@/components/fleet/safety/EndpointSafety`。仅展示数据，不请求接口、不发起测评、不修改终端配置。复用现有 Card、SectionCard、Badge、EmptyState 和语义色，没有修改全局令牌。

## 组件与字段

| 组件 | 属性 | 对应契约与行为 |
| --- | --- | --- |
| SafetyStateBadge | state? | risk / clear / not_checked；缺失或未知保持没检查；图形加文字 |
| RiskLevelBadge | severity? | HIGH / MEDIUM / LOW；仅明确高危使用红色，不从状态推算等级 |
| CheckFindingCard | finding | plainTitle、subjects、state、plainWhy、plainFix、notCheckedReason、howToCheck；可选 evidence、severity；涉及对象超过 5 个自动聚合（风险置顶、未检查按原因归并、已检查折叠只给数量） |
| RiskCategoryCard | title、description?、findings | 页面按目录分组后传入原检查项；组件统计三态并呈现空状态 |
| EndpointConclusion | verdictLine?、state?、description? | endpoint-summary.verdictLine；state 必须由页面根据明确的检查结果提供 |
| KeyMetricCards | metrics | 展示页面已计算的 label、value、unit?、description?；null/undefined/非有限数显示暂无数据，0 保留为 0 |
| LiveScenarioCard | scenario、title?、state? | scenarioId、riskType、whatWeAsked、whatItDid、judgement、evidenceExcerpt；title 取目录中文标签，state 单独传入 |
| AgentInventoryCard | agents?、description?、mode?、enableHint? | product、displayName、version、installHint、liveEvalSupported、liveEvalRegistered、liveEvalBlockedReason；mode=live（默认）逐处保留重复安装，mode=posture 只列产品与版本并合并同产品同版本 |
| ExpandableSafetyText | text、label、collapsed?、lines? | 长说明默认两行预览，lines=1 用于聚合列表的单行预览（按钮同行）；collapsed=true 用于默认隐藏证据；按钮支持键盘与展开状态 |

这些类型是契约的前端结构类型，不取代其他车道的接口类型，也不定义产品或风险类别常量。已有 API 对象只要结构匹配就能直接传入。可选字段用于适配升级中的旧终端，不会把缺失字段判作无风险。

## 给 A 的接入位置

1. `apps/web/src/components/fleet/RiskSummary.tsx`：保留目录排序、ruleId 与 category 匹配，以及未归类检查项处理。把顶部两段文字替换为 EndpointConclusion；把 `groups.filter(...).map(...)` 内原有 details 与逐条 div 替换为 RiskCategoryCard。不要把 subjects 内某一个对象的状态当作整个项目状态。
2. 顶部结论状态按项目三态计算：有 risk 则 risk；无风险但有 not_checked 或缺失状态则 not_checked；只有非空且全部 clear 才是 clear。空结果使用原页面加载/空状态，不能把空数组当全部通过。
3. `apps/web/src/components/fleet/EndpointDetailModal.tsx`：保留风险摘要加载、错误和重试分支；本车道未改这些文件。由 A 另行把“最近检测”里的“已装智能体”简短串联展示补为 AgentInventoryCard，数据传 endpoint.agents，不能把旧资产摘要转成可测状态。

```tsx
import {
  EndpointConclusion,
  KeyMetricCards,
  RiskCategoryCard,
} from '@/components/fleet/safety/EndpointSafety';

// 保留页面已有的分组和结论计算。不要把对象数与检查项数相加。
<div className="space-y-5">
  <EndpointConclusion verdictLine={verdictLine} state={overallState} />
  <KeyMetricCards metrics={[
    { label: '发现风险', value: riskCount, unit: '项' },
    { label: '已检查无风险', value: clearCount, unit: '项' },
    { label: '没检查', value: notCheckedCount, unit: '项' },
  ]} />
  {groups.map(group => (
    <RiskCategoryCard key={group.id} title={group.label} findings={group.items} />
  ))}
</div>
```

## 给 C 的接入位置

- 现有 `apps/web/src/pages/EvalTaskDetailPage.tsx` 主渲染区在 TaskSummaryCard 附近。终端任务分支应使用 C 新建的专用结果组件，传入 endpoint-summary；保留非终端任务原有页面。不要将配置检查继续套进通用模型结果展示。
- 专用结果组件：标题区保留被测电脑 endpoint.name 和检查时间，随后放 EndpointConclusion、KeyMetricCards、AgentInventoryCard；groups 逐类渲染 RiskCategoryCard；liveScenarios 逐条渲染 LiveScenarioCard。
- CONTRACT 未定义 groups 的外层 id/label/items 名称：由 C 在页面边界转换，只将原 finding 传给本组件，不再造一套检查项字段。
- CONTRACT 的 liveScenarios **没有三态字段**。从 B 的真实执行与判定结果取得 state 后显式传入，不根据 judgement 的文字推断，也不能只凭进程完成就显示无风险。拿不到状态时不传，组件如实显示没检查；页面应解释缺少哪条记录及补查办法。
- 中文 title 使用 check-catalog.liveRiskTypes 的 label；组件不会把 riskType 或 scenarioId 原始标识显示给管理员。
- 真机运行范围必须由页面说明。AgentInventoryCard 只表示是否具备发起条件，不代表该安装参与了本次任务，也不代表已经通过。

```tsx
import {
  AgentInventoryCard,
  LiveScenarioCard,
} from '@/components/fleet/safety/EndpointSafety';

<AgentInventoryCard agents={summary.agents}
  description="以下是终端已安装的智能体；实际运行范围以本次任务记录为准。" />

{summary.liveScenarios.map(scenario => (
  <LiveScenarioCard key={scenario.scenarioId} scenario={scenario}
    title={riskLabels.get(scenario.riskType) ?? '真机场景检查'}
    state={scenarioStates.get(scenario.scenarioId)} />
))}
```

## 给 D 及后续页面接入

- `apps/web/src/components/fleet/RunChecksModal.tsx`：后续可用 AgentInventoryCard 展示智能体支持与登记信息，但选择与提交逻辑仍由 C 维护；清单组件没有选择行为，不可直接替代选择器。
- 所有会改动终端的操作，都需由发起操作的页面明确说明做什么、影响哪里、能否撤销。组件不生成停用、删除、重试等动作。
- 检查项较多时，弹窗中按页面现有分步或分区机制接入，避免把整页检查卡直接堆进一层弹窗。

## 验证

`EndpointSafety.test.tsx` 为行为测试，不使用快照，不模拟被测组件。覆盖三态、专用补查原因、独立对象状态、缺失数据、重复安装、证据折叠、场景四块信息、统计与步骤状态。

## 集成后的页面接入（本轮续改）


本轮扩展的展示属性：

- `CheckFindingCard.showAllGuidance`、`RiskCategoryCard.showAllGuidance`：在风险与未检查对象混合的项目中，完整保留补查办法；在未检查项目中同时保留原有原因和整改建议。
- `RiskCategoryCard.extra`：保留类别最高风险等级；`showItemRiskLevel=false` 防止同一等级在类别和项目层重复。
- `EndpointConclusion.showState=false`：保留原有一句话结论，不额外重复下方的状态徽标；不会由文字推断状态。
- `LiveScenarioCard.renderText` 和 `ExpandableSafetyText.renderText`：把文字继续交给页面原有的 SensitiveText 脱敏展示。折叠展开也不会绕过它。
- `AgentInventoryCard.title`、`versionSeparator`：任务结果使用原有“名字 · 版本”的完整文本节点，默认布局仍可分行展示。`displayName` 可选以兼容现有 API 类型，缺失时显示未命名智能体，不展示内部产品标识。

三态徽标统一为“发现风险 / 已检查无风险 / 终端没检查”。当前结果接口的场景类型未声明 state，页面仅在运行记录明确携带 state 时传入；拿不到就显示终端没检查，不从结论文字猜测。

## 终端结果长列表的展示口径（本轮）

- `CheckFindingCard` 的「涉及对象」：不超过 5 个保持逐条平铺；超过 5 个先给一行摘要（共 N 个 + 三态徽标与数量），再按状态分区。风险对象默认展开并排在前面，超过 10 个才折叠其余；终端没检查的对象按原因归并，同一条原因只写一次，默认列前 8 个名称加「等共 N 个」，可展开全部；已检查无风险的对象默认只给数量，展开只列名称。三个分区都由带 `aria-expanded` 的按钮控制，键盘可操作。
- 同一段说明在同一个检查项里只出现一次：风险对象按说明归并成一行、名称并列；平铺时相同说明只在第一条后展示。
- 未检查项目的字段名统一为「未检查的原因」。
- `AgentInventoryCard` 的 `mode="posture"` 用于配置体检：只显示「产品名 · 版本」，同产品同版本合并为「×N 处」，展开后列出探针上报的安装位置指纹（`installHint`，脱敏哈希前 8 位）；没有指纹时如实说明无法区分，不编造路径。`mode="live"`（默认）与终端详情保留逐处展示，所有卡片阻塞原因相同时只在卡片区上方统一说明一次，`enableHint` 由页面提供开启入口。
