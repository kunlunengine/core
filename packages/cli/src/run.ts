import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { nasti } from '@kunlun-js/builder-nasti'
import { rspack } from '@kunlun-js/builder-rspack'
import { vite } from '@kunlun-js/builder-vite'
import { webpack } from '@kunlun-js/builder-webpack'
import {
  createApplicationManifest,
  createRuntimeApplication,
  defineConfig,
  type KunlunConfig,
  type TargetDefinition,
} from '@kunlun-js/core'
import { nodeRuntime } from '@kunlun-js/runtime-node'

const VERSION = '0.2.0'
const ENGINES = { nasti, vite, webpack, rspack } as const
type EngineName = keyof typeof ENGINES

export async function runCli(args: string[], cwd = process.cwd()): Promise<void> {
  const command = args[0] ?? 'help'
  const rest = args.slice(1)

  switch (command) {
    case 'build':
      await buildCommand(rest, cwd)
      break
    case 'dev':
      await devCommand(rest, cwd)
      break
    case 'start':
      await startCommand(rest, cwd)
      break
    case 'doctor':
      await doctorCommand(rest, cwd)
      break
    case 'engines':
      enginesCommand()
      break
    case 'new':
    case 'create':
      await createCommand(rest, cwd)
      break
    case '--version':
    case '-v':
    case 'version':
      console.log(VERSION)
      break
    case '--help':
    case '-h':
    case 'help':
      printHelp()
      break
    default:
      throw new Error(`Unknown command "${command}". Run kunlun help.`)
  }
}

async function buildCommand(args: string[], cwd: string): Promise<void> {
  const root = path.resolve(cwd, option(args, '--root') ?? '.')
  const config = await loadConfig(root, option(args, '--config'))
  const targets = selectedTargets(config, option(args, '--target'))
  const session = await config.builder.createSession({
    root,
    mode: 'production',
    application: createApplicationManifest(config.application),
  })

  try {
    for (const target of targets) {
      const result = await session.build(target)
      console.log(
        `✓ ${result.target} built with ${result.engine} in ${Math.ceil(result.durationMs)}ms `
        + `(${result.artifacts.length} artifacts)`,
      )
    }
    const manifestDir = path.join(root, '.kunlun')
    await mkdir(manifestDir, { recursive: true })
    await writeFile(
      path.join(manifestDir, 'application-manifest.json'),
      `${JSON.stringify(createApplicationManifest(config.application), null, 2)}\n`,
    )
    console.log('✓ application manifest written to .kunlun/application-manifest.json')
  } finally {
    await session.close()
  }
}

async function devCommand(args: string[], cwd: string): Promise<void> {
  const root = path.resolve(cwd, option(args, '--root') ?? '.')
  const config = await loadConfig(root, option(args, '--config'))
  const targets = selectedTargets(config, option(args, '--target'))
  const basePort = parsePort(option(args, '--port') ?? '3000')
  const defaultRuntimePort = basePort === 0 ? 0 : basePort + targets.length
  const runtimePort = parsePort(
    option(args, '--runtime-port') ?? String(config.runtimeOptions?.port ?? defaultRuntimePort),
  )
  const session = await config.builder.createSession({
    root,
    mode: 'development',
    application: createApplicationManifest(config.application),
  })
  const devSessions = []
  let runtimeServer: Awaited<ReturnType<ReturnType<typeof nodeRuntime>['start']>> | undefined
  try {
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]
      if (target) {
        const port = basePort === 0 ? 0 : parsePort(String(basePort + index))
        devSessions.push(await session.serve({ ...target, port }))
      }
    }
    for (const dev of devSessions) {
      console.log(`✓ ${dev.target} running with ${dev.engine}`)
      for (const url of dev.urls) console.log(`  ${url}`)
    }

    const runtime = config.runtime ?? nodeRuntime()
    runtimeServer = await runtime.start(runtimeApplication(config), {
      ...config.runtimeOptions,
      mode: 'development',
      port: runtimePort,
      cors: config.runtimeOptions?.cors ?? true,
    })
    console.log(`✓ application running with ${runtime.displayName}`)
    console.log(`  ${runtimeServer.url}`)
    await waitForShutdown()
  } finally {
    await runtimeServer?.close()
    await Promise.all(devSessions.map((dev) => dev.close()))
    await session.close()
  }
}

async function startCommand(args: string[], cwd: string): Promise<void> {
  const root = path.resolve(cwd, option(args, '--root') ?? '.')
  const config = await loadConfig(root, option(args, '--config'))
  const port = parsePort(option(args, '--port') ?? String(config.runtimeOptions?.port ?? 3000))
  const runtime = config.runtime ?? nodeRuntime()
  const server = await runtime.start(runtimeApplication(config), {
    ...config.runtimeOptions,
    mode: 'production',
    port,
  })
  console.log(`✓ application running with ${runtime.displayName}`)
  console.log(`  ${server.url}`)
  try {
    await waitForShutdown()
  } finally {
    await server.close()
  }
}

async function doctorCommand(args: string[], cwd: string): Promise<void> {
  const root = path.resolve(cwd, option(args, '--root') ?? '.')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) throw new Error(`Node.js ${process.versions.node} is unsupported; use >=20.19`)
  console.log(`✓ Node.js ${process.versions.node}`)

  const config = await loadConfig(root, option(args, '--config'))
  console.log(`✓ config loaded (${config.application.name})`)
  console.log(`✓ build engine: ${config.builder.displayName}`)
  console.log(`✓ runtime: ${(config.runtime ?? nodeRuntime()).displayName}`)
  console.log(`✓ targets: ${selectedTargets(config).map((target) => target.name).join(', ')}`)
}

