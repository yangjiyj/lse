import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 开发态：前端 5173 反代 /api → 后端 8090；生产态由 Nginx/Caddy 统一反代。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/sink': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8090',
        changeOrigin: true,
      },
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8090',
        changeOrigin: true,
      },
    },
  },
  // 开发态预构建依赖：vite 6 默认目标含 safari14，而根 package.json 把 esbuild 锁到 0.28.1，
  // 它认为 Safari 14 不支持解构又无法降级，class-variance-authority 等依赖预构建会报错。
  // 与生产构建用同一目标。
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});
