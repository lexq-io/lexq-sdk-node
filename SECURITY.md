# Security Policy

## Reporting a vulnerability

Please report security issues through GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/lexq-io/lexq-sdk-node/security/advisories/new)**

That form is private. Only you and the maintainers can read the report until they publish
an advisory. Do not open a public issue or pull request for a security problem. An issue is
world-readable the moment it is filed, which tells everyone about the flaw before there is
anything to upgrade to.

I acknowledge each report as soon as I can.

## Scope

This policy covers the `@lexq/sdk` package, including how it sends requests, holds the API
key, retries, and reads responses.

To report a problem in the LexQ API itself, use a contact in
[lexq.io's security.txt](https://lexq.io/.well-known/security.txt).

## Supported versions

Fixes go to the latest published version on npm. There are no long-term support branches, so
upgrading is the remedy.

## Credentials

Never include a real API key, token, or customer data in a report. A redacted example or a
description of the data is enough to reproduce the problem.
