import { afterAll, beforeAll } from '@lightning-js/lightning'
import type { TestClient, TestRequest } from './client.js'
import { createTestServer, type TestServer, type TestServerOptions } from './server.js'

export { TestFetchError, type TestClient, type TestRequest } from './client.js'
export { createTestServer, type TestServer, type TestServerOptions } from './server.js'

export interface SetupOptions extends TestServerOptions {
  setupTimeout?: number
  teardownTimeout?: number
}

export function setup(options: SetupOptions): TestClient {
  const setupTimeout = options.setupTimeout ?? 30_000
  const teardownTimeout = options.teardownTimeout ?? 30_000
  for (const timeout of [setupTimeout, teardownTimeout]) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError('Test setup and teardown timeouts must be positive finite numbers')
    }
  }

  let context: TestServer | undefined
  let disposed = false
  const controller = new AbortController()
  const callerSignal = options.runtimeOptions?.signal
  const runtimeOptions = {
    ...options.runtimeOptions,
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
  }
  beforeAll(async () => {
    try {
      await withTimeout(createTestServer({ ...options, runtimeOptions }).then(async (server) => {
        if (disposed) await server.close()
        else context = server
      }), setupTimeout, 'setup')
    } catch (error) {
      disposed = true
      controller.abort(error)
      throw error
    }
  })
  afterAll(async () => {
    disposed = true
    try {
      if (context) await withTimeout(context.close(), teardownTimeout, 'teardown')
    } finally {
      controller.abort()
    }
  })

  function useContext(): TestServer {
    if (!context) throw new Error('Test context is not ready; use it inside tests after beforeAll')
    return context
  }

  // Each suite owns its handle; nested and concurrent suites do not share a current app.
  return {
    url: (path) => useContext().url(path),
    fetch: (input, init) => useContext().fetch(input, init),
    $fetch: <T = unknown>(input: TestRequest, init?: RequestInit) =>
      useContext().$fetch<T>(input, init),
  }
}

// Lightning 3 hooks do not accept individual timeouts.
async function withTimeout<T>(operation: Promise<T>, timeout: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test server ${phase} timed out after ${timeout}ms`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
