/**
 * A safe-to-log summary of an error. Every logging sink that might see a real Plaid/Axios error
 * must log this — never the raw error object itself.
 *
 * Why the raw object is unsafe: Plaid's SDK calls (`plaidService.ts`) go over Axios, and a
 * rejected request throws an `AxiosError` whose `.config` property is the *entire outgoing
 * request* — for Plaid API calls, that request body is JSON containing `access_token` and/or
 * `client_id`/`secret` (verified against this repo's actual installed `axios` package:
 * `node_modules/axios/dist/esm/axios.js`'s `AxiosError` class stores `config`/`request`/
 * `response` as full properties, and even wraps the *original* underlying error as a non-
 * enumerable `.cause`, which can carry its own request reference). `console.error(err)` on such
 * an object — Node's default `util.inspect` — prints every enumerable own property, `.config`
 * included. This is exactly the leak an independent audit found, verified with sentinel values.
 *
 * `err.message` itself is safe and is included here: verified against the same installed axios
 * source that a failed-request `AxiosError`'s message is always the literal string
 * `'Request failed with status code ' + status` — never anything derived from the request or
 * response body.
 */
export interface SafeErrorSummary {
  name: string;
  message: string;
  /** Plaid's own machine-readable error code (e.g. 'ITEM_LOGIN_REQUIRED'), when the error shape
   *  has one — same field `plaidErrors.ts`'s `isReauthRequiredError` already reads. */
  plaidErrorCode?: string;
  plaidErrorType?: string;
  httpStatus?: number;
}

interface AxiosLikeError {
  response?: {
    status?: unknown;
    data?: {
      error_code?: unknown;
      error_type?: unknown;
    };
  };
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Extracts only known-safe fields from any thrown value. Deliberately allow-list, not deny-list —
 * never touches `.config`, `.request`, `.response` (beyond the two specific `data` fields and the
 * status code pulled out individually below), `.cause`, `.toJSON()`, or any header. Safe to pass
 * directly to `console.error`/any log line for a value that might be a real Plaid/Axios error, a
 * plain `Error`, or anything else thrown.
 */
export function summarizeErrorSafely(err: unknown): SafeErrorSummary {
  if (!(err instanceof Error)) {
    return { name: 'UnknownThrownValue', message: 'A non-Error value was thrown.' };
  }

  const axiosLike = err as unknown as AxiosLikeError;
  return {
    name: err.name,
    message: err.message,
    plaidErrorCode: safeString(axiosLike.response?.data?.error_code),
    plaidErrorType: safeString(axiosLike.response?.data?.error_type),
    httpStatus: safeNumber(axiosLike.response?.status),
  };
}
