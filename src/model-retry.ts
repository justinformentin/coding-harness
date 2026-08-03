import type { ModelErrorKind } from "./contracts/model.js";

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelError";
  }
}

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
};

export function classifyModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof DOMException && error.name === "AbortError")
    return new ModelError(error.message, "aborted", undefined, {
      cause: error,
    });
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message))
    return new ModelError(message, "aborted", undefined, { cause: error });
  if (/timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message))
    return new ModelError(message, "transient", undefined, { cause: error });
  return new ModelError(message, "unknown", undefined, { cause: error });
}

export function modelErrorForResponse(
  provider: string,
  model: string,
  status: number,
  body: string,
): ModelError {
  const kind: ModelErrorKind =
    status === 429
      ? "rate_limit"
      : status === 401 || status === 403
        ? "authentication"
        : status === 400 || status === 404 || status === 422
          ? "invalid_request"
          : status >= 500
            ? "transient"
            : "unknown";
  return new ModelError(
    `${provider} request failed [${model}] (${status}): ${body}`,
    kind,
    status,
  );
}

export function isRetryableModelError(error: unknown): boolean {
  const kind = classifyModelError(error).kind;
  return kind === "transient" || kind === "rate_limit";
}

export async function retryModelCall<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  options: {
    random?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (options.signal?.aborted)
      throw new ModelError("Model call aborted", "aborted");
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= policy.maxAttempts || !isRetryableModelError(error))
        throw error;
      const ceiling = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      await sleep(Math.floor(random() * ceiling));
    }
  }
  throw lastError;
}
