import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, describe, it } from '@lightning-js/lightning'
import { route } from '@kunlun-js/core'
import type { RuntimeServer } from '@kunlun-js/runtime-api'
import { nodeRuntime } from '@kunlun-js/runtime-node'
import { setup } from '@kunlun-js/test-utils/e2e'

const phase = process.env['TEST_UTILS_TIMEOUT_PHASE']
let server: RuntimeServer
let signal: AbortSignal
let closeCalls = 0

// Check while the worker is still alive, not after process exit has closed its sockets.
afterAll(async () => {
  await delay(200)
  let closed = false
  try {
    await fetch(server.url)
  } catch {
    closed = true
  }
  await writeFile(process.env['TEST_UTILS_TIMEOUT_MARKER']!, JSON.stringify({
    aborted: signal.aborted, closed, closeCalls,
  }))
  // Keep the negative fixture itself leak-free if the implementation regresses.
  await server.close()
})

describe('timeout cleanup', () => {
  setup({
    application: {
      name: 'timeout-test',
      services: [{ name: 'api', routes: [route('GET', '/', () => new Response('alive'))] }],
    },
    setupTimeout: 50,
    teardownTimeout: 50,
    runtime: {
      name: 'stalling',
      displayName: 'Stalling runtime',
      async start(application, options) {
        signal = options!.signal!
        server = await nodeRuntime().start(application, options)
        if (phase === 'setup') return new Promise<never>(() => {})
        if (phase === 'late-setup') await delay(100)
        return {
          ...server,
          async close() {
            closeCalls++
            if (phase === 'teardown') return new Promise<never>(() => {})
            await server.close()
          },
        }
      },
    },
  })
  it('runs only if setup completed', () => {})
})
