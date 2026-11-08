# Client contract

This repository builds `@lexq/sdk`, the Node.js client for the [LexQ](https://lexq.io)
execution API. A backend service sends facts, such as an order's amount and the
customer's tier, and LexQ evaluates the deployed rules and returns the decision. This
package makes that call. It does not evaluate rules itself.

The package starts with one endpoint, `POST /api/v1/execution/groups/{groupId}`.
Batch and composite execution are not in it yet. Managing rules belongs to the
[LexQ CLI](https://github.com/lexq-io/lexq-cli) and its MCP server. The endpoint is
described in the [Execution API reference](https://docs.lexq.io/api/execution), and
its failures in [error codes](https://docs.lexq.io/api/errors).

## Resilience Contract

A call to LexQ crosses the network, so it can be slow or fail. What the caller should
do then depends on the decision: a checkout can go ahead without a discount, but a
transfer should wait. This package exists for the four safeguards below, and every
release keeps all four.

### 1. Give every call a deadline

The default is finite. The client sets it, a call can override it, and neither can
turn it off. The deadline covers every attempt and every wait between attempts. Each
attempt also has its own timeout, cut to the time left before the deadline, so an
attempt that hangs leaves time for another.

### 2. Retry with the same `Idempotency-Key` and the same bytes

When an attempt fails, send it again with the same key. If the caller passes no key,
generate one per call and use it for every attempt of that call. Serialize the body
once and resend those bytes: the same key with a different body fails with `I-001`,
and a body serialized a second time can differ. Retries are on by default. The client
or a single call can turn them off.

| What came back | Retry |
|---|---|
| Nothing: the attempt timed out or the connection failed | Yes, with backoff, while the deadline allows |
| `502`, `503`, or `504` | Yes, with backoff, while the deadline allows |
| `429` | Yes, after `Retry-After` if the response has one, or else after a longer wait, while the deadline allows. A request rejected with `429` did not use its key |
| `409` with `I-002` | Yes, with backoff, while the deadline allows. A request with this key is still running or failed less than a minute ago |
| `409` with `I-001` | Never. The key is spent, and only a new key works |
| `403` with `B-008` | Never. The monthly execution quota is used up, and every call fails the same way until it resets or the plan is upgraded |
| Anything else | No |

If this package adds batch execution, it must never retry a batch automatically.
Batch calls take no `Idempotency-Key`, so a retried batch runs and bills every item
again.

### 3. Keep a circuit breaker on by default

The breaker counts calls, not attempts. A call adds one when it ends with the fallback
because the deadline ran out, or because its last attempt timed out, failed to
connect, or got a 5xx. Any other call that got a response resets the count to zero. A
call that sent nothing, because the breaker was open or the call failed before
sending, leaves the count alone.

When the count reaches the threshold, the breaker opens: calls skip the network and go
straight to the fallback. After a cool-down, one trial call goes through with its
retries, while other calls keep getting the fallback. If the trial adds to the count,
the breaker opens again; otherwise it closes. The breaker belongs to the client
instance, so a service creates one client and reuses it. The client can turn the
breaker off.

### 4. Require a fallback on every call, and use it on every failure

The package never picks a decision for the caller, because only the caller knows which
side is safe. LexQ errors that are not retried use the fallback too. A rule change that
needs a new fact, or a policy group someone disabled to stop bad decisions, must not
take the caller's service down. The fallback is a function that receives the error and
returns the caller's own value. If it throws, the call rejects with that error. The
deadline covers the attempts to reach LexQ, not the fallback. The result is either
LexQ's decision or the fallback's value with the error, and it says which.

### Errors

Two kinds of mistake skip the fallback, because they are bugs in the calling code. One
is leaving out the fallback. The other is an option of the wrong type or range, such as
a deadline of `0` or `Infinity`. Both are rejected with a `TypeError` before anything
is sent. The constructor throws, and a call's promise rejects. In TypeScript, a call
without a fallback also fails to compile.

Everything else uses the fallback, including two failures that happen before anything
is sent. One is a fact that JSON cannot carry as written, such as `NaN`, `Infinity`, or
a list with a missing element. The other is an idempotency key that is empty or that a
header cannot carry. For both, the fallback receives a `TypeError`.

The error the fallback receives names the reason: an open breaker, the deadline, a
failed connection, or a LexQ error with its status and `errorCode`. It also lists every
attempt and carries the idempotency key the call used, so a caller can repeat the call
later without running the decision twice.

### Contract tests

Each safeguard must have a contract test that CI runs on every pull request. The tests
are the specification: a change to a safeguard changes its test in the same pull
request, and the description says why. The fallback test has a `@ts-expect-error` call
without a fallback, so it fails if such a call ever compiles. Thresholds, waits, and
default values belong in the code next to their tests, not in this file.

## Wire Contract

### Reading a response

- Read the body for every status. LexQ reports failures in the body, for 5xx as well
  as 4xx. `fetch` does not throw on an error status, and a replacement HTTP client
  must not either.
- Never follow a redirect. `fetch` follows redirects by default and would send the
  request's headers, `x-api-key` included, to the new address. A `3xx` is a failure
  that keeps its status.
- A body that is not JSON is a failure that keeps its status. A load balancer's 502
  page or the 404 from a wrong host is HTML.
- A LexQ response has two branches. `result: "SUCCESS"` carries `data`, and
  `result: "ERROR"` carries `errorCode` and `message`. The key is `errorCode`, not
  `code`, and reading the wrong key fails silently: every error arrives without a
  code.
- A 2xx whose `result` is not `SUCCESS`, or a 4xx or 5xx whose `result` is `SUCCESS`,
  is a server defect. Treat it as a failure even if it carries `data`.
- Branch on `errorCode` as well as the status. `I-001` and `I-002` are both `409` and
  need opposite handling. Codes are stable, and messages may be reworded.

### Returning a decision

- Return the final facts as well as the three layers LexQ sends. `inputFacts` holds
  the facts as LexQ received them, `mutatedFacts` the facts a rule changed, and
  `generatedVariables` the keys the request did not send, such as a `SET_FACT` target.
  The final facts are `{ ...inputFacts, ...mutatedFacts, ...generatedVariables }`.
- Make a block hard to miss. A `BLOCK` action does not fail the call. It sets
  `isBlocked`, which arrives in `generatedVariables`, or in `mutatedFacts` if the
  request sent `isBlocked` itself. The result for LexQ's decision has a top-level
  `isBlocked` that is `true` when the final facts have `isBlocked: true`, and `false`
  otherwise. A fallback's value has no such field.
- Return `data.traceId`. It is the execution's audit handle, and the caller stores it
  with the record the decision applies to. A retry that LexQ served from the
  idempotency key returns the original `traceId`.
- Keep every number exact in both directions. LexQ calculates in decimal, and an
  amount can carry 34 significant digits or more. A JavaScript number holds 15
  reliably, and the package cannot tell an amount from a count. Parse responses so
  that no number loses digits, and give callers a way to send an exact amount as a
  JSON number. A string such as `"150000"` is not a number to LexQ. The first
  implementation pull request settles how exact values reach the caller, and a
  contract test sends and reads back an amount with more than 34 significant digits.

### Sending a request

- Keep the API key on the server. Send it in the `x-api-key` header, never in
  `Authorization`. The constructor throws where `window` and `document` exist, because
  the key would ship to every visitor. It accepts an `http` base URL only for
  `localhost`, `127.0.0.1`, and `[::1]`.
- Drop a fact whose value is `null` or `undefined` before sending. If a rule needs it,
  LexQ answers `P-015` with its name. Inside a list, a missing element fails the call
  instead, as described under Errors.
- Never shorten a caller's idempotency key. LexQ accepts up to 255 characters and
  answers a longer key with `I-003` rather than cutting it. Keys are stored with the
  execution, so tell callers to hash long IDs and keep personal data out of them.
- Send `trafficKey` in `context`. A/B routing reads `context.trafficKey`. In `facts`
  it is ignored, and the test version receives no traffic. The package does not move
  it, so the documentation for `context` must say where it goes.
