import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Save } from 'lucide-react';
import { api, ApiError, type DataSecuritySettings, type SystemSettings } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import { loadDataSecurity } from '@/lib/data-security';

export const DEFAULT_DATA_SECURITY: DataSecuritySettings = {
  maskSensitive: true,
  downloadWatermark: true,
  pageWatermark: true,
};

const FIELDS: Array<{ key: keyof DataSecuritySettings; label: string; hint: string }> = [
  {
    key: 'maskSensitive',
    label: '敏感个人信息默认脱敏',
    hint: '手机号、身份证号、邮箱、银行卡号、姓名默认脱敏展示；有「查看敏感信息明文」权限者可查看明文，查看操作记入操作日志',
  },
  {
    key: 'downloadWatermark',
    label: '下载文件添加水印',
    hint: '报告 PDF、风险样本/模板 Excel、CSV、JSON 附带「平台标题 下载人 下载时间」水印；下载日志始终记录',
  },
  {
    key: 'pageWatermark',
    label: '前端页面水印',
    hint: '页面叠加「用户名 + 时间」浅色水印',
  },
];

/** 平台设置 →「数据安全」：脱敏、下载水印、页面水印开关（默认全部开启）。 */
export function DataSecurityCard({ canUpdate }: { canUpdate: boolean }) {
  const { success, error: toastError } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.systemSettings.get(),
  });
  const [form, setForm] = useState<DataSecuritySettings>(DEFAULT_DATA_SECURITY);

  useEffect(() => {
    if (query.data?.data_security) setForm(query.data.data_security);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.systemSettings.update({ data_security: form }),
    onSuccess: (res: SystemSettings) => {
      queryClient.setQueryData(['system-settings'], res);
      if (res.data_security) setForm(res.data_security);
      void loadDataSecurity(true);
      success('数据安全设置已保存');
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '保存失败'),
  });

  if (query.isLoading) return <LoadingBlock label="正在加载数据安全设置…" />;

  const updatedAt = query.data?.updatedAt.data_security;
  return (
    <Card id="data-security" className="scroll-mt-5 rounded-none border-0 shadow-none">
      <CardHeader className="border-b border-line pb-4">
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-primary" />
          <CardTitle>数据安全</CardTitle>
          <Badge tone="success">已启用</Badge>
        </div>
        <p className="text-sm text-ink-3">
          1.系统前端展示敏感个人信息时须默认进行脱敏处理。2.系统前端提供文件下载服务时，须对下载文件添加水印，并保留下载日志用于审计。
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {!canUpdate ? (
          <div className="rounded-md border border-amber-200 bg-severity-medium-bg px-3 py-2 text-sm text-severity-medium">
            当前账号没有权限修改数据安全设置，以下为只读展示。
          </div>
        ) : null}
        {FIELDS.map((f) => (
          <label key={f.key} className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              checked={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
              disabled={!canUpdate}
            />
            <span>
              <span className="font-medium text-ink">{f.label}</span>
              <span className="block text-xs text-ink-3">{f.hint}</span>
            </span>
          </label>
        ))}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            aria-label="保存数据安全设置"
            onClick={() => save.mutate()}
            disabled={!canUpdate || save.isPending}
          >
            {save.isPending ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            保存配置
          </Button>
          {updatedAt ? (
            <span className="text-xs text-ink-3">最近更新：{formatDateTime(updatedAt)}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
