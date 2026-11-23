import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCorpusParser,
  detectContainer,
  parseCorpusText,
  type ParsedItem,
} from '../src/modules/corpus-scans/core/formats.ts';

// 1.2.5 多格式微调语料：自动识别 Alpaca、ShareGPT、messages、prompt/completion、chosen/rejected、csv、txt，
// 拆出要检测的文本字段；结构不合法的行记行号和原因，不中断。

function records(items: ParsedItem[]) {
  return items.filter((i) => i.kind === 'record');
}
function invalid(items: ParsedItem[]) {
  return items.filter((i) => i.kind === 'invalid');
}
function fields(item: ParsedItem) {
  assert.equal(item.kind, 'record');
  return item.kind === 'record' ? item.fields.map((f) => [f.path, f.text]) : [];
}

test('Alpaca jsonl：识别为 alpaca，拆出 instruction、input、output', () => {
  const text = [
    JSON.stringify({ instruction: '把下面的话翻译成英文', input: '你好', output: 'Hello' }),
    JSON.stringify({ instruction: '写一首诗', input: '', output: '床前明月光' }),
  ].join('\n');
  const r = parseCorpusText(text, { fileName: 'train.jsonl' });
  assert.equal(r.container, 'jsonl');
  assert.equal(r.detectedFormat, 'alpaca');
  const recs = records(r.items);
  assert.equal(recs.length, 2);
  assert.deepEqual(fields(recs[0]!), [
    ['instruction', '把下面的话翻译成英文'],
    ['input', '你好'],
    ['output', 'Hello'],
  ]);
  // 空 input 不算字段
  assert.deepEqual(fields(recs[1]!), [
    ['instruction', '写一首诗'],
    ['output', '床前明月光'],
  ]);
  assert.equal(recs[1]!.kind === 'record' && recs[1]!.line, 2);
});

test('ShareGPT json 数组：识别为 sharegpt，按轮次拆出 value', () => {
  const text = JSON.stringify(
    [
      {
        conversations: [
          { from: 'human', value: '你是谁' },
          { from: 'gpt', value: '我是助手' },
        ],
        system: '你是一个助手',
      },
    ],
    null,
    2,
  );
  const r = parseCorpusText(text, { fileName: 'sharegpt.json' });
  assert.equal(r.container, 'json');
  assert.equal(r.detectedFormat, 'sharegpt');
  const recs = records(r.items);
  assert.equal(recs.length, 1);
  assert.deepEqual(fields(recs[0]!), [
    ['system', '你是一个助手'],
    ['conversations[0].value', '你是谁'],
    ['conversations[1].value', '我是助手'],
  ]);
  assert.equal(recs[0]!.kind === 'record' && recs[0]!.line, 2);
});

test('OpenAI messages：content 为字符串或多段文本都能拆出', () => {
  const text = [
    JSON.stringify({
      messages: [
        { role: 'system', content: '系统提示' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'image_url', image_url: { url: 'x' } },
          ],
        },
        { role: 'assistant', content: '回答' },
      ],
    }),
  ].join('\n');
  const r = parseCorpusText(text);
  assert.equal(r.container, 'jsonl');
  assert.equal(r.detectedFormat, 'messages');
  assert.deepEqual(fields(records(r.items)[0]!), [
    ['messages[0].content', '系统提示'],
    ['messages[1].content[0].text', '第一段'],
    ['messages[2].content', '回答'],
  ]);
});

test('prompt/completion：识别并拆出两个字段', () => {
  const r = parseCorpusText(JSON.stringify({ prompt: '问题', completion: '答案' }));
  assert.equal(r.detectedFormat, 'prompt_completion');
  assert.deepEqual(fields(records(r.items)[0]!), [
    ['prompt', '问题'],
    ['completion', '答案'],
  ]);
});

test('chosen/rejected：字符串和对话两种写法都能拆出', () => {
  const text = [
    JSON.stringify({ prompt: '怎么做菜', chosen: '先洗菜', rejected: '不知道' }),
    JSON.stringify({
      chosen: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
      ],
      rejected: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '走开' },
      ],
    }),
  ].join('\n');
  const r = parseCorpusText(text);
  assert.equal(r.detectedFormat, 'chosen_rejected');
  const recs = records(r.items);
  assert.deepEqual(fields(recs[0]!), [
    ['prompt', '怎么做菜'],
    ['chosen', '先洗菜'],
    ['rejected', '不知道'],
  ]);
  assert.deepEqual(fields(recs[1]!), [
    ['chosen[0].content', '你好'],
    ['chosen[1].content', '你好呀'],
    ['rejected[0].content', '你好'],
    ['rejected[1].content', '走开'],
  ]);
});

