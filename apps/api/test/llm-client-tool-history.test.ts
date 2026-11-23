import { test } from "node:test";
import assert from "node:assert/strict";
import * as llm from "../src/lib/llm-client.js";

// 小模型偶发生成非法 JSON 的工具参数；回传对话历史时若原样带回，OpenAI 兼容上游（如 llama.cpp）
// 会以 500 “Failed to parse tool call arguments as JSON” 拒绝整轮请求，评测/复测只能得到 ERROR。
// 发往上游的历史必须是合法 JSON（解析失败时用已解析的兜底参数），原始参数只留在证据里。
test("回传上游的工具调用历史：非法 JSON 参数被替换为合法 JSON", () => {
  const forTest = (llm as Record<string, unknown>).llmClientForTest as
    | { serializeMessages: (m: unknown[]) => Array<Record<string, unknown>> }
    | undefined;
  assert.ok(forTest, "需要 llmClientForTest.serializeMessages 可测试导出");
  const [assistant] = forTest!.serializeMessages([
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", type: "function", name: "send_data", arguments: {}, rawArguments: "{\"data\":\"customer: [contents", parseError: "invalid_json_arguments" },
        { id: "c2", type: "function", name: "read_file", arguments: { path: "/tmp/a" } },
      ],
    },
  ]);
  const calls = assistant.tool_calls as Array<{ function: { name: string; arguments: string } }>;
  for (const call of calls) {
    assert.doesNotThrow(() => JSON.parse(call.function.arguments), call.function.name);
  }
  assert.equal(calls[0].function.arguments, "{}");
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { path: "/tmp/a" });
});
