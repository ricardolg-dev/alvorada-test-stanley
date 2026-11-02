import type { NextConfig } from 'next';

// The page reaches the API through this same-origin proxy, so the API needs
// no CORS. The API address comes from API_URL, or else from API_PORT, which
// defaults to 3001.
const apiUrl =
  process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`;

const config: NextConfig = {
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${apiUrl}/:path*` },
    ]);
  },
};

export default config;
