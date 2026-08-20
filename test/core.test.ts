import { describe, expect, it } from 'vitest'
import {
  capability,
  createApplicationManifest,
  createRequestHandler,
  defineApplication,
  defineService,
  MissingCapabilityError,
  route,
} from '../packages/core/src/index.js'

function fixtureApplication() {
  return defineApplication({
    name: 'orders-app',
    version: '0.1.0',
    services: [
      defineService({
        name: 'orders',
        basePath: '/api',
        capabilities: [capability('database.orders', { operations: ['select'] })],
        routes: [
          route('GET', '/orders/:id', ({ params }) => Response.json({ id: params.id })),
          route('POST', '/orders', () => new Response(null, { status: 201 })),
        ],
      }),
    ],
  })
}

describe('application core', () => {
  it('routes requests without decorators or reflection', async () => {
    const handler = createRequestHandler(fixtureApplication(), {
      capabilities: { 'database.orders': { query: () => undefined } },
    })
    const response = await handler(new Request('http://localhost/api/orders/42'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ id: '42' })
  })

  it('distinguishes missing paths from unsupported methods', async () => {
    const handler = createRequestHandler(fixtureApplication(), {
      capabilities: { 'database.orders': {} },
    })
    expect((await handler(new Request('http://localhost/missing'))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/orders/1', { method: 'DELETE' }))).status).toBe(405)
  })

  it('fails before serving when a required capability is absent', () => {
    expect(() => createRequestHandler(fixtureApplication())).toThrow(MissingCapabilityError)
  })

  it('emits a serializable runtime manifest', () => {
    expect(createApplicationManifest(fixtureApplication())).toEqual({
      name: 'orders-app',
      version: '0.1.0',
      services: [{
        name: 'orders',
        capabilities: [{
          name: 'database.orders',
          optional: false,
          operations: ['select'],
        }],
        routes: [
          { method: 'GET', path: '/api/orders/:id' },
          { method: 'POST', path: '/api/orders' },
        ],
      }],
    })
  })
})
