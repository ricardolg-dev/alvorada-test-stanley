# 0002. Pure domain, per-operation validation and synchronous processing

## Status

Accepted.

## Context

A batch of operations can mix valid operations, invalid ones, conflicts and replays. The statement asks for one result per operation, in order, and for an error or a conflict not to stop the operations that follow. The rules for revisions and receipts are the part of the work that has to be right, so they should be easy to test without starting a server.

The API also has to keep arrival order. Two operations on the same revision must not both succeed.

## Decision

The API has three layers, and dependencies point inward:

- `domain` holds every sync rule as plain TypeScript functions over an explicit store. It imports nothing from NestJS, and a lint rule forbids `Date` there. A pure function, `decideOperation`, decides the result of one valid operation against the current note, and a thin function reads and writes the store around it.
- `presentation` holds the controller. It checks that the body is a list (anything else is HTTP 400), sets status codes, calls the domain and returns one result per operation.
- `infrastructure` holds the in-memory store: two `Map` objects, one for notes and one for receipts.

Each operation is validated on its own with a Zod `safeParse` inside the domain, before its `op_id` is looked up. An invalid operation gets its own `invalid` result and is never stored. Nest's `ValidationPipe` is not used for the batch.

A batch is processed synchronously. Nothing is awaited between reading a note and writing it, so in one process the order of arrival is the order of decision. State lives in memory: no database and no disk.

There is no `application` layer. With a single use case it would only forward the call.

## Alternatives considered

- `ValidationPipe` with class-validator. It rejects the whole request when one element is wrong, which is the opposite of one result per operation. Making it tolerant means working around it.
- Validation in the controller. It would work, but the rule "invalid before lookup" would then live in two layers, and the domain tests could not cover it.
- An `application` layer. With one use case it would add a file that forwards a call.
- A repository with methods such as `findNote` and `saveNote`. With one in-memory store, each method would only forward to a `Map`. It would not prepare the work for a database either: there, the revision check moves into a conditional update in one transaction, and the code becomes asynchronous. The domain already depends on the `SyncStore` interface, not on its implementation.
- A backend queue. It would serialise writes, but one process already does, and a queue adds a moving part without a second consumer to justify it.
- PostgreSQL now. The statement says disk storage is not needed, and one process has no concurrent writers to control. A database would add setup for whoever runs the work, migrations, and slower property tests. Production with several API instances would need it: a conditional update on the revision and a unique `op_id` in one transaction.

## How it was verified

- The statement's example, O1 to O4 with replays and a reused id: [statement example](../../apps/api/test/domain/statement-example.test.ts).
- Rules in combination, including the three highlighted scenarios: [rules](../../apps/api/test/domain/rules.test.ts).
- Per-operation validation and ids that collide with `Object` names: [validation](../../apps/api/test/domain/validation.test.ts).
- A fast-check model over random queues, including prefixes of a queue: [properties](../../apps/api/test/domain/sync.properties.test.ts).
- One result per operation over HTTP, the 400 for a body that is not a list, and an empty batch: [operations over HTTP](../../apps/api/test/api/operations.test.ts).
- Two simultaneous batches with the same base revision give one `updated` and one `conflito`: [concurrency over HTTP](../../apps/api/test/api/concurrency.test.ts).

## Consequences

- The rules can be tested as functions, with no server and no framework.
- The state is lost when the API process stops, and a second API process would have its own, separate state. Both are documented as limits in the README.
- Memory is unbounded: nothing evicts notes or receipts.
- Synchronous processing is correct only because there is one process. Moving to several instances means moving the revision check into the store.
