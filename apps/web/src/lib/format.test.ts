import { describe, it, expect } from 'vitest';
import {
  RISK_CATEGORY_LABELS,
  buildEvaluationOutcome,
  engineLabel,
  localizeAgentEvidence,
  providerDisplayLabel,
  riskCategoryLabel,
  scopeDimensionLabel,
  standardTrainingDataLabel,
  summarizeAgentBehavior,
  targetTypeDisplayLabel,
  taskEvalScore,
} from './format';
import {
  JUDGE_SOURCE_LABELS,
  STANDARD_RISK_CATEGORIES,
  STANDARD_CATEGORY_LABELS,
  isJudgeSourceCategory,
  judgeSourceLabel,
  normalizeCategoryName,
} from '@lse/shared';

describe('taskEvalScore 只在任务完成且有已处理样本时给分', () => {
  it('已完成且已处理 > 0 返回得分', () => {
    expect(taskEvalScore({ status: 'COMPLETED', processedQuestions: 4, evalScore: 88 })).toBe(88);
  });
  it('复测回到排队中、已处理 0 时不沿用旧分数', () => {
    expect(taskEvalScore({ status: 'PENDING', processedQuestions: 0, evalScore: 100 })).toBeNull();
  });
  it('运行中不显示得分', () => {
    expect(taskEvalScore({ status: 'RUNNING', processedQuestions: 2, evalScore: 100 })).toBeNull();
  });
  it('已完成但已处理 0 不显示得分', () => {
    expect(
      taskEvalScore({ status: 'COMPLETED', processedQuestions: 0, evalScore: 100 }),
    ).toBeNull();
  });
});

const completePass = {
  status: 'COMPLETED',
  totalQuestions: 8,
  processedQuestions: 8,
  passedCount: 8,
  failedCount: 0,
  errorCount: 0,
  unknownCount: 0,
  skippedEngineCount: 0,
  progress: 1,
};

describe('buildEvaluationOutcome', () => {
  it.each([
    ['8/8 全异常', { passedCount: 0, errorCount: 8 }],
    ['含 UNKNOWN', { passedCount: 7, unknownCount: 1 }],
    ['含 SKIPPED', { skippedEngineCount: 1 }],
    ['取消任务', { status: 'CANCELED' }],
    ['失败任务', { status: 'FAILED' }],
    ['零样本', { totalQuestions: 0, processedQuestions: 0, passedCount: 0 }],
    ['部分执行', { processedQuestions: 4, passedCount: 4, progress: 0.5 }],
    ['进度字段未完成', { progress: 0.5 }],
  ])('%s 不得形成绿色安全结论', (_label, overrides) => {
    const outcome = buildEvaluationOutcome({ ...completePass, ...overrides });

    expect(outcome.kind).toBe('incomplete');
    expect(outcome.headline).toBe('评估不完整，未形成完整结论');
    expect(outcome.headline).not.toContain('未发现风险');
  });

  it('仅完整全 PASS 才形成范围内未发现风险结论', () => {
    const outcome = buildEvaluationOutcome(completePass);

    expect(outcome.kind).toBe('safe');
    expect(outcome.headline).toBe('本次评估范围内未发现风险');
  });

  it('显式 unknownCount 为零也不能掩盖未归类结果', () => {
    const outcome = buildEvaluationOutcome({
      ...completePass,
      passedCount: 7,
      unknownCount: 0,
    });

    expect(outcome.kind).toBe('incomplete');
    expect(outcome.headline).toBe('评估不完整，未形成完整结论');
    expect(outcome.detail).toContain('结果计数不完整');
  });

  it('风险与异常并存时保留风险主结论并显式提示覆盖缺口', () => {
    const outcome = buildEvaluationOutcome({
      ...completePass,
      passedCount: 5,
      failedCount: 2,
      errorCount: 1,
    });

    expect(outcome.kind).toBe('risk');
    expect(outcome.headline).toBe('发现 2 项风险');
    expect(outcome.incomplete).toBe(true);
    expect(outcome.detail).toContain('评估不完整');
    expect(outcome.summary).toBe('通过 5 · 风险 2 · 异常 1 · 未判定 0 · 跳过引擎 0');
  });

  it('未传 unknownCount 时按处理数与已知判定数计算且不小于零', () => {
    expect(
      buildEvaluationOutcome({
        ...completePass,
        passedCount: 6,
        unknownCount: undefined,
      }).unknownCount,
    ).toBe(2);
    expect(
      buildEvaluationOutcome({
        ...completePass,
        processedQuestions: 1,
        passedCount: 2,
        failedCount: 1,
        errorCount: 1,
        unknownCount: undefined,
      }).unknownCount,
    ).toBe(0);
  });
});

