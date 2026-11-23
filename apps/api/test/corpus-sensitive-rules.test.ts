import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SENSITIVE_TYPES,
  findSensitive,
  maskSensitive,
} from '../src/modules/corpus-scans/core/sensitive-rules.ts';

// 敏感信息扫描（1.2.2）：40 类，带校验的要校验（身份证校验位、银行卡 Luhn）；每类至少一正一反。
// 来源对照只在仓库文档 docs/corpus-scan-sensitive-rules.md 里，检测核心（会打进命令行版）不带来源信息。

const DOC = fileURLToPath(new URL('../../../docs/corpus-scan-sensitive-rules.md', import.meta.url));

const AWS_SECRET = 'Vq8bN2xLk3Jd9Rt5Yw1Pz7Hc4Fs6Gm0Ea2Ub8XiQ';
const GH = 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5';

/** [类型, 应命中, 不应命中] */
const SAMPLES: Array<[string, string, string]> = [
  [
    'private_key',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7v\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----',
  ],
  [
    'database_url',
    'DATABASE_URL=postgres://app:S3cretPass@db.internal:5432/app',
    'postgres://app:${DB_PASS}@db.internal/app',
  ],
  [
    'cloud_credential',
    'client_secret: Zk8xQ2pLm9vRt7Wn4Ys1',
    'client_secret: your_client_secret_here',
  ],
  ['aws_access_key', 'key AKIAZ7Q3LMN4PQR8ST2U', 'key AKIAIOSFODNN7EXAMPLE'],
  ['aws_secret_key', `aws_secret_access_key = ${AWS_SECRET}`, `随便一个串 ${AWS_SECRET}`],
  ['anthropic_key', 'sk-ant-api03-Ab3dEf7hIj9kLm2nOp4qRs6t', 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx'],
  ['openai_key', 'OPENAI=sk-proj-4fT9xQ2mLp8Rw3Zk7Vb1Nc6Hd', 'sk-your-api-key-here-placeholder'],
  ['github_token', `token ${GH}`, 'ghp_short'],
  [
    'jwt_token',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'eyJhbGciOiJIUzI1NiJ9',
  ],
  ['generic_api_key', 'api_key=Q7vX2pL9mK4rT8wZ1nB6', 'api_key=YOUR_API_KEY'],
  ['access_key', 'access_key = "Lt8Kq2Wm9Rv4"', 'access_key = "${ACCESS_KEY}"'],
  ['token_leak', 'auth_token: "Zx9Lm2Qp8Rt4Vw7Ny3K"', 'auth_token: "your-token-here-placeholder"'],
  ['login_credential', '用户名：zhangsan 密码：abc123', '用户名：zhangsan 密码：******'],
  ['plain_password', '登录密码：Xk9#mQ2$vL7p', '登录密码：password'],
  ['password_in_code', 'db_password = "hunter22"', 'password = "${DB_PASSWORD}"'],
  ['driver_license_cn', '驾驶证号：110101199003071233', '驾驶证号：110101199003071234'],
  ['social_security_cn', '社保卡号：440306198511200016', '社保卡号：440306198511200017'],
  ['passport_cn', '护照号码：E12345678', '护照号码：A1234567'],
  ['hk_macao_taiwan_id', '香港身份证：A123456(7)', '香港身份证：未提供'],
  ['officer_id_cn', '军官证号：南字第20231234号', '军官证号：暂无'],
  ['id_card_cn', '身份证 110101199003071233', '身份证 110101199003071234'],
  ['bank_card_cn', '卡号 6222020200112233446', '卡号 6222020200112233445'],
  ['phone_cn', '电话 13800138000', '编号 14012345678'],
  ['email', '联系 zhang.san@example.com', 'pnpm patches/node-pty@1.2.0.patch'],
  ['uscc', '统一社会信用代码：91110000600037341L', '统一社会信用代码：91110000600037341A'],
  ['home_address_cn', '家庭住址：北京市朝阳区建国路88号院3号楼2单元501室', '服务器地址：10.0.0.1'],
  ['ip_address', '登录IP：192.168.10.25', '登录IP：999.1.1.1'],
  ['birth_date', '出生日期：1990-03-07', '出生日期：1990-13-45'],
  ['gps_location', 'GPS坐标：39.9087,116.3975', 'GPS坐标：95.1234,10.5678'],
  [
    'communication_record',
    '通话记录：2026-11-01 10:23 对方号码13800138000 通话时长 5分钟',
    '通话记录：暂时没有任何记录可以提供',
  ],
  ['credit_card_cvv', 'CVV：123', 'CID：404'],
  [
    'bank_statement',
    '银行流水：2026-10-01 转账 金额 5000.00元 对方账户 张三',
    '银行流水：请到柜台打印纸质版本谢谢',
  ],
  ['insurance_info', '保单号：PICC20261101A88', '保单号：无'],
  [
    'medical_record',
    '病历记录：患者张某，门诊诊断为高血压，处方用药氨氯地平',
    '病历记录：本系统不保存任何个人内容',
  ],
  ['genetic_data', '基因序列：ACGTACGTTAGCCGATAGCTAGCT', '基因序列：AAAAAAAAAAAAAAAAAAAAAAAA'],
  [
    'biometric_data',
    '指纹模板：Qm9yZ2V0TWVOb3QyMDI2RmluZ2VycHJpbnQ=',
    '指纹模板：xxxxxxxxxxxxxxxxxxxxxxxx',
  ],
  ['internal_project_code', '项目代号：PHOENIX-2026', '项目代号：PHOENIX'],
  [
    'sensitive_code',
    '核心算法代码：def score(x): return x * 0.618',
    '核心算法代码：这部分不方便透露给外部人员看',
  ],
  ['education_background', '毕业院校：清华大学计算机系', '毕业院校：保密不告诉你'],
  ['criminal_record', '犯罪记录：2019年因盗窃罪被判处有期徒刑一年', '犯罪记录：无'],
];

const typesOf = (text: string) => findSensitive(text).map((h) => h.type);

test('类别清单：不少于 40 类，每类都有正反样例', () => {
  const types = SENSITIVE_TYPES.map((t) => t.type);
  assert.ok(types.length >= 40, `只有 ${types.length} 类`);
  assert.equal(new Set(types).size, types.length);
  assert.deepEqual([...SAMPLES.map((s) => s[0])].sort(), [...types].sort());
  const doc = readFileSync(DOC, 'utf8');
  for (const t of SENSITIVE_TYPES) {
    assert.ok(t.label, t.type);
    assert.match(t.severity, /^(CRITICAL|HIGH|MEDIUM|LOW)$/);
    assert.ok(doc.includes(`| \`${t.type}\` |`), `文档里没有 ${t.type} 的来源对照`);
  }
});

for (const [type, positive, negative] of SAMPLES) {
  test(`${type}：正例命中、反例不命中`, () => {
    assert.ok(
      typesOf(positive).includes(type),
      `正例没命中：${positive} → ${typesOf(positive).join(',')}`,
    );
    assert.ok(!typesOf(negative).includes(type), `反例误报：${negative}`);
  });
}

test('身份证校验位错误不命中，带分隔符的写法也认', () => {
  assert.deepEqual(typesOf('110101199003071234'), []);
  assert.deepEqual(typesOf('110101199003071233'), ['id_card_cn']);
  assert.deepEqual(typesOf('证件 110101 19900307 1233'), ['id_card_cn']);
  // 生日不存在
  assert.deepEqual(typesOf('110101199002301239'), []);
});

test('银行卡 Luhn 不过不命中', () => {
  assert.deepEqual(typesOf('4111111111111111'), ['bank_card_cn']);
  assert.deepEqual(typesOf('4111111111111112'), []);
  assert.deepEqual(typesOf('卡号 6222 0202 0011 2233 446'), ['bank_card_cn']);
});

test('命中值是原文片段：带标签的只取值', () => {
  const [hit] = findSensitive('身份证号：110101199003071233，谢谢');
  assert.equal(hit!.value, '110101199003071233');
  assert.equal(hit!.label, '身份证号');
  const [pwd] = findSensitive('登录密码：Xk9#mQ2$vL7p');
  assert.equal(pwd!.value, 'Xk9#mQ2$vL7p');
});

test('打码：敏感信息换成 [类型]，其余原样，行数不变', () => {
  const text =
    '姓名张三\n身份证 110101199003071233，电话 13800138000\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n结束';
  const masked = maskSensitive(text);
  assert.equal(masked.split('\n').length, text.split('\n').length);
  assert.ok(masked.includes('身份证 [身份证号]，电话 [手机号]'));
  assert.ok(!masked.includes('110101199003071233'));
  assert.ok(!masked.includes('AAAA'));
  assert.ok(masked.startsWith('姓名张三\n'));
  assert.ok(masked.endsWith('\n结束'));
  assert.equal(maskSensitive('没有敏感信息'), '没有敏感信息');
});

const hitsOf = (text: string) => findSensitive(text).map((h) => `${h.type}:${h.value}`);

test('误报过滤：小数的小数部分、ASCII 标识符里的数字串不算手机号、银行卡号', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let hit = 0;
  for (let i = 0; i < 2000; i++) {
    if (findSensitive(`"loss": ${(rnd() * 0.7 + 0.3).toFixed(17)}`).length) hit += 1;
  }
  assert.equal(hit, 0, `随机 17 位小数被报 ${hit} 次`);
  assert.deepEqual(hitsOf('"lr": 0.30000000000000004'), []);
  assert.deepEqual(hitsOf('文件 img_13800138000.png 已上传'), []);
  assert.deepEqual(hitsOf('trace_id=req13912345678abc'), []);
  assert.deepEqual(hitsOf('user_id: u4111111111111111'), []);
  assert.deepEqual(hitsOf('NAME TYPE SIZE USED PRIO\n/swap.img file 4111111111111111 0 -2\n'), []);
  // 中文标签紧贴的真号码、整数照样认
  assert.deepEqual(hitsOf('电话13800138000'), ['phone_cn:13800138000']);
  assert.deepEqual(hitsOf('卡号 4111111111111111'), ['bank_card_cn:4111111111111111']);
  assert.deepEqual(hitsOf('金额 13800138000.50 元'), ['phone_cn:13800138000']);
});

