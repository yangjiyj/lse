import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion } from '../src/modules/engines/ai-asset/vulndb/version.js';
import {
  evaluateRuleText,
  parseRule,
} from '../src/modules/engines/ai-asset/vulndb/version-expr.js';

test('版本比较：PEP 440 / semver 常见写法', () => {
  const lt: Array<[string, string]> = [
    ['1.0.0rc1', '1.0.0'],
    ['1.0.dev1', '1.0a1'],
    ['1.0a1', '1.0b1'],
    ['1.0b2', '1.0rc1'],
    ['1.0.0', '1.0.post1'],
    ['0.0.131', '0.0.132'],
    ['2023.12', '2024.1'],
    ['1.3.0-rc11', '1.3.0rc12'],
    ['1.0.0-beta.2', '1.0.0'],
    ['2026.2.21', '2026.2.21-1'],
    ['1.9', '1.10'],
  ];
  for (const [a, b] of lt) {
    assert.equal(compareVersions(a, b), -1, `${a} < ${b}`);
    assert.equal(compareVersions(b, a), 1, `${b} > ${a}`);
  }
  for (const [a, b] of [
    ['1.0', '1.0.0'],
    ['v1.2', '1.2'],
    ['1.3.0-rc11', '1.3.0rc11'],
    ['20240410', '20240410'],
    ['1.2.3+local.1', '1.2.3'],
  ] as const) {
    assert.equal(compareVersions(a, b), 0, `${a} == ${b}`);
  }
  for (const bad of ['main', 'cec2080', '21.1.x', '@gradio/video@0.10.2', '', '1..2']) {
    assert.equal(parseVersion(bad), null, bad);
  }
});

