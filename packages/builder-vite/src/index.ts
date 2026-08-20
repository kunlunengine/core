import type { InlineConfig, Rollup } from 'vite'
import {
  artifactBytes,
  type BuildArtifact,
  type BuildEngine,
  type BuildRequest,
  type BuildSession,
  type ServeRequest,
} from '@kunlun-js/build-api'

type ViteImplementation = Pick<typeof import('vite'), 'build' | 'createServer'>

export interface ViteBuilderOptions {
  config?: InlineConfig
  implementation?: ViteImplementation
}

export function vite(options: ViteBuilderOptions = {}): BuildEngine {
  return {
    name: 'vite',
    displayName: 'Vite',
    capabilities: Object.freeze({
      hmr: true,
      middleware: true,
      moduleGraph: true,
      multiEnvironment: 'native',
      ssrModuleRunner: true,
      lazyCompilation: false,
    }),
    async createSession(context): Promise<BuildSession> {
      const implementation = options.implementation ?? (await import('vite'))
      const devServers = new Set<Awaited<ReturnType<ViteImplementation['createServer']>>>()

      return {
        async build(request) {
          const start = performance.now()
          const raw = await implementation.build(createViteConfig(context.root, request, options.config))
          const artifacts = normalizeViteArtifacts(raw)
          return {
            engine: 'vite',
            target: request.name,
            outDir: request.outDir,
            durationMs: performance.now() - start,
            artifacts,
            entries: Object.fromEntries(
              artifacts.filter((item) => item.entry).map((item) => [entryName(item.fileName), item.fileName]),
            ),
            diagnostics: [],
            raw,
          }
        },
        async serve(request) {
          const server = await implementation.createServer(
            createViteConfig(context.root, request, options.config),
          )
          devServers.add(server)
          await server.listen(request.port)
          const urls = [
            ...(server.resolvedUrls?.local ?? []),
            ...(server.resolvedUrls?.network ?? []),
          ]
          return {
            engine: 'vite',
            target: request.name,
            urls,
            middleware: server.middlewares,
            transform: async (url) => {
              const result = await server.environments[request.name]?.transformRequest(url)
                ?? await server.transformRequest(url)
              return result ? { code: result.code, ...(result.map === null ? {} : { map: result.map }) } : null
            },
            loadServerModule: server.ssrLoadModule,
            invalidate: async (files) => {
              for (const file of files) server.watcher.emit('change', file)
            },
            close: async () => {
              if (!devServers.delete(server)) return
              await server.close()
            },
          }
        },
        async close() {
          const servers = [...devServers]
          devServers.clear()
          await Promise.all(servers.map((server) => server.close()))
        },
      }
    },
  }
}

function createViteConfig(
  root: string,
  request: BuildRequest | ServeRequest,
  base: InlineConfig = {},
): InlineConfig {
  const existingBuild = base.build ?? {}
  const existingRolldown = existingBuild.rolldownOptions ?? {}
  const entries = Object.values(request.entries)
  const rolldownOptions = { ...existingRolldown }
  if (entries.length > 0) rolldownOptions.input = request.entries
  if (request.external?.length) rolldownOptions.external = request.external
  const server = 'port' in request
    ? {
        ...base.server,
        ...(request.host === undefined ? {} : { host: request.host }),
        ...(request.port === undefined ? {} : { port: request.port }),
      }
    : base.server

  const build: NonNullable<InlineConfig['build']> = {
    ...existingBuild,
    outDir: request.outDir,
    manifest: existingBuild.manifest ?? true,
    rolldownOptions,
  }
  if (request.sourcemap !== undefined) build.sourcemap = request.sourcemap
  if (request.minify !== undefined) build.minify = request.minify

  return {
    ...base,
    configFile: base.configFile ?? false,
    root,
    ...(server === undefined ? {} : { server }),
    build,
  }
}

function normalizeViteArtifacts(raw: unknown): BuildArtifact[] {
  const outputs = (Array.isArray(raw) ? raw : [raw]).flatMap((item) => {
    if (!item || typeof item !== 'object' || !('output' in item)) return []
    return (item as Rollup.RollupOutput).output
  })

  return outputs.map((item) => {
    const artifact: BuildArtifact = {
      type: item.type === 'asset' ? 'asset' : 'chunk',
      fileName: item.fileName,
    }
    const bytes = artifactBytes(item.type === 'asset' ? item.source : item.code)
    if (bytes !== undefined) artifact.bytes = bytes
    if (item.type === 'chunk' && item.isEntry) artifact.entry = true
    return artifact
  })
}

function entryName(fileName: string): string {
  const leaf = fileName.split('/').at(-1) ?? fileName
  return leaf.replace(/[-.][A-Za-z0-9_-]{6,}(?=\.)/, '').replace(/\.[^.]+$/, '')
}
