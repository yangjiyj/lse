# AI 服务安全核验十项门禁报告

- 生成时间：2026-08-31T17:41:25Z
- 总体状态：**MET**
- AIG 引用审计：configured tasks=0; active runs=0; historical runs=3; historical findings=2; relay imports=0.

| 门禁 | 状态 | RC | 检查时间 | 证据 | 说明 |
| --- | --- | ---: | --- | --- | --- |
| 1-误报控制 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/mode-safe.txt` | 普通 API 网关 JSON 负样本为 0 正式风险且无 Triton 误报 |
| 2-正样本 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/mode-deep.txt` | SAFE 配置命中与 DEEP 未授权接口均形成带哈希的正式判断 |
| 3-负样本 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/mode-sbom.txt` | 修复版本 0 正式风险并显式生成 11 条 NOT_AFFECTED |
| 4-证据 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/checksums.sha256` | 三模式正式判断、证据哈希、数据库验证与报告摘要校验通过 |
| 5-三模式 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/vm-business-e2e-rc.txt` | VM 中 SAFE、DEEP、SBOM 真实正负样本执行 RC=0 |
| 6-报告 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/database-verification.json` | 正式 PDF 报告已生成，rawOutput 非空数与同一哨兵命中均为 0 |
| 7-安全 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/logs/final` | gitleaks 56 提交无泄漏；pnpm audit --prod 官方源无已知漏洞 |
| 8-视觉 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/evidence/vm-business/visual-verification.txt` | 桌面与 390x844 Playwright 2/2；console、pageerror、溢出和禁词均为 0 |
| 9-离线 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/logs/remote-x86-offline-acceptance-final-rerun.log` | 同一台隔离 VM 完成旧包新装、重启、升级、断网恢复、故障恢复与再升级 |
| 10-回滚 | MET | 0 | 2026-08-31T17:39:49Z | `/home/user/releases/lse-service-assurance-af3d08c/logs/remote-x86-offline-acceptance-final-rerun.log` | 真实应用回滚保留新 schema 与历史证据计数，随后候选包再升级成功 |

全部门禁满足；仍须单独审批 AIG 代码与运行服务退役，历史数据、日志和卷不得删除。
