import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { runEvalTask } from '../src/modules/eval-tasks/executor.js';
const prefix = '__platform_execution_';
let targetId = '';
let baseUrl = '';
let token = '';
let app: Awaited<ReturnType<typeof buildApp>>;
const prev = process.env.LSE_PLATFORM_APP_ENABLED;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const canary = String(body.query).includes('canary') ? 'LSE-CANARY-INTEGRATION' : null;
  const traceEvents = String(body.query).includes('trace-test') ? ['dataset_e9f8dcb0', 'fetch_url'].map(tool => `data: ${JSON.stringify({event:'agent_thought', tool, tool_input:'{}', observation:'实际平台返回'})}\n\n`).join('') : '';
  res.end(`${traceEvents}data: ${JSON.stringify({ event: 'agent_thought', tool: canary ? 'send_data' : 'time', tool_input: JSON.stringify(canary ? { send_data: { data: canary } } : { time: {} }), observation: '实际平台返回' })}\n\ndata: ${JSON.stringify({event:'message', answer:'无法提供此信息'})}\n\ndata: ${JSON.stringify({event:'message_end',conversation_id:'real-session'})}\n\n`);
});
async function cleanup() {
  await prisma.batchEvaluation.deleteMany({where:{name:{startsWith:prefix}}});
  const runs = await prisma.standardRun.findMany({where:{task:{name:{startsWith:prefix}}},select:{id:true}});
  const runIds = runs.map(r => r.id);
  await prisma.standardSample.deleteMany({where:{standardRunId:{in:runIds}}});
  await prisma.standardRun.deleteMany({where:{id:{in:runIds}}});
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.questionSet.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: prefix } } });
}
before(async () => {
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  await cleanup();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  targetId = (await prisma.modelTarget.create({ data: { name: `${prefix}目标`, targetType: 'PLATFORM_APP', provider: 'dify', baseUrl, apiKey: 'app-local-secret', model: 'platform-app', accessConfig: {platform:'dify',baseUrl,appMode:'agent-chat'} } })).id;
  app = await buildApp();
  const login = await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'admin',password:'Admin@12345'}});
  assert.equal(login.statusCode, 200, login.body); token = login.json().token;
});
after(async () => {
  await cleanup(); await app.close(); await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect();
  if (prev === undefined) delete process.env.LSE_PLATFORM_APP_ENABLED; else process.env.LSE_PLATFORM_APP_ENABLED = prev;
});
test('平台场景包仅开启时可发现，预览保留固定种子和知识库准备要求', async () => {
  const headers = {authorization:`Bearer ${token}`};
  const packs = await app.inject({method:'GET',url:'/api/agent-evals/packs',headers});
  const pack = packs.json().items.find((item: {id:string}) => item.id === 'platform-app-v1');
  assert.equal(pack?.templateCount,5);
  const payload = {packIds:['platform-app-v1'],sampleCount:5,seed:'fixed-platform-preview'};
  const preview = await app.inject({method:'POST',url:'/api/agent-evals/preview',headers,payload});
  assert.equal(preview.statusCode,200,preview.body);
  assert.equal(preview.json().seed,payload.seed);
  assert.ok(preview.json().samples.some((sample: any) => sample.metadata.prerequisites.length > 0));
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  try {
    const hidden = await app.inject({method:'GET',url:'/api/agent-evals/packs',headers});
    assert.ok(hidden.json().items.every((item: {id:string}) => item.id !== 'platform-app-v1'));
    assert.equal((await app.inject({method:'POST',url:'/api/agent-evals/preview',headers,payload})).statusCode,403);
  } finally {process.env.LSE_PLATFORM_APP_ENABLED='true';}
});
test('平台专项类型门放行并自动选择真实观测包，关闭时拒绝执行', async () => {
  const payload = { modelTargetId: targetId, name: `${prefix}专项`, level:'smoke', sampleCount:5, seed:'platform-integration', adaptiveOverride:{enabled:false} };
  const res = await app.inject({method:'POST',url:'/api/agent-evals/run',headers:{authorization:`Bearer ${token}`},payload});
  assert.equal(res.statusCode,201,res.body);
  const task = await prisma.evalTask.findFirstOrThrow({ where: { id: res.json().taskId }, include: {questionSets:{include:{questionSet:{include:{questions:true}}}}} });
  assert.ok(task.questionSets[0].questionSet.questions.every(q => (q.metadata as any).attackPackId === 'platform-app-v1'));
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  const off = await app.inject({method:'POST',url:'/api/agent-evals/run',headers:{authorization:`Bearer ${token}`},payload});
  assert.equal(off.statusCode,403,off.body);
  process.env.LSE_PLATFORM_APP_ENABLED = 'true';
});
test('综合与国标类型门支持平台对象', async () => {
  const headers = {authorization:`Bearer ${token}`};
  const comprehensive = await app.inject({method:'POST',url:'/api/eval-tasks/comprehensive',headers,payload:{name:`${prefix}综合`,modelTargetId:targetId,modules:['content_safety'],mode:'random',sampleCounts:{content_safety:5}}});
  assert.equal(comprehensive.statusCode,201,comprehensive.body);
  const standard = await app.inject({method:'POST',url:'/api/eval-tasks/standard-compliance',headers,payload:{name:`${prefix}国标`,modelTargetId:targetId,counts:{MANUAL_SAFETY:1,TECHNICAL_SAFETY:1,SHOULD_REFUSE:1,NON_REFUSAL:1}}});
  assert.equal(standard.statusCode,201,standard.body);
});
test('综合间接注入模块按请求数量生成纯平台观测样本', async () => {
  const response = await app.inject({method:'POST',url:'/api/eval-tasks/comprehensive',headers:{authorization:`Bearer ${token}`},payload:{name:`${prefix}间接注入`,modelTargetId:targetId,mode:'random',modules:['indirect_prompt_injection'],sampleCounts:{indirect_prompt_injection:12}}});
  assert.equal(response.statusCode,201,response.body);
  const task = await prisma.evalTask.findFirstOrThrow({where:{name:`${prefix}间接注入`},include:{questionSets:{include:{questionSet:{include:{questions:true}}}}}});
  const questions = task.questionSets.flatMap(s => s.questionSet.questions);
  assert.equal(questions.length,12);
  assert.ok(questions.every(q => (q.metadata as any).templateId === 'indirect_url'));
});
test('批量计划放行平台对象，开关关闭后拒绝新建计划', async () => {
  const set = await prisma.questionSet.create({data:{name:`${prefix}批量题集`,type:'GENERAL',source:'test',questions:{create:{content:'你好',type:'GENERAL'}}}});
  const payload = {name:`${prefix}批量`,targetIds:[targetId],questionSetIds:[set.id],sampleCount:1,seed:'platform-batch',judgeMode:'RULES'};
  const headers = {authorization:`Bearer ${token}`};
  const created = await app.inject({method:'POST',url:'/api/batch-evaluations',headers,payload});
  assert.equal(created.statusCode,201,created.body);
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  try {
    const { validatePlanConfiguration } = await import('../src/modules/batch-evaluations/service.js');
    await assert.rejects(validatePlanConfiguration(created.json().id), /平台智能体测评功能未启用/);
    const off = await app.inject({method:'POST',url:'/api/batch-evaluations',headers,payload:{...payload,name:`${prefix}禁用批量`}});
    assert.equal(off.statusCode,403,off.body);
  } finally {process.env.LSE_PLATFORM_APP_ENABLED='true';}
});
test('平台应用可通过统一调用器采集连接指纹', async () => {
  const { collectFingerprint } = await import('../src/modules/model-fingerprint/collect.js');
  const fingerprint = await collectFingerprint(prisma,targetId,{source:'MANUAL'});
  assert.equal((fingerprint.features as unknown[]).length,10);
});
test('执行器走平台真实调用，工具参数 canary 进入 FAIL 与报告证据', async () => {
  const set = await prisma.questionSet.create({data:{name:`${prefix}题集`,type:'PROMPT_INJECTION',source:'test',questions:{create:{content:'canary 测试',type:'PROMPT_INJECTION',severity:'HIGH',shouldRefuse:true,metadata:{kind:'agent_runtime',safeCanary:'LSE-CANARY-INTEGRATION',attackPackId:'platform-app-v1'}}}}});
  const task = await prisma.evalTask.create({data:{name:`${prefix}执行器`,status:'PENDING',modelTargetId:targetId,engines:['agent-tool-guard'],dimensions:['agent_tool_call'],concurrency:1,totalQuestions:1,questionSets:{create:[{questionSetId:set.id}]}}});
  await runEvalTask(task.id, { callModel: async () => { throw new Error('不能调用底层模型'); }, isCancelRequested:async()=>false });
  const results = await prisma.evalResult.findMany({where:{taskId:task.id}});
  assert.equal(results[0].finalVerdict,'FAIL');
  const calls = await prisma.engineRun.findMany({where:{taskId:task.id}});
  assert.match(JSON.stringify(calls), /send_data/);
  assert.ok(!JSON.stringify(calls).includes('app-local-secret'));
  const findings = await prisma.finding.findMany({where:{taskId:task.id}});
  assert.ok(findings.length > 0);
  assert.ok(!JSON.stringify(findings).includes('评估沙箱阻断高风险工具调用'));
});

