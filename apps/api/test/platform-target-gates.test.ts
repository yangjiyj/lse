import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRedTeamEvaluationTarget, assertCallableRedTeamTarget } from '../src/modules/red-team/target-validation.js';
import { enforcePlatformConnectorAccess, CONNECTOR_RESTRICTED } from '../src/lib/platform-connector-access.js';
const target = { id:'p',targetType:'PLATFORM_APP' as const,isActive:true,baseUrl:'https://example.com',apiKey:'app-test',model:'platform-app' };
test('红队可攻击平台应用，但攻击模型与裁判仍要求普通模型', () => {
  assert.doesNotThrow(() => assertRedTeamEvaluationTarget(target));
  assert.throws(() => assertCallableRedTeamTarget(target, 'attacker'));
  assert.throws(() => assertCallableRedTeamTarget(target, 'judge'));
});
test('受限连接器可查询能力并创建平台对象，不放宽修改权限', async () => {
  const user = {id:'service',username:'service',isBuiltin:false,permissions:new Set([CONNECTOR_RESTRICTED]),roles:['platform_connector']} as any;
  await enforcePlatformConnectorAccess(user,{method:'GET',routeOptions:{url:'/api/model-targets/capabilities'}},{} as any);
  await enforcePlatformConnectorAccess(user,{method:'POST',routeOptions:{url:'/api/model-targets'},body:{targetType:'PLATFORM_APP'}},{} as any);
});
