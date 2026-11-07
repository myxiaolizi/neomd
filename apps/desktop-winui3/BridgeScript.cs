using System;

namespace NeoMD.WinUI3;

/// <summary>
/// 注入到每个文档创建时的脚本（首帧前执行，早于 index-*.js）。
/// 桥实现全部走 fetch('/__bridge/{method}', POST)，避免 WebView2 的 AddHostObjectToScript COM 坑。
/// </summary>
internal static class BridgeScript
{
    public static string Build() => Script;

    private const string Script = """
    (() => {
      const VERSION = '2.2.0';
      function notImpl() { return Promise.reject(new Error('NOT_IMPLEMENTED')); }

      async function call(method, ...args) {
        const res = await fetch('/__bridge/' + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        const j = await res.json();
        if (j && j.ok === true) return j.value;
        throw new Error((j && j.error) || ('bridge call failed: ' + method));
      }

      const fs = {
        readText: (p) => call('fs.readText', p),
        readBinary: async (p) => {
          const b64 = await call('fs.readBinary', p);
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        },
        writeText: (p, c) => call('fs.writeText', p, c),
        writeBinary: (p, d) => {
          const bytes = (d instanceof Uint8Array) ? d : new Uint8Array(d);
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          return call('fs.writeBinary', p, btoa(bin));
        },
        mkdirp: (p) => call('fs.mkdirp', p),
        remove: (p) => call('fs.remove', p),
        rename: (a, b) => call('fs.rename', a, b),
        list: (p) => call('fs.list', p),
        exists: (p) => call('fs.exists', p),
        stat: (p) => call('fs.stat', p),
      };

      const dialog = {
        pickDirectory: () => call('dialog.pickDirectory'),
        pickFile: (f) => call('dialog.pickFile', f || []),
        saveFile: (n) => call('dialog.saveFile', n),
      };

      const paths = {
        documents: () => call('paths.documents'),
        userData: () => call('paths.userData'),
        vaultDefault: () => call('paths.vaultDefault'),
      };

      const app = {
        version: () => call('app.version'),
        onOpenFile: (cb) => { /* 同步 void 注册；WinUI3 壳当前无文件关联推送源，保留签名 */ },
      };

      const shell = {
        openExternal: (u) => call('shell.openExternal', u),
        showItemInFolder: (p) => call('shell.showItemInFolder', p),
      };

      const win = {
        isMaximized: () => call('win.isMaximized'),
        toggleMaximize: () => call('win.toggleMaximize'),
        minimize: () => call('win.minimize'),
        close: () => call('win.close'),
        // 2.1.0：WebView2 不认 CSS 的 -webkit-app-region: drag，
        // 页面在标题栏按下时改调它，由原生侧发起系统拖动。
        startDrag: () => call('win.startDrag'),
      };

      const secrets = {
        encrypt: (p) => call('secrets.encrypt', p),
        decrypt: (c) => call('secrets.decrypt', c),
      };

      window.NeoMD = {
        env: 'desktop',
        version: VERSION,
        bridge: { fs, dialog, paths, app, shell, win, secrets },
      };

      // 首帧即向宿主上报环境，C# 落盘 data/boot.json 作为"注入已生效"证据
      try {
        fetch('/__bridge/app.ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([location.href, window.NeoMD.env, window.NeoMD.version])
        }).catch(function () {});
      } catch (e) {}
    })();
    """;
}