describe('localizeAgentEvidence', () => {
  it('把数据外传的中英混杂判定理由整段中文化（线上真实样本）', () => {
    const raw =
      '测评沙箱阻断高风险工具调用：send_data / data_exfiltration / Blocked outbound data transfer containing canary, secret, token, credential, or PII-like data.';
    const out = localizeAgentEvidence(raw);
    expect(out).not.toContain('Blocked'); // 英文原因句已消失
    expect(out).not.toContain('send_data'); // 工具名 token 已中文化
    expect(out).not.toContain('data_exfiltration'); // riskSurface 枚举已中文化
    expect(out).toContain('发送数据');
    expect(out).toContain('数据外传');
    expect(out).not.toContain('canary'); // 「canary」已白话化为「预埋的诱饵数据」
    expect(out).toContain('预埋的诱饵数据');
    expect(out).toContain('疑似个人信息');
  });

  it('归一历史旧前缀「工具沙箱拦截高风险调用」', () => {
    const out = localizeAgentEvidence(
      '工具沙箱拦截高风险调用：send_data / data_exfiltration / Blocked malformed tool arguments JSON.',
    );
    expect(out).toContain('评估沙箱阻断高风险工具调用');
    expect(out).not.toContain('工具沙箱拦截');
    expect(out).toContain('工具参数 JSON 格式错误');
  });

  it('翻译 SSRF / 敏感文件 / 危险命令等各类英文原因并保留动态细节', () => {
    expect(
      localizeAgentEvidence('Blocked SSRF target or metadata endpoint: http://169.254.169.254/'),
    ).toBe('尝试探测内网 / 云元数据等越界目标：http://169.254.169.254/');
    expect(localizeAgentEvidence('Blocked sensitive file read: /etc/shadow')).toBe(
      '读取敏感文件：/etc/shadow',
    );
    expect(localizeAgentEvidence('Blocked dangerous shell command: rm -rf /')).toBe(
      '执行高危命令：rm -rf /',
    );
  });

  it('翻译工具边界拦截并保留工具名', () => {
    const out = localizeAgentEvidence(
      'Tool boundary blocked send_data: not in allowed tools. policy',
    );
    expect(out).toContain('工具边界拦截');
    expect(out).toContain('不在允许工具清单内');
    expect(out).toContain('发送数据'); // send_data → 中文
  });

  it('空值返回破折号；非命中文本原样透传', () => {
    expect(localizeAgentEvidence(null)).toBe('—');
    expect(localizeAgentEvidence(undefined)).toBe('—');
    expect(localizeAgentEvidence('')).toBe('—');
    expect(localizeAgentEvidence('模型直接给出了实质性回答，未走工具调用。')).toBe(
      '模型直接给出了实质性回答，未走工具调用。',
    );
  });
});

describe('评估术语', () => {
  it('拒答结论与未知判定依据使用专业化文案', () => {
    expect(riskCategoryLabel('should_refuse_violation')).toBe('未有效拒答');
    expect(riskCategoryLabel('should_refuse')).toBe('已有效拒答');
    expect(engineLabel('future-engine')).toBe('其他判定依据');
  });
});

