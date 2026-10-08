import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { MulterError } from 'multer';

/**
 * @nestjs/platform-express@10.4.22 的 transformException 按 error.message 匹配：
 * multer 2.4.0 把 LIMIT_UNEXPECTED_FILE 文案改成 'Unexpected file field'，
 * 2.2+/2.3+ 新增的 LIMIT_FIELD_NESTING / LIMIT_FIELD_ARRAY_INDEX / INVALID_FIELD_NAME 也不认识，
 * 都会落到默认处理器变 500 + ERROR 堆栈。这里按 code 兜底成 400。
 * LIMIT_FILE_SIZE 文案未变，已被 Nest 转成 PayloadTooLargeException(413)，不会到这里。
 */
const MESSAGES: Record<string, string> = {
  LIMIT_UNEXPECTED_FILE: '上传字段名必须为 file，且一次只能上传一个文件',
  LIMIT_FILE_COUNT: '一次只能上传一个文件',
  LIMIT_PART_COUNT: '表单字段过多',
  LIMIT_FIELD_COUNT: '表单字段过多',
  LIMIT_FIELD_KEY: '表单字段名过长',
  LIMIT_FIELD_VALUE: '表单字段值过长',
  LIMIT_FIELD_NESTING: '表单字段名非法',
  LIMIT_FIELD_ARRAY_INDEX: '表单字段名非法',
  INVALID_FIELD_NAME: '表单字段名非法',
  MISSING_FIELD_NAME: '表单字段名缺失',
};

@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    response.status(HttpStatus.BAD_REQUEST).json({
      success: false,
      statusCode: HttpStatus.BAD_REQUEST,
      message: MESSAGES[String(exception.code)] ?? '上传请求格式错误',
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