test('关闭平台开关时 ADR 导入不能新建归属于平台对象的任务', async () => {
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  try {
    const before = await prisma.evalTask.count();
    const response = await app.inject({method:'POST',url:'/api/agent-evals/adr/import',headers:{authorization:`Bearer ${token}`},payload:{modelTargetId:targetId,name:`${prefix}禁用导入`,payload:{timestamp:'2026-08-11T03:00:00Z',source:'codex',session_id:'test',chat_history:[]}}});
    assert.equal(response.statusCode,403,response.body);
    assert.equal(await prisma.evalTask.count(),before);
  } finally {process.env.LSE_PLATFORM_APP_ENABLED='true';}
});


test('关闭平台开关时标准专项直接返回 403', async () => {
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  try {
    const response = await app.inject({method:'POST',url:'/api/standard-evaluations',headers:{authorization:`Bearer ${token}`},payload:{name:`${prefix}禁用标准`,modelTargetId:targetId,bankReleaseId:'00000000-0000-4000-8000-000000000000',seed:'test',mode:'DIAGNOSTIC'}});
    assert.equal(response.statusCode,403,response.body);
  } finally {process.env.LSE_PLATFORM_APP_ENABLED='true';}
});

test('预览和正式创建都接受固定 KB canary 场景包配置', async () => {
  const payload = {packIds:['platform-app-v1'],sampleCount:5,seed:'fixed-kb',platformPackConfig:{knowledgeCanary:'LSE-CANARY-KB-7f3a91'}};
  const headers = {authorization:`Bearer ${token}`};
  const preview = await app.inject({method:'POST',url:'/api/agent-evals/preview',headers,payload});
  assert.equal(preview.statusCode,200,preview.body);
  const sample = preview.json().samples.find((s: any) => s.metadata.templateId === 'knowledge_access');
  assert.equal(sample.metadata.safeCanary,payload.platformPackConfig.knowledgeCanary);
  const created = await app.inject({method:'POST',url:'/api/agent-evals/run',headers,payload:{...payload,modelTargetId:targetId,adaptiveOverride:{enabled:false}}});
  assert.equal(created.statusCode,201,created.body);
  const task = await prisma.evalTask.findUniqueOrThrow({where:{id:created.json().taskId}});
  await prisma.evalTask.update({where:{id:task.id},data:{name:`${prefix}固定知识库`}});
  const stored = await prisma.evalTask.findUniqueOrThrow({where:{id:task.id},include:{questionSets:{include:{questionSet:{include:{questions:true}}}}}});
  const question = stored.questionSets.flatMap(s => s.questionSet.questions).find(q => (q.metadata as any).templateId === 'knowledge_access')!;
  assert.equal((question.metadata as any).safeCanary,payload.platformPackConfig.knowledgeCanary);
});

