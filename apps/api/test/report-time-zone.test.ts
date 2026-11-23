import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime } from '../src/modules/reports/labels.js';
import { buildReportTitleParts } from '../src/modules/reports/pdf.js';

test('report timestamps identify Beijing time independently of server timezone', () => {
  const previous = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      process.env.TZ = tz;
      assert.equal(
        formatDateTime(new Date('2026-09-05T02:26:15Z')),
        '2026-09-05 10:26:15（北京时间 UTC+08:00）',
      );
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('report cover retains timezone and labels legacy unknown timezone honestly', () => {
  const report = {
    title: '综合评估报告',
    content: '> 生成时间：2026-09-05 10:26:15（北京时间 UTC+08:00）',
  };
  assert.match(buildReportTitleParts(report).subtitle, /北京时间 UTC\+08:00/);
  assert.match(
    buildReportTitleParts({ ...report, content: '> 生成时间：2026-09-05 02:26:15' }).subtitle,
    /原报告未记录时区/,
  );
});