test('误报过滤：URL 里的 userinfo 不是邮箱；base64 图片里的号码不算', () => {
  assert.deepEqual(hitsOf('git clone https://alice@example.com/repo.git'), []);
  assert.deepEqual(hitsOf('联系 alice@example.com'), ['email:alice@example.com']);
  const blob = (head: number[]) => {
    const bytes = Buffer.alloc(300);
    Buffer.from(head).copy(bytes);
    const b64 = bytes.toString('base64');
    return `${b64.slice(0, 200)}/110101199003071233/${b64.slice(220)}`;
  };
  const png = blob([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.length % 4, 0);
  assert.deepEqual(hitsOf(`图片 data:image/png;base64,${png}`), []);
  const text = blob([...Buffer.from('hello world, plain text')]);
  assert.deepEqual(hitsOf(`附件 ${text}`), ['id_card_cn:110101199003071233']);
});

test('不带标签词的护照号、统一社会信用代码降为低危，带标签的照旧', () => {
  const sev = (text: string) => findSensitive(text).map((h) => `${h.type}:${h.severity}`);
  assert.deepEqual(sev('单据 D20231201 已归档'), ['passport_cn:LOW']);
  assert.deepEqual(sev('护照号码是E12345678'), ['passport_cn:HIGH']);
  assert.deepEqual(sev('护照号：E12345678'), ['passport_cn:HIGH']);
  assert.deepEqual(sev('编号 91350100M000100Y43'), ['uscc:LOW']);
  assert.deepEqual(sev('统一社会信用代码：91350100M000100Y43'), ['uscc:MEDIUM']);
});

test('大段文本里各类命中交错：整批归并，不逐个往中间插，耗时随长度线性增长', () => {
  const time = (n: number) => {
    const text = Array.from({ length: n }, (_, i) => `u${i}@ex.com 13800138000`).join(' ');
    const t0 = performance.now();
    const hits = findSensitive(text);
    const ms = performance.now() - t0;
    assert.equal(hits.length, n * 2);
    assert.ok(hits.every((h, i) => i === 0 || hits[i - 1]!.end <= h.start));
    return ms;
  };
  const small = time(40_000);
  const big = time(160_000);
  // 线性约 4 倍；逐个往中间插（平方）时远超
  assert.ok(
    big / small < 7,
    `4 倍长度用了 ${(big / small).toFixed(1)} 倍时间（${small.toFixed(0)}ms → ${big.toFixed(0)}ms）`,
  );
});
