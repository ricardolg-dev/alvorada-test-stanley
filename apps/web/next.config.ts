import type { NextConfig } from 'next';

// The page reaches the API through this same-origin proxy, so the API needs
// no CORS. The API listens on 127.0.0.1:3001.
const config: NextConfig = {
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: 'http://127.0.0.1:3001/:path*' },
    ]);
  },
};

export default config;
