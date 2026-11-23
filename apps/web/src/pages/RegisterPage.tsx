import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { api, ApiError, type LoginStats } from '@/lib/api';
import { DEFAULT_PASSWORD_POLICY, passwordRules, passwordSatisfies } from '@/lib/password-policy';
import { PasswordRuleList } from '@/components/PasswordRuleList';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { BrandLogo } from '@/components/brand/Logo';

const EMPTY = {
  username: '',
  displayName: '',
  phone: '',
  organization: '',
  password: '',
  confirm: '',
};

/** 参数校验失败时取第一条具体原因，否则用接口给的提示。 */
function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return '注册失败，请重试';
  const issues = err.issues;
  if (Array.isArray(issues)) {
    const first = issues.find(
      (i): i is { message: string } => typeof (i as { message?: unknown })?.message === 'string',
    );
    if (first) return first.message;
  }
  return err.message;
}

/** 自助注册（免登录）：提交后待管理员审核。 */
export function RegisterPage() {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // undefined = 还在读；null = 读失败（照常显示表单，由服务端把关）。
  const [stats, setStats] = useState<LoginStats | null | undefined>(undefined);
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const policy = { ...DEFAULT_PASSWORD_POLICY, ...stats?.passwordPolicy };
  const rules = passwordRules(form.password, policy);
  const passwordOk = passwordSatisfies(form.password, policy);

  useEffect(() => {
    let active = true;
    api
      .loginStats()
      .then((res) => {
        if (active) setStats(res);
      })
      .catch(() => {
        if (active) setStats(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm || !passwordOk) return;
    setError(null);
    setLoading(true);
    try {
      await api.register({
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        phone: form.phone.trim(),
        organization: form.organization.trim(),
        password: form.password,
      });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-canvas bg-[radial-gradient(640px_380px_at_8%_6%,#E3EDFF,transparent_70%),radial-gradient(520px_360px_at_100%_100%,#E6F0FF,transparent_70%)]">
      <header className="px-6 py-5 sm:px-14">
        <BrandLogo size={34} nameClassName="text-[17px]" asHeading />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-10">
        <div className="w-full max-w-[480px] rounded-[22px] border border-white/80 bg-white p-10 shadow-[0_24px_60px_-24px_rgba(31,87,224,0.30),0_2px_6px_rgba(15,23,42,0.04)]">
          <h2 className="text-[24px] font-bold leading-tight text-ink">注册账号</h2>
          {stats === undefined ? (
            <LoadingBlock />
          ) : stats && !stats.registrationEnabled ? (
            <div className="mt-7 flex flex-col items-center gap-4 text-center">
              <p className="text-[15px] font-semibold text-ink">未开放注册</p>
              <Link
                to="/login"
                className="text-[13.5px] font-medium text-brand-600 hover:underline"
              >
                返回登录
              </Link>
            </div>
          ) : done ? (
            <div className="mt-7 flex flex-col items-center gap-4 text-center">
              <CircleCheck className="h-10 w-10 text-emerald-600" aria-hidden="true" />
              <p className="text-[15px] font-semibold text-ink">已提交，等待管理员审核</p>
              <Link
                to="/login"
                className="text-[13.5px] font-medium text-brand-600 hover:underline"
              >
                返回登录
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4">
              <Field label="用户名" htmlFor="reg-username" required>
                <Input
                  id="reg-username"
                  autoComplete="username"
                  value={form.username}
                  onChange={set('username')}
                  minLength={3}
                  maxLength={64}
                  required
                />
              </Field>
              <Field label="姓名" htmlFor="reg-name" required>
                <Input
                  id="reg-name"
                  autoComplete="name"
                  value={form.displayName}
                  onChange={set('displayName')}
                  maxLength={32}
                  required
                />
              </Field>
              <Field label="手机号" htmlFor="reg-phone" required>
                <Input
                  id="reg-phone"
                  type="tel"
                  autoComplete="tel"
                  inputMode="numeric"
                  value={form.phone}
                  onChange={set('phone')}
                  maxLength={11}
                  required
                />
              </Field>
              <Field label="单位" htmlFor="reg-org" required>
                <Input
                  id="reg-org"
                  autoComplete="organization"
                  value={form.organization}
                  onChange={set('organization')}
                  maxLength={64}
                  required
                />
              </Field>
              <Field label="密码" htmlFor="reg-password" required>
                <Input
                  id="reg-password"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={set('password')}
                  required
                />
              </Field>
              <PasswordRuleList rules={rules} />
              <Field
                label="确认密码"
                htmlFor="reg-confirm"
                required
                error={mismatch ? '两次输入的密码不一致' : undefined}
              >
                <Input
                  id="reg-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={form.confirm}
                  onChange={set('confirm')}
                  required
                />
              </Field>
              {error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-[10px] bg-severity-critical-bg px-3.5 py-2.5 text-[13.5px] leading-5 text-severity-critical"
                >
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </p>
              )}
              <Button
                type="submit"
                disabled={loading || mismatch || !passwordOk}
                size="lg"
                className="mt-1 h-12 w-full text-[15px]"
              >
                {loading && <Spinner className="h-4 w-4" />}
                注册
              </Button>
              <Link
                to="/login"
                className="text-center text-[13.5px] font-medium text-brand-600 hover:underline"
              >
                返回登录
              </Link>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
