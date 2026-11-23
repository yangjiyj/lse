import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_SOURCE_LABELS } from '@lse/shared';
import { humanizeIdentifiers } from '../src/modules/reports/html/derive.js';
import {
  riskLabel,
  riskLabelForJudge,
  ENGINE_LABELS,
  engineLabel,
  localizeFindingTag,
  reportRiskTypeLabel,
  riskDomainLabel,
} from '../src/modules/reports/labels.js';

// 系统中所有判定引擎 / 规则可产出的「静态」风险类别代码。
// 报告里绝不能出现未翻译的英文枚举（用户验收红线）。
// 来源：rule-judge.ts、sensitive scan、executor.ts、python-judge / llm-judge、
// ai-infra-guard / garak / pyrit 适配器。
const STATIC_RISK_CODES = [
  'forbidden_content',
  'should_refuse',
  'should_refuse_violation',
  'expected_answer',
  'missing_expected',
  'general',
  'prompt_injection',
  'sensitive_info',
  'sensitive_info_secret',
  'sensitive_info_pii',
  'agent_tool_abuse',
  'engine_error',
  'llm_judge_pass',
  'llm_judge_fail',
  'llm_judge_unknown',
  'python_judge_unavailable',
  'redteam_scan',
  'redteam_probe',
  'redteam_attack',
  'gateway_policy_event',
];

const hasCjk = (s: string): boolean => /[一-鿿]/.test(s);

test('riskLabel：所有静态风险类别代码都有中文标签（不泄露英文枚举）', () => {
  for (const code of STATIC_RISK_CODES) {
    const label = riskLabel(code);
    assert.notEqual(label, code, `风险类别 ${code} 未翻译，仍是原始英文枚举`);
    assert.ok(hasCjk(label), `风险类别 ${code} 的标签「${label}」不含中文`);
  }
});

test('riskLabel：should_refuse_violation 兼容枚举不再展示为应拒答未拒答', () => {
  const pass = riskLabel('should_refuse');
  const fail = riskLabel('should_refuse_violation');
  assert.ok(pass.includes('拒答'), `should_refuse 标签应含「拒答」，实际「${pass}」`);
  assert.equal(fail, '高风险请求越界');
  assert.doesNotMatch(fail, /应拒答未拒答|应拒答但未拒答|未拒答/);
  assert.notEqual(pass, fail, 'PASS 与历史兼容风险枚举不应共用同一标签');
});

test('riskLabel：敏感信息违规细分（凭据 / 个人信息）可区分', () => {
  const secret = riskLabel('sensitive_info_secret');
  const pii = riskLabel('sensitive_info_pii');
  assert.ok(hasCjk(secret) && hasCjk(pii));
  assert.notEqual(secret, pii, '凭据泄露与个人信息泄露应有不同标签');
});

test('riskLabel：已知动态前缀代码本地化为「中文 + 序号」', () => {
  assert.equal(riskLabel('redteam_finding_3'), '红队发现项 #3');
  assert.equal(riskLabel('garak_probe_7'), 'Garak 探针项 #7');
  assert.equal(riskLabel('pyrit_attack_12'), 'PyRIT 攻击项 #12');
});

test('riskLabel：完全未知的代码回退为原始字符串（最后兜底）', () => {
  assert.equal(riskLabel('some_unknown_future_code'), 'some_unknown_future_code');
});

test('标签辅助函数：__proto__ / constructor 不能通过原型链变成对象或函数', () => {
  for (const code of ['__proto__', 'constructor']) {
    const labels = [
      riskLabel(code),
      engineLabel(code),
      riskDomainLabel(code),
      reportRiskTypeLabel({ riskCategory: code }),
      localizeFindingTag(`[rule-judge] ${code}`),
    ];

    for (const label of labels) {
      assert.equal(typeof label, 'string', `${code} 标签必须始终为 string`);
      assert.doesNotMatch(
        label,
        /\[object Object\]|function Object|native code/,
        `${code} 不得泄漏原型对象或函数文本`,
      );
    }
  }
});

test('ENGINE_LABELS：网关引擎代码有中文标签（与前端 format.ts 口径一致）', () => {
  const label = ENGINE_LABELS['newapi-agent-security-gateway'];
  assert.equal(label, '智能体安全网关');
  assert.ok(hasCjk(label ?? ''), `网关引擎标签「${label}」不含中文`);
});