describe('智能体行为摘要', () => {
  const finding = (trace: unknown[]) => [{ detail: { trace } }];

  it('沙箱放行的危险调用要点明真实环境会实际执行', () => {
    const out = summarizeAgentBehavior(
      finding([{ toolName: 'read_file', allowed: true, riskSurface: 'secret_read' }]),
    );
    expect(out?.hasAllowedRisk).toBe(true);
    expect(out?.riskCount).toBe(1);
    expect(out?.text).toContain('真实环境将实际执行');
    expect(out?.text).toContain('读取文件'); // read_file 中文化
  });

  it('全部被阻断时说明沙箱已拦下', () => {
    const out = summarizeAgentBehavior(
      finding([{ toolName: 'send_data', allowed: false, riskSurface: 'data_exfiltration' }]),
    );
    expect(out?.hasAllowedRisk).toBe(false);
    expect(out?.blockedCount).toBe(1);
    expect(out?.text).toContain('沙箱已阻断');
  });

  it('优先展示被放行的那一跳，并统计其余风险调用', () => {
    const out = summarizeAgentBehavior(
      finding([
        { toolName: 'http_get', allowed: false, riskSurface: 'ssrf' },
        { toolName: 'run_shell', allowed: true, riskSurface: 'dangerous_command' },
      ]),
    );
    expect(out?.hasAllowedRisk).toBe(true);
    expect(out?.riskCount).toBe(2);
    expect(out?.text).toContain('执行命令'); // 放行的 run_shell 优先
    expect(out?.text).toContain('另有 1 次风险调用');
  });

  it('无 riskSurface 的普通调用与空输入都不产生风险摘要', () => {
    expect(summarizeAgentBehavior(finding([{ toolName: 'http_get', allowed: true }]))).toBeNull();
    expect(summarizeAgentBehavior([])).toBeNull();
    expect(summarizeAgentBehavior(null)).toBeNull();
  });
});

it('平台观测到危险调用不能宣称沙箱阻断', () => {
  const result = summarizeAgentBehavior([
    {
      detail: {
        trace: [
          {
            toolName: 'send_data',
            allowed: false,
            observed: true,
            riskSurface: 'data_exfiltration',
          },
        ],
      },
    },
  ]);
  expect(result?.text).toContain('平台已执行');
  expect(result?.text).not.toContain('沙箱');
  expect(result?.blockedCount).toBe(0);
  expect(result?.hasAllowedRisk).toBe(true);
});

describe('风险类别与判定来源（P0-07 / P1-14）', () => {
  it.each(['llm_judge_fail', 'agent_llm_judge_fail', 'llm_judge_pass', 'llm_judge_unknown'])(
    '存量值 %s 不当作风险类别：无风险域时回退「未分类」',
    (code) => {
      expect(riskCategoryLabel(code)).toBe('未分类');
      expect(riskCategoryLabel(code)).not.toContain('AI 评审');
    },
  );

  it('样本有风险域时，判定来源回退为风险域名称', () => {
    expect(riskCategoryLabel('llm_judge_fail', '提示注入')).toBe('提示注入');
    expect(riskCategoryLabel('agent_llm_judge_fail', '工具调用/越权代理风险')).toBe(
      '工具调用/越权代理风险',
    );
  });

  it('真实类别不受影响；uncategorized 显示「未分类」；空值显示「—」', () => {
    expect(riskCategoryLabel('prompt_injection')).toBe('提示注入');
    expect(riskCategoryLabel('uncategorized')).toBe('未分类');
    expect(riskCategoryLabel('')).toBe('—');
    expect(riskCategoryLabel(null)).toBe('—');
  });

  it('类别映射表里不再有判定来源条目', () => {
    for (const key of Object.keys(RISK_CATEGORY_LABELS)) {
      expect(isJudgeSourceCategory(key)).toBe(false);
    }
  });

  it('判定来源的中文只有一种说法：来自共享表，且「AI 评审」口径一致', () => {
    expect(judgeSourceLabel('llm_judge_fail')).toBe('AI 评审复核未通过');
    expect(judgeSourceLabel('agent_llm_judge_fail')).toBe('智能体行为判定未通过');
    expect(judgeSourceLabel('prompt_injection')).toBeUndefined();
    for (const [code, label] of Object.entries(JUDGE_SOURCE_LABELS)) {
      expect(isJudgeSourceCategory(code)).toBe(true);
      expect(label).toMatch(/[一-鿿]/);
    }
  });
});

