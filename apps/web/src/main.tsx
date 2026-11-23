import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { loadBranding } from './lib/branding';

// 租户信息设置：尽早拉取平台标题与页签logo，避免页签先闪默认值。
void loadBranding();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('未找到 #root 挂载点');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
