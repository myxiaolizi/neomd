/**
 * 桌面端打包配置。
 * 产物：portable exe（免安装）+ nsis 安装包（含 .md 文件关联）
 */
const path = require('node:path');
const fs = require('node:fs');

const webDist = path.join(__dirname, '..', 'web', 'dist');
const outDir = path.join(__dirname, '..', '..', 'dist-artifacts');

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('[build] 未找到 Web 构建产物，请先执行: pnpm --filter @neomd/web build');
  process.exit(1);
}

module.exports = {
  appId: 'vip.zhengl.neomd',
  productName: 'Neo MD',
  copyright: 'Copyright © 2026 Neo MD',
  directories: {
    output: outDir,
    buildResources: path.join(__dirname, 'build'),
  },
  // 注意：electron-builder 的 files 是显式白名单，主进程 require 的每个「本地」文件都必须列出来。
  // 如果漏加，打包后主进程会以 MODULE_NOT_FOUND 直接启动失败——而开发态（直接跑源码）完全不暴露，
  // 属于"只有发出去的包才炸"的坑。1.1.9 曾漏过 window-utils/window-registry，1.2.0 又新增了 portable.cjs。
  // 白名单与真实 require 的一致性由 tools/verify-119-multiwindow.mjs 的单测 + tools/verify-120-portable.mjs 自动比对。
  files: ['main.cjs', 'preload.cjs', 'window-utils.cjs', 'window-registry.cjs', 'portable.cjs', 'package.json'],
  extraResources: [
    {
      from: webDist,
      // 不能命名为 app：resources/app 目录会遮蔽 resources/app.asar
      to: 'webdist',
    },
  ],
  extraMetadata: {
    main: 'main.cjs',
  },
  asar: true,
  compression: 'maximum',
  win: {
    // 只保留 nsis：绿色版 zip 统一由 build.mjs 从 win-unpacked 打包（单一生产者）。
    // 早先这里同时配了 zip 目标，它产出的文件名与 build.mjs 的 tar 产物完全相同，
    // 结果是同一份 250MB 目录被压两遍、后写的覆盖先写的，白白多花几分钟且让人分不清哪个才是发布物。
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: path.join(__dirname, 'build', 'icon.ico'),
    artifactName: 'NeoMD-${version}-win-${arch}.${ext}',
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Neo MD',
    artifactName: 'NeoMD-${version}-setup.${ext}',
    installerIcon: path.join(__dirname, 'build', 'icon.ico'),
    uninstallerIcon: path.join(__dirname, 'build', 'icon.ico'),
    installerHeaderIcon: path.join(__dirname, 'build', 'icon.ico'),
    deleteAppDataOnUninstall: false,
    menuCategory: false,
    runAfterFinish: true,
  },
  portable: {
    artifactName: 'NeoMD-${version}-portable.${ext}',
  },
  fileAssociations: [
    {
      ext: ['md', 'markdown'],
      name: 'Markdown 文档',
      description: 'Neo MD Markdown 文档',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      role: 'Editor',
    },
  ],
  publish: null,
};
