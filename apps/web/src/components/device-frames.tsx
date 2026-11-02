import type { ReactNode } from 'react';
import { DEVICE_META, type DeviceId } from './device-meta';

export interface FrameProps {
  id: DeviceId;
  online: boolean;
  children: ReactNode;
}

export function PhoneFrame({ id, online, children }: FrameProps) {
  return (
    <section className="phone" aria-label={`${DEVICE_META[id].name} phone`}>
      <div className="phone-status" aria-hidden="true">
        <span>9:41</span>
        <span className="island" />
        <span className={`sig ${online ? '' : 'off'}`}>
          <span className="bars">
            <i />
            <i />
            <i />
            <i />
          </span>
          {online ? '5G' : 'No signal'}
        </span>
      </div>
      {children}
    </section>
  );
}

export function WindowFrame({ id, online, children }: FrameProps) {
  return (
    <section className="window" aria-label={`${DEVICE_META[id].name} computer`}>
      <div className="window-bar" aria-hidden="true">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span className="addr mono">claims-desk.fictional-insurer.example</span>
        <span className={`conn ${online ? '' : 'off'}`}>
          {online ? 'Connected' : 'No connection'}
        </span>
      </div>
      {children}
    </section>
  );
}
