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

## Development

The package supports Node.js 22.12 or later. [.nvmrc](.nvmrc) names the version to
develop with.

```sh
npm ci
npm run typecheck
npm test
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
