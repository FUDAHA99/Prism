import { ConfigService } from '@nestjs/config';

export const DEFAULT_UPLOAD_MAX_SIZE = 10 * 1024 * 1024; // 10MB
// nginx client_max_body_size 为 12M，留出 multipart 头部余量，后端上限不得超过它
export const UPLOAD_MAX_SIZE_CEILING = 11 * 1024 * 1024;

/**
 * 读取 configuration.ts 已 parseInt 过的 app.upload.maxSize。
 * 不要读 'UPLOAD_MAX_SIZE'：ConfigService 对原始 env 返回字符串，
 * multer 2.4 的 validateLimits 遇到字符串会在启动时直接抛 TypeError。
 */
export function resolveUploadMaxSize(config: ConfigService): number {
  const v = config.get<number>('app.upload.maxSize', DEFAULT_UPLOAD_MAX_SIZE);
  if (!Number.isInteger(v) || v <= 0 || v > UPLOAD_MAX_SIZE_CEILING) {
    throw new Error(
      `UPLOAD_MAX_SIZE 非法: ${v}（需为 1..${UPLOAD_MAX_SIZE_CEILING} 的整数字节数，且不能超过 nginx client_max_body_size）`,
    );
  }
  return v;
}
