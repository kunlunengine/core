import type { NastiConfig } from '@nasti-toolchain/nasti'
import {
  artifactBytes,
  type BuildArtifact,
  type BuildEngine,
  type BuildRequest,
  type BuildSession,
  type ServeRequest,
} from '@kunlun-js/build-api'

type NastiImplementation = Pick<typeof import('@nasti-toolchain/nasti'), 'build' | 'createServer'>

export interface NastiBuilderOptions {
  config?: NastiConfig
  implementation?: NastiImplementation
}

export function nasti(options: NastiBuilderOptions = {}): BuildEngine {
  return {
    name: 'nasti',
    displayName: 'Nasti',
    capabilities: Object.freeze({
      hmr: true,
      middleware: true,
      moduleGraph: true,
      multiEnvironment: 'native',
      ssrModuleRunner: true,
      lazyCompilation: true,
    }),
    async createSession(context): Promise<BuildSession> {
      const implementation = options.implementation ?? (await import('@nasti-toolchain/nasti'))
      const devServers = new Set<Awaited<ReturnType<NastiImplementation['createServer']>>>()

      return {
        async build(request) {
          const start = performance.now()
          const raw = await implementation.build(createNastiConfig(context.root, request, options.config))
          const candidate = request.name === 'client'
            ? raw.output
            : (raw.environments?.[request.name] ?? raw.output)
          const artifacts = normalizeNastiArtifacts(candidate as unknown[])

          return {
            engine: 'nasti',
            target: request.name,
            outDir: request.outDir,
            durationMs: performance.now() - start,
            artifacts,
            entries: entriesFromArtifacts(artifacts),
            diagnostics: [],
            raw,
          }
        },
        async serve(request) {
          const server = await implementation.createServer(
            createNastiConfig(context.root, request, options.config),
          )
          devServers.add(server)
          await server.listen(request.port)
          const port = server.config.server.port
          const host = normalizeHost(request.host ?? server.config.server.host)

          return {
            engine: 'nasti',
            target: request.name,
            urls: [`http://${host}:${port}/`],
            middleware: server.middlewares,
            transform: async (url) => {
              const result = await server.transformEnvironmentRequest(request.name, url)
              if (!result) return null
              if (typeof result === 'string') return { code: result }
              return { code: result.code, ...(result.map === undefined ? {} : { map: result.map }) }
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

function createNastiConfig(
  root: string,
  request: BuildRequest | ServeRequest,
  base: NastiConfig = {},
): NastiConfig {
  const external = request.external ?? []
  const existingRolldown = base.build?.rolldownOptions ?? {}
  const rolldownOptions = { ...existingRolldown }
  if (external.length > 0) rolldownOptions.external = external
  const build: NonNullable<NastiConfig['build']> = {
    ...base.build,
    outDir: request.outDir,
    rolldownOptions,
  }
  if (request.sourcemap !== undefined) build.sourcemap = request.sourcemap
  if (request.minify !== undefined) build.minify = request.minify

  const common: NastiConfig = {
    ...base,
    root,
    build,
  }

  if ('port' in request) {
    common.server = {
      ...base.server,
      ...(request.host === undefined ? {} : { host: request.host }),
      ...(request.port === undefined ? {} : { port: request.port }),
    }
  }

  if (request.consumer !== 'client') {
    common.environments = {
      ...base.environments,
      client: { ...base.environments?.client, buildEnabled: false },
      [request.name]: {
        ...base.environments?.[request.name],
        consumer: 'server',
        entry: Object.values(request.entries),
      },
    }
  }

  return common
}

function normalizeNastiArtifacts(output: unknown[]): BuildArtifact[] {
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    if (typeof value.fileName !== 'string') return []
    const artifact: BuildArtifact = {
      type: value.type === 'asset' ? 'asset' : 'chunk',
      fileName: value.fileName,
    }
    const bytes = artifactBytes(value.code ?? value.source)
    if (bytes !== undefined) artifact.bytes = bytes
    if (value.isEntry === true) artifact.entry = true
    return [artifact]
  })
}

function entriesFromArtifacts(artifacts: BuildArtifact[]): Record<string, string> {
  return Object.fromEntries(
    artifacts.filter((item) => item.entry).map((item) => [entryName(item.fileName), item.fileName]),
  )
}

function entryName(fileName: string): string {
  const leaf = fileName.split('/').at(-1) ?? fileName
  return leaf.replace(/\.[^.]+$/, '')
}

function normalizeHost(host: string | boolean): string {
  if (host === true || host === '0.0.0.0') return 'localhost'
  return host || 'localhost'
}
