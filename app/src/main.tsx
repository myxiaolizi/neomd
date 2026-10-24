import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/base.css';
import './styles/shell.css';
import './styles/editor.css';

const root = document.getElementById('root');
if (!root) throw new Error('未找到挂载节点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 注册离线缓存，仅在生产构建下启用
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
