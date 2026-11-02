# 0004. An outbox on each device, with one pending operation per note

## Status

Accepted.

## Context

A device that is offline keeps editing. When it reconnects, it has to send what it did, and the server will compare each operation with the note as it is then. The device needs a rule for what it keeps while offline, what base revision it sends, and what it does when a response is lost.

The base revision matters most. It says what the person was looking at when they edited, and it is the only thing that lets the server tell a fresh edit from an outdated one.

## Decision

Each device keeps its pending operations in an outbox, with at most one per note.

- Editing a note again before it is sent replaces the text of its pending operation. The `op_id` and the place in the queue stay the same.
- Once an operation is sent, it is frozen. It is resent unchanged, with the same `op_id`, until a receipt arrives. A note with a frozen operation cannot be edited, while other notes can.
- The base revision is the revision the device last saw for that note, or 0 when the device is creating it. A receipt for an operation the device sent updates what it saw and never lowers it. A resent receipt is only displayed.
- A pull never rebases a pending operation. The base revision stays the one the person edited from, so an outdated edit still meets the conflict instead of overwriting the server.
- Keeping the server text discards the proposal and sends nothing, because the person is accepting what the server already holds. A new operation would raise the revision with no change, and could conflict with another device's pending edit.
- The outbox lives in memory. It is not saved in `localStorage`.
- The outbox belongs to a device. There is no outbox on the server.

## Alternatives considered

- Sending one operation per edit. Two edits of the same note made offline would both carry the same base revision. The first would be accepted and the second would meet a conflict with the first, so a device would conflict with itself. One operation per note avoids it, and the last text wins on that device by design.
- Rebasing pending operations after a pull. It would turn real conflicts into silent overwrites, because the device would claim it had seen a revision that the person never looked at.
- Saving the outbox in `localStorage`. The statement does not ask for edits to survive a page reload. A saved outbox could also outlive the in-memory server: after an API restart or a Reset, a device would hold operations built on revisions the server no longer has. The loss of device state on reload is documented as a limit.

## How it was verified

- Editing twice while offline leaves one pending operation with the latest text and the same `op_id`, and a back-online send carries the outbox in order: [device tests, outbox while offline](../../apps/web/src/device/device.test.ts).
- A sent operation is frozen, and Retry brings back the stored receipt: the same file, sections on sending and on lost responses.
- A pull never changes the base revision of a pending operation, and a stale receipt never lowers the revision seen: the same file.
- Two devices, a conflict, a resolution and a resend, against the real API: [the Playwright flow](../../apps/web/e2e/simulator.spec.ts).
- Keeping the server text sends no request and leaves the revision and the receipt count unchanged: [the Playwright flow](../../apps/web/e2e/simulator.spec.ts).

## Consequences

- A person who edits a note several times offline sends one operation, so the server sees one revision change, not one per keystroke or per save.
- The earlier texts of an offline note are not kept. Only the last text is proposed.
- State is lost on a page reload, and a reload empties the server too.
- The conflict view is the only place where two texts are put side by side, and a person chooses the result. Nothing is merged automatically.
