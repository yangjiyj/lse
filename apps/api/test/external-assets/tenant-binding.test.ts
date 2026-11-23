import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {prisma} from '../../src/db.js';
import {externalAssetAssessmentRoutes} from '../../src/modules/external-assets/routes.js';
import {platformTenantForUser} from '../../src/modules/external-assets/tenant-binding.js';
test('trusted native-account mapping rejects forged tenant and foreign report reads with real database',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'lse-binding-'));const file=join(temp,'binding.json');
 process.env.LSE_PLATFORM_TENANT_BINDINGS_FILE=file;
 const role=await prisma.role.create({data:{name:'cap-test-'+Date.now(),permissions:{create:['eval_task:create','eval_task:read'].map(code=>({permission:{connectOrCreate:{where:{code},create:{code,name:code,group:'test'}}}}))}}});
 const users=await Promise.all(['a','b','unbound'].map(name=>prisma.user.create({data:{username:'cap-'+name+'-'+Date.now(),passwordHash:'not-login-usable',displayName:name,isActive:true,roles:{create:{roleId:role.id}}}})));
 writeFileSync(file,JSON.stringify({[users[0].id]:'tenant-a',[users[1].id]:'tenant-b'}),{mode:0o600});
 const app=Fastify();await app.register(jwt,{secret:'isolated-test-secret-01234567890123456789'});
 await app.register(externalAssetAssessmentRoutes,{prefix:'/api/external-assets'});await app.ready();
 const token=(i:number)=>({authorization:'Bearer '+app.jwt.sign({sub:users[i].id})});
 const body={source_request_id:crypto.randomUUID(),source_tenant_id:'tenant-a',source_asset_id:'asset-a',source_instance_id:'instance-a',asset_type:'skill',content_hash:'a'.repeat(64),ruleset_version:'agent-static-v1',status:'partial',checks:[]};
 try {
  assert.equal(platformTenantForUser(users[0].id),'tenant-a');
  let res=await app.inject({method:'POST',url:'/api/external-assets/assessments',headers:token(0),payload:{...body,source_tenant_id:'tenant-b'}});assert.equal(res.statusCode,403,res.body);
  res=await app.inject({method:'POST',url:'/api/external-assets/assessments',headers:token(2),payload:body});assert.equal(res.statusCode,503,res.body);
  res=await app.inject({method:'POST',url:'/api/external-assets/assessments',headers:token(0),payload:body});assert.equal(res.statusCode,201,res.body);
  const result=res.json();assert.equal(result.source_tenant_id,'tenant-a');assert.equal(result.method,'supplied_static_evidence_review');
  res=await app.inject({method:'GET',url:'/api/external-assets/assessments/'+result.id,headers:token(1)});assert.equal(res.statusCode,404,res.body);
  res=await app.inject({method:'GET',url:'/api/external-assets/assessments',headers:token(1)});assert.equal(res.statusCode,200);assert.equal(res.json().total,0);
  chmodSync(file,0o644);assert.equal(platformTenantForUser(users[0].id),null);chmodSync(file,0o600);
  writeFileSync(file,JSON.stringify({[users[0].id]:'tenant-changed',[users[1].id]:'tenant-b'}));
  res=await app.inject({method:'GET',url:'/api/external-assets/assessments/'+result.id,headers:token(0)});assert.equal(res.statusCode,404,res.body);
 } finally {
  await prisma.auditLog.deleteMany({where:{actorId:{in:users.map(u=>u.id)}}});
  await prisma.externalAssetAssessment.deleteMany({where:{createdById:{in:users.map(u=>u.id)}}});
  await prisma.userRole.deleteMany({where:{userId:{in:users.map(u=>u.id)}}});
  await prisma.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});await prisma.role.delete({where:{id:role.id}});
  await app.close();await prisma.$disconnect();rmSync(temp,{recursive:true,force:true});
 }
});
