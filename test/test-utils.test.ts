import { afterAll, describe, expect, it, vi } from '@lightning-js/lightning'
import { capability, MissingCapabilityError, route, type ApplicationDefinition } from '../packages/core/src/index.js'
import { nodeRuntime } from '../packages/runtime-node/src/index.js'
import type { RuntimeAdapter, RuntimeServer } from '../packages/runtime-api/src/index.js'
import { createTestApplication, TestFetchError } from '@kunlun-js/test-utils/runtime'
import { createTestApplication as rootCreateTestApplication, createTestServer } from '@kunlun-js/test-utils'
import { setup } from '@kunlun-js/test-utils/e2e'

function fixtureApplication(label = 'Kunlun'): ApplicationDefinition {
  return {
    name: 'test-utils-app',
    services: [{
      name: 'api',
      basePath: '/api',
      routes: [
        route('GET', '/hello/:name', ({ params }) => Response.json({ greeting: `${label} ${params.name}` })),
        route('POST', '/echo', async ({ request }) => Response.json({
          body: await request.text(),
          header: request.headers.get('x-test'),
          query: new URL(request.url).searchParams.get('q'),
        })),
        route('GET', '/text', () => new Response(label)),
        route('GET', '/empty', () => new Response(null, { status: 204 })),
        route('GET', '/problem', () => new Response('{"detail":"bad request"}', {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        })),
        route('GET', '/invalid-json', () => new Response('not json', {
          headers: { 'content-type': 'application/json' },
        })),
        route('GET', '/invalid-error', () => new Response('not json', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })),
        route('GET', '/throw', () => { throw new Error('handler failed') }),
      ],
    }],
  }
}

