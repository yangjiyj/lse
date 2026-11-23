/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        // 方向 B「澄」设计令牌：主蓝 / 墨色 / 页面底
        brand: {
          50: '#EAF1FF',
          100: '#DCE8FF',
          400: '#7FA6F5',
          500: '#3A74F0',
          600: '#1F57E0',
          700: '#1745B8',
        },
        ink: { DEFAULT: '#0F172A', 2: '#475569', 3: '#5B6778' },
        canvas: '#F4F7FC',
        line: { DEFAULT: '#E4EAF3', 2: '#D5DEEB' },
        // 严重度语义色：文字 / 浅底，对比度均 >= 4.5:1（取自样稿，勿改）
        severity: {
          critical: '#B42318',
          'critical-bg': '#FDECEA',
          high: '#B04A05',
          'high-bg': '#FFF0E3',
          medium: '#8A5F00',
          'medium-bg': '#FFF6D6',
          low: '#4F6B8A',
          'low-bg': '#EAF0F6',
          pass: '#1B7A46',
          'pass-bg': '#E4F5EB',
          unknown: '#46536A',
          'unknown-bg': '#EEF1F5',
        },
        // 辅助文字不得浅于 #5B6778，故把 slate-500 收敛到该值
        slate: { 500: '#5B6778' },
      },
      fontFamily: {
        sans: [
          'PingFang SC',
          'HarmonyOS Sans SC',
          'Microsoft YaHei UI',
          'Microsoft YaHei',
          'Noto Sans CJK SC',
          'Source Han Sans SC',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        num: [
          'Avenir Next',
          'DIN Alternate',
          'Helvetica Neue',
          'Segoe UI',
          'Roboto',
          'system-ui',
          'sans-serif',
        ],
      },
      fontSize: { xs: ['0.78125rem', { lineHeight: '1.125rem' }] },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        card: '18px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,.04), 0 10px 28px -14px rgba(31,87,224,.20)',
        pop: '0 12px 32px -8px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.06)',
        btn: '0 6px 14px -6px rgba(31,87,224,.55)',
      },
    },
  },
  plugins: [],
};
