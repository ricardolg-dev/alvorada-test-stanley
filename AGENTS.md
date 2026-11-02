# AGENTS.md

`AGENTS.md` is the single source of truth for this repository's conventions and for every coding agent, Claude Code included. Change conventions here, never in `CLAUDE.md`.

Conventions for Case 05 of the Alvorada technical challenge, an offline notes sync simulator:

- The project uses pnpm workspaces, with `minimumReleaseAge: 10080` in `pnpm-workspace.yaml`, so no direct or transitive dependency published less than 7 days before the install is resolved. `pnpm-lock.yaml` is committed, and the pnpm version itself is at least 7 days old, pinned in `packageManager`.
- Monorepo with pnpm workspaces: `apps/api` (NestJS) and `apps/web` (Next.js App Router). There is no shared package; the web app keeps its own contract types and `docs/api.md` documents the HTTP contract. The apps do not import each other; only the test in the root `tests/` folder imports both.
- TypeScript strict in both apps.
- Layering: dependencies point inward. All server rules live in `apps/api/src/domain`, which imports nothing from NestJS. `presentation` holds the controller, which checks the body, sets status codes and calls the domain. `infrastructure` holds the in-memory store. There is no `application` layer: with a single use case it would only forward the call.
- Operations are validated one by one with Zod `safeParse` inside the domain, so one invalid operation yields its own result and never rejects the batch. Do not use Nest's `ValidationPipe` for the batch body.
- State lives in memory in one API process: notes and receipts. Batches are processed synchronously: a pure function decides each operation and a thin layer reads and writes the store, which keeps arrival order. A reset endpoint empties both for demonstrations and tests. No database, no disk storage.
- Module boundaries: the device logic in `apps/web/src/device` has no framework code and takes its I/O by injection (outbox, receipts, conflicts); components render it and dispatch actions. `src/guide` holds the scenarios as data and no sync rule, `src/api-client` holds the transport and the contract types, and `src/test-support` holds test-only doubles that runtime code never imports.
- Tests: Vitest across the repository, with `unplugin-swc` in the API; domain rules with unit tests and fast-check properties; the API with supertest; the device with unit tests; two real devices against the real rules with fast-check in the root `tests/` folder; components with Vitest, using jsdom where a test needs a DOM; and the two-device flow with a Playwright spec.
- The page reaches the API through a Next.js `rewrites()` proxy. The web app runs on 127.0.0.1:3000 and the API on 127.0.0.1:3001 by default, so the API needs no CORS. `WEB_PORT`, `API_PORT` and `API_URL` change them; the host stays 127.0.0.1, and no `.env` file is needed.
- Naming: everything written in the project is in English: code, identifiers, comments, tests, UI text, README, ADRs, commit messages and demonstration data. The only exceptions are what the statement itself fixes as a criterion: the status tokens `conflito` and `id_reutilizado`, the texts of the statement's example when it is reproduced (`início`, `edição A`, `edição B`), and the case title when it is quoted.
- All data is fictional: a fictional insurer's claim notes. No credentials, real personal data or employer code.

Instructions when changing code:

- Put every server rule in `apps/api/src/domain` as plain TypeScript functions over an explicit store; never import NestJS or Next.js there.
- Validate each operation with Zod `safeParse` before looking up its `op_id`; an invalid operation must not be stored.
- Keep the controller thin: parse the body, reject a body that is not a list with HTTP 400, call the domain, return one result per operation in order.
- Keep receipts and current notes separate: a replayed receipt is returned verbatim, and only the note query shows current state.
- In `apps/web`, change device behaviour only in `src/device`; keep components free of sync rules. Rules for what a device keeps and sends while offline live there. The server has the final say on every operation.
- When an HTTP result changes, update `docs/contract/results.json`, `apps/web/src/api-client/contract.ts` and the domain together; the tests of both apps read that file and `pnpm typecheck` compares it with the types. Also update `docs/api.md`.
- Keep batch processing synchronous, with no `await` between checking a revision and writing the note.
- Add dependencies only with pnpm and never lower `minimumReleaseAge` or exclude a package from it.
- Do not add a database, browser storage for the outbox, a backend queue, a repository layer, a Sync button, a shared package, `ValidationPipe` for the batch, automatic merging or clock-based conflict resolution.
- Before finishing a change, run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, and `pnpm test:e2e` when the page or the API contract changed.

## Commits and Pull Requests

### Commit Message Guidelines

**Format:**

```
<type>(<scope>): <subject>

Problem: <brief description of the problem>

Solution: <detailed description of changes and how they resolve it>
```

**Rules:**

1. **Subject line**: Use imperative style, limit to 50 characters
2. **Scope** (optional): Limit to 50 characters
3. **Body**: Use imperative style throughout
4. **Single line summary**: Be descriptive but keep the subject to one line
5. **No AI trailers**: Never add a `Co-Authored-By` or session trailer naming an AI assistant

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding or updating tests
- `docs`: Documentation changes
- `chore`: Maintenance tasks
- `perf`: Performance improvements

**Example:**

```
feat(sync): reject stale revisions as conflito

Problem: A device editing from an old revision could overwrite a newer
note, and the other device's text would be lost without notice.

Solution: Compare the base revision with the stored one before writing.
Return conflito with both texts when they differ and keep the note
unchanged. Store the receipt so a resend returns the same result.
```

### Pull Request Guidelines

Pull request descriptions must follow `.github/pull_request_template.md`, with only the `## Problem` and `## Solution` sections. Do **not** include a `Changes` or `Files Changed` section; GitHub already renders the diff.

**Title Format:**

```
<type>(<scope>): <subject>
```

**Description Format:**

```
## Problem

<Brief description of the problem being solved>

## Solution

<Detailed description of the work and how it resolves the problem>
```

**Rules:**

1. **Title**: Use the same format as commit messages (imperative style, limit to 50 characters)
2. **Problem section**: Clearly explain why this change is needed
3. **Solution section**: Describe how the problem was solved
4. **No generated footer**: No "generated with" line or session link

**Types:** Same as the commit types.
