/** Stable library errors. AbortSignal reasons and source-stream errors pass through unchanged. */
export class SpreadsheetError extends Error {
  override readonly name = 'SpreadsheetError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function nativeError(error: unknown): unknown {
  if (error instanceof Error) {
    const match = /^(ERR_[A-Z_]+): (.*)$/s.exec(error.message);
    if (match?.[1] && match[2]) {
      return new SpreadsheetError(match[1], match[2], { cause: error });
    }
  }
  return error;
}

export function integer(value: number, name: string, min = 1, max = 0xffff_ffff): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
