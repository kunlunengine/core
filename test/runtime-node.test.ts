import { describe, expect, it, vi } from 'vitest'
import { nodeRuntime } from '../packages/runtime-node/src/index.js'
import type { RuntimeApplication } from '../packages/runtime-api/src/index.js'

function application(fetch: RuntimeApplication['fetch']): RuntimeApplication {
  return {
    manifest: { name: 'runtime-test', services: [] },
    fetch,
  }
}

describe('Node reference runtime', () => {
  it('serves a Fetch application over HTTP and supports development CORS', async () => {
    const server = await nodeRuntime().start(application(async (request) => {
      return Response.json({ method: request.method, body: await request.text() })
    }), { port: 0, cors: true })

    try {
      const response = await fetch(`${server.url}/echo`, { method: 'POST', body: 'Kunlun' })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      await expect(response.json()).resolves.toEqual({ method: 'POST', body: 'Kunlun' })

      const preflight = await fetch(`${server.url}/echo`, { method: 'OPTIONS' })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    } finally {
      await server.close()
    }
  })

  it('returns a stable 500 response and reports handler failures', async () => {
    const onError = vi.fn()
    const server = await nodeRuntime().start(application(async () => {
      throw new Error('boom')
    }), { port: 0, onError })

    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'Internal Server Error' })
      expect(onError).toHaveBeenCalledOnce()
    } finally {
      await server.close()
    }
  })
})
