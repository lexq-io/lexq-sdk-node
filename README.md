# LexQ Node.js SDK

The Node.js client for the [LexQ](https://lexq.io) execution API, to be published as
`@lexq/sdk`.

**In development. There is nothing to install yet.** The `@lexq/sdk` package on npm
is a name reservation until the first release.

Your backend sends facts, such as an order's amount, and LexQ evaluates your rules and
returns the decision. This package makes that call, with four safeguards:

- Every call has a timeout that covers its retries.
- An attempt that times out or hits a temporary error is sent again with the same
  `Idempotency-Key`. If the first attempt succeeded, LexQ returns its result instead
  of running the decision again.
- A circuit breaker stops calling LexQ for a while when calls keep failing.
- Every call requires a fallback: the decision your service uses when the call fails.

[CONTRACT.md](CONTRACT.md) spells out each safeguard and how the package reads LexQ's
responses.

Until the first release, the clients in
[lexq-examples](https://github.com/lexq-io/lexq-examples) show how to call the API,
and [When LexQ Is Slow or Unavailable](https://docs.lexq.io/api/execution#when-lexq-is-slow-or-unavailable)
covers what to do when a call fails.

## Usage

Run the client on a server. It refuses to start in a browser, where the API key would
reach every visitor.

```ts
import { LexqClient } from "@lexq/sdk";

// Create one client and reuse it: the circuit breaker belongs to it.
const lexq = new LexqClient({ apiKey: process.env.LEXQ_API_KEY! });

const result = await lexq.execute(groupId, {
  facts: { paymentAmount: 150000, customerTier: "VIP" },
  // A/B routing reads trafficKey from contexts. In facts it is ignored.
  contexts: { trafficKey: customerId },
  idempotencyKey: `checkout-${orderId}`,
  // What your service does when the call fails: here, no discount.
  fallback: () => ({ discount: 0 }),
});

if (result.source === "lexq") {
  // result.facts, result.isBlocked, and result.traceId, which you store with the order.
  // result.decisionTraces says why each rule fired or did not.
} else {
  // result.value is what the fallback returned, and result.error says why.
}
```

Every number in a decision's facts, contexts, and traces is a `Decimal`, because LexQ
calculates in decimal and an amount can have more digits than a JavaScript number
holds. Read it with `toString()`, for example to pass it to a decimal library, or with
`toNumber()` when the nearest JavaScript number is enough. Arithmetic on a `Decimal`
throws instead of rounding. To send an exact amount, pass `new Decimal("150000.50")` or
a bigint. A string such as `"150000"` stays a string, and a fact whose type is NUMBER
rejects it with `P-060`.

By default a call has a 15-second deadline and 10 seconds per attempt, and the circuit
breaker opens for 10 seconds after 5 failed calls in a row. Set `timeoutMs` lower for a
request that cannot wait that long. LexQ still finishes and bills a decision that the
deadline cut off. If it succeeded, repeating the call within 24 hours with the
`idempotencyKey` from the error returns it instead of running it again.
[Retrying a Failed Call](https://docs.lexq.io/api/execution#retrying-a-failed-call) says
what a repeat gets otherwise. The options are documented on `ClientOptions` and
`ExecuteOptions` in the type definitions.

## Development

The package supports Node.js 22.12 or later. [.nvmrc](.nvmrc) names the version to
develop with.

```sh
npm ci
npm run typecheck
npm test
```

`contracts/lexq-manifest.sdk.json` holds the LexQ limits and error codes the client relies
on, taken from LexQ's contract manifest, and `src/contract.ts` is generated from it. To
regenerate both from a copy of the manifest kept outside this repository:

```sh
node scripts/gen-contract.mjs ../lexq-manifest.json
```

## Maintenance

I'm Sanghyun Park, and I maintain this package. I write most of it with AI coding
tools, mainly Claude Code. I decide each change, read every commit and diff before it
is pushed, and merge every pull request myself. The rules for changing the package
are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report a vulnerability privately, as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
