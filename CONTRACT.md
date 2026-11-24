# Client contract

`@lexq/sdk` follows v0.1.0 of the LexQ SDK specification. The specification's version
numbers are separate from this package's. [spec/SPEC.md](spec/SPEC.md) is an unchanged copy
of that version and says what the client must do when it calls LexQ. This file lists
where the client does not yet do what that version says, and it maps the specification
onto Node.js.

## Not followed yet

Until an item is closed, the client does what the item says instead.

- **Cancellation** ([Cancellation](spec/SPEC.md#cancellation)): a call cannot be canceled.
  `execute` takes no `AbortSignal`.
- **Where the client starts**
  ([Sending a request](spec/SPEC.md#sending-a-request)): the client refuses to start only
  where `window` and `document` both exist. It starts in a web page's workers and in a
  mobile app. The documentation does not yet say to keep it out of desktop apps.
- **`Retry-After`** ([Defaults](spec/SPEC.md#defaults)): the client reads a whole number of
  seconds and the IMF-fixdate form, such as `Tue, 10 Nov 2026 00:00:05 GMT`. The RFC 850
  and asctime forms count as no `Retry-After`.
- **Errors** ([Errors](spec/SPEC.md#errors)):
  - The message leaves out LexQ's `message` when the answer carries no `errorCode` or one
    of the wrong form, when a `2xx` does not carry `result: "SUCCESS"`, when an answer
    with `result: "SUCCESS"` is not a decision, and when the answer is a redirect. The
    error of a redirect, and of a `2xx` with `result: "SUCCESS"` whose `data` is an object
    but not a decision, also leaves out any `errorCode` the body carries.
  - When a getter, a `toJSON` method, or a proxy in the facts or contexts throws a
    `TypeError`, its message becomes the error's message unchanged, not made one line or
    cut to length.
  - The code Node.js gives a connection error, such as `ECONNREFUSED`, goes into the
    message without being made one line or cut to length.
- **Keys that are not strings** ([Errors](spec/SPEC.md#errors)): a symbol key in `facts`
  or `contexts` is left out of the request instead of failing the call as `invalid_input`.
- **Nesting through `toJSON`** ([LexQ limits](spec/SPEC.md#lexq-limits)): an object with a
  `toJSON` method counts as a level even when `toJSON` returns a string, as a `Date`'s
  does, and a list or object that `toJSON` returns is counted one level deeper than it is.
  So a body within the limit can be refused when it uses `toJSON` near the limit.
- **Enum values in the types**
  ([Returning a decision](spec/SPEC.md#returning-a-decision)): the client passes `null`
  and any value through, but the type definitions declare `RuleAction.type`,
  `DecisionTrace.status`, and `DecisionTrace.reasonCode` as `string`, without `null`.
- **Documentation:**
  - Where it describes retries, it does not yet say what Fail-open does to them
    ([Retry with the same `Idempotency-Key` and the same bytes](spec/SPEC.md#2-retry-with-the-same-idempotency-key-and-the-same-bytes)).
  - It does not yet say to make `trafficKey` a surrogate key or a keyed hash, never an
    email address or a phone number, or to hash a non-ASCII ID before using it as an
    idempotency key ([Sending a request](spec/SPEC.md#sending-a-request)).
  - It says a NUMBER fact rejects a string with `P-060`, though LexQ can answer that way
    only when an enabled rule reads the fact ([Numbers](spec/SPEC.md#numbers)).
  - It says LexQ answers any key ending in `__delta` with `P-068`, though only a
    top-level key in `facts` gets that answer
    ([Returning a decision](spec/SPEC.md#returning-a-decision)).
- **Tests** ([Tests](spec/SPEC.md#tests)): no test yet covers an attempt that times out
  while the body is arriving, a call that fails before sending and so leaves the breaker's
  trial to the next call, sending a `Decimal` with an exponent, a group ID with a space,
  removing the spaces at either end of LexQ's `message`, or `null` in an enum field. No
  test yet checks that the client uses the default breaker cool-down, reads a response
  body exactly as large as the default limit, keeps an `errorCode` exactly as long as its
  default limit, keeps LexQ's `message` and a key path whole when each is exactly as long
  as its default limit, or cuts LexQ's `message` when it is one code unit longer than its
  limit.

## Language mapping

| What the specification leaves to each SDK | The Node.js client |
|---|---|
| The shape of a call | `execute` returns a promise. It resolves with LexQ's decision, or with the fallback's value and the error. It rejects when the fallback throws, when the call is a programming error, or when a getter, a `toJSON` method, or a proxy in the facts or contexts throws something other than a `TypeError` |
| The error type, and how a programming error is reported | The fallback receives a `LexqError`. A programming error is a `TypeError`: the constructor throws it, and `execute` rejects with it before sending anything. Where the client refuses to start, the constructor throws an `Error` |
| How it writes the reasons and the two values of `source` | As strings. `error.reason` is `"breaker_open"`, `"invalid_input"`, `"deadline"`, `"timeout"`, `"connection"`, or `"response"`, and `result.source` is `"lexq"` or `"fallback"`. The types declare each as a union of string literals |
| The exact decimal type, and how to compare two numbers by value | `Decimal`, which keeps in `text` the number exactly as LexQ wrote it. It has no comparison of its own. To compare two numbers by value, pass each one's `toString()` to a decimal library: the text keeps the scale, so `20` and `20.0` are different text |
| The text it writes for a number that carries no text of its own | A JavaScript number goes out as `String(value)` writes it, so `0.0000001` goes out as `1e-7`, `1e21` as `1e+21`, and `-0` as `0`. A bigint goes out as its digits, and a `Decimal` as its `text` |
| The cancellation mechanism | None yet. See [Not followed yet](#not-followed-yet) |
| Where it refuses to start | The constructor throws where `window` and `document` both exist, as in a web page |
| How a field LexQ adds later reaches the caller | As a property of the decision, which holds every field in LexQ's `data` with `source` added. The types declare only the fields this release knows |
| Which collections it refuses because it cannot rely on their order | Every object in the facts or contexts that is neither a plain object nor an array, such as a `Set` or a `Map`, fails the call as `invalid_input`, unless it has a `toJSON` method, whose result goes out instead |
| Which key names could change how its own objects behave or which types its parser creates, and how it keeps them ordinary keys | `__proto__` and `toJSON`. The parser and the decision define every key LexQ sends as an own property, so `__proto__` never sets a prototype. The request is written from each object's own enumerable string keys. A `toJSON` method on an object in the facts or contexts is called, as `JSON.stringify` does, and a `toJSON` key whose value is not a function goes out as an ordinary key |
| How one client is shared across concurrent calls | One client serves any number of concurrent calls. Its breaker counts that client's calls only and updates its count synchronously, so concurrent calls share one count. Create one client for a service and reuse it |
| Any rule that only its language has | A key whose value is `undefined` is left out, as `JSON.stringify` does, and `undefined` or a missing element in a list fails the call as `invalid_input`. A bigint goes out as an integer, and a `JSON.rawJSON` value as its text. `timeoutMs`, `attemptTimeoutMs`, and `breaker.cooldownMs` take at most 2,147,483,647 ms, the longest delay a Node.js timer runs. A group ID that holds an unpaired surrogate is a programming error, because a URL cannot carry it |
