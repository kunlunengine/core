import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppRouteDiscoveryError,
  discoverAppRoutes,
  RouteHandlerModuleError,
  validateRouteHandlerModule,
} from '../packages/next/src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('app route discovery', () => {
  it('discovers pages, inherited layouts, dynamic segments, and route handlers', async () => {
    const appDir = await appFixture([
      'layout.tsx',
      'page.tsx',
      'orders/layout.tsx',
      'orders/[id]/page.tsx',
      'api/orders/route.ts',
      'api/orders/schema.ts',
    ])

    await expect(discoverAppRoutes({ appDir })).resolves.toEqual({
      appDir,
      layouts: [
        {
          kind: 'layout',
          path: '/',
          source: 'layout.tsx',
          segments: [],
          params: [],
        },
        {
          kind: 'layout',
          path: '/orders',
          source: 'orders/layout.tsx',
          segments: [{ kind: 'static', value: 'orders' }],
          params: [],
        },
      ],
      routes: [
        {
          kind: 'page',
          path: '/',
          source: 'page.tsx',
          segments: [],
          params: [],
          layouts: ['layout.tsx'],
        },
        {
          kind: 'route',
          path: '/api/orders',
          source: 'api/orders/route.ts',
          segments: [
            { kind: 'static', value: 'api' },
            { kind: 'static', value: 'orders' },
          ],
          params: [],
        },
        {
          kind: 'page',
          path: '/orders/:id',
          source: 'orders/[id]/page.tsx',
          segments: [
            { kind: 'static', value: 'orders' },
            { kind: 'dynamic', name: 'id' },
          ],
          params: ['id'],
          layouts: ['layout.tsx', 'orders/layout.tsx'],
        },
      ],
    })
  })

  it('supports an explicit source extension set', async () => {
    const appDir = await appFixture(['page.tsx', 'docs/page.md'])

    const manifest = await discoverAppRoutes({ appDir, extensions: ['.md'] })

    expect(manifest.routes).toEqual([{
      kind: 'page',
      path: '/docs',
      source: 'docs/page.md',
      segments: [{ kind: 'static', value: 'docs' }],
      params: [],
      layouts: [],
    }])
  })

  it('encodes static filesystem segments without changing their inspectable value', async () => {
    const appDir = await appFixture(['about us/page.tsx'])

    const manifest = await discoverAppRoutes({ appDir })

    expect(manifest.routes[0]).toMatchObject({
      path: '/about%20us',
      segments: [{ kind: 'static', value: 'about us' }],
    })
  })

  it('reports duplicate convention modules in one directory', async () => {
    const appDir = await appFixture(['page.ts', 'page.tsx'])

    await expect(discoverAppRoutes({ appDir })).rejects.toMatchObject({
      diagnostics: [{
        code: 'DUPLICATE_CONVENTION',
        sources: ['page.ts', 'page.tsx'],
      }],
    })
  })

  it.each(['[...slug]', '[[slug]]', '[]', '[slug']) (
    'reports unsupported dynamic segment %s',
    async (segment) => {
      const appDir = await appFixture([`${segment}/page.tsx`])

      await expect(discoverAppRoutes({ appDir })).rejects.toMatchObject({
        diagnostics: [{
          code: 'INVALID_DYNAMIC_SEGMENT',
          sources: [`${segment}/page.tsx`],
        }],
      })
    },
  )

  it('rejects duplicate parameter names in one route', async () => {
    const appDir = await appFixture(['orders/[id]/lines/[id]/page.tsx'])

    await expect(discoverAppRoutes({ appDir })).rejects.toMatchObject({
      diagnostics: [{ code: 'DUPLICATE_DYNAMIC_PARAMETER' }],
    })
  })

  it('rejects routes with equivalent dynamic URL patterns', async () => {
    const appDir = await appFixture([
      'orders/[id]/page.tsx',
      'orders/[slug]/page.tsx',
    ])

    await expect(discoverAppRoutes({ appDir })).rejects.toMatchObject({
      diagnostics: [{
        code: 'DUPLICATE_ROUTE_PATTERN',
        sources: ['orders/[id]/page.tsx', 'orders/[slug]/page.tsx'],
      }],
    })
  })

  it('rejects a page and route handler that claim the same path', async () => {
    const appDir = await appFixture(['orders/page.tsx', 'orders/route.ts'])

    await expect(discoverAppRoutes({ appDir })).rejects.toMatchObject({
      diagnostics: [{
        code: 'ROUTE_KIND_CONFLICT',
        sources: ['orders/page.tsx', 'orders/route.ts'],
      }],
    })
  })

  it('returns a structured diagnostic when the app directory is missing', async () => {
    const root = await temporaryDirectory()
    const appDir = join(root, 'app')

    await expect(discoverAppRoutes({ appDir })).rejects.toEqual(expect.objectContaining({
      name: 'AppRouteDiscoveryError',
      diagnostics: [{
        code: 'APP_DIRECTORY_NOT_FOUND',
        message: `App directory does not exist or is not a directory: ${appDir}`,
        sources: [],
      }],
    }))
  })

  it('uses a dedicated aggregate error for route diagnostics', async () => {
    const appDir = await appFixture(['page.ts', 'page.tsx'])

    try {
      await discoverAppRoutes({ appDir })
      expect.unreachable('route discovery should fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AppRouteDiscoveryError)
      expect(String(error)).toContain('[DUPLICATE_CONVENTION]')
    }
  })
})

describe('route handler module contract', () => {
  it('accepts supported Fetch handler exports and ignores unrelated exports', () => {
    const GET = () => Response.json({ ok: true })
    const POST = async () => new Response(null, { status: 201 })

    expect(validateRouteHandlerModule({ GET, POST, capabilities: [] }, 'api/route.ts')).toEqual({
      GET,
      POST,
    })
  })

  it('rejects non-function HTTP exports with an actionable source', () => {
    expect(() => validateRouteHandlerModule({ GET: 'invalid' }, 'api/route.ts')).toThrowError(
      expect.objectContaining<Partial<RouteHandlerModuleError>>({
        code: 'INVALID_ROUTE_HANDLER_EXPORT',
        source: 'api/route.ts',
        exportName: 'GET',
      }),
    )
  })

  it('rejects explicitly undefined HTTP exports as invalid', () => {
    expect(() => validateRouteHandlerModule({ GET: undefined }, 'api/route.ts')).toThrowError(
      expect.objectContaining<Partial<RouteHandlerModuleError>>({
        code: 'INVALID_ROUTE_HANDLER_EXPORT',
        source: 'api/route.ts',
        exportName: 'GET',
      }),
    )
  })

  it('requires at least one supported HTTP method', () => {
    expect(() => validateRouteHandlerModule({ default: () => undefined }, 'api/route.ts')).toThrowError(
      expect.objectContaining<Partial<RouteHandlerModuleError>>({
        code: 'MISSING_ROUTE_HANDLER_EXPORT',
        source: 'api/route.ts',
      }),
    )
  })
})

async function appFixture(files: readonly string[]): Promise<string> {
  const root = await temporaryDirectory()
  const appDir = join(root, 'app')
  await mkdir(appDir)

  for (const file of files) {
    const path = join(appDir, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '')
  }

  return appDir
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kunlun-next-'))
  temporaryDirectories.push(directory)
  return directory
}
