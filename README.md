# LexQ Node.js SDK

The Node.js client for the [LexQ](https://lexq.io) execution API, published on npm as
`@lexq/sdk`.

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

## Usage

```sh
npm install @lexq/sdk
```

The package supports Node.js 22.12 or later. It is an ES module, and CommonJS code can
load it with `require()` as well.

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
  // LexQ's data as it came back. Store result.traceId with the order.
  // A rule that changed paymentAmount put the new value in mutatedFacts.
  const amount = result.mutatedFacts.paymentAmount ?? result.inputFacts.paymentAmount;
  // A BLOCK action does not fail the call. It sets isBlocked: true in one of the layers.
  const blocked = [result.generatedVariables, result.mutatedFacts, result.inputFacts].some(
    (layer) => layer.isBlocked === true,
  );
  // result.decisionTraces says why each rule fired or did not.
} else {
  // result.value is what the fallback returned, and result.error says why.
}
```

A decision is LexQ's `data` as it came back, with `source` added. A layer or a trace list
that LexQ leaves out is empty, so you can read it without a check. The facts come in three
layers: `inputFacts` as LexQ received them, `mutatedFacts` with the new value of each fact
the request sent that a rule changed, and `generatedVariables` with the keys the request
did not send, such as a `SET_FACT` target. A `MUTATE_FACT` that changes `paymentAmount`
also adds `paymentAmount__delta` to `generatedVariables`: how much it changed, not the new
value. To send a decision's facts to another call, take each value from `mutatedFacts` or
`generatedVariables` when it is there and from `inputFacts` otherwise, and leave out the
`__delta` keys and `isBlocked`. LexQ answers a request whose `facts` holds a key that ends
in `__delta` with `400` (`P-068`), and the fallback runs. Send an earlier block under
another key, such as `previouslyBlocked`: a request that sends `isBlocked: true` looks
blocked whether or not a rule blocked it.

Every number in a decision's facts, contexts, and traces is a `Decimal`, because LexQ
calculates in decimal and an amount can have more digits than a JavaScript number
holds. Read it with `toString()`, for example to pass it to a decimal library, or with
`toNumber()` when the nearest JavaScript number is enough. Arithmetic on a `Decimal`
throws instead of rounding. To send an exact amount, pass `new Decimal("150000.50")` or
a bigint. A string such as `"150000"` stays a string, and a fact whose type is NUMBER
rejects it with `P-060`.

To send a fact you have no value for, set it to `null`. LexQ keeps the key, but a
condition on a `null` value does not match, even in a rule that blocks. Make sure the
group still decides such a request, as
[When an input is null](https://docs.lexq.io/guides/policy-rules#when-an-input-is-null)
shows. A fact whose value is `undefined` is left out of the request. If an enabled rule
reads it, LexQ answers `P-015` and the call uses the fallback.
[Required vs Optional Facts](https://docs.lexq.io/guides/fact-definitions#required-vs-optional-facts)
lists the keys a request must send, and what happens when a `MUTATE_FACT` target is
`null`.

By default a call has a 15-second deadline and 10 seconds per attempt, and the circuit
breaker opens for 10 seconds after 5 failed calls in a row. Set `timeoutMs` lower for a
request that cannot wait that long. LexQ still finishes and bills a decision that the
deadline cut off. If it succeeded, repeating the call within 24 hours with the
`idempotencyKey` from the error returns it instead of running it again.
[Retrying a Failed Call](https://docs.lexq.io/api/execution#retrying-a-failed-call) says
what a repeat gets otherwise. The options are documented on `ClientOptions` and
`ExecuteOptions` in the type definitions.

## Development

[.nvmrc](.nvmrc) names the Node.js version to develop with.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` compiles `src` into `dist/`, which is what npm publishes.

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
