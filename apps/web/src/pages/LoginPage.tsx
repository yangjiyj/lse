import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CircleAlert,
  FileCheck2,
  Info,
  Lock,
  ScanSearch,
  ShieldCheck,
  Swords,
  User,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api, ApiError, type LoginStats } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { BrandLogo } from '@/components/brand/Logo';
import { SupportContact } from '@/components/brand/SupportContact';

const FEATURES = [
  { icon: ShieldCheck, label: '内容安全评估' },
  { icon: Swords, label: '多轮对抗演练' },
  { icon: FileCheck2, label: '合规专项检测' },
  { icon: ScanSearch, label: 'AI 组件漏洞扫描' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('reason') === 'idle'
      ? '长时间未操作，已超时登出，请重新登录'
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<LoginStats | null>(null);

  // 先计这次访问再取统计，页面上的数字包含本次访问。
  useEffect(() => {
    let active = true;
    api
      .recordVisit()
      .catch(() => undefined)
      .then(() => api.loginStats())
      .then((res) => {
        if (active) setStats(res);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请重试');
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
        <div className="flex w-full max-w-[1120px] items-center justify-center gap-16 lg:justify-between">
          <section className="hidden max-w-[640px] lg:block">
            <p className="text-[42px] font-bold leading-[1.3] tracking-[0.01em] text-ink">
              大模型上线前
              <br />
              <span className="text-brand-600">安全评估</span>与审计
            </p>
            <p className="mt-5 text-[15.5px] leading-7 text-ink-3">
              覆盖内容安全评估、多轮对抗演练、合规专项检测与 AI 组件漏洞扫描，每次上线有据可查。
            </p>
            <ul className="mt-7 flex flex-wrap gap-3">
              {FEATURES.map(({ icon: Icon, label }) => (
                <li
                  key={label}
                  className="flex items-center gap-2 rounded-full border border-white bg-white px-3.5 py-2 text-[13.5px] font-semibold text-ink shadow-card"
                >
                  <Icon className="h-4 w-4 text-brand-600" aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
          </section>
          <div className="w-full max-w-[440px] rounded-[22px] border border-white/80 bg-white p-10 shadow-[0_24px_60px_-24px_rgba(31,87,224,0.30),0_2px_6px_rgba(15,23,42,0.04)]">
            <h2 className="text-[24px] font-bold leading-tight text-ink">登录平台</h2>
            <p className="mt-1.5 text-[13.5px] text-ink-3">请使用平台账号登录</p>
            <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-5">
              <Field label="用户名" htmlFor="username">
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />
                  <Input
                    id="username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    className="h-11 bg-white pl-10"
                  />
                </div>
              </Field>
              <Field label="密码" htmlFor="password">
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="h-11 bg-white pl-10"
                  />
                </div>
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
                disabled={loading}
                size="lg"
                className="h-12 w-full text-[15px]"
              >
                {loading && <Spinner className="h-4 w-4" />}
                登录
              </Button>
              {stats?.registrationEnabled && (
                <Link
                  to="/register"
                  className="-mt-1 text-center text-[13.5px] font-medium text-brand-600 hover:underline"
                >
                  注册
                </Link>
              )}
            </form>
            <p className="mt-5 flex items-start gap-2 rounded-[10px] bg-canvas px-3.5 py-3 text-[12.5px] leading-5 text-ink-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>账号由平台管理员分配；忘记账号或密码，请联系平台管理员。</span>
            </p>
          </div>
        </div>
      </main>
      <footer className="px-6 pb-6 text-center text-[12.5px] text-ink-3">
        {stats?.visits && stats.downloads && (
          <p className="mb-1.5 tabular-nums">
            <span>
              今日访问 {formatNumber(stats.visits.today)} · 累计 {formatNumber(stats.visits.total)}
            </span>
            <span className="mx-3 text-line-2">|</span>
            <span>
              今日下载 {formatNumber(stats.downloads.today)} · 累计{' '}
              {formatNumber(stats.downloads.total)}
            </span>
          </p>
        )}
        GB/T 45654—2025 生成式人工智能服务安全基本要求<span className="mx-3 text-line-2">|</span>
        私有化部署，操作全程留痕
        <SupportContact className="mt-1.5" />
      </footer>
    </div>
  );
}
