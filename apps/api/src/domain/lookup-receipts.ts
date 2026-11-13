import type { StoredResult } from './model';
import type { SyncStore } from './store';

export interface ReceiptRow {
  op_id: string;
  result: StoredResult | null;
}

/** Looks up the receipts requested by a support panel. */
export function lookupReceipts(
  store: SyncStore,
  opIds: readonly string[],
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const keys = [...new Set(opIds)].sort();
  for (const opId of keys) {
    const receipt = store.receipts.get(opId);
    if (receipt === undefined) {
      rows.push({ op_id: opId, result: null });
      continue;
    }

    const result = receipt.result;
    if (result.status === 'conflito' && result.server !== null) {
      const note = store.notes.get(result.note_id);
      if (note !== undefined) result.server = { ...note };
    }
    rows.push({ op_id: opId, result: structuredClone(result) });
  }
  return rows;
}
