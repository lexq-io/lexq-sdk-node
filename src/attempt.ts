import { MAX_ERROR_CODE_LENGTH, MAX_MESSAGE_LENGTH, MAX_RESPONSE_BYTES } from "./contract.ts";
import { Decimal } from "./decimal.ts";
import { decodeBody } from "./json.ts";
import { cut, spaced } from "./text.ts";

// LexQ's codes look like P-015 or ACT-033. A value that is not a short token, such as
// text with a line break, is not kept as a code.
const ERROR_CODE = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ERROR_CODE_LENGTH}}$`);

/** What one attempt came back with. */
export type AttemptOutcome =
  | { readonly kind: "decision"; readonly status: number; readonly data: Readonly<Record<string, unknown>> }
  | { readonly kind: "timeout" }
  | { readonly kind: "connection"; readonly cause: unknown }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly errorCode: string | undefined;
      readonly message: string;
      readonly retryAfter: string | null;
    };

export interface PreparedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized once per call, so every attempt sends the same bytes. */
  readonly body: Uint8Array;
}

/** Sends the request once and reads the whole answer within `timeoutMs`. */
export async function sendAttempt(request: PreparedRequest, timeoutMs: number): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timedOut = new Error("attempt timed out");
  const timer = setTimeout(() => controller.abort(timedOut), timeoutMs);
  let status: number;
  let retryAfter: string | null;
  let text: string | undefined;
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      // A followed redirect would carry x-api-key to the new address.
      redirect: "manual",
      signal: controller.signal,
    });
    status = response.status;
    retryAfter = response.headers.get("retry-after");
    // Read for every status: LexQ reports failures in the body, 5xx included.
    text = await readBody(response);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timedOut) {
      return { kind: "timeout" };
    }
    return { kind: "connection", cause: error };
  } finally {
    clearTimeout(timer);
  }
  return classify(status, text, retryAfter);
}

/**
 * The body as text, or undefined when it is larger than MAX_RESPONSE_BYTES. A larger body
 * makes the attempt a failure that keeps its status, even when it carries a decision, so the
 * client never holds it all in memory.
 */
async function readBody(response: Response): Promise<string | undefined> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text + decoder.decode();
    }
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function classify(status: number, text: string | undefined, retryAfter: string | null): AttemptOutcome {
  const failure = (errorCode: string | undefined, message: string): AttemptOutcome => ({
    kind: "response",
    status,
    errorCode,
    message,
    retryAfter,
  });
  if (status >= 300 && status < 400) {
    return failure(undefined, `LexQ answered ${status}, a redirect, which the client does not follow`);
  }
  if (text === undefined) {
    return failure(undefined, `LexQ answered ${status} with a body larger than ${MAX_RESPONSE_BYTES} bytes`);
  }
  let body: unknown;
  try {
    body = decodeBody(text);
  } catch {
    // A load balancer's error page or a wrong host's 404 is HTML.
    return failure(undefined, `LexQ answered ${status} with a body that is not JSON`);
  }
  if (!isRecord(body)) {
    return failure(undefined, `LexQ answered ${status} with JSON that is not an object`);
  }
  const errorCode = typeof body.errorCode === "string" && ERROR_CODE.test(body.errorCode) ? body.errorCode : undefined;
  const succeeded = status >= 200 && status < 300;
  if (body.result === "SUCCESS") {
    if (!succeeded) {
      return failure(errorCode, `LexQ answered ${status} with result SUCCESS, which only a 2xx status can carry`);
    }
    if (!isRecord(body.data)) {
      return failure(errorCode, `LexQ answered ${status} with result SUCCESS but no data`);
    }
    return { kind: "decision", status, data: body.data };
  }
  if (succeeded) {
    return failure(errorCode, `LexQ answered ${status} without result SUCCESS`);
  }
  if (errorCode === undefined) {
    return failure(undefined, `LexQ answered ${status}`);
  }
  const message = typeof body.message === "string" ? `: ${clean(body.message)}` : "";
  return failure(errorCode, `LexQ answered ${status} ${errorCode}${message}`);
}

function clean(message: string): string {
  return cut(spaced(message), MAX_MESSAGE_LENGTH);
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Decimal);
}
