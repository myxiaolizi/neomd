import type { StorageConfig, StorageProviderId, UrlStyle } from './types';

export interface StoragePreset {
  id: StorageProviderId;
  name: string;
  /** 文档链接 */
  docs: string;
  /** 地域列表，用于下拉 */
  regions: Array<{ id: string; label: string }>;
  /** 由地域推导 endpoint */
  endpointFor(region: string): string;
  urlStyle: UrlStyle;
  /** 是否支持 s3:// 兼容端点（用于统一直连协议） */
  s3Compatible: boolean;
  /** 需要覆盖的默认项 */
  notes?: string;
}

function host(region: string, tpl: string): string {
  return tpl.replace(/\{r\}/g, region);
}

export const STORAGE_PRESETS: StoragePreset[] = [
  {
    id: 'aliyun-oss',
    name: '阿里云 OSS',
    docs: 'https://help.aliyun.com/zh/oss/developer-reference/compatibility-with-amazon-s3',
    regions: [
      { id: 'cn-guangzhou', label: '华南1（广州）' },
      { id: 'cn-shenzhen', label: '华南2（深圳）' },
      { id: 'cn-hangzhou', label: '华东1（杭州）' },
      { id: 'cn-shanghai', label: '华东2（上海）' },
      { id: 'cn-beijing', label: '华北2（北京）' },
      { id: 'cn-zhangjiakou', label: '华北3（张家口）' },
      { id: 'cn-chengdu', label: '西南1（成都）' },
      { id: 'cn-hongkong', label: '中国香港' },
    ],
    endpointFor: (r) => host(r, 'https://s3.oss-{r}.aliyuncs.com'),
    urlStyle: 'virtual-hosted',
    s3Compatible: true,
    notes: '兼容 Amazon S3 协议；公网访问域名与 API 端点分离，私有桶建议填写自定义域名。',
  },
  {
    id: 'tencent-cos',
    name: '腾讯云 COS',
    docs: 'https://cloud.tencent.com/document/product/436/6224',
    regions: [
      { id: 'ap-guangzhou', label: '广州' },
      { id: 'ap-shenzhen', label: '深圳' },
      { id: 'ap-shanghai', label: '上海' },
      { id: 'ap-beijing', label: '北京' },
      { id: 'ap-chengdu', label: '成都' },
      { id: 'ap-hongkong', label: '中国香港' },
    ],
    endpointFor: (r) => `https://cos.${r}.myqcloud.com`,
    urlStyle: 'virtual-hosted',
    s3Compatible: true,
    notes: '支持 S3 兼容接口，签名使用 v5；路径风格在部分地域需强制开启。',
  },
  {
    id: 'volcengine-tos',
    name: '火山引擎 TOS',
    docs: 'https://www.volcengine.com/docs/6349/147050',
    regions: [
      { id: 'cn-guangzhou', label: '华南（广州）' },
      { id: 'cn-beijing', label: '华北（北京）' },
      { id: 'cn-shanghai', label: '华东（上海）' },
      { id: 'cn-hongkong', label: '中国香港' },
    ],
    endpointFor: (r) => `https://tos-s3-${r}.volces.com`,
    urlStyle: 'virtual-hosted',
    s3Compatible: true,
    notes: 'S3 兼容端点使用 tos-s3-<region>.volces.com。',
  },
  {
    id: 'baidu-bos',
    name: '百度云 BOS',
    docs: 'https://cloud.baidu.com/doc/BOS/s/8kxmgmn0p',
    regions: [
      { id: 'gz', label: '广州' },
      { id: 'bj', label: '北京' },
      { id: 'su', label: '苏州' },
      { id: 'hkg', label: '中国香港' },
    ],
    endpointFor: (r) => `https://s3.${r}.bcebos.com`,
    urlStyle: 'virtual-hosted',
    s3Compatible: true,
    notes: 'S3 兼容端点为 s3.<region>.bcebos.com。',
  },
  {
    id: 'jd-cloud',
    name: '京东云对象存储',
    docs: 'https://docs.jdcloud.com/cn/object-storage-service/api/overview',
    regions: [
      { id: 'cn-north-1', label: '华北-北京' },
      { id: 'cn-south-1', label: '华南-广州' },
      { id: 'cn-east-1', label: '华东-宿迁' },
      { id: 'cn-east-2', label: '华东-上海' },
    ],
    endpointFor: (r) => `https://s3.${r}.jdcloud-oss.com`,
    urlStyle: 'virtual-hosted',
    s3Compatible: true,
    notes: '兼容 S3 协议，端点形如 s3.<region>.jdcloud-oss.com。',
  },
  {
    id: 'kingsoft-ks3',
    name: '金山云 KS3',
    docs: 'https://docs.ksyun.com/documents/2326',
    regions: [
      { id: 'BEIJING', label: '北京' },
      { id: 'SHANGHAI', label: '上海' },
      { id: 'GUANGZHOU', label: '广州' },
      { id: 'HONGKONG', label: '中国香港' },
    ],
    endpointFor: (r) => `https://ks3-${r.toLowerCase()}.ksyuncs.com`,
    urlStyle: 'virtual-hosted',
    s3Compatible: true,
    notes: 'KS3 兼容 S3 协议，region 需大写。',
  },
  {
    id: 'custom-s3',
    name: '自定义 S3 / MinIO',
    docs: 'https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html',
    regions: [{ id: 'us-east-1', label: 'us-east-1' }],
    endpointFor: (r) => `https://s3.${r}.amazonaws.com`,
    urlStyle: 'path',
    s3Compatible: true,
    notes: '适用于 AWS S3、MinIO、Cloudflare R2 等标准实现。',
  },
];

export function getStoragePreset(id: StorageProviderId): StoragePreset {
  return STORAGE_PRESETS.find((p) => p.id === id) ?? STORAGE_PRESETS[0]!;
}

export const DEFAULT_BASE_PREFIX = 'mdadmin/';

/** 平台默认桶配置（未登录用户与公共资源使用） */
export const PLATFORM_STORAGE: StorageConfig = {
  provider: 'aliyun-oss',
  endpoint: 'https://s3.oss-cn-guangzhou.aliyuncs.com',
  region: 'cn-guangzhou',
  bucket: 'zhengle',
  accessKeyId: '',
  accessKeySecret: '',
  publicDomain: 'https://mdadmin.zhengl.vip',
  urlStyle: 'virtual-hosted',
  isPrivate: false,
  basePrefix: DEFAULT_BASE_PREFIX,
  useTls: true,
};

export function userPrefix(username: string): string {
  return `us/${username}/`;
}

export function userAssetPrefix(username: string, kind: 'image' | 'backup' | 'other'): string {
  const sub = kind === 'image' ? 'tupian' : kind === 'backup' ? 'bk' : 'ot';
  return `${userPrefix(username)}${sub}/`;
}

export function monthFolder(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}
