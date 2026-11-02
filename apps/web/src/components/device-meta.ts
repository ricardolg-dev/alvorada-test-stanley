import type { IconName } from './icons';

export type DeviceId = 'adjuster' | 'office';

export interface DeviceMeta {
  name: string;
  kind: 'phone' | 'computer';
  icon: IconName;
  app: string;
}

export const DEVICE_META: Record<DeviceId, DeviceMeta> = {
  adjuster: {
    name: 'Field adjuster',
    kind: 'phone',
    icon: 'phone',
    app: 'Field notes',
  },
  office: {
    name: 'Claims office',
    kind: 'computer',
    icon: 'desktop',
    app: 'Claims desk',
  },
};
