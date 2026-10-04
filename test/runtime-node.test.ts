import { get, request as httpRequest } from 'node:http'
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

  it.each([false, true])('rejects malformed results before direct fetch or CORS (%s)', async (cors) => {
    for (const result of [{}, { status: 200, headers: new Headers(), body: null }]) {
      const server = await nodeRuntime().start(application(async () => result as Response), { port: 0, cors })
      try {
        await expect(server.fetch(new Request(server.url))).rejects.toThrow('Runtime handler must return a Response')
        const response = await fetch(server.url)
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'Internal Server Error' })
      } finally {
        await server.close()
      }
    }
  })

  it('shares dispatch semantics and closes the application once with a shared completion', async () => {
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => { finish = resolve })
    const app = application(async function () {
      expect(this).toBe(app)
      return new Response('ok')
    })
    const close = vi.fn(() => cleanup)
    Object.assign(app, { close })
    const server = await nodeRuntime().start(app, { port: 0 })
    expect(await (await server.fetch(new Request(server.url))).text()).toBe('ok')
    expect(await (await fetch(server.url)).text()).toBe('ok')
    const first = server.close()
    expect(server.close()).toBe(first)
    await expect(server.fetch(new Request(server.url))).rejects.toThrow('closed')
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    finish()
    await first
    expect(server.close()).toBe(first)
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps a stable 500 when diagnostics throw', async () => {
    const server = await nodeRuntime().start(application(async () => {
      throw new Error('handler')
    }), { port: 0, onError: async () => { throw new Error('diagnostics') } })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'Internal Server Error' })
    } finally {
      await server.close()
    }
  })

  it('aborts the request and cancels its response stream on a premature disconnect', async () => {
    let signal!: AbortSignal
    const cancel = vi.fn()
    const server = await nodeRuntime().start(application(async (request) => {
      signal = request.signal
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('first')) },
        cancel,
      }))
    }), { port: 0 })
    try {
      await new Promise<void>((resolve, reject) => {
        const client = get(server.url, (response) => {
          response.once('data', () => {
            expect(signal.aborted).toBe(false)
            client.destroy()
            resolve()
          })
        })
        client.once('error', reject)
      })
      await vi.waitFor(() => {
        expect(signal.aborted).toBe(true)
        expect(cancel).toHaveBeenCalledOnce()
      })
    } finally {
      await server.close()
    }
  })

  it('does not abort normally completed requests and cancels HEAD bodies', async () => {
    const signals: AbortSignal[] = []
    const cancel = vi.fn()
    const server = await nodeRuntime().start(application(async (request) => {
      signals.push(request.signal)
      return request.method === 'HEAD'
        ? new Response(new ReadableStream({ cancel }))
        : new Response('ok')
    }), { port: 0 })
    try {
      expect(await (await fetch(server.url)).text()).toBe('ok')
      expect((await fetch(server.url, { method: 'HEAD' })).status).toBe(200)
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
      expect(signals.every((signal) => !signal.aborted)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('aborts incoming uploads and cancels responses returned after disconnect', async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    let signal!: AbortSignal
    const cancel = vi.fn()
    const server = await nodeRuntime().start(application(async (request) => {
      signal = request.signal
      started()
      await pending
      return new Response(new ReadableStream({ cancel }))
    }), { port: 0 })
    const client = httpRequest(server.url, { method: 'POST' })
    client.on('error', () => {})
    try {
      client.write('unfinished upload')
      await ready
      client.destroy()
      await vi.waitFor(() => expect(signal.aborted).toBe(true))
      release()
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    } finally {
      release()
      client.destroy()
      await server.close()
    }
  })

  it('contains cleanup failures when shutdown is triggered by an abort signal', async () => {
    const controller = new AbortController()
    const onError = vi.fn(async () => { throw new Error('diagnostics') })
    const app = application(async () => new Response('ok'))
    Object.assign(app, { close: async () => { throw new Error('cleanup') } })
    const server = await nodeRuntime().start(app, { port: 0, signal: controller.signal, onError })
    controller.abort()
    await expect(server.close()).rejects.toThrow('cleanup')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
  })
})