test('riskLabel：网关引擎的动态策略类别包装为中文标签（红线）', () => {
  assert.equal(
    riskLabel('domain_blocklist', 'newapi-agent-security-gateway'),
    '网关策略事件（domain_blocklist）',
  );
  assert.equal(
    riskLabel('prompt_guard', 'newapi-agent-security-gateway'),
    '网关策略事件（prompt_guard）',
  );
});

test('riskLabel：红队引擎的原始探针/攻击类别包装为中文标签（红线）', () => {
  assert.equal(
    riskLabel('promptinject.HijackHateHumans', 'garak'),
    '红队发现（promptinject.HijackHateHumans）',
  );
  assert.equal(riskLabel('crescendo', 'pyrit'), '红队发现（crescendo）');
});

test('riskLabel：已注册标签与动态前缀优先于引擎包装', () => {
  assert.equal(riskLabel('gateway_policy_event', 'newapi-agent-security-gateway'), '网关策略事件');
  assert.equal(riskLabel('redteam_finding_3', 'ai-infra-guard'), '红队发现项 #3');
});

test('localizeFindingTag：把 executor 的 [engine] code 结构标签本地化为中文（红线）', () => {
  const out = localizeFindingTag('关键依据：[llm-judge] llm_judge_fail');
  assert.ok(out.includes('AI 评审复核未通过'), `应含中文风险标签，实际「${out}」`);
  assert.doesNotMatch(out, /\[llm-judge\]|llm_judge_fail/, '不应再出现原始英文枚举');
});

test('localizeFindingTag：未识别的方括号文本原样保留（避免误伤引用编号等）', () => {
  assert.equal(localizeFindingTag('见参考 [1] 节'), '见参考 [1] 节');
  assert.equal(localizeFindingTag('普通文本，无标签'), '普通文本，无标签');
});

test('ENGINE_LABELS：AI 组件漏洞扫描引擎有中文标签，报告不出现 skill-mcp-static', () => {
  const label = ENGINE_LABELS['skill-mcp-static'];
  assert.equal(label, 'AI 组件漏洞扫描');
  assert.ok(hasCjk(label ?? ''));
});

test('ENGINE_LABELS：RAG 专项评估引擎有中文标签，风险类别均已翻译', () => {
  assert.equal(ENGINE_LABELS['rag-eval'], 'RAG 专项评估');
  assert.equal(engineLabel('rag-eval'), 'RAG 专项评估');
  for (const code of ['misinformation_hallucination', 'rag_data_poisoning', 'prompt_injection', 'data_exfiltration']) {
    assert.ok(hasCjk(riskLabel(code, 'rag-eval')), code);
  }
});

test('P1-14：判定来源在报告标签、报告摘要里与页面共用同一张共享表，同一个值只有一种说法', () => {
  for (const code of [
    'llm_judge_fail',
    'agent_llm_judge_fail',
    'llm_judge_pass',
    'llm_judge_unknown',
  ]) {
    const shared = JUDGE_SOURCE_LABELS[code];
    assert.ok(shared, `${code} 应在共享表里`);
    // 报告标签（labels.ts）
    assert.equal(riskLabel(code), shared);
    // 报告摘要（derive.ts 的 humanizeIdentifiers）把正文里残留的标识符映射成同一个说法
    assert.equal(humanizeIdentifiers(`命中 ${code}`), `命中 ${shared}`);
  }
  assert.equal(riskLabel('llm_judge_fail'), 'AI 评审复核未通过');
  assert.equal(riskLabel('agent_llm_judge_fail'), '智能体行为判定未通过');
  // 旧的三套说法不再出现
  for (const old of ['判定模型识别为风险', '内容判定未通过', 'AI 评审不通过']) {
    assert.notEqual(riskLabel('llm_judge_fail'), old);
    assert.doesNotMatch(humanizeIdentifiers('触发 llm_judge_fail'), new RegExp(old));
  }
});

test('P0-07：外发研判边界里，agent_llm_judge_* 同样按判定来源回退到业务风险分类，不当作类别原样输出', () => {
  for (const code of ['llm_judge_fail', 'agent_llm_judge_fail', 'python_judge_unavailable']) {
    const out = riskLabelForJudge(code, 'llm-judge');
    assert.ok(/[一-鿿]/.test(out), `${code} → ${out}`);
    assert.doesNotMatch(out, /judge|AI 评审/);
  }
});
