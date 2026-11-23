export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code = 'ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, message, code, details);
export const unauthorized = (message = '未认证或登录已失效', code = 'UNAUTHORIZED') =>
  new AppError(401, message, code);
export const forbidden = (message = '无访问权限', code = 'FORBIDDEN', details?: unknown) =>
  new AppError(403, message, code, details);
/** 缺少权限时的用户可见提示；权限码只放在 details.required，不出现在提示文案里。 */
export const PERMISSION_DENIED_MESSAGE = '当前账号无此操作权限';
export const permissionDenied = (required: string[]) =>
  forbidden(PERMISSION_DENIED_MESSAGE, 'FORBIDDEN', { required });
export const notFound = (message = '资源不存在', code = 'NOT_FOUND') =>
  new AppError(404, message, code);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, message, code);
