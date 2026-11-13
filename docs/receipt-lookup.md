# Batch receipt lookup

A support panel needs to look up several operation receipts in one call to
the domain. This change adds the domain helper and tests. HTTP routing and
the panel are outside this change.

`lookupReceipts(store, opIds)` accepts a list of operation IDs and returns
one `{ op_id, result }` row per requested ID, in request order. Repeated IDs
produce repeated rows. An unknown ID has `result: null`.

For a known ID, `result` is the original stored receipt, including any
historical note or conflict data. Looking up receipts must not change notes,
receipt contents or receipt counts, or process an operation again.

All existing operation, resend and query contracts continue to apply. This
helper is synchronous and uses the existing in-memory store. Authentication,
retention, pagination and multiple server processes are outside this change.
