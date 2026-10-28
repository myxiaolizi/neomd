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
  files: ['main.cjs', 'preload.cjs', 'package.json'],
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
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
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
