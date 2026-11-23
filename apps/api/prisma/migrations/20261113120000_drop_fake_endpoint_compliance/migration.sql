-- 清除历史数据里无出处的「GB/T 45654 智能体检测项：①②④（候选对照）」字样。
-- GB/T 45654-2025 没有「智能体检测项」；终端检查项改为对照 TC260-PG-20266A 附录 A（见标准条款主表）。
-- 只改文本与 JSON 中的这段后缀和 ①②④ 对照数组，不删行、不改结论。

-- 评估结果的回答快照
UPDATE "eval_results"
SET "response" = regexp_replace("response", '\s?GB/T 45654 智能体检测项：[^（]*（候选对照）。?', '', 'g')
WHERE "response" LIKE '%GB/T 45654 智能体检测项%';

-- 风险项证据
UPDATE "findings"
SET "evidence" = regexp_replace("evidence", '\s?GB/T 45654 智能体检测项：[^（]*（候选对照）。?', '', 'g')
WHERE "evidence" LIKE '%GB/T 45654 智能体检测项%';

-- 风险项明细里的 ①②④ 对照数组
UPDATE "findings"
SET "detail" = jsonb_set("detail"::jsonb, '{compliance}', '[]'::jsonb)
WHERE "detail" IS NOT NULL
  AND jsonb_typeof("detail"::jsonb -> 'compliance') = 'array'
  AND ("detail"::jsonb -> 'compliance')::text ~ '[①②③④]';

-- 终端测评题目元数据里的 ①②④ 对照数组
UPDATE "questions"
SET "metadata" = jsonb_set("metadata"::jsonb, '{compliance}', '[]'::jsonb)
WHERE "metadata" IS NOT NULL
  AND jsonb_typeof("metadata"::jsonb -> 'compliance') = 'array'
  AND ("metadata"::jsonb -> 'compliance')::text ~ '[①②③④]';

-- 错题快照
UPDATE "wrong_answers"
SET "modelResponse" = regexp_replace("modelResponse", '\s?GB/T 45654 智能体检测项：[^（]*（候选对照）。?', '', 'g')
WHERE "modelResponse" LIKE '%GB/T 45654 智能体检测项%';

-- 报告正文与摘要快照
UPDATE "reports"
SET "content" = regexp_replace("content", '\s?GB/T 45654 智能体检测项：[^（]*（候选对照）。?', '', 'g')
WHERE "content" LIKE '%GB/T 45654 智能体检测项%';

UPDATE "reports"
SET "summary" = regexp_replace(
      regexp_replace("summary"::text, '\s?GB/T 45654 智能体检测项：[^（]*（候选对照）。?', '', 'g'),
      '"compliance": \[("[①②③④]"(, )?)+\]', '"compliance": []', 'g'
    )::jsonb
WHERE "summary" IS NOT NULL AND "summary"::text ~ '(GB/T 45654 智能体检测项|"compliance": \["[①②③④])';

UPDATE "reports"
SET "listSummary" = regexp_replace("listSummary"::text, '\s?GB/T 45654 智能体检测项：[^（]*（候选对照）。?', '', 'g')::jsonb
WHERE "listSummary" IS NOT NULL AND "listSummary"::text LIKE '%GB/T 45654 智能体检测项%';

-- 任务名与报告标题去掉「符合性」字样：平台出具的是评估报告，不是符合性认证。
UPDATE "eval_tasks" SET "name" = replace("name", 'GB/T 45654 符合性评估', 'GB/T 45654 生成内容安全评估')
WHERE "name" LIKE '%GB/T 45654 符合性评估%';
UPDATE "reports" SET "title" = replace("title", 'GB/T 45654 符合性评估', 'GB/T 45654 生成内容安全评估')
WHERE "title" LIKE '%GB/T 45654 符合性评估%';
