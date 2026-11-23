# Platform-to-LSE service boundary

Source: e184916d69f795979064897fc2ee7a70fb4b7d8b.
Status: source implementation only. NOT DEPLOYED. No identity or secret created.
Existing evaluation/scanning engines remain unchanged. Ordinary users keep existing behavior.

## Requested operator approval, after isolated validation deployment

Target system: isolated LSE connector validation API 18481/web 15481, fresh dedicated
database on 55466 and Redis 16386 under a separate validation directory.
Do not upgrade existing production LSE or copy production data, secrets or license.
Apply native migrations including 20261001010000_platform_connector_boundary.
Create one non-builtin active service identity with username agent-platform-lse,
and one role named platform_connector; attach only this role to that identity.
Grant exactly:
- platform_connector:restricted
- model_target:read
- model_target:create
- eval_task:read
- eval_task:create
- report:read
- report:generate
- remediation:update

Optional remediation:read only if the client requires GET /api/remediation/:findingId.
Task Findings are already available via GET /api/eval-tasks/:id/findings.
No user/person, role management, billing, licensing, system-settings, report download,
sensitive-plaintext or report-delete privilege. Do not assign admin/super_admin.
Store generated credentials only in controlled host-local runtime secret files; never
return them to chat. Platform receives its own LSE identity, never a gateway admin token.
Account bootstrap must use a documented/native controlled admin path reviewed by operator;
this patch does not invent a bootstrap bypass or relax authentication policies.

## Enforced data scope

Marker OR dedicated role name triggers the server-side authenticate preHandler boundary.
It cannot be bypassed by adding ordinary permissions or setting the builtin flag.
Only explicitly enumerated routes are permitted. DELETE, global summaries/trends, unknown
new routes and admin APIs fail closed. Existing permission and license checks still apply.

Lists of tasks and targets use createdById = service user ID; reports use task.createdById.
By-ID reads, run target references, report source/review references, Finding references,
remediation retest links and nested adaptive attacker references require exact ownership.
Null-owned legacy records are excluded. Target creation is limited to AGENT_API,
PUBLIC_AGENT and MCP_OPENAPI. A connector cannot create a global system JUDGE target.
Unspecified adaptive attacker configuration is disabled for connector runs, avoiding use
of another user's global configured attacker. Normal engine-configured judging remains
part of the existing evaluation engine and is not exposed as a connector-readable target.

Reports can be generated/read only for service-owned tasks; report:generate does not
authorize DELETE for this identity. No cross-product database access is introduced.

## Validation and rollback

pnpm install --offline --frozen-lockfile
pnpm db:generate
pnpm --filter @lse/api typecheck
cd apps/api && node --import tsx --test test/platform-connector-access.test.ts

Unit/Fastify tests use in-memory ownership records, do not access production DB.
Live identity, persistent role grants, real engine execution and migration deployment:
NOT RUN, awaiting isolated deployment/identity authorization. Never claim these as passed.

Do not roll running production backward. For isolated release rollback, stop only the
new instance and return to its previous artifact/configuration. Disable the service
identity before rollback; retain migration ledger and ownership records. Marker row is
additive and must not be removed while any service identity remains active.

共享权限目录明确声明restricted marker，roles API与permissions manifest可识别。内置admin的全权限集合排除此限制marker，保持普通管理员原行为；服务角色与admin混合仍按服务边界失败关闭。
