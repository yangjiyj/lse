import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadGoldSet, categoryCounts, GOLD_SET_PATH } from './gold-set.js';

const present = existsSync(GOLD_SET_PATH);

test(
  '定稿 gold set：合法、四类齐全、规模达标',
  { skip: present ? false : '尚未定稿 gold set fixture（任务 5/6 产出后此用例自动生效）' },
  () => {
    const items = loadGoldSet(); // parseGoldSet 内部已做 schema/去重校验
    assert.ok(items.length >= 100, `gold set 至少 100 条，当前 ${items.length}`);
    const counts = categoryCounts(items);
    (Object.keys(counts) as (keyof typeof counts)[]).forEach((cat) => {
      assert.ok(counts[cat] >= 1, `类别 ${cat} 至少 1 条，当前 ${counts[cat]}`);
    });
  },
);
