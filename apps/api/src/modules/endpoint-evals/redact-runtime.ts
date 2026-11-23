/** 面向管理员的文本不得暴露任务专属的接收令牌。 */
export function redactRunSinks(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>\\]*\/sink\/[a-f\d]{48}(?:\/[a-z\d_/%?=&.-]*)?/gi, '受控接收端地址')
    .replace(/\/sink\/[a-f\d]{48}(?:\/[a-z\d_/%?=&.-]*)?/gi, '受控接收端地址');
}
