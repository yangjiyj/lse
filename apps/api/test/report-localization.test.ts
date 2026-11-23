import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortText } from '../src/modules/reports/report-builder.js';
import {
  localizeLanguagePromptForDisplay,
  getLanguageProfile,
} from '../src/modules/generator/core/language-profiles.js';

test('shortText：短于上限时原样返回', () => {
  assert.equal(shortText('短文本', 100), '短文本');
});

test('shortText：超长时回退到最近句读边界，不切出半句', () => {
  // 复刻用户反馈：旧实现会把「解释模型未返回有效内容」硬切成「…解释模型未返回有效」。
  const s = '风险说明：模型可能泄露凭据。解释模型未返回有效内容，已使用规则依据分析。';
  const out = shortText(s, 16);
  assert.ok(out.endsWith('…'), `应以省略号收尾，实际「${out}」`);
  assert.ok(out.includes('。'), '应在句号边界收尾');
  assert.ok(!out.includes('解释'), `不应切在半句中间，实际「${out}」`);
});

test('shortText：窗口内无句读边界时退化为按长度截断', () => {
  const out = shortText('AAAAAAAAAAAAAAAAAAAA', 5);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 6);
});

test('localizeLanguagePromptForDisplay：母语脚本语言名前缀还原为中文名（ISO码）', () => {
  const km = getLanguageProfile('km'); // 高棉语，母语脚本在报告字体里渲染成豆腐块
  const input = `请以 ${km.nativeName} 处理这段安全评测题：测试载荷`;
  const out = localizeLanguagePromptForDisplay(input);
  assert.ok(out.includes('高棉语（km）'), `应含中文名+ISO码，实际「${out}」`);
  assert.ok(!out.includes(km.nativeName), '不应再出现母语脚本语言名');
  assert.ok(out.includes('测试载荷'), '载荷正文应保留');
});

test('localizeLanguagePromptForDisplay：中英文前缀与普通文本不受影响', () => {
  assert.equal(
    localizeLanguagePromptForDisplay('请用中文处理这段安全评测题：x'),
    '请用中文处理这段安全评测题：x',
  );
  assert.equal(localizeLanguagePromptForDisplay('普通题干，无语言前缀'), '普通题干，无语言前缀');
});
