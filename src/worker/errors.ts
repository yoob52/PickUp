import type { AppError, AppErrorCode } from "../shared/contracts";

/** 领域校验失败：可映射为明确的错误码返回给调用方。 */
export class DomainError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DomainError";
  }

  static validation(message: string): DomainError {
    return new DomainError("VALIDATION_ERROR", message, false);
  }

  static notFound(): DomainError {
    return new DomainError(
      "NOT_FOUND",
      "任务不存在或已被其他窗口修改，请刷新后重试。",
      false,
    );
  }

  static stateConflict(message: string): DomainError {
    return new DomainError("STATE_CONFLICT", message, true);
  }

  static needSwitch(): DomainError {
    return new DomainError(
      "NEED_SWITCH",
      "已有其他任务正在进行中，请先完成切换再开始这一件。",
      true,
    );
  }

  static commandIdReused(): DomainError {
    return new DomainError(
      "COMMAND_ID_REUSED",
      "本次提交标识已用于其他内容，请重新提交。",
      false,
    );
  }
}

/** 数据库 schema 比当前应用更新：停止写入，避免破坏较新的数据。 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`schema ${found} > supported ${supported}`);
    this.name = "SchemaTooNewError";
  }
}

export class MigrationFailedError extends Error {
  constructor(
    message: string,
    readonly backupPath: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MigrationFailedError";
  }
}

/** 一致性检查失败或数据库文件无法读取；原文件必须保留。 */
export class IntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntegrityError";
  }
}

/** 无法建立数据库连接（占用、只读、空间不足等）。 */
export class BackendUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackendUnavailableError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof DomainError)
    return {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  return {
    ok: false,
    code: "STORAGE_ERROR",
    message: "数据未保存，请保留输入后重试。",
    retryable: true,
  };
}

/** 面向用户的启动失败诊断信息；不包含数据库路径以外的环境细节。 */
export function describeBootFailure(error: unknown): string {
  if (error instanceof SchemaTooNewError)
    return "本地数据库版本比当前应用更新。已停止写入以免损坏数据，请使用较新版本的应用打开。";
  if (error instanceof MigrationFailedError)
    return "本地数据库升级失败，已保留原数据与升级前保护副本。请查看诊断信息后重试。";
  if (error instanceof IntegrityError)
    return "本地数据库一致性检查未通过，已保留原文件，未创建空库覆盖。请检查存储环境。";
  if (error instanceof BackendUnavailableError) return error.message;
  return "数据库初始化失败。原数据已保留，请关闭后检查存储环境。";
}
