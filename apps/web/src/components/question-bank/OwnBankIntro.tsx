import { NoteBox } from '@/components/page-kit/NoteBox';

/** 「自有样本库」页签顶部说明：是什么、三种来源及适用场景。 */
export const OWN_BANK_ACTION_HINTS = {
  import: '导入样本库：上传 Excel/CSV 文件，把你已有的测试题变成样本库。',
  benchmark: '评估基准：从平台自带的公开评估基准样例中导入题目，适合快速验证流程。',
  attackSeed: '攻击种子泛化：给一条攻击思路，由模型改写扩展成一批变体样本，适合补充红队题。',
  customerData: '客户数据生成：按客户业务字段生成数据泄露类测试样本，适合做数据防泄漏评估。',
} as const;

export function OwnBankIntro() {
  return (
    <NoteBox tone="info" className="mb-4">
      <p>自有样本库是你自己建立、可以随时修改的测试题集合，评估任务可以直接选用。三种来源：</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>导入文件：已有 Excel/CSV 题库时使用，最直接。</li>
        <li>攻击种子泛化：只有少量攻击思路、需要扩成一批变体时使用。</li>
        <li>客户数据生成：要检查模型会不会泄露客户业务数据时使用。</li>
      </ul>
    </NoteBox>
  );
}
