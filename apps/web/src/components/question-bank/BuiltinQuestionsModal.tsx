import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { seedBankTitle } from './seed-bank-meta';

const PAGE_SIZE = 20;

/** 题目所属题库的短名：国标三库用短名，其余取名称「·」前一段（如「内置合规题库」）。 */
const bankTag = (name: string, source: string | null) => seedBankTitle(name, source).split(' · ')[0]!;

/** 浏览某内置小类下的题目（只读），与小类题数同口径：跨在用内置库列出，每题标所属题库。 */
export function BuiltinQuestionsModal({
  category,
  onClose,
}: {
  category: { minorCode: string; minor: string };
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['question-sets', 'builtin-browse', category.minorCode, page],
    queryFn: () => api.questionSets.builtinBrowse({ minor: category.minorCode, page, pageSize: PAGE_SIZE }),
  });
  const items = q.data?.items ?? [];
  return (
    <Modal open onClose={onClose} size="lg" title={`浏览题目 · ${category.minor}`}>
      {q.isLoading ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState title="暂无题目" description="该小类下还没有题目。" />
      ) : (
        <>
          <ol
            start={(page - 1) * PAGE_SIZE + 1}
            className="list-decimal space-y-2 pl-6 text-sm"
            aria-label="题目列表"
          >
            {items.map((x) => (
              <li key={x.id} className="whitespace-pre-wrap break-words">
                <Badge tone="neutral" className="mr-2 align-middle">
                  {bankTag(x.setName, x.setSource)}
                </Badge>
                {x.content}
              </li>
            ))}
          </ol>
          <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onPageChange={setPage} />
        </>
      )}
    </Modal>
  );
}