describe('in-memory application testing', () => {
  it('uses Core routing, manifests, and standard URL resolution without a listener', async () => {
    expect(rootCreateTestApplication).toBe(createTestApplication)
    const context = createTestApplication(fixtureApplication(), { baseURL: 'https://app.test/api/' })
    expect(context.application.manifest.name).toBe('test-utils-app')
    expect(context.url('hello/Ada')).toBe('https://app.test/api/hello/Ada')
    expect(context.url('/api/text')).toBe('https://app.test/api/text')
    await expect(context.$fetch('hello/Ada')).resolves.toEqual({ greeting: 'Kunlun Ada' })
    expect((await context.fetch('/missing')).status).toBe(404)
    expect((await context.fetch('/api/text', { method: 'DELETE' })).status).toBe(405)
  })

  it('accepts paths, URL and Request inputs and forwards request options', async () => {
    const context = createTestApplication(fixtureApplication())
    await expect(context.$fetch(new URL(context.url('/api/echo?q=one')), {
      method: 'POST',
      body: 'hello',
      headers: { 'x-test': 'url' },
    })).resolves.toEqual({ body: 'hello', header: 'url', query: 'one' })
    const request = new Request(context.url('/api/echo?q=two'), {
      method: 'POST',
      body: 'original',
      headers: { 'x-test': 'request' },
    })
    await expect(context.$fetch(request, { body: 'override' })).resolves.toEqual({
      body: 'override', header: 'request', query: 'two',
    })
  })

  it('decodes text and empty responses and retains HTTP errors for inspection', async () => {
    const context = createTestApplication(fixtureApplication())
    await expect(context.$fetch('/api/text')).resolves.toBe('Kunlun')
    await expect(context.$fetch('/api/empty')).resolves.toBeUndefined()
    try {
      await context.$fetch('/api/problem')
      expect.unreachable('non-2xx responses must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(TestFetchError)
      const failure = error as TestFetchError
      expect(failure.response.status).toBe(400)
      expect(failure.data).toEqual({ detail: 'bad request' })
      await expect(failure.response.json()).resolves.toEqual({ detail: 'bad request' })
    }
    const missing = await context.$fetch('/missing').catch((error: TestFetchError) => error)
    expect(missing).toBeInstanceOf(TestFetchError)
    expect((missing as TestFetchError).data).toBe('Not Found')
    expect((missing as TestFetchError).response.status).toBe(404)
  })

  it('preserves HTTP errors with malformed JSON while rejecting invalid successful JSON', async () => {
    const context = createTestApplication(fixtureApplication())
    const failure = await context.$fetch('/api/invalid-error').catch((error: TestFetchError) => error)
    expect(failure).toBeInstanceOf(TestFetchError)
    expect((failure as TestFetchError).data).toBe('not json')
    expect((failure as TestFetchError).response.status).toBe(500)
    await expect(context.$fetch('/api/invalid-json')).rejects.toThrow(SyntaxError)
  })

  it('propagates handler errors rather than emulating HTTP runtime error handling', async () => {
    await expect(createTestApplication(fixtureApplication()).fetch('/api/throw')).rejects.toThrow('handler failed')
  })

  it('mocks capabilities explicitly and keeps application instances isolated', async () => {
    const application: ApplicationDefinition = {
      name: 'capability-test',
      services: [{
        name: 'api',
        capabilities: [capability('greeting')],
        routes: [route('GET', '/', ({ capabilities }) => Response.json(capabilities['greeting']))],
      }],
    }
    expect(() => createTestApplication(application)).toThrow(MissingCapabilityError)
    const first = createTestApplication(application, { capabilities: { greeting: 'first' } })
    const second = createTestApplication(application, { capabilities: { greeting: 'second' } })
    await expect(Promise.all([first.$fetch('/'), second.$fetch('/')])).resolves.toEqual(['first', 'second'])
  })

  it('validates application definitions and HTTP base URLs before serving', () => {
    expect(() => createTestApplication({ name: 'invalid', services: [] })).toThrow('at least one service')
    expect(() => createTestApplication(fixtureApplication(), { baseURL: 'file:///tmp/' })).toThrow('HTTP or HTTPS')
  })
})

describe('HTTP application testing', () => {
  it('uses an ephemeral real HTTP server and closes idempotently', async () => {
    const context = await createTestServer({
      application: fixtureApplication(),
      runtimeOptions: { cors: true },
    })
    try {
      expect(context.server.address.port).toBeGreaterThan(0)
      expect(context.server.address.host).toBe('127.0.0.1')
      const response = await context.fetch('/api/text')
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      await expect(response.text()).resolves.toBe('Kunlun')
      await expect(context.$fetch('/api/hello/Ada')).resolves.toEqual({ greeting: 'Kunlun Ada' })
      await expect(context.$fetch('/api/echo', {
        method: 'POST', body: 'http', headers: { 'x-test': 'network' },
      })).resolves.toEqual({ body: 'http', header: 'network', query: null })
    } finally {
      await Promise.all([context.close(), context.close()])
    }
    await expect(context.fetch('/api/text')).rejects.toThrow('Test server is closed')
    await expect(globalThis.fetch(context.url('/api/text'))).rejects.toThrow()
  })

  it('uses HTTP error handling and forwards runtime options to the selected adapter', async () => {
    const onError = vi.fn()
    const start = vi.fn(nodeRuntime().start)
    const runtime: RuntimeAdapter = { name: 'custom', displayName: 'Custom runtime', start }
    const context = await createTestServer({
      application: fixtureApplication(),
      runtime,
      runtimeOptions: { cors: true, shutdownGracePeriodMs: 10, onError },
    })
    try {
      expect(start).toHaveBeenCalledTimes(1)
      expect(start.mock.calls[0]?.[1]).toMatchObject({
        host: '127.0.0.1', port: 0, mode: 'test', cors: true, shutdownGracePeriodMs: 10,
      })
      const failure = await context.$fetch('/api/throw').catch((error: TestFetchError) => error)
      expect(failure).toBeInstanceOf(TestFetchError)
      expect((failure as TestFetchError).data).toEqual({ error: 'Internal Server Error' })
      expect((failure as TestFetchError).response.status).toBe(500)
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      await context.close()
    }
  })

  it('closes a started adapter when the returned server URL is invalid', async () => {
    const close = vi.fn(async () => undefined)
    const runtime: RuntimeAdapter = {
      name: 'invalid',
      displayName: 'Invalid URL runtime',
      async start(application) {
        return {
          adapter: 'invalid',
          address: { host: '127.0.0.1', port: 0, family: 'IPv4' },
          url: 'file:///invalid',
          fetch: application.fetch,
          close,
        }
      },
    }
    await expect(createTestServer({ application: fixtureApplication(), runtime })).rejects.toThrow('HTTP or HTTPS')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reports both initialization and cleanup errors when startup validation fails', async () => {
    const runtime: RuntimeAdapter = {
      name: 'invalid',
      displayName: 'Invalid URL runtime',
      async start(application) {
        return {
          adapter: 'invalid',
          address: { host: '127.0.0.1', port: 0, family: 'IPv4' },
          url: 'not a url',
          fetch: application.fetch,
          async close() { throw new Error('cleanup failed') },
        }
      },
    }
    const failure = await createTestServer({ application: fixtureApplication(), runtime }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors as Error[]
    expect(errors[0]).toBeInstanceOf(TypeError)
    expect(errors[1]?.message).toBe('cleanup failed')
  })

  it('retains one shared close result even when adapter teardown fails', async () => {
    const failure = new Error('close failed')
    const close = vi.fn(async () => { throw failure })
    const runtime: RuntimeAdapter = {
      name: 'failing-close',
      displayName: 'Failing close runtime',
      async start(application) {
        return {
          adapter: 'failing-close',
          address: { host: '127.0.0.1', port: 0, family: 'IPv4' },
          url: 'http://127.0.0.1:1',
          fetch: application.fetch,
          close,
        }
      },
    }
    const context = await createTestServer({ application: fixtureApplication(), runtime })
    const first = context.close()
    expect(context.close()).toBe(first)
    await expect(first).rejects.toThrow('close failed')
    await expect(context.close()).rejects.toThrow('close failed')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Lightning suite lifecycle', () => {
  const servers: RuntimeServer[] = []
  const closed: RuntimeServer[] = []
  const runtime: RuntimeAdapter = {
    name: 'tracked',
    displayName: 'Tracked Node runtime',
    async start(application, options) {
      const server = await nodeRuntime().start(application, options)
      servers.push(server)
      return {
        ...server,
        async close() {
          await server.close()
          closed.push(server)
        },
      }
    },
  }

  afterAll(async () => {
    expect(servers.length).toBe(3)
    expect(closed.length).toBe(3)
    for (const server of servers) {
      await expect(globalThis.fetch(server.url)).rejects.toThrow()
    }
  })

  describe('outer context', () => {
    const context = setup({ application: fixtureApplication('outer'), runtime })

    it('starts before tests and resolves suite-bound requests', async () => {
      await expect(context.$fetch('/api/text')).resolves.toBe('outer')
    })

    describe('nested context', () => {
      const nested = setup({ application: fixtureApplication('nested'), runtime })

      it('does not replace the parent suite context', async () => {
        await expect(Promise.all([context.$fetch('/api/text'), nested.$fetch('/api/text')]))
          .resolves.toEqual(['outer', 'nested'])
        expect(nested.url()).not.toBe(context.url())
      })
    })
  })

  describe('failure cleanup', () => {
    const context = setup({ application: fixtureApplication('failure'), runtime })

    it.fails('still tears down a suite whose test fails', async () => {
      await context.fetch('/api/text')
      throw new Error('intentional failure')
    })
  })
})
