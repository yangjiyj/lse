import { Prisma } from '@prisma/client';
import { DETECT_RAW_STATUS_MAP } from '@lse/shared';
import { currentTenantId } from './tenant-context.js';

// 统一任务视图、风险统计共用的原始 SQL 片段。原始 SQL 不经租户查询扩展，租户条件用 tenantCondition。

const col = (alias: string, name: string) => Prisma.raw(`${alias}."${name}"`);

/** 终端测评任务的引擎标识，与 apps/api/src/modules/endpoint-evals/service.ts 的 ENDPOINT_ENGINE 一致（测试核对）。 */
export const ENDPOINT_ENGINE_SQL_VALUE = 'endpoint-agent-eval';

/** 与 detectCategoryOfEvalTask 等价：评估任务归 content 还是 app_env。判断顺序同 classifyEvalTask。 */
export function evalTaskDetectCategorySql(alias = 't'): Prisma.Sql {
  const e = col(alias, 'engines');
  const d = col(alias, 'dimensions');
  return Prisma.sql`(CASE
    WHEN 'comprehensive' = ANY(${d}) THEN 'content'
    WHEN 'standard_output_safety' = ANY(${d}) OR 'standard-output-v1' = ANY(${e}) THEN 'content'
    WHEN 'redteam_attack' = ANY(${d}) OR 'autonomous-red-team' = ANY(${e}) THEN 'content'
    WHEN 'gateway_traffic_log' = ANY(${d}) THEN 'content'
    WHEN 'gateway-assurance' = ANY(${e}) THEN 'content'
    WHEN 'agent_tool_call' = ANY(${d}) THEN 'app_env'
    ELSE 'content' END)`;
}

/** eval_tasks 的行在统一视图里细分成哪种记录：国标专项、RAG、终端测评，其余是评估任务。 */
export function evalTaskRecordKindSql(alias = 't'): Prisma.Sql {
  const id = col(alias, 'id');
  return Prisma.sql`(CASE
    WHEN EXISTS (SELECT 1 FROM "standard_runs" sr WHERE sr."taskId" = ${id}) THEN 'standard_run'
    WHEN EXISTS (SELECT 1 FROM "rag_eval_runs" rr WHERE rr."taskId" = ${id}) THEN 'rag_eval'
    WHEN ${ENDPOINT_ENGINE_SQL_VALUE} = ANY(${col(alias, 'engines')}) THEN 'fleet_eval_job'
    ELSE 'eval_task' END)`;
}

/** 原始状态（枚举或字符串列）→ 统一状态，与 normalizeDetectTaskStatus 同一张表。 */
export function detectStatusSql(expr: Prisma.Sql): Prisma.Sql {
  const whens = Object.entries(DETECT_RAW_STATUS_MAP).map(
    ([raw, status]) => Prisma.sql`WHEN ${raw} THEN ${status}`,
  );
  return Prisma.sql`(CASE (${expr})::text ${Prisma.join(whens, ' ')} ELSE 'FAILED' END)`;
}

/** 租户条件：explicit 优先（全部租户视角的 ?tenantId=），否则取当前租户范围；都没有时不加条件。 */
export function tenantCondition(column: string, explicitTenantId?: string): Prisma.Sql {
  const tenantId = explicitTenantId ?? currentTenantId();
  return tenantId ? Prisma.sql`AND ${Prisma.raw(column)} = ${tenantId}` : Prisma.empty;
}
