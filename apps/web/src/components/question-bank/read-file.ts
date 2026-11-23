/** 读取用户选择的文本文件（UTF-8）。用 FileReader 而不是 File.text()，兼容老浏览器与测试环境。 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}
