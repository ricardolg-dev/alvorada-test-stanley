# Offline notes sync simulator

A sync simulator for two devices that edit the same notes, one of them offline, against a server that keeps conflicts instead of overwriting work.

In ten minutes: [install and run](#install-run-and-test), the Conflict scenario in the [demonstration](#demonstration), the [highlighted tests](#highlighted-tests) and the [decisions](#decisions).

## Case and focus

This is my answer to Case 05 of the Alvorada technical challenge, "Sincronização de notas offline". Devices send operations (`op_id`, `note_id`, `base_revision`, text) to a server. The server applies them by revision, keeps a receipt for every valid `op_id`, reports a `conflito` when a base revision is outdated, and answers `id_reutilizado` when an `op_id` comes back with other content.

My declared focus is full stack. The server is a NestJS API, and the client is a Next.js page that simulates two devices: a field adjuster's phone and a claims office computer. The statement does not require HTTP. I use it because a real client and a real server are where a lost response, a resend and an outdated edit actually happen, and I want them to be visible rather than described.

The demonstration uses a fictional insurer's claim notes. The decisions behind the shape of the work are in the [four ADRs](#decisions).

Time spent: about 5 to 5.5 hours, including planning, review and directing the coding agents.

## Install, run and test

Requirements: Node.js 24 (see `.nvmrc`) and pnpm 12.15.0, the version pinned in `packageManager`.

Install pnpm with npm, not with Corepack. Corepack 0.34 fails with `MODULE_NOT_FOUND` when it is asked to run pnpm 12.

```bash
npm install --global pnpm@12.15.0
```

Then, from a clean clone:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

- `pnpm dev` starts both apps. The page listens on `127.0.0.1:3000` and the API on `127.0.0.1:3001`. Both ports must be free. To use other ports, set `API_PORT` and `WEB_PORT` in the environment:

  ```bash
  API_PORT=3101 WEB_PORT=3100 pnpm dev
  ```

- Wait for `Nest application successfully started` before you open the page. If you open it too early, it shows `Could not read the server` and `Reset failed`. Reload once the API is up.
- The page and the API share one server: opening the page, `pnpm test:e2e` and the first `curl` command all reset it, and an open page does not notice a change made elsewhere until its next device action.

Checks:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test        # Vitest: domain, API, page and two-device tests
pnpm --dir apps/web exec playwright install chromium    # once, before test:e2e
pnpm test:e2e    # Playwright: starts both apps if they are not running
```

`pnpm test:e2e` uses the same ports, and the same variables change them. If `pnpm dev` is already running, it reuses those servers. On a Linux machine without the browser libraries, add `--with-deps` to the install, as the CI workflow does.

The workflow in `.github/workflows/ci.yml` runs the same checks on a clean machine for every push.

## Demonstration

Run `pnpm dev`, wait for the API, and open <http://127.0.0.1:3000>. The page opens in the "Conflict between devices" scenario with an empty server. A guide bar offers two scenarios and Free play. Each step names the device, the action and the expected result, highlights the control, prefills a suggested text and offers "Do this step". After the step it compares the state with what was expected. The "Reset server and devices" button empties the server and both devices and restarts the scenario.

### Conflict between devices (8 steps)

1. **Expected:** the phone creates the claim note, and the server holds it at r1. An online device sends right away. **Do:** create the claim note on the phone.
2. **Expected:** the office also sees the note at r1. **Do:** pull the notes on the office computer.
3. **Expected:** the line from the phone to the server breaks. Editing still works, and Pull turns off. **Do:** take the phone offline.
4. **Expected:** the edit stays pending on base r1, and the server stays at r1. **Do:** edit the note on the phone.
5. **Expected:** the office edit is sent right away and the server moves to r2. The phone does not know yet. **Do:** edit the same note at the office.
6. **Expected:** the pending operation goes out by itself on base r1, and the server answers `conflito`: it keeps r2, and both texts come back. **Do:** bring the phone back online.
7. **Expected:** a new operation with a new `op_id`, on base r2, is accepted: the server moves to r3 and neither text is lost. **Do:** send a combined text to resolve the conflict.
8. **Expected:** the original receipt comes back, still showing r2, and the server stays at r3. **Do:** resend the conflict receipt.

At the end the guide reports how many steps matched. Following the eight steps with "Do this step" reaches 8 of 8.

### Lost response and resend (3 steps)

1. **Expected:** the next answer from the server will be dropped on its way back. **Do:** turn on "Lose next response" for the phone.
2. **Expected:** the server creates r1, but no receipt arrives. The operation stays pending and frozen, and Retry appears. **Do:** create the claim note on the phone.
3. **Expected:** the stored receipt returns: created at r1, no new revision, and still one stored receipt. **Do:** retry the operation.

Following the three steps reaches 3 of 3. Choosing Free play leaves both devices usable.

## Highlighted tests

All three are in [`rules.test.ts`](apps/api/test/domain/rules.test.ts).

1. **An invalid operation does not occupy its `op_id`** (`processes a valid operation that reuses the op_id of an invalid one`). An operation with `base_revision` -1 and `op_id` `X` is followed by a valid one with the same `op_id`. Expected: `invalid`, then `created` at revision 1, with one stored receipt. Catches a server that stores invalid operations.
2. **A resend returns what happened, not what is true now** (`returns the revision-2 conflict on a late resend while the query shows revision 3`). After O1 to O4, the resend of O3 equals the original conflict at revision 2, while the query shows revision 3. Catches a server that recomputes receipts.
3. **Base revision 0 does not overwrite** (`reports base revision 0 on an existing note as a conflict and leaves the note alone`). On an existing note, it gives `conflito` with reason `revision_mismatch`, and the note keeps its text and revision. Catches a create that overwrites.

The statement's own example runs in [`statement-example.test.ts`](apps/api/test/domain/statement-example.test.ts).

The browser checks, with screenshots and what is still open, are in [docs/validation.md](docs/validation.md).

## Decisions

The four ADRs are in `docs/adr/`. I highlight the first and the last.

- [0001, a NestJS API and a Next.js page](docs/adr/0001-nestjs-api-and-nextjs-page.md): **highlighted.** The delivery form under a full stack focus, with pnpm workspaces and no shared package.
- [0002, pure domain and layers](docs/adr/0002-pure-domain-and-layers.md): the rules in a domain that imports nothing from NestJS, per-operation validation and synchronous processing in memory.
- [0003, receipts](docs/adr/0003-receipts.md): a receipt per valid `op_id`, compared exactly, validated before lookup and never recomputed.
- [0004, an outbox on each device](docs/adr/0004-device-outbox.md): **highlighted.** One pending operation per note, frozen once sent, never rebased by a pull.

Two decisions from the work:

**What counts as the same content on a resend?** The statement says a repeated `op_id` with the same content returns the receipt, but not how to compare. I wanted to know whether exact comparison was the best choice, so I compared it with normalizing the text and with a hash. The first proposal for the hash said it would save memory. I observed that a receipt must return its result, and the result already holds the text, so it would save little. I kept the exact comparison: a false mismatch gives a visible `id_reutilizado`, while normalizing could return an old receipt and lose an edit silently. See [ADR 0003](docs/adr/0003-receipts.md).

**Can a saved draft overwrite newer work?** The tests passed, but I wanted to see the flows in a real browser, so I asked for a visual and flow validation. It showed that a draft saved after a pull replaced the newer text with no conflict, which is what the statement asks to prevent. I decided to fix it: a draft now keeps the revision it started from, and the same steps give `conflito`. See [docs/validation.md](docs/validation.md).

## How AI helped

I used Claude Code with my own aimi-engineering plugin (<https://github.com/aimi-so/aimi-engineering-plugin>).

**How it helped.** The plugin plans the work as small stories, each with acceptance criteria and a command that must pass. Claude Code implements one story at a time, and each story is its own commit. `AGENTS.md` holds the repository's conventions for any coding agent, and `CLAUDE.md` only imports it, so the two cannot drift apart.

**What I kept or changed.**

| Topic                                | AI proposal                                   | My choice                                                                                                      |
| ------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Web test importing the API domain    | Keep it and document the exception in the ADR | Changed: I decided to move it to `tests/`, so the apps do not import each other                                |
| Browser validation                   | Automated tests and spot checks               | Changed: I asked for a visual and flow validation, which found a draft overwriting newer text with no conflict |
| Script replaying the `curl` examples | Keep it and add it to CI                      | Changed: I removed it after seeing that the tests already covered those answers                                |
| Hash to compare content              | Argued it would save memory                   | Changed: I observed that receipts already hold the text, so it would save little                               |
| API documentation                    | Keep it all in the README                     | Changed: I moved it to `docs/api.md`, with no Swagger                                                          |
| Decisions in the README              | Full text in the README                       | Changed: I kept the details in the ADRs and a short summary in the README                                      |
| Code out of line with an ADR         | Adjust the ADR text                           | Changed: I decided to fix the code so the ADR's decision holds                                                 |
| Hardcoded ports                      | Not in the plan                               | Changed: I reviewed the hardcoded values and moved the ports to environment variables                          |
| Exact content comparison             | No normalization of the text                  | Kept: I chose the error that stays visible over one that could lose an edit                                    |
| `frozen \|\| busy` in two places     | Treat it as duplication to fix                | Kept: I observed that the page shows the rule and the device enforces it                                       |
| Repository layer                     | Do not add one                                | Kept: I reviewed it and decided it would only forward calls                                                    |

**How it was verified.** I did not take the tool's report as the result. I used the page in the browser myself, and I had the plugin's reviewers go through architecture, bugs, simplicity and documents. When they reported findings, I asked for each one to be proven before accepting a fix, by reproducing it in a browser or with a test that failed first. I also had each rule of the statement checked against the running API, including its example. I read the reports and decided what to fix, what to keep and what to leave out, as the table above shows. The repository carries the checks to run again: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm test:e2e`, and CI runs them on a clean machine. The browser checks are in [docs/validation.md](docs/validation.md).

## Data and language

All data is fictional: a fictional insurer's claim notes. The repository holds no credentials, no real personal data and no employer code. Everything written in the project is in English: code, identifiers, comments, tests, UI text, this README, the ADRs and the demonstration data. The only exceptions are what the statement itself fixes as a criterion: the status tokens `conflito` and `id_reutilizado`, the texts of the statement's example when it is reproduced, and the case title when it is quoted.

## Limits and production

Limits of this version:

- State is in memory. Stopping the API loses every note and receipt. [ADR 0002](docs/adr/0002-pure-domain-and-layers.md) explains why there is no database.
- One API process. Synchronous processing keeps arrival order only because there is one process.
- Device state is lost on a page reload, and a reload empties the server too: the page resets the server when it opens. [ADR 0004](docs/adr/0004-device-outbox.md) explains why there is no `localStorage`.
- The reset endpoint is unauthenticated. Anyone who can reach the API can empty it.
- Memory is unbounded: nothing evicts notes or receipts.

In production, several API instances would share a database. A conditional update on the revision (`UPDATE ... WHERE revision = :base`) and a unique `op_id` would sit in one PostgreSQL transaction, so that a change and its receipt are stored together or not at all. The receipt rules and the device outbox would stay as they are.

## Pending

Nothing from the case is left undone. The known limits are in [Limits and production](#limits-and-production).

## HTTP API

The page reaches the API through a same-origin proxy. The HTTP contract and sixteen `curl` examples with their answers are in [docs/api.md](docs/api.md).

## Rule interpretations

The statement leaves some points open. These are my readings, and each is covered by tests.

1. **Field validity.** `op_id` and `note_id` are non-empty strings, `base_revision` is an integer of 0 or more, and text is a string that may be empty. A missing or an extra field makes the operation `invalid`.
2. **Validity before lookup.** An invalid operation whose `op_id` was already used returns `invalid`, never the stored receipt and never `id_reutilizado`. An invalid operation is not stored, so it does not occupy its `op_id`.
3. **Same content.** The same `note_id`, `base_revision` and text, compared exactly, with no trimming or case folding. The `op_id` is the key, not part of the content.
4. **One `op_id` space.** An `op_id` is unique across the whole server, not per note.
5. **Conflict reasons.** Base revision 0 on an existing note, or any base revision other than the current one, is `conflito` with reason `revision_mismatch` and the note's current data. A base revision above 0 on a note that does not exist is `conflito` with reason `note_not_found` and no server data. The client's proposal is in both.
6. **`id_reutilizado` changes nothing.** It stores nothing, and sending the original content afterwards still returns the original receipt.
7. **Tokens and codes.** The tokens from the statement stay as written: `conflito` and `id_reutilizado`. The other results are `created`, `updated` and `invalid`. Only a body that is not a list is rejected as a whole, with HTTP 400 (malformed JSON, an empty body and a non-JSON content type included). Any list, `[]` included, gets HTTP 200 with one result per element, up to a 10 MB body. `POST /reset` answers 204.
8. **Repeated `op_id` in one batch.** The second occurrence is processed after the first, so it gets the first's receipt (same content) or `id_reutilizado` (different content).
9. **Generated `note_id`.** The statement does not say who names a note. A device generates the id when it creates the note: a claim number such as `CLM-7F3A2C91`, which is `CLM-` plus eight uppercase hexadecimal characters, retried if the device already holds it. It never changes after creation. Each `op_id` is a device prefix plus 64 random bits.
10. **One request in flight.** A device has at most one request in flight. While it waits, its actions are refused or disabled. A Reset waits for an open request to end before it empties the server, and blocks the controls meanwhile, so nothing lands after it. A rejected request, a timeout and a non-2xx answer count as a lost response: the operations stay frozen and Retry appears.
11. **A change with the same text is still a change.** A new `op_id` on the current revision raises the revision even when the text is equal, as the statement says. Only a resend of the same `op_id` applies nothing.
