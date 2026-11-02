import { defineConfig } from 'vitest/config';

// Only the tests that join both apps; each app runs its own tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
