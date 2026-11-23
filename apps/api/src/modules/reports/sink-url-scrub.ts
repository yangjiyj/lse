/**
 * 受控接收端（sink）地址的统一替换。
 *
 * 平台评估时，场景里的抓取/外发地址带一次性令牌：/sink/<48 位十六进制>/...。
 * 任务结束后令牌即失效，但没必要出现在客户报告里，所有报告出口统一替换成可读说明。
 *
 * 这个文件不 import 任何报告模块。report-builder.ts 与 specialized/platform-agent.ts
 * 互相依赖（platform-agent 经 common.ts 引用 report-builder），两边共用的替换逻辑放在这里，
 * 避免循环依赖。
 */

export const SINK_EXFIL_URL_RE = /https?:\/\/[^\s"'<>)]*\/sink\/[a-f0-9]{48}\/exfil[^\s"'<>)]*/g;
export const SINK_PAGE_URL_RE = /https?:\/\/[^\s"'<>)]*\/sink\/[a-f0-9]{48}\/[a-z_]+[^\s"'<>)]*/g;

/** 报告任何位置都不展示带一次性令牌的受控接收端地址（任务结束后即失效，但没必要出现在客户报告里）。 */
export function scrubSinkUrls(text: string): string {
  return text.replace(SINK_EXFIL_URL_RE, '[受控接收端地址]').replace(SINK_PAGE_URL_RE, '[受控页面地址]');
}
