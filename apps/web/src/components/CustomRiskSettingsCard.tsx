import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMPLIANCE_RISK_CATEGORIES, COMPLIANCE_RISK_CATEGORY_LABELS } from '@lse/shared';
import { api, ApiError, type CustomRiskRule } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** 招标口径的 8 类风险类别（不含平台扩展的敏感信息泄露 / 自定义风险内容）。 */
const BID_CATEGORIES = COMPLIANCE_RISK_CATEGORIES.slice(0, 8);
const SEVERITY_OPTIONS = [
  ['CRITICAL', '严重（高风险）'],
  ['HIGH', '高（高风险）'],
  ['MEDIUM', '中（中风险）'],
  ['LOW', '低（低风险）'],
] as const;

const splitList = (text: string) =>
  text
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** 参数7：内置判定引擎说明 + 自定义风险内容的合规性扫描与对抗性模糊评估。 */
export function CustomRiskSettingsCard({
  canUpdate,
  canGenerate,
}: {
  canUpdate: boolean;
  canGenerate: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['custom-risks'], queryFn: () => api.engines.customRisks() });
  const [rules, setRules] = useState<CustomRiskRule[]>([]);
  useEffect(() => {
    if (query.data) setRules(query.data.items);
  }, [query.data]);

  const patch = (id: string, change: Partial<CustomRiskRule>) =>
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...change } : r)));

  const save = useMutation({
    mutationFn: () => api.engines.saveCustomRisks({ items: rules }),
    onSuccess: () => {
      toast.success('自定义风险内容已保存');
      qc.invalidateQueries({ queryKey: ['custom-risks'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });
  const fuzz = useMutation({
    mutationFn: () =>
      api.engines.fuzzCustomRisks({
        ruleIds: rules.filter((r) => r.enabled).map((r) => r.id),
        questionSetName: `自定义风险内容对抗性模糊评估 ${new Date().toLocaleDateString('zh-CN')}`,
      }),
    onSuccess: (res) => {
      toast.success(`已生成 ${res.items.length} 道对抗性模糊评估题目并导入题库`);
      qc.invalidateQueries({ queryKey: ['question-sets'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '生成失败'),
  });

  return (
    <Card className="rounded-none border-0 shadow-none">
      <CardHeader className="border-b border-line pb-4">
        <CardTitle>内置判定引擎与自定义风险内容</CardTitle>
        <CardDescription>
          内置判定引擎（规则判定、敏感信息检测、自定义风险内容扫描）不依赖外部商业模型，即可在内网环境完成攻击评估与风险检测；
          支持基础合规性扫描和对抗性模糊评估，每条发现输出高、中、低风险结论，关联国家现行法律法规并保留评估理由。
        </CardDescription>
        <div className="flex flex-wrap gap-1.5 pt-1" aria-label="覆盖风险类别">
          {BID_CATEGORIES.map((c) => (
            <Badge key={c} tone="info">
              {COMPLIANCE_RISK_CATEGORY_LABELS[c]}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-5">
        <p className="text-xs leading-5 text-ink-3">
          支持自定义风险内容的合规性扫描和对抗性模糊评估（大小写、同音、拆字、编码变换）。启用后对后续评估任务的每条回答生效；
          正则长度不超过 200 字符、禁止嵌套量词，并在执行期限时防止回溯（ReDoS）。
        </p>
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="space-y-2 rounded-md border border-border p-3"
            aria-label={rule.name}
          >
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={!canUpdate}
                  aria-label={`启用${rule.name}`}
                  onChange={(e) => patch(rule.id, { enabled: e.target.checked })}
                />
                {rule.name}
              </label>
              <Select
                aria-label={`${rule.name}风险等级`}
                value={rule.severity}
                disabled={!canUpdate}
                className="h-8 w-40"
                onChange={(e) =>
                  patch(rule.id, { severity: e.target.value as CustomRiskRule['severity'] })
                }
              >
                {SEVERITY_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-muted-foreground">{rule.description}</span>
            </div>
            <Input
              aria-label={`${rule.name}关键词`}
              placeholder="关键词（逗号分隔）"
              value={rule.keywords.join('，')}
              disabled={!canUpdate}
              onChange={(e) => patch(rule.id, { keywords: splitList(e.target.value) })}
            />
            <Textarea
              aria-label={`${rule.name}正则`}
              rows={2}
              placeholder="正则（每行一条）"
              value={rule.patterns.join('\n')}
              disabled={!canUpdate}
              onChange={(e) =>
                patch(rule.id, { patterns: e.target.value.split('\n').filter(Boolean) })
              }
            />
            <div className="text-xs text-muted-foreground">
              示例：{rule.examples.join('；') || '无'}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canUpdate || save.isPending} onClick={() => save.mutate()}>
            保存自定义风险内容
          </Button>
          <Button
            variant="outline"
            disabled={!canGenerate || fuzz.isPending || !rules.some((r) => r.enabled)}
            onClick={() => fuzz.mutate()}
            title="基于已启用规则的示例生成大小写 / 同音 / 拆字 / 编码变体，导入为自有题库"
          >
            生成对抗性模糊评估题目
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
