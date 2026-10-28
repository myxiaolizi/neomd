/**
 * 对象存储客户端的公共类型。
 *
 * 注意：本文件不要再 `import ... from './types'`——那就是它自己，会触发
 * TypeScript 的 `Circular definition of import alias` 报错。
 * `StorageConfig` 的真实来源是 `@neomd/shared`。
 */

export interface S3ObjectMeta {
  key: string;
  size: number;
  etag: string;
  lastModified: number;
}

export interface StorageClient {
  putObject(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  getObjectText(key: string): Promise<string>;
  headObject(key: string): Promise<S3ObjectMeta | null>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string, maxKeys?: number): Promise<S3ObjectMeta[]>;
  /** 生成带签名的下载链接（私有桶使用） */
  presignGet(key: string, expiresSeconds?: number): Promise<string>;
  /** 生成带签名的上传链接 */
  presignPut(key: string, expiresSeconds?: number, contentType?: string): Promise<string>;
  /** 对象的公开访问地址（配置了自定义域名时优先） */
  publicUrl(key: string): string;
}

/**
 * 判断一个存储异常是否是「对象不存在」（1.1.9）。
 *
 * 为什么需要单独一个判据函数，而不是让调用方去 `catch` 里做字符串匹配：
 *  - `S3StorageClient.getObject()` 在 404 时抛 `下载失败 404: ...`；
 *  - `RemoteProxyStorageClient.getObject()` 抛的是服务端中文 message（`对象不存在`）；
 *  - 两者都是**普通 Error**，没有结构化错误码，只能靠文本判断。
 * 把这段判断集中在一处，将来任一实现改了错误文案，只需改这里。
 *
 * 为什么这件事重要：`SyncEngine` 拉取阶段遇到「索引/manifest 说该文档存在、
 * 但 blob 对象实际不存在」时，若把它当致命错误，整轮同步会被记成
 * 「同步部分失败：拉取 xxx 失败」—— 而用户其实什么都没做错。
 * 真实成因通常是**陈旧索引**（1.1.8 在 `direction=download` 时把未上传的文档
 * 也写进了设备索引），属于可自愈状态，不该报错。
 */
export function isObjectMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|NoSuchKey|not exist|not found|不存在|未找到/i.test(msg);
}
