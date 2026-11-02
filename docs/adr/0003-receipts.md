# 0003. Receipts per valid op_id, compared exactly and never recomputed

## Status

Accepted.

## Context

A client that loses a response cannot tell whether the server applied its operation. It has to be able to send the same operation again and get a safe answer. The statement asks that a resend with the same content return the original result, and that the same `op_id` with other content give `id_reutilizado`.

The original result can be out of date by the time of the resend. In the statement's example, the resend of the conflicting operation comes after another change has moved the note on.

## Decision

For each valid operation received for the first time, the server stores a receipt: the operation's content (`note_id`, `base_revision` and `text`) and its result, even when the result is a conflict.

- Validity comes first. An invalid operation is never looked up and never stored, so it does not occupy its `op_id`.
- "Same content" means the same `note_id`, `base_revision` and text, compared exactly, with no trimming and no case folding. The `op_id` is the key, not part of the content.
- A replay returns a copy of the stored result and applies nothing. Different content returns `id_reutilizado` and stores nothing, so the original content still gets the original receipt afterwards.
- A result is never recomputed on replay. The note query is the only place that shows current state.

## Alternatives considered

- Hashing the content. It would save little, because the stored result already holds the text and a receipt must return that result on a resend. Comparing the fields directly also keeps what was compared visible when debugging.
- Normalizing the text before comparing. Two different texts could then count as one, so a resend would return an old receipt and an edit would be lost silently. An exact comparison errs on the visible side: `id_reutilizado`.
- Storing invalid operations. It would make `invalid` replayable, but then a malformed operation would occupy its `op_id` and a later valid operation with the same id would get `id_reutilizado` for a request the server never accepted.
- Recomputing the result on replay. It would be shorter to write, but a resend would then mix receipts with current state: the resend of a conflict would show a newer server note than the one the conflict was about, and a replay could change a revision.

## How it was verified

- A valid operation that reuses the `op_id` of an invalid one is processed: the first test in [rules](../../apps/api/test/domain/rules.test.ts).
- The resend of the conflicting operation after a later change returns the revision-2 conflict while the query shows revision 3: the second test in the same file.
- `id_reutilizado` stores nothing and the original receipt survives, and a returned result cannot change the stored one: more tests in the same file.
- Replays of any queue are deep-equal and change nothing: [properties](../../apps/api/test/domain/sync.properties.test.ts).
- A resend over HTTP returns the original receipt with no new revision: [concurrency over HTTP](../../apps/api/test/api/concurrency.test.ts) and the [`curl` examples](../api.md).

## Consequences

- A resend can show old data on purpose. A person who wants the present reads the note.
- Receipts grow with every valid operation and are never removed, which is part of the unbounded memory limit.
- A device can retry a lost response without a risk of applying the change twice.
