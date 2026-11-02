import type { Receipt } from '../device/device';
import type { DeviceId } from './device-meta';
import { ResultSummary, StatusPill } from './result-summary';

export interface ReceiptsListProps {
  deviceId: DeviceId;
  /** Newest first, as the device keeps them. */
  receipts: readonly Receipt[];
  /** Resend is off while the device is offline or has a request in flight. */
  disabled: boolean;
  onResend: (seq: number) => void;
}

export function ReceiptsList({
  deviceId,
  receipts,
  disabled,
  onResend,
}: ReceiptsListProps) {
  return (
    <details>
      <summary data-fid={`receipts:${deviceId}`}>
        {`Receipts (${receipts.length})`}
      </summary>
      <div className="receipts">
        {receipts.length === 0 ? (
          <p className="empty">
            No receipts yet. They arrive when an operation reaches the server.
          </p>
        ) : (
          receipts.map((receipt) => (
            <div className="receipt" key={receipt.seq}>
              <div>
                <span className="mono">{receipt.op.op_id}</span>{' '}
                {receipt.resend ? (
                  <StatusPill text="resent" kind="rev" />
                ) : null}
                <br />
                <ResultSummary result={receipt.result} />
              </div>
              <button
                type="button"
                data-fid={`resend:${deviceId}:${receipt.seq}`}
                disabled={disabled}
                onClick={() => {
                  onResend(receipt.seq);
                }}
              >
                Resend
              </button>
            </div>
          ))
        )}
      </div>
    </details>
  );
}
