# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: on this repository, open **Security → Report a vulnerability**. Don't open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it, the version affected and what an attacker could do with it. You should get a first answer within a week. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Supported versions

Security fixes go into the latest minor release.

| Version          | Supported |
| ---------------- | --------- |
| Latest 1.x minor | Yes       |
| Older 1.x minors | No        |

## Scope

In scope: the `agent-intake` package — the React components and hook, the runtime server (`agent-intake/server`), the CLI and Studio. Of particular interest are anything that could expose an LLM API key to a browser, let a request make the server fetch a URL or read a file, let a page reach Studio from another origin, or make the model add a form field the spec doesn't have.

Out of scope: the security of your own API that the form's operations call, and deployments that expose the runtime routes without the authentication and rate limiting the README asks for.
