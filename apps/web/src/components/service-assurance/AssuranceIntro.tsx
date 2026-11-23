/** 核验方式的名称与说明，供页首与发起表单的方式选择卡共用。 */
export const ASSURANCE_MODES = [
  {
    key: 'SAFE',
    name: '基础检查',
    detail:
      '仅发送只读、低频的探测请求，识别服务暴露面、响应防护配置与可识别组件的已知漏洞；不修改目标数据，对业务影响低。',
  },
  {
    key: 'DEEP',
    name: '基础及附加授权检查',
    detail:
      '在基础检查之上增加受控的主动验证请求（如管理状态接口未授权访问、接口主动检查），可能触发目标侧安全告警；须事先取得目标所有方的主动核验授权，并在发起时逐次确认。',
  },
  {
    key: 'SBOM',
    name: '组件清单核验',
    detail:
      '上传 CycloneDX 或 SPDX 格式的组件清单（SBOM），在平台内离线匹配固定版本的漏洞库，不访问任何远程目标。',
  },
] as const;

export function AssuranceIntro() {
  return (
    <section
      aria-label="核验说明"
      className="rounded-card border border-line bg-white px-5 py-3.5 text-sm leading-6 text-ink-2 shadow-card"
    >
      对 AI
      服务地址做暴露面与已知漏洞核验，或离线核对组件清单。可独立发起，无需预先创建评估任务；需要纳入某个评估任务的汇总报告时，再在核验记录上关联该任务。
    </section>
  );
}
