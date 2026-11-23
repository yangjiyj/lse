export interface EgressPolicy {
  /**
   * 允许外发的 host（含端口，如 '127.0.0.1:41234'）。只放行平台自己的 sink。
   *
   * 安全前提：这里必须放【IP:端口 字面量】，不要放域名——本函数在 DNS 解析之前对
   * `url.host` 做字符串精确匹配。若放域名，无法防 DNS rebinding（串匹配通过、socket
   * 实连到解析后的任意地址）。另注意：host 等于协议默认端口时 WHATWG 会剥离端口
   * （http→':80'、https→':443'），故白名单勿写 ':80'/':443'（会永不匹配，属失败关闭方向）。
   */
  allowHosts: string[];
}

export function isAllowedEgress(rawUrl: string, policy: EgressPolicy): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return policy.allowHosts.includes(url.host);
}
