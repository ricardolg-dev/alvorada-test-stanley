import { DEVICE_META, type DeviceId } from './device-meta';
import { Icon } from './icons';

export interface DeviceToolbarProps {
  id: DeviceId;
  online: boolean;
  loseNextResponse: boolean;
  /** True while a request is in flight: the network switch waits for it. */
  busy: boolean;
  onOnline: (online: boolean) => void;
  onLoseNextResponse: (value: boolean) => void;
}

/** Network switch and lost-response toggle, above the frame and outside it. */
export function DeviceToolbar({
  id,
  online,
  loseNextResponse,
  busy,
  onOnline,
  onLoseNextResponse,
}: DeviceToolbarProps) {
  const meta = DEVICE_META[id];
  return (
    <div className="dev-toolbar">
      <span className="dev-name">
        <Icon name={meta.icon} /> {meta.name}{' '}
        <span className="kind">· {meta.kind}</span>
      </span>
      <div className="dev-controls">
        <div className="seg" role="group" aria-label={`${meta.name} network`}>
          <button
            type="button"
            data-fid={`net:${id}:online`}
            aria-pressed={online}
            disabled={busy}
            onClick={() => {
              onOnline(true);
            }}
          >
            Online
          </button>
          <button
            type="button"
            className="off"
            data-fid={`net:${id}:offline`}
            aria-pressed={!online}
            disabled={busy}
            onClick={() => {
              onOnline(false);
            }}
          >
            Offline
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            data-fid={`lose:${id}`}
            checked={loseNextResponse}
            onChange={(event) => {
              onLoseNextResponse(event.target.checked);
            }}
          />{' '}
          Lose next response
        </label>
      </div>
    </div>
  );
}
