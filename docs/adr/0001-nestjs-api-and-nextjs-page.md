# 0001. A NestJS API and a Next.js page as the delivery form

## Status

Accepted.

## Context

Case 05 asks for an offline notes sync simulator: devices edit notes without a connection, a server applies operations by revision, and conflicts are kept instead of overwritten. The statement does not say what the delivered thing must look like. I declared a full stack focus, so the delivery has to show a real server and a real client, not only a model of one.

The sync rules also need a place where the evaluator can poke at them. A person should be able to run the rules from a terminal, and also see two devices diverge on one screen.

## Decision

The delivery is two applications in one pnpm workspace:

- `apps/api` is a NestJS API that holds notes and operation receipts in memory and exposes the sync rules over HTTP.
- `apps/web` is a Next.js App Router page, the "Simulator", with a phone, a computer window and the server between them. It reaches the API through a same-origin `rewrites()` proxy, so the API needs no CORS.

HTTP is used although the statement does not require it: it is the boundary where a real client and a real server disagree about what was received, which is exactly what receipts, resends and lost responses are about.

There is no shared package. The web app keeps its own contract types, and `docs/contract/results.json` is one example of every result shape, read by the tests of both apps. It is test data only: neither app imports it at run time.

## Alternatives considered

- A CLI simulator. It is the smallest delivery, but it cannot show two devices and a server at once, and a person following the work would have to read logs to see a conflict.
- A single Next.js app with route handlers. It would run with one process, but it would blur the line between the client and the server that the focus is meant to show, and the sync rules would sit next to rendering code.
- Client and server both in the browser. It needs no server at all, but then nothing crosses a network: a lost response, a rejected request or a resend would all be simulated on one side of a function call.
- A shared contracts package. It would stop the two sides from drifting, but it adds a package, a build order and an import path for a handful of types. One example file that both test suites read gives the same protection against drift with no coupling at run time.

## How it was verified

- The API produces every shape in `docs/contract/results.json`: [contract test of the API](../../apps/api/test/api/contract.test.ts).
- The device applies every shape in the same file: [contract test of the device](../../apps/web/src/device/contract.test.ts).
- Both apps run together and a person-level flow crosses the proxy: [the Playwright flow](../../apps/web/e2e/simulator.spec.ts).
- A clean install and all checks run in [the CI workflow](../../.github/workflows/ci.yml).

## Consequences

- An evaluator needs two processes and two ports (3000 and 3001), started together by `pnpm dev`.
- A change to an HTTP result touches three places: the domain, the web contract types and the example file. `pnpm test` and `pnpm typecheck` fail when one of them is left behind.
- The page and the API share nothing at compile time, so a type error across the boundary is only caught by the contract checks. Only the test in `tests/`, at the repository root, imports both apps, to run real devices against the real rules.
