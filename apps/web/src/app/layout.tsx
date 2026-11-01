import type { ReactNode } from 'react';

export const metadata = {
  title: 'Offline notes sync',
  description: 'Two devices editing the same notes while offline.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
