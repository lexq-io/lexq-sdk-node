# LexQ SDK Specification

This file specifies what a LexQ SDK in any language does when it calls the
[LexQ](https://lexq.io) execution API. A backend service sends facts, such as an order's
amount and the customer's tier, and LexQ evaluates the deployed rules and returns the
decision. An SDK makes that call. It does not evaluate rules itself.

This specification is the single source of truth for LexQ SDKs. Each SDK follows one
version of it, and two SDKs that follow the same version differ only where their
languages differ.

The specification sets outcomes, not types. It says, for example, that an amount with
more than 34 significant digits goes out and comes back with every digit, and each SDK
picks the type that does that in its language. [Language mapping](#language-mapping)
lists what each SDK decides for itself.

The calls are described in the [Execution API reference](https://docs.lexq.io/api/execution),
and their failures in [error codes](https://docs.lexq.io/api/errors). This file covers
single-group execution, `POST /api/v1/execution/groups/{groupId}`, and safeguard 2 ends
with the rules for composite and batch execution.

## Resilience

A call to LexQ crosses the network, so it can be slow or fail. What the caller should do
then depends on the decision: a checkout can go ahead without a discount, but a transfer
should wait. An SDK exists for the four safeguards below, and every release keeps all
four.

### 1. Give every call a deadline

Every call has a deadline. The client sets it, a call can override it, and neither can
turn it off. The deadline covers every attempt and every wait between attempts. Each
attempt also has its own timeout, cut to the time left before the deadline, so an
attempt that hangs leaves time for another. With retries off, a call makes one attempt,
and that attempt's timeout is the whole deadline. An attempt's timeout covers the whole
response, up to its last byte. [Defaults](#defaults) gives the deadline and the timeout
for one attempt.

### 2. Retry with the same `Idempotency-Key` and the same bytes

When an attempt fails, send it again with the same key. If the caller passes no key,
generate one per call and use it for every attempt of that call. Serialize the body once
and resend those bytes, because a body serialized a second time can differ. LexQ compares
a repeat with the first request after parsing it: whitespace and the order of object keys
do not matter, but the order of list elements and the way each number is written do, so
`150000` and `150000.0` are different requests. Keys are not scoped to a group, so the
group in the path is compared too: the same key and body sent to another group is a
different request. For composite execution the target groups are compared too, though
not their order. Retries are on by default. The client or a single call can turn them
off.

| What came back | Retry |
|---|---|
| Nothing: the attempt timed out or the connection failed | Yes, with backoff, while the deadline allows |
| `502`, `503`, or `504` | Yes, with backoff, while the deadline allows |
| `429` | Yes, after `Retry-After` if the response has one, or else after a longer wait, while the deadline allows |
| `409` with `I-002` | Yes, after a longer wait than a backoff, while the deadline allows. Another request with this key started less than a minute ago, and it is still running or failed without freeing the key. A request still running a minute after it started no longer holds the key, so a retry then runs the decision again and is billed again |
| `409` with `I-001` | Never. LexQ holds a successful decision for this key, made within the last 24 hours for a different request. Only a new key works until that decision is 24 hours old |
| `403` with `B-008` | Never. The plan's monthly execution quota cannot cover the call, and a retry fails the same way until the quota resets or the plan is upgraded |
| `500` with `P-003` | Never. An action of a matched rule failed, and running the request again fails the same way until the rule or LexQ changes |
| Anything else | No |

A row that names a code applies to that code whatever the HTTP status, and wins over a
row that names only a status, because the [error codes](https://docs.lexq.io/api/errors)
reference says a code's status may change.

Retries also stop after the number of attempts in [Defaults](#defaults), even when the
deadline has time left.

Some failures leave the key free, so the same key then works for a new call: `429`,
`403` with `B-008`, a group error (`404` with `P-001`, `403` with `P-009`, or `400` with
`P-019`), and a request that LexQ refuses before anything runs because it is past one of
the [LexQ limits](#lexq-limits). A request that failed with `P-015` or `P-003` does not
free its key: a repeat with that key can get `I-002` for up to a minute after the failed
request started.

In an organization that uses
[Fail-open](https://docs.lexq.io/glossary#billing-and-infrastructure), LexQ keeps running
calls through some outages in its own infrastructure. When such an outage stops it from
checking whether another request holds the idempotency key, a retry that arrives while
the first request is still running, or after it failed, runs the decision again and is
billed again instead of getting `I-002`. An SDK's documentation must say so where it
describes retries.

Composite execution, `POST /api/v1/execution/composite`, takes an `Idempotency-Key` and
follows this safeguard as single-group execution does. Batch execution takes no
`Idempotency-Key`, so a retried batch runs and bills every item again. An SDK never
retries a batch automatically, and it does not send the header with one.

### 3. Keep a circuit breaker on by default

The breaker counts calls, not attempts. A call adds one when it ends with the fallback
because the deadline ran out, or because its last attempt timed out, failed to connect,
or got a 5xx, unless its `errorCode` is `P-003`. Any other call that got a response resets
the count to zero. A call that sent nothing, because the breaker was open or the call
failed before sending, leaves the count alone.

A `P-003` does not mean LexQ is down: it answered, and one rule's action failed. A
service calls every group through one client, so counting it could let one group's
broken rule open the breaker and send the other groups' calls to the fallback.

When the count reaches the threshold, the breaker opens: calls skip the network and go
straight to the fallback. After a cool-down, one trial call goes through with its
retries, while other calls keep getting the fallback. A call that fails before sending
leaves the trial to the next call. If the trial adds to the count, the breaker opens
again; otherwise it closes. The breaker belongs to the client instance, so a service
creates one client and reuses it. One client is safe to use from many concurrent calls,
and they share its breaker. The client can turn the breaker off.

### 4. Require a fallback on every call, and use it on every failure

An SDK never picks a decision for the caller, because only the caller knows which side
is safe. LexQ errors that are not retried use the fallback too. A rule change that needs
a new fact, or a policy group someone disabled to stop bad decisions, must not take the
caller's service down. The fallback is code the caller passes with the call: it receives
the error and returns the caller's own value. If the fallback fails, the call fails with
the fallback's error. The deadline covers the attempts to reach LexQ, not the fallback.
The result is either LexQ's decision or the fallback's value with the error, and its
`source` says which: `lexq` or `fallback`.

### Cancellation

A caller can cancel a call with the language's own cancellation mechanism. A canceled
call ends without the fallback, because the caller no longer wants a result, and fails
the way the language reports a cancellation. Cancellation is not one of the error
reasons below. It leaves the breaker count alone, and canceling the breaker's trial call
frees the trial for a later call. LexQ may still finish and bill a decision whose
request was already sent. If that decision succeeded, repeating the call with the same
key within 24 hours returns it. A canceled call does not report the idempotency key it
used, so the documentation must tell callers to pass their own key when they may cancel
a call but still want its decision.

## Errors

Two kinds of mistake skip the fallback, because they are bugs in the calling code. One is
leaving out the fallback. The other is an argument or option of the wrong type or range,
such as a deadline that is zero, negative, or infinite, or a group ID that
[Sending a request](#sending-a-request) rules out. Both fail before anything is sent, the
way the language reports a programming error. Where the language checks types before the
code runs, a call without a fallback does not compile.

Everything else uses the fallback. The error the fallback receives names one reason:

| Reason | The call ended because |
|---|---|
| `breaker_open` | The circuit breaker is open, so nothing was sent |
| `invalid_input` | The SDK refused to send the request, for a reason in the list below |
| `deadline` | The call's deadline ran out before LexQ's whole answer arrived |
| `timeout` | The last attempt did not get its whole answer within its own timeout, which ended before the call's deadline, and no retry followed |
| `connection` | The last attempt could not connect, or the connection broke |
| `response` | An answer came back that is not a decision |

An SDK refuses a request as `invalid_input`, not as a programming error, when it has:

- a value in the facts or contexts that JSON cannot carry as written, such as NaN,
  infinity, a list with a missing element, or a map with a key that is not a string
- a collection whose order the SDK cannot rely on, such as a set: it would go out as a
  JSON list, and a later call with the same key could list its elements in another order
  and get `I-001`
- a value nested deeper than the [LexQ limits](#lexq-limits) allow
- an idempotency key in a form that [Sending a request](#sending-a-request) rules out

The error lists every attempt in order, with each attempt's outcome, HTTP status, LexQ's
`errorCode`, and duration, and it carries the idempotency key the call used. When the
call ended on an answer, the error carries that answer's status and any `errorCode`, and
its message includes any `message` LexQ sent. An `invalid_input` error keeps the error
that stopped the request as its cause. When the SDK refused the idempotency key itself,
the error leaves the key out, because such a key can hold a character that breaks a log
line, such as a line break.

When LexQ finished the call's decision and it succeeded, repeating the call with the
error's key within 24 hours returns the decision instead of running a second one.

Callers log errors, so an error never carries the API key, a value from the facts or
contexts, or a raw response body. Every message is one line of bounded length, even where
it quotes text the SDK did not write: LexQ's message, or the key path of a value in the
facts or contexts, such as `facts.items[3]`. Control characters (Unicode `Cc`), format
characters (`Cf`), unpaired surrogates, and line and paragraph separators (`Zl` and `Zp`)
never appear in a message as they are. In LexQ's message, each run of them becomes one
space, and every space separator (`Zs`) left at either end is removed. In a key path,
each of them is written as a `\uXXXX` escape, one for each UTF-16 code unit.
[Defaults](#defaults) gives the lengths. An SDK logs nothing by default. Anything else a
caller may want to know goes in the result or to an optional hook the caller owns.

## Wire

### Reading a response

- Read the body for every status. To a request that accepts JSON, LexQ reports failures
  in the body, for 5xx as well as 4xx. An HTTP client that raises on an error status must
  not stop the SDK from reading the body.
- Never follow a redirect. Many HTTP clients follow redirects by default and would send
  the request's headers, `x-api-key` included, to the new address. A `3xx` is a failure
  that keeps its status.
- A response whose body is not JSON, or has no `result`, is a failure that keeps its HTTP
  status and any `errorCode` in the body.
- Read at most the number of bytes in [Defaults](#defaults). A larger body is a failure
  that keeps its status, even when it carries a decision, so one response cannot fill the
  caller's memory. A body whose declared length is over the limit is not read at all.
- A LexQ response has two branches. `result: "SUCCESS"` carries `data`, and
  `result: "ERROR"` carries `errorCode` and `message`. The key is `errorCode`, not
  `code`, and reading the wrong key fails silently: every error arrives without a code.
  Compare `errorCode` only as a whole string, never by a part of it such as the letters
  before the hyphen, and keep it only when it has the form [Defaults](#defaults) gives.
- Only a 2xx whose `result` is `SUCCESS` carries a decision. Any other response is a
  failure even if it carries `data`.
- Branch on `errorCode` as well as the status. `I-001` and `I-002` are both `409` and
  need opposite handling. The [error codes](https://docs.lexq.io/api/errors) reference
  promises that a code is never reused for another meaning. LexQ still adds codes and can
  move a failure to a new, more specific code, so an SDK branches only on the codes in the
  retry table. A response with a code the table does not name, such as one that a failure
  has moved to, is handled by its status alone. Messages may be reworded.

### Returning a decision

- Return every field LexQ sends in `data`, and add only `source`, which tells LexQ's
  decision from the fallback's value. Besides the facts and `traceId`, that is
  `executedAt`, `totalProcessingTimeMs`, `inputContexts`, `executionTraces`, and
  `decisionTraces`. A field LexQ adds later reaches the caller too, before the SDK's types
  name it. When they do, they make it optional, and the SDK accepts it when it is empty:
  a retry that LexQ serves from the idempotency key can return a decision made before the
  field existed, with the field `null`, `0`, or `false`. During a LexQ release, such a
  retry can also lack a recently added field that the first response had, or carry `null`
  for a recently added enum value. In every field that holds an enum value, such as a
  trace's `status`, the SDK accepts `null` and any value it does not know, because LexQ
  adds values. A test reads the single-group response the Execution API reference shows
  and fails when one of its fields is missing from the result.
- A layer, the contexts, or a trace list that LexQ leaves out or sends as `null` is empty
  in the result.
- Return the facts in the three layers LexQ sends, and never merge them. `inputFacts`
  holds the facts as LexQ received them. `mutatedFacts` holds the new value of each fact
  the request sent that a rule changed, so a fact whose value did not change is only in
  `inputFacts`. `generatedVariables` holds the keys the request did not send, such as a
  `SET_FACT` target, and keys that only describe the decision, such as
  `paymentAmount__delta`, the net change to `paymentAmount` from the value the request
  sent, which LexQ adds when a `MUTATE_FACT` changes it. The documentation must say where
  a new value is, and that a caller who sends a decision's facts again leaves the
  `__delta` keys out: LexQ answers a top-level key in `facts` that ends in `__delta` with
  `400` (`P-068`).
- Make a block hard to miss. A `BLOCK` action does not fail the call. It writes
  `isBlocked: true` and `blockReason`, which arrive in `generatedVariables` when the
  request did not send them. A request that sends `isBlocked` itself finds that key
  elsewhere: in `mutatedFacts` when it sent another value, and only in `inputFacts` when
  it sent `true`, because the value did not change. The documentation must show a check
  that reads all three layers, and say to send an earlier block under another key, such
  as `previouslyBlocked`, because a request that sends `isBlocked: true` looks blocked
  whether or not a `BLOCK` ran.
- Return `data.traceId`. It is the execution's audit handle, and the caller stores it with
  the record the decision applies to. A retry that LexQ served from the idempotency key
  returns the original `traceId` and `executedAt`.
- The result's `source` is always the SDK's, even when LexQ's `data` has a field of the
  same name.
- A key in `data`, the facts, or the contexts is data, whatever its name. It never changes
  how the SDK's own objects behave or which types its parser creates.

### Numbers

- Keep every number exact in both directions. LexQ calculates in decimal, and an amount
  can carry more digits than the 15 or so that a binary floating-point number holds
  reliably. An SDK cannot tell an amount from a count. Parse responses so that no number
  loses digits, and give callers a way to send an exact amount as a JSON number. A string
  such as `"150000"` is not one: when an enabled rule reads a fact registered as NUMBER,
  LexQ can answer the string with `400` (`P-060`).
- Never expand an exponent when writing a number: write `1E+400` in that form, not as 401
  digits. Expanding `1E+10000000` would write over ten million digits only for LexQ to
  reject them. LexQ evaluates a number the same with or without an exponent, so `1.5E+5`
  gets the same decision as `150000`.
- Every number in the facts, the contexts, and the traces reaches the caller as an exact
  decimal that keeps the digits and the scale LexQ wrote, so `1.50` stays `1.50`.
  `totalProcessingTimeMs` is an integer, because it counts milliseconds. A number from one
  decision goes back out with the same digits and scale. A decimal type that keeps the
  text LexQ wrote sends that text. One that keeps only the digits and the scale, such as
  Java's `BigDecimal`, may write its own form, which can use an exponent where LexQ wrote
  none, as `1E-7` for `0.0000001`. Such an SDK must write the same digits and scale as
  the same text every time. A test sends and reads back an amount with more than 34
  significant digits.
- An SDK documents how a caller compares two numbers by value, because a decimal type
  that keeps text or scale can call `20` and `20.0` different.
- An SDK documents the text it writes for a number that carries no text of its own, such
  as a binary floating-point value or a decimal that keeps only digits and scale. In
  JavaScript, the number `0.0000001` is written `1e-7`.

### Sending a request

- Keep the API key on the server. Send it in the `x-api-key` header, never in
  `Authorization`: LexQ answers a request whose key is only there with `401`, as it
  answers one without a key. Refuse to start in a web page, in the workers a web page
  starts, and in a mobile app, where the key would reach end users. Server runtimes must
  still start. An app that runs on its user's own machine, such as a desktop app, hands
  the key to that user too, but an SDK cannot always tell it from a server, so the
  documentation must say to keep the SDK out of such apps. Accept an `http` base URL only
  for `localhost`, `127.0.0.1`, and `[::1]`.
- Send the request as a JSON `POST` to the group, and keep a path in the base URL in
  front of the API path. Send `Content-Type: application/json` and
  `Accept: application/json`: LexQ answers another content type with `415` (`C-010`), and
  a request that does not accept JSON gets an answer with no body. The body holds only
  `facts` and `contexts`, and leaves `contexts` out when the call has none. LexQ answers
  any other top-level field, even one set to `null`, with `400` (`C-001`). Percent-encode
  the group ID as one path segment, writing a space as `%20`. A group ID that is empty,
  `.`, or `..` is a programming error: encoding leaves it as it is, so an empty ID drops
  the group from the path, and a URL parser treats `.` and `..` as steps to another path.
- Send `null` as JSON `null` and keep its key, at every level of `facts` and
  `contexts`. LexQ treats a key sent as `null` differently from a key left out. A
  condition on a `null` value does not match, even in a rule that blocks. If an
  enabled rule reads a key that the request leaves out of `facts`, the request fails
  with `400` (`P-015`), which names the key, before any rule runs. An SDK in a language
  with a second missing value, such as JavaScript's `undefined`, leaves out a key that
  holds it, as that language's JSON writer does. Inside a list, such a value fails the
  call instead, as described under Errors.
- An idempotency key is one or more printable ASCII characters with no space at either
  end. An HTTP client can trim the ends of a header value, and clients and servers
  disagree on characters outside ASCII, so the key that reaches LexQ could differ from the
  one the SDK puts in its error. Send the key unchanged, and never shorten it: LexQ
  accepts up to 255 characters and answers a longer key with `400` (`I-003`) rather
  than cutting it. Keys are stored with the execution, so tell callers to hash a long or
  non-ASCII ID and keep personal data out of keys.
- Send `trafficKey` in `contexts`. A/B routing reads `contexts.trafficKey`. In `facts` it
  is ignored, and the test version receives no traffic. The SDK does not move it, so the
  documentation for `contexts` must say where it goes. LexQ stores the whole `contexts`
  object with the execution, so the documentation must also say to keep personal data out
  of it and to make `trafficKey` a surrogate key or a keyed hash, never an email address
  or a phone number.

## Defaults

Every SDK uses these values.

| What | Value |
|---|---|
| Base URL | `https://api.lexq.io` |
| Deadline for a call | 15 seconds |
| Timeout for one attempt, with retries on | 10 seconds |
| Attempts for a call, counting the first | 4 |
| Backoff before the next attempt | A random time from 50 to 100 ms after the first failed attempt, from 100 to 200 ms after the second, and from 200 to 400 ms after the third |
| Wait after `429` without `Retry-After` | A random time from 1 to 1.5 seconds |
| Wait after `I-002` | A random time from 1 to 1.5 seconds |
| Counted calls in a row that open the breaker | 5 |
| Breaker cool-down before a trial | 10 seconds |
| Largest response body read | 16 MiB |
| Longest part of LexQ's `message` in an error message | 1,000 UTF-16 code units, then `...` |
| Longest key path in an error message | 300 UTF-16 code units, then `...` |
| Form of an `errorCode` the error keeps | 1 to 32 ASCII letters, digits, hyphens, or underscores |

The two lengths in an error message are counted after the text is made one line, as
[Errors](#errors) describes.
A cut never splits a surrogate pair, and the `...` is not counted.

Safeguard 1 says who can change the deadline, and safeguards 2 and 3 say who can turn off
the retries and the breaker. The client can also change the base URL, the timeout for one
attempt, the breaker's threshold, and its cool-down. No one can change the other values.

`Retry-After` is read as a whole number of seconds, or as an HTTP date in any of the three
formats RFC 9110 requires a recipient to accept, such as `Tue, 10 Nov 2026 00:00:05 GMT`.
A value in no such form counts as no `Retry-After`.

## LexQ limits

Before anything runs, LexQ checks the request as it was sent against the limits below,
which the [Execution API reference](https://docs.lexq.io/api/execution) publishes. Of
these limits, an SDK checks only the nesting before sending, and leaves the rest to
LexQ's answer.

| Limit | Value | Past it |
|---|---|---|
| Size of the request body | 1 MB | `413` (`C-011`) |
| Nesting of objects and lists in the body | 32 levels, counting the body's outermost braces | `400` (`C-012`) |
| Length of a property name anywhere in the body | 256 characters, counted in UTF-16 code units | `400` (`C-013`) |
| Items in a list | 1,000 | `400` (`P-064`) |
| Length of a text value | 4,096 characters, counted in UTF-16 code units | `400` (`P-064`) |
| Digits in a number | 34 before the decimal point and 34 after, counted with the number written in full and trailing zeros included, so `1.5e-34` has 35 after | `400` (`P-064`) |

## Tests

Each SDK has contract tests for every safeguard and wire rule, and its CI runs them on
every pull request. Where the language checks types before the code runs, the fallback
test has a call without a fallback that must fail to compile. A test fails when the SDK's
values differ from [Defaults](#defaults), or when the nesting it refuses differs from
[LexQ limits](#lexq-limits).

## Language mapping

Each SDK's `CONTRACT.md` maps this specification onto its language. It names the version
of the specification it follows, and it says:

- the shape of a call, such as a promise, a future, or a blocking call
- the error type, and how a programming error is reported
- how it writes the reasons and the two values of `source`, such as `breaker_open` as a
  string or as a constant `BREAKER_OPEN`
- the exact decimal type, and how to compare two numbers by value
- the text it writes for a number that carries no text of its own
- the cancellation mechanism
- where it refuses to start, such as a web page and the workers a page starts, or Android
- how a field LexQ adds later reaches the caller
- which collections it refuses because it cannot rely on their order
- which key names could change how its own objects behave or which types its parser
  creates, such as `__proto__` in JavaScript or `@class` in Java, and how it keeps them
  ordinary keys
- how one client is shared across concurrent calls
- any rule that only that language has
