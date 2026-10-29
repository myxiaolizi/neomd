export const APP_NAME = 'Neo MD';
export const APP_VERSION = '1.2.0';
export const IS_PROD = import.meta.env.PROD;
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';
export const SITE_URL = 'https://md.zhengl.vip';

/**
 * 下载走服务端重定向到对象存储（大文件不占用云服务器带宽）。
 * /api/download/:file 由后端签名后 302 到 OSS。
 */
export const DOWNLOAD_WINDOWS_ZIP = '/api/download/NeoMD-1.2.0-win-x64.zip';
export const DOWNLOAD_WINDOWS_SETUP = '/api/download/NeoMD-1.2.0-setup.exe';
export const DOWNLOAD_ANDROID = '/api/download/NeoMD-1.2.0.apk';

export interface DownloadEntry {
  file: string;
  title: string;
  desc: string;
  platform: 'windows' | 'android' | 'web';
  primary?: boolean;
  url: string;
}

export const DOWNLOADS: DownloadEntry[] = [
  {
    file: 'NeoMD-1.2.0-win-x64.zip',
    title: 'Windows x64 绿色版',
    desc: '解压即用，不写注册表，适合放 U 盘或移动硬盘',
    platform: 'windows',
    primary: true,
    url: DOWNLOAD_WINDOWS_ZIP,
  },
  {
    file: 'NeoMD-1.2.0-setup.exe',
    title: 'Windows x64 安装包',
    desc: '注册 .md 文件关联，双击笔记直接打开',
    platform: 'windows',
    url: DOWNLOAD_WINDOWS_SETUP,
  },
  {
    file: 'NeoMD-1.2.0.apk',
    title: 'Android APK',
    desc: '手机与平板通用，支持从文件管理器导入',
    platform: 'android',
    primary: true,
    url: DOWNLOAD_ANDROID,
  },
];
