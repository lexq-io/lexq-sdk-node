# Contributing

These rules cover every change to this repository. What the package itself must do
is in [CONTRACT.md](CONTRACT.md).

- Unit and contract tests use a fake server. A change to how a call is sent or read
  also gets one real call against a live tenant before it lands. Outputs pasted into
  the README or comments come from a real run, and the pull request says which run.
- Sanitize pasted output. API keys, tenant IDs, and user IDs become placeholders.
  Apart from those, decision payloads stay exactly as they came back.
- Response types list only the fields LexQ sends, taken from the Execution API
  reference and a real response. The package's own result may add derived fields,
  such as `isBlocked`.
- LexQ's own limits and error codes that the client relies on, such as how deep a
  request body may nest, live in `contracts/lexq-manifest.sdk.json`, and
  `src/contract.ts` is generated from it. Change them by regenerating both from LexQ's
  contract manifest, never by hand. `npm test` fails when the two files disagree or
  the documentation states another value.
- Add a runtime dependency only with a reason in the pull request. Every dependency
  ships into every customer's server.
- Log nothing by default. Errors carry the status, `errorCode`, LexQ's `message`, and
  the idempotency key. They never carry the API key, a fact's value, or a raw response
  body, because callers log errors. For the same reason, every message is one line of
  bounded length, even where it quotes text the client did not write, such as LexQ's
  message or a key in `facts`. Report anything else through the result and an optional
  hook the caller owns.
- Publish only from a tag. Raise `version` in `package.json` inside the pull request,
  where a reviewer sees it beside the change that justifies it. After the merge, push
  the matching `v<version>` tag. CI stages that version on npm with provenance, and it
  goes public only when a maintainer approves it there with two-factor authentication.
  Never run `npm publish` by hand. `repository` in `package.json` names this
  repository, because npm checks the provenance against it. The first release is
  `0.1.0` or later, because `0.0.1` on npm is a name reservation.
- Pick the version number by what breaks. A change is breaking when a call that used
  to work now fails or does something else. That includes removing or renaming an
  option, changing its type, making an optional argument required, narrowing the
  values it accepts, and changing a safeguard in a way a caller notices. Raising the
  minimum Node.js version is breaking too. Before `1.0.0`, a breaking change raises
  the minor number. From `1.0.0` on, it raises the major.
- Link only to docs.lexq.io and public repositories.
- Commit messages take the form `type: description`.

Run commands and supported Node.js versions belong in the README and `package.json`.
