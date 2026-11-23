import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BUILTIN_TAXONOMIES, builtinSetSource, type BuiltinTaxonomyId } from '@lse/shared';
import { api, type BuiltinBankStats } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { BuiltinBankActions } from './BuiltinBankActions';
import { BuiltinQuestionsModal } from './BuiltinQuestionsModal';

export const builtinSource = (id: BuiltinTaxonomyId) => builtinSetSource(id);

/**
 * GB/T 45654-2025 附录 B 对题库的规模要求：A.1、A.2 每个小项不少于 50 题，其余小项不少于 20 题。
 * 依赖：C1 车道的覆盖校验函数（packages/shared/src/standards/bank-coverage.ts）交付后，改为取其结果；
 * 在此之前题数取内置题库统计接口，要求值在此处按附录 B 写死。
 */
export function annexBMinQuestions(minorCode: string): number {
  return minorCode.startsWith('A.1.') || minorCode.startsWith('A.2.') ? 50 : 20;
}

const pct = (n: number, total: number) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%');

function countOf(stats: BuiltinBankStats | undefined, tax: string, major: string, minor?: string) {
  return (stats?.categories ?? [])
    .filter((c) => c.taxonomy === tax && c.major === major && (!minor || c.minor === minor))
    .reduce((a, c) => a + c.count, 0);
}

/** 样本库「内置合规题库」视图：三套分类体系的 大类 → 小类 树、题数、占比与浏览入口。 */
export function BuiltinBankPanel() {
  const [tax, setTax] = useState<BuiltinTaxonomyId>('tc260');
  const [browse, setBrowse] = useState<{ minorCode: string; minor: string } | null>(null);
  const stats = useQuery({
    queryKey: ['question-sets', 'builtin-stats'],
    queryFn: () => api.questionSets.builtinStats(),
  });
  const sets = useQuery({
    queryKey: ['question-sets', 'builtin-list'],
    queryFn: () => api.questionSets.list({ origin: 'builtin', pageSize: 100 }),
  });
  if (stats.isLoading || sets.isLoading) return <LoadingBlock />;
  const taxonomy = BUILTIN_TAXONOMIES.find((t) => t.id === tax)!;
  const set = sets.data?.items.find((s) => s.source === builtinSource(tax));
  const taxTotal = (stats.data?.categories ?? [])
    .filter((c) => c.taxonomy === tax)
    .reduce((a, c) => a + c.count, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          平台内置题库总数：
          <b className="tabular-nums">
            {(stats.data?.builtinQuestionTotal ?? 0).toLocaleString('zh-CN')}
          </b>{' '}
          题
        </span>
        <span className="text-muted-foreground">
          内置题库 {stats.data?.builtinSetCount ?? 0} 个 · 自有题库 {stats.data?.ownSetCount ?? 0}{' '}
          个
        </span>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="分类体系">
        {BUILTIN_TAXONOMIES.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={t.id === tax}
            size="sm"
            variant={t.id === tax ? 'primary' : 'outline'}
            onClick={() => setTax(t.id)}
          >
            {t.name}
          </Button>
        ))}
      </div>
      <div className="rounded-md border p-3 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-3xl text-muted-foreground">{taxonomy.description}</p>
          {/* 附录 A 视图的题数合并了国标三库和合规题库，而这两个按钮只作用于合规题库一个库，放在这里会让人以为用的是全部题。 */}
          {set && tax !== 'tc260' ? <BuiltinBankActions set={set} /> : null}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          本体系 {taxTotal.toLocaleString('zh-CN')} 题 · {taxonomy.majors.length} 大类 ·{' '}
          {taxonomy.majors.reduce((a, m) => a + m.minors.length, 0)} 小类
        </div>
      </div>
      {!set ? (
        <EmptyState title="内置题库尚未初始化" description="请执行数据库 seed 后刷新。" />
      ) : (
        <ul className="space-y-3" aria-label="大类小类树">
          {taxonomy.majors.map((major) => {
            const mc = countOf(stats.data, tax, major.name);
            const short =
              tax === 'tc260'
                ? major.minors.filter(
                    (minor) =>
                      countOf(stats.data, tax, major.name, minor.name) < annexBMinQuestions(minor.code),
                  ).length
                : 0;
            return (
              <li key={major.code} className="rounded-md border">
                <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-sm font-medium">
                  <span>
                    {major.name} <Badge tone="info">内置</Badge>
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {short > 0 && <Badge tone="warning">{short} 项不足</Badge>}
                    <span>
                      {mc.toLocaleString('zh-CN')} 题 · 占比 {pct(mc, taxTotal)}
                    </span>
                  </span>
                </div>
                <ul className="divide-y">
                  {major.minors.map((minor) => {
                    const n = countOf(stats.data, tax, major.name, minor.name);
                    const required = tax === 'tc260' ? annexBMinQuestions(minor.code) : 0;
                    return (
                      <li
                        key={minor.code}
                        className="flex items-center justify-between px-3 py-1.5 pl-6 text-sm"
                      >
                        <span>{minor.name}</span>
                        <span className="flex items-center gap-3 tabular-nums">
                          {required > 0 && (
                            <span className="text-xs text-muted-foreground">
                              附录 B 要求不少于 {required}
                            </span>
                          )}
                          {required > 0 && n < required && (
                            <Badge tone="warning" data-testid={`short-${minor.code}`}>
                              不足
                            </Badge>
                          )}
                          <span>{n.toLocaleString('zh-CN')} 题</span>
                          <span className="w-16 text-right text-muted-foreground">
                            {pct(n, taxTotal)}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setBrowse({ minorCode: minor.code, minor: minor.name })}
                          >
                            浏览题目
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {browse ? <BuiltinQuestionsModal category={browse} onClose={() => setBrowse(null)} /> : null}
    </div>
  );
}
