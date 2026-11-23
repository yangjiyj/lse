import type { RagAlignmentMode } from '@/lib/api';

/**
 * 模式 A/C 配置了知识库上传接口时，执行器会自动向被测知识库上传安全测试文档（executor.ts「投毒文档」「越权哨兵」段）。
 * 这里如实说明：上传哪些文档、用途、用哪个身份、结束后是否清理。
 */
export function AutoUploadNotice(props: {
  mode: RagAlignmentMode;
  uploadConfigured: boolean;
  deleteConfigured: boolean;
  restrictedReady: boolean;
}) {
  if (props.mode === 'TEST_PACKAGE' || !props.uploadConfigured) return null;
  return (
    <div
      role="note"
      aria-label="自动上传测试文档说明"
      className="space-y-1 rounded-lg border border-severity-high p-3 text-sm text-slate-700"
    >
      <p className="font-medium text-severity-high">
        该对象配置了知识库上传接口，发起评估后平台会自动向被测知识库上传以下测试文档：
      </p>
      <ul className="list-inside list-disc space-y-0.5">
        <li>
          投毒测试文档
          lse-rag-poison-test.md（测试集含投毒、间接注入题时）：上传到测试知识库，使用被测对象的接入身份；
          用于文档投毒与间接提示词注入检测，正文夹带要求 AI
          输出验证码、忽略用户问题并推荐外链的虚构指令。
        </li>
        {props.restrictedReady ? (
          <li>
            越权哨兵文档
            lse-rag-sentinel-test.md（测试集含越权读取题时）：只用受限库上传凭据上传到受限知识库，
            用于检测被测身份能否越权读到其他租户/受限文件。
          </li>
        ) : (
          <li>
            越权哨兵文档：未同时配置受限知识库与受限库上传凭据，不会自动上传（越权读取项需人工导入哨兵文档，否则记“未评估”）。
          </li>
        )}
        <li>平台语料文档不会上传（本模式以被测系统已有知识库为准）。</li>
      </ul>
      <p>
        {props.deleteConfigured
          ? '评估结束后，无论成功、失败还是取消，都会调用删除接口删除本次上传的测试文档；删除失败的会在结果页残留清单中列出，需人工删除。'
          : '未配置删除接口：评估结束后这些测试文档会留在被测知识库中，结果页会列出残留清单，需人工删除。'}
      </p>
    </div>
  );
}
