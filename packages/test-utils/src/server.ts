import {
  createRuntimeApplication,
  defineApplication,
  type ApplicationDefinition,
  type RequestHandlerOptions,
} from '@kunlun-js/core'
import type { RuntimeAdapter, RuntimeServer, RuntimeStartOptions } from '@kunlun-js/runtime-api'
import { nodeRuntime } from '@kunlun-js/runtime-node'
import { createTestClient, type TestClient } from './client.js'

export interface TestServerOptions extends RequestHandlerOptions {
  application: ApplicationDefinition
  runtime?: RuntimeAdapter
  runtimeOptions?: Omit<RuntimeStartOptions, 'mode'>
}

export interface TestServer extends TestClient {
  readonly server: RuntimeServer
  close(): Promise<void>
}

export async function createTestServer(options: TestServerOptions): Promise<TestServer> {
  const application = createRuntimeApplication(defineApplication(options.application), options)
  const server = await (options.runtime ?? nodeRuntime()).start(application, {
    host: '127.0.0.1',
    port: 0,
    ...options.runtimeOptions,
    mode: 'test',
  })
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= Promise.resolve().then(() => server.close())
    return closing
  }

  try {
    const client = createTestClient(server.url, async (request) => {
      if (closing) throw new Error('Test server is closed')
      // Exercise the HTTP adapter, not RuntimeServer.fetch's in-memory shortcut.
      return globalThis.fetch(request)
    })
    return { server, close, ...client }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Test server initialization and cleanup failed')
    }
    throw error
  }
}
