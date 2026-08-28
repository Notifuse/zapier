import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The Zapier runtime is Node 22, and createAppTester talks to nock-intercepted
    // HTTP. Running files in a single fork keeps nock's global interceptors from
    // leaking between workers.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
})
