# Contributing

These rules cover every change to this repository. What the package itself must do is
in the LexQ SDK specification, copied in [spec/SPEC.md](spec/SPEC.md), and
[CONTRACT.md](CONTRACT.md) names the version this package follows.

- Unit and contract tests use a fake server. A change to how a call is sent or read
  also gets one real call against a live tenant before it lands. Outputs pasted into
  the README or comments come from a real run, and the pull request says which run.
- Sanitize pasted output. API keys, tenant IDs, and user IDs become placeholders.
  Apart from those, decision payloads stay exactly as they came back.
- Response types list only the fields LexQ sends, taken from the Execution API
  reference and a real response. The package's own result adds only `source`, and
  derives no field from LexQ's.
- `spec/` holds `SPEC.md` and `values.json`, unchanged copies of one version of the
  specification, and `spec.lock`, which records that version and the SHA-256 of each
  copy. Never edit these files by hand. To report a problem in the specification, open
  an issue in this repository. Maintainers replace the three files together when the
  package moves to another version of the specification, in one pull request that also
  names that version in `CONTRACT.md` and either changes the code and the tests to match
  or lists in `CONTRACT.md` what the code does not do yet. `npm test` fails when `spec/`
  does not hold exactly the three files, when one of them is not a regular file, when a
  copy's SHA-256 differs from the lock, or when `CONTRACT.md` names a version other than
  the lock's, names the lock's more than once, or leaves it out. Any string written like
  `v1.2.3` counts as a version, even one meant as a tag of this package.
- `spec/values.json` holds the values the specification sets: LexQ's enums and
  constants, the error codes the specification names, and the defaults.
  `scripts/gen-contract.mjs` writes `src/contract.ts` from it, and the tests take their
  expected values from it. `npm test` also fails when `src/contract.ts` was changed by
  hand, or when the documentation gives a default, a LexQ constant, or an error status
  that differs from `spec/values.json`.
- `contracts/lexq-manifest.sdk.json` holds a subset of those values. The same script
  writes it, and a later change removes it.
- Add a runtime dependency only with a reason in the pull request. Every dependency
  ships into every customer's server.
- Errors and logging follow [Errors](spec/SPEC.md#errors) in the specification.
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
- Link only to lexq.io, docs.lexq.io, and public repositories.
- Commit messages take the form `type: description`.

Run commands and supported Node.js versions belong in the README and `package.json`.