test('csv：首行表头，默认全部列，可只选部分列；引号里的逗号和换行保留', () => {
  const text = '问题,回答,编号\r\n"你好,世界","第一行\n第二行",1\r\n天气,晴,2\r\n';
  const all = parseCorpusText(text, { fileName: 'data.csv' });
  assert.equal(all.container, 'csv');
  assert.equal(all.detectedFormat, 'csv');
  assert.deepEqual(all.csvHeader, ['问题', '回答', '编号']);
  const recs = records(all.items);
  assert.equal(recs.length, 2);
  assert.deepEqual(fields(recs[0]!), [
    ['问题', '你好,世界'],
    ['回答', '第一行\n第二行'],
    ['编号', '1'],
  ]);
  assert.equal(recs[1]!.kind === 'record' && recs[1]!.line, 4);

  const picked = parseCorpusText(text, { fileName: 'data.csv', csvColumns: ['回答'] });
  assert.deepEqual(fields(records(picked.items)[0]!), [['回答', '第一行\n第二行']]);
});

test('txt：按行，空行跳过，行号对得上', () => {
  const r = parseCorpusText('第一行\n\n第三行\r\n', { fileName: 'a.txt' });
  assert.equal(r.container, 'txt');
  assert.equal(r.detectedFormat, 'txt');
  const recs = records(r.items);
  assert.equal(recs.length, 2);
  assert.deepEqual(fields(recs[1]!), [['text', '第三行']]);
  assert.equal(recs[1]!.kind === 'record' && recs[1]!.line, 3);
});

test('坏 JSON 行记行号和原因，后面的行照常解析', () => {
  const text = [
    JSON.stringify({ instruction: 'a', output: 'b' }),
    '{"instruction": "坏行"',
    '',
    JSON.stringify({ instruction: 'c', output: 'd' }),
    '[1,2]',
  ].join('\n');
  const r = parseCorpusText(text);
  const bad = invalid(r.items);
  assert.equal(bad.length, 2);
  assert.equal(bad[0]!.line, 2);
  assert.match(bad[0]!.kind === 'invalid' ? bad[0]!.reason : '', /JSON/);
  assert.equal(bad[1]!.line, 5);
  assert.equal(records(r.items).length, 2);
});

test('手动指定格式时结构不符的记录记为非法', () => {
  const text = [
    JSON.stringify({ instruction: '有指令', output: '有回答' }),
    JSON.stringify({ prompt: '不是 alpaca', completion: 'x' }),
  ].join('\n');
  const r = parseCorpusText(text, { format: 'alpaca' });
  assert.equal(records(r.items).length, 1);
  const bad = invalid(r.items);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.line, 2);
  assert.match(bad[0]!.kind === 'invalid' ? bad[0]!.reason : '', /instruction/);
});

test('json 数组里坏的元素和未结束的数组都记下来', () => {
  const text =
    '[\n  {"prompt": "a", "completion": "b"},\n  "只是字符串",\n  {"prompt": "c", "completion": "d"}\n';
  const r = parseCorpusText(text, { fileName: 'x.json' });
  assert.equal(records(r.items).length, 2);
  const bad = invalid(r.items);
  assert.deepEqual(
    bad.map((b) => b.line),
    [3, 5],
  );
});

