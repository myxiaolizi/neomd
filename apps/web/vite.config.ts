import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [vue()],
  // 网页版由服务端在根路径托管；桌面/安卓由自定义协议或本地服务器在根路径托管，
  // 因此统一使用绝对路径，保证 /s/:token 这类多级路由下资源仍可正确解析。
  base: '/',
  resolve: {
    alias: [
      { find: '@neomd/ui/styles.css', replacement: resolve(root, '../../packages/ui/src/styles/index.css') },
      { find: '@neomd/ui/content.css', replacement: resolve(root, '../../packages/ui/src/styles/content.css') },
      { find: '@neomd/core', replacement: resolve(root, '../../packages/core/src/index.ts') },
      { find: '@neomd/shared', replacement: resolve(root, '../../packages/shared/src/index.ts') },
      { find: '@neomd/ui', replacement: resolve(root, '../../packages/ui/src/index.ts') },
      { find: '@', replacement: resolve(root, 'src') },
    ],
  },
  server: {
    port: 5178,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3200', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
    /*
     * 模块预加载（1.1.8 启动极速化）。
     *
     * 默认 Vite 会给入口 chunk 的**所有静态依赖**注入 `<link rel="modulepreload">`，
     * 即使某个 chunk 在首屏用不到也会被预下载。这里把判断权交给自定义函数：
     * 首屏必需的 chunk 预加载，懒加载的大块（编辑器内核 / 图编辑器 / 后台）不预加载，
     * 等真正 `import()` 时再拉，避免白抢带宽与主线程解析时间。
     */
    modulePreload: {
      polyfill: false,
      resolveDependencies(_filename, deps) {
        // 首屏必需：运行时框架、编辑器内核、主入口
        const EAGER = /(^|\/)(vendor|editor|codemirror|index|EditorPage)-/;
        // 明确懒加载的大块：不预取
        const LAZY = /(^|\/)(SettingsPage|AdminPage|PluginCenter|AiPanel|FlowchartEditor|MindmapEditor|AccountPage|MarketingHome)-/;
        return deps.filter((dep) => {
          if (LAZY.test(dep)) return false;
          if (EAGER.test(dep)) return true;
          // 其余小块保持默认（预加载），避免过度保守拖慢首屏
          return true;
        });
      },
    },
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
      },
      output: {
        manualChunks: {
          // 运行时框架：几乎所有页面都要，独立成块便于长期缓存
          vendor: ['vue', 'vue-router', 'pinia'],
          // 编辑器内核：首屏要用，但体积大，单独成块
          editor: ['@tiptap/core', '@tiptap/starter-kit', '@tiptap/vue-3'],
          // CodeMirror（源码模式）与 TipTap（所见即所得）互斥，拆开可并行下载
          codemirror: ['@codemirror/view', '@codemirror/state', '@codemirror/lang-markdown'],
        },
      },
    },
    cssCodeSplit: true,
    sourcemap: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
  },
});