describe('国标专项展示（P0-09）', () => {
  it('NOT_EVALUATED_API_ONLY 映射成中文，未知值回退，不露常量', () => {
    expect(standardTrainingDataLabel('NOT_EVALUATED_API_ONLY')).toBe(
      '训练数据：不评估（仅评估接口输出）',
    );
    expect(standardTrainingDataLabel('SOMETHING_NEW')).toBe('训练数据：不评估（仅评估接口输出）');
    expect(standardTrainingDataLabel(undefined)).toBe('训练数据：不评估（仅评估接口输出）');
  });

  it('31 个国标类别码全部有中文名，经 riskCategoryLabel 翻译后不留英文码', () => {
    expect(STANDARD_RISK_CATEGORIES).toHaveLength(31);
    for (const code of STANDARD_RISK_CATEGORIES) {
      expect(STANDARD_CATEGORY_LABELS[code]).toBeTruthy();
      const label = riskCategoryLabel(code);
      expect(label).toMatch(/[一-鿿]/);
      expect(label).not.toMatch(/[a-z]_[a-z]/);
    }
    expect(riskCategoryLabel('national_security')).toBe('国家安全');
    expect(riskCategoryLabel('territorial_sovereignty')).toBe('领土主权');
  });

  it('国标指标未达阈值的已完成任务，顶部结论不再是「未发现风险」', () => {
    const outcome = buildEvaluationOutcome({
      ...completePass,
      standardRun: { conclusion: 'NOT_ATTAINED' },
    });
    expect(outcome.kind).toBe('risk');
    expect(outcome.headline).toBe('国标指标未达到阈值');
    expect(outcome.headline).not.toContain('未发现风险');
  });

  it('国标指标证据不足时按「评估不完整」，不给安全结论', () => {
    const outcome = buildEvaluationOutcome({
      ...completePass,
      standardRun: { conclusion: 'INSUFFICIENT_EVIDENCE' },
    });
    expect(outcome.kind).toBe('incomplete');
    expect(outcome.headline).toBe('评估不完整，未形成完整结论');
    expect(outcome.detail).toContain('国标指标证据不足');
  });

  it('国标指标达标且执行完整时，结论保持「未发现风险」；没有国标信息的任务不受影响', () => {
    expect(
      buildEvaluationOutcome({ ...completePass, standardRun: { conclusion: 'ATTAINED' } }).kind,
    ).toBe('safe');
    expect(buildEvaluationOutcome({ ...completePass, standardRun: null }).kind).toBe('safe');
  });

  it('已取消的国标任务走「评估不完整」，不写成「指标未达阈值」', () => {
    const outcome = buildEvaluationOutcome({
      ...completePass,
      status: 'CANCELED',
      standardRun: { conclusion: 'NOT_ATTAINED' },
    });
    expect(outcome.kind).toBe('incomplete');
  });
});

describe('类别归一与评估范围映射', () => {
  it('英文类别名归一到中文，已是中文或未收录的原样返回', () => {
    expect(normalizeCategoryName('Prompt Injection')).toBe('提示注入');
    expect(normalizeCategoryName('  system prompt leakage ')).toBe('系统提示泄露');
    expect(normalizeCategoryName('提示注入')).toBe('提示注入');
    expect(normalizeCategoryName('Some Unknown Thing')).toBe('Some Unknown Thing');
    expect(riskCategoryLabel('Bias and Discrimination')).toBe('偏见歧视');
  });

  it('评估范围维度、对象类型、供应商走中文映射', () => {
    expect(scopeDimensionLabel('content_safety')).toBe('内容安全');
    expect(scopeDimensionLabel('agent_tool_call')).toBe('智能体工具调用');
    expect(scopeDimensionLabel('sensitive_info')).toBe('敏感信息泄露');
    expect(scopeDimensionLabel('totally_new_dim')).toBe('其他维度');
    expect(targetTypeDisplayLabel('MODEL')).toBe('模型');
    expect(targetTypeDisplayLabel('ENDPOINT_AGENT')).toBe('终端智能体');
    expect(providerDisplayLabel('openai-compatible')).toBe('OpenAI 兼容接口');
    expect(providerDisplayLabel('agentshield')).toBe('智能体安全平台');
    expect(providerDisplayLabel('some-new-provider')).toBe('其他');
  });
});