/** 36 种规则形态，规则文本逐字取自 AIG data/vuln（shapes 统计的首个样本）。 */
const SHAPES: Array<[string, Array<[string, boolean | null]>]> = [
  ['version < "0.5.2"', [['0.5.1', true], ['0.5.2', false], ['0.5.2rc1', true], ['0.6', false]]],
  ['version <= "0.2"', [['0.2.0', true], ['0.2.1', false], ['0.1.9', true]]],
  ['version >= "1.80.5" && version < "1.83.7"', [['1.80.5', true], ['1.83.7', false], ['1.80.4', false], ['1.82.0', true]]],
  ['version > "0" && version < "1.40.15"', [['0', false], ['0.0.1', true], ['1.40.15', false], ['1.40.14', true]]],
  ['version >= "1.82.7" && version <= "1.82.8"', [['1.82.8', true], ['1.82.9', false], ['1.82.6', false]]],
  ['version == "20240410"', [['20240410', true], ['20240411', false]]],
  ['version >= "0"', [['0.0.1', true], ['99', true], ['main', null]]],
  ['version = "20240121"', [['20240121', true], ['v20240121', true], ['20240122', false]]],
  ['version > "0" && version <= "1.28.11"', [['1.28.11', true], ['1.28.12', false]]],
  ['(version > "0" && version < "0.3.81") || (version >= "1.0.0" && version < "1.2.5")', [['0.3.80', true], ['0.3.81', false], ['0.9', false], ['1.2.4', true], ['1.2.5', false]]],
  ['version < "3.39.2" || (version >= "4.0.0" && version < "4.0.5")', [['3.39.1', true], ['3.40', false], ['4.0.4', true], ['4.0.5', false]]],
  ['(version >= "4.5.0" && version <= "4.5.9") || (version >= "4.6.0" && version <= "4.6.1")', [['4.5.9', true], ['4.5.10', false], ['4.6.1', true], ['4.6.2', false]]],
  ['version < "1.123.32" || (version >= "2.0.0" && version < "2.17.4") || (version >= "2.18.0" && version < "2.18.1")', [['1.123.31', true], ['1.123.32', false], ['2.17.3', true], ['2.17.4', false], ['2.18.0', true], ['2.18.1', false]]],
  ['(version < "1.123.22") || (version >= "2.0.0" && version < "2.9.3") || (version == "2.10.0")', [['1.123.21', true], ['2.9.3', false], ['2.10.0', true], ['2.10.1', false]]],
  ['version<= "0.3.8"', [['0.3.8', true], ['0.3.9', false]]],
  ['version < "20.8.18.32" || (version < "21.1.9.41" && version != "21.1.x") || version < "21.2.9.41" || version < "21.3.6.55" || version < "21.4.3.21"', [['21.4.3.20', true], ['21.4.3.21', false], ['21.1.0', true]]],
  ['(version >= "6.4.0" && version <= "6.4.11") || (version >= "1.16.0" && version < "1.17.1") || (version == "2.0.0a0")', [['2.0.0a0', true], ['2.0.0', false], ['1.17.0', true], ['6.4.11', true], ['6.4.12', false]]],
  ['(version >= "1.0.0" && version <= "1.1.5") || version == "1.2.0" || (version >= "1.3.0" && version <= "1.8.1") || (version >= "2.0.0" && version <= "2.5.1")', [['1.2.0', true], ['1.2.1', false], ['1.8.1', true], ['1.9.0', false], ['2.5.2', false]]],
  ['version < "1.2.21" || (version >= "2.0.0a0" && version < "2.2.10") || (version >= "2.3.0a0" && version < "2.3.2") || (version >= "3.0.0a0" && version < "3.0.17") || (version >= "3.1.0a0" && version < "3.1.4")', [['1.2.21', false], ['2.0.0rc1', true], ['3.0.17', false], ['3.1.0b1', true], ['3.1.4', false]]],
  ['version < "1.1.1" || (version >= "2.0.0" && version < "2.1.1") || (version >= "3.0.0" && version < "3.1.1") || version < "5.0.2" || version >= "6.0.0" && version < "6.1.2" || version < "1.0.1" || version >= "2.0.0" && version < "2.1.1"', [['5.0.1', true], ['5.0.2', false], ['5.5', false], ['6.1.1', true], ['6.1.2', false]]],
  ['(version <= "3.6.7" && version >= "0") || (version <= "4.2.4" && version >= "4.0.0")', [['3.6.7', true], ['3.6.8', false], ['4.2.4', true], ['4.2.5', false]]],
  ['version <= "4.5.9" || (version >= "4.6.0" && version <= "4.6.1")', [['4.5.9', true], ['4.5.10', false], ['4.6.0', true]]],
  ['(version >= "0.1.17" && version < "0.1.53") || (version >= "0.2.0" && version < "0.2.43") || (version >= "0.3.0" && version < "0.3.15")', [['0.1.16', false], ['0.1.52', true], ['0.1.53', false], ['0.2.42', true], ['0.3.15', false]]],
  ['version < "0.2.19" && (version >= "0.2.0" && version < "0.2.0")', [['0.2.0', false], ['0.1.0', false]]],
  ['version < "1.0.7" || version < "0.3.80"', [['1.0.6', true], ['1.0.7', false]]],
  ['(version > "0" && version < "0.3.80") || (version > "1.0.0" && version < "1.1.8") || (version > "0" && version < "0.3.37") || (version > "1.0.0" && version < "1.2.3")', [['0.3.79', true], ['0.3.80', false], ['1.0.0', false], ['1.2.2', true], ['1.2.3', false]]],
  ['version < "0.3.85" || version >= "1.0.0" && version < "1.3.3"', [['0.3.84', true], ['0.9', false], ['1.3.2', true], ['1.3.3', false]]],
  ['version >= "0.211.0" && version < "1.120.4" || version >= "1.121.0" && version < "1.121.1"', [['0.210.9', false], ['1.120.3', true], ['1.120.4', false], ['1.121.0', true], ['1.121.1', false]]],
  ['(version > "0" && version < "1.123.17") || (version >= "2.0.0" && version < "2.4.5") || (version >= "2.5.0" && version < "2.5.1")', [['1.123.17', false], ['2.4.4', true], ['2.5.0', true], ['2.5.1', false]]],
  ['(version > "2.0.0" && version < "2.2.1") || (version > "0" && version < "1.123.9")', [['2.0.0', false], ['2.0.1', true], ['1.123.9', false]]],
  ['(version < "2.25.7") || (version >= "2.26.0" && version < "2.26.2")', [['2.25.7', false], ['2.26.1', true]]],
  ['version <= "2026.2.21" || version = "2026.2.21-1" || version = "2026.2.21-2"', [['2026.2.21', true], ['2026.2.21-1', true], ['2026.2.21-3', false], ['2026.2.22', false]]],
  ['version = "cec2080" || version < "main"', [['1.0', null]]],
  ['(version >= "1.3.3" && version < "1.3.5") || (version >= "1.4.0" && version < "1.4.2")', [['1.3.4', true], ['1.3.5', false], ['1.4.1', true]]],
];

test('规则求值覆盖数据中的全部版本形态', () => {
  assert.equal(SHAPES.length, 34);
  for (const [rule, cases] of SHAPES) {
    assert.equal(parseRule(rule).kind, 'version', rule);
    for (const [version, expected] of cases) {
      assert.equal(evaluateRuleText(rule, version), expected, `${rule} @ ${version}`);
    }
  }
  // 另外两种形态：空规则、is_internal 规则
  assert.equal(parseRule('').kind, 'empty');
  assert.equal(parseRule(null).kind, 'empty');
  assert.equal(parseRule('is_internal=="true"').kind, 'non_version');
  assert.equal(evaluateRuleText('is_internal=="true"', '1.0'), null);
});

test('非法表达式返回“无法判定”，不会执行任何代码', () => {
  for (const bad of [
    'version <',
    'version < 1.0',
    'version < "1.0" &&',
    '(version < "1.0"',
    'version < "1.0")',
    'version ~= "1.0"',
    'eval("process.exit(1)")',
    'version < "1.0" ; process.exit(1)',
    '"1.0" > version',
    'version < "1',
  ]) {
    assert.equal(parseRule(bad).kind, 'invalid', bad);
    assert.equal(evaluateRuleText(bad, '0.1'), null, bad);
  }
  assert.equal(parseRule('('.repeat(40) + 'version < "1"' + ')'.repeat(40)).kind, 'invalid');
});