test('流式：按任意切块喂入，结果与一次性解析一致', () => {
  const text = [
    JSON.stringify({ conversations: [{ from: 'human', value: '中文内容，带"引号"和\\反斜杠' }] }),
    JSON.stringify({ conversations: [{ from: 'gpt', value: 'second' }] }),
  ].join('\n');
  const whole = parseCorpusText(text);
  for (const size of [1, 3, 7, 64]) {
    const p = createCorpusParser({});
    const out: ParsedItem[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
    out.push(...p.end());
    assert.deepEqual(out, whole.items, `切块 ${size}`);
  }
});

test('流式：json 数组和 csv 跨块切开也一致', () => {
  const cases: Array<[string, string]> = [
    [
      'a.json',
      JSON.stringify(
        [
          { instruction: '指令,带逗号]和括号{', output: '回答"引号"' },
          { prompt: 'p', completion: 'c' },
          '坏元素',
        ],
        null,
        2,
      ),
    ],
    ['b.csv', '甲,乙\n"多\n行,""引号""",2\n3,4\n'],
  ];
  for (const [name, text] of cases) {
    const whole = parseCorpusText(text, { fileName: name });
    assert.ok(whole.items.length >= 2, name);
    for (const size of [1, 2, 5, 13]) {
      const p = createCorpusParser({ fileName: name });
      const out: ParsedItem[] = [];
      for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
      out.push(...p.end());
      assert.deepEqual(out, whole.items, `${name} 切块 ${size}`);
    }
  }
});

test('按文件名和内容猜容器', () => {
  assert.equal(detectContainer('a.csv', 'x,y'), 'csv');
  assert.equal(detectContainer('a.txt', '{"a":1}'), 'txt');
  assert.equal(detectContainer('a.jsonl', '{"a":1}'), 'jsonl');
  assert.equal(detectContainer(undefined, '﻿  [ {"a":1} ]'), 'json');
  assert.equal(detectContainer(undefined, '{"a":1}'), 'jsonl');
  assert.equal(detectContainer(undefined, '普通文本'), 'txt');
});

test('csv：字段中间的裸引号（5"3）当普通字符，不吞后面的行；与打码副本切分一致', async () => {
  const { createScanSession } = await import('../src/modules/corpus-scans/core/scan.ts');
  const { maskCorpusText } = await import('../src/modules/corpus-scans/core/mask.ts');
  const csv = 'id,text\n1,屏幕 5"3 寸\n2,电话 13800138000\n3,身份证 110101199003071233\n';
  const r = parseCorpusText(csv, { fileName: 'x.csv' });
  assert.deepEqual(
    r.items.map((x) => [x.kind, x.line]),
    [
      ['record', 2],
      ['record', 3],
      ['record', 4],
    ],
  );
  assert.deepEqual(fields(r.items[0]!), [
    ['id', '1'],
    ['text', '屏幕 5"3 寸'],
  ]);
  const s = createScanSession({ fileName: 'x.csv' }, {});
  const found = [...s.push(csv), ...s.end()];
  assert.deepEqual(
    found.map((f) => [f.recordIndex, f.subtype]),
    [
      [2, 'phone_cn'],
      [3, 'id_card_cn'],
    ],
  );
  assert.equal(
    maskCorpusText(csv, 'csv').text,
    'id,text\n1,屏幕 5"3 寸\n2,电话 [手机号]\n3,身份证 [身份证号]\n',
  );
  // 字段开头的引号照样开启引号（引号里的逗号、换行保留）
  const quoted = parseCorpusText('a,b\n"x,""y""\nz",2\n', { fileName: 'q.csv' });
  assert.deepEqual(fields(quoted.items[0]!), [
    ['a', 'x,"y"\nz'],
    ['b', '2'],
  ]);
});

test('自动识别：开头几十兆空白不按块数平方变慢，丢掉的空行照样计进行号', () => {
  const p = createCorpusParser({ fileName: 'x.dat' });
  const ws = ' '.repeat(1 << 20);
  const t0 = performance.now();
  for (let i = 0; i < 64; i++) assert.deepEqual(p.push(ws), []);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `64 MiB 空白用了 ${ms.toFixed(0)}ms`);
  assert.deepEqual(p.end(), []);

  const lines = createCorpusParser({ fileName: 'x.dat' });
  const got = [
    ...lines.push('\n \n'),
    ...lines.push('\t\n  '),
    ...lines.push('{"instruction":"问","output":"答"}\n{坏'),
    ...lines.end(),
  ];
  assert.deepEqual(
    got.map((x) => [x.kind, x.line]),
    [
      ['record', 4],
      ['invalid', 5],
    ],
  );
  assert.equal(lines.container(), 'jsonl');
  const arr = createCorpusParser({ fileName: 'x.dat' });
  const items = [
    ...arr.push('\n\n'),
    ...arr.push('[\n{"prompt":"a","completion":"b"}]'),
    ...arr.end(),
  ];
  assert.deepEqual(
    items.map((x) => [x.kind, x.line]),
    [['record', 4]],
  );
});