function enginesCommand(): void {
  for (const create of Object.values(ENGINES)) {
    const engine = create()
    const features = Object.entries(engine.capabilities)
      .filter(([, value]) => value !== false)
      .map(([name, value]) => value === true ? name : `${name}:${value}`)
    console.log(`${engine.name.padEnd(8)} ${features.join(', ')}`)
  }
}

async function createCommand(args: string[], cwd: string): Promise<void> {
  const destination = firstPositional(args, ['--builder'])
  if (!destination) throw new Error('Usage: kunlun new <directory> [--builder nasti|vite|webpack|rspack]')
  const engineName = (option(args, '--builder') ?? 'nasti') as EngineName
  if (!(engineName in ENGINES)) throw new Error(`Unknown build engine: ${engineName}`)

  const root = path.resolve(cwd, destination)
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length > 0) throw new Error(`Directory is not empty: ${root}`)

  const packageName = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
  const peer = enginePeer(engineName)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await Promise.all([
    writeFile(path.join(root, 'package.json'), `${JSON.stringify({
      name: packageName,
      version: '0.0.0',
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.22.0',
      scripts: { dev: 'kunlun dev', build: 'kunlun build', start: 'kunlun start', doctor: 'kunlun doctor' },
      dependencies: {
        '@kunlun-js/core': '^0.2.0',
        [`@kunlun-js/builder-${engineName}`]: '^0.1.0',
      },
      devDependencies: {
        '@kunlun-js/cli': '^0.2.0',
        [peer.name]: peer.version,
      },
    }, null, 2)}\n`),
    writeFile(path.join(root, 'kunlun.config.mjs'), configTemplate(engineName)),
    writeFile(path.join(root, 'index.html'), '<!doctype html>\n<meta charset="utf-8">\n<title>Kunlun Engine</title>\n<div id="app">Loading…</div>\n<script type="module" src="/src/main.js"></script>\n'),
    writeFile(path.join(root, 'src/main.js'), `const app = document.querySelector('#app')
try {
  const response = await fetch('http://localhost:3001/api/hello')
  const result = await response.json()
  app.textContent = result.hello
} catch (error) {
  app.textContent = \`Runtime unavailable: \${error.message}\`
}
`),
    writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist/\n.kunlun/\n'),
  ])
  console.log(`✓ Created ${packageName} with ${engineName} at ${root}`)
  console.log(`  cd ${destination}`)
  console.log('  pnpm install')
  console.log('  pnpm dev')
}

async function loadConfig(root: string, explicit?: string): Promise<KunlunConfig> {
  const candidates = explicit
    ? [path.resolve(root, explicit)]
    : ['kunlun.config.mjs', 'kunlun.config.js'].map((file) => path.join(root, file))
  const file = await firstExisting(candidates)
  if (!file) throw new Error(`No Kunlun config found in ${root}`)
  const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
  if (!module.default) throw new Error(`${file} must export a default config`)
  return defineConfig(module.default as KunlunConfig)
}

async function firstExisting(files: string[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      await access(file)
      return file
    } catch {
      // Continue to the next supported config filename.
    }
  }
  return undefined
}

function selectedTargets(config: KunlunConfig, selected?: string): TargetDefinition[] {
  const targets = [...(config.targets ?? [])]
  const result = selected ? targets.filter((target) => target.name === selected) : targets
  if (result.length === 0) throw new Error(selected ? `Unknown target: ${selected}` : 'No build targets configured')
  return result
}

function runtimeApplication(config: KunlunConfig) {
  return createRuntimeApplication(
    config.application,
    config.capabilities === undefined ? {} : { capabilities: config.capabilities },
  )
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`)
  return port
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function option(args: string[], name: string): string | undefined {
  const equal = args.find((arg) => arg.startsWith(`${name}=`))
  if (equal) return equal.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function firstPositional(args: string[], valueOptions: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (!value) continue
    if (valueOptions.includes(value)) {
      index++
      continue
    }
    if (value.startsWith('--')) continue
    return value
  }
  return undefined
}

function enginePeer(name: EngineName): { name: string; version: string } {
  switch (name) {
    case 'nasti': return { name: '@nasti-toolchain/nasti', version: '^2.4.4' }
    case 'vite': return { name: 'vite', version: '^8.2.2' }
    case 'webpack': return { name: 'webpack', version: '^5.109.2' }
    case 'rspack': return { name: '@rspack/core', version: '^2.1.10' }
  }
}

function configTemplate(name: EngineName): string {
  return `import { ${name} } from '@kunlun-js/builder-${name}'
import { defineApplication, defineConfig, defineService, route } from '@kunlun-js/core'

const application = defineApplication({
  name: 'hello-kunlun',
  services: [
    defineService({
      name: 'hello',
      routes: [route('GET', '/api/hello', () => Response.json({ hello: 'Kunlun' }))],
    }),
  ],
})

export default defineConfig({
  application,
  builder: ${name}(),
  targets: [
    {
      name: 'client',
      consumer: 'client',
      entries: { main: './src/main.js' },
      outDir: 'dist/client',
    },
  ],
})
`
}

function printHelp(): void {
  console.log(`Kunlun Engine ${VERSION}

Usage: kunlun <command> [options]

Commands:
  new <directory>      Create a project (Nasti by default)
  dev                  Start build targets and the application runtime
  build                Build configured targets
  start                Start only the application runtime
  doctor               Validate the project and environment
  engines              Show available engines and capabilities

Options:
  --builder <name>     nasti, vite, webpack, or rspack
  --config <file>      Config path relative to the project root
  --root <directory>   Project root
  --target <name>      Run one configured target
  --port <number>      Base build target port, or runtime port for start
  --runtime-port <n>   Runtime port for dev (default: after target ports)`)
}
