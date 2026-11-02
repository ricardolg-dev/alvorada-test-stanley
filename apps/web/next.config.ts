import type { NextConfig } from 'next';

// The page reaches the API through this same-origin proxy, so the API needs
// no CORS. The API address comes from API_URL, which defaults to
// 127.0.0.1:3001.
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3001';

const config: NextConfig = {
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${apiUrl}/:path*` },
    ]);
  },
};

export default config;
