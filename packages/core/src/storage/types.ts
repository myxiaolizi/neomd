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