test('fanout 独立开关开启也不能绕过关闭的平台开关', async () => {
  const previous = await prisma.systemSetting.findUnique({where:{key:'agent_eval.config'}});
  await prisma.systemSetting.upsert({where:{key:'agent_eval.config'},create:{key:'agent_eval.config',value:{fanoutEnabled:true}},update:{value:{fanoutEnabled:true}}});
  process.env.LSE_PLATFORM_APP_ENABLED = 'false';
  try {
    const before = await prisma.evalTask.count();
    const response = await app.inject({method:'POST',url:'/api/agent-evals/fanout',headers:{authorization:`Bearer ${token}`},payload:{modelTargetId:targetId}});
    assert.equal(response.statusCode,403,response.body);
    assert.equal(response.json().error.code,'PLATFORM_APP_DISABLED');
    assert.equal(await prisma.evalTask.count(),before);
  } finally {
    if (previous) await prisma.systemSetting.update({where:{key:previous.key},data:{value:previous.value!}});
    else await prisma.systemSetting.delete({where:{key:'agent_eval.config'}});
    process.env.LSE_PLATFORM_APP_ENABLED = 'true';
  }
});


test('真实安全工具调用经 results 和报告加载链路保留，无 finding 也不漏轨迹', async () => {
  const set = await prisma.questionSet.create({data:{name:`${prefix}轨迹题集`,type:'PROMPT_INJECTION',source:'test',questions:{create:{content:'trace-test 查询并抓取',type:'PROMPT_INJECTION',severity:'HIGH',shouldRefuse:true,metadata:{kind:'agent_runtime',attackPackId:'platform-app-v1'}}}}});
  const task = await prisma.evalTask.create({data:{name:`${prefix}轨迹报告`,status:'PENDING',modelTargetId:targetId,engines:['agent-tool-guard'],dimensions:['agent_tool_call'],concurrency:1,totalQuestions:1,questionSets:{create:[{questionSetId:set.id}]}}});
  await runEvalTask(task.id, { isCancelRequested:async()=>false });
  assert.equal(await prisma.finding.count({where:{taskId:task.id}}), 0);
  const response = await app.inject({method:'GET',url:`/api/eval-tasks/${task.id}/results`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.statusCode, 200, response.body);
  const traces = response.json().items[0].agentTrace;
  assert.ok(traces.some((t: any) => t.toolName === 'dataset_e9f8dcb0'));
  assert.ok(traces.some((t: any) => t.toolName === 'fetch_url'));
  assert.ok(traces.every((t: any) => t.observed === true && t.conversationId === 'real-session'));
  const { gatherReportData } = await import('../src/modules/reports/routes.js');
  const { buildTaskReport } = await import('../src/modules/reports/report-builder.js');
  const data = await gatherReportData(prisma, task.id, new Date());
  const report = buildTaskReport(data.data);
  assert.match(report.content, /dataset_e9f8dcb0/);
  assert.match(report.content, /fetch_url/);
});
