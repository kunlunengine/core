import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
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
import { materializeProject, planProjectCreation } from './generator.js'
import { GeneratorError } from './generator-types.js'

const VERSION = '0.2.0'
const ENGINES = { nasti, vite, webpack, rspack } as const

export async function runCli(args: string[], cwd = process.cwd()): Promise<void> {
  const command = args[0] ?? 'help'
  const rest = args.slice(1)
  if (command !== 'create' && command !== 'new') {
    if (rest.some((arg) => /^(--dry-run|--json)(=|$)/.test(arg))) {
      throw new Error('--dry-run and --json are currently supported only by kunlun create/new.')
    }
  }

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
  const { values, positionals } = parseCreationArgs(args)
  if (values.help) {
    if (values.json) {
      throw new GeneratorError(
        'KUNLUN_CREATE_ARGUMENT_INVALID',
        '--help cannot be combined with --json.',
        'Run kunlun create --help for human help, or provide a destination with --dry-run --json for a plan.',
      )
    }
    printHelp()
    return
  }
  const destination = positionals[0]
  if (positionals.length !== 1 || !destination) {
    throw new GeneratorError(
      'KUNLUN_CREATE_ARGUMENT_INVALID',
      'Creation requires exactly one destination directory.',
      'Run kunlun create <directory> [--builder nasti|vite|webpack|rspack] [--dry-run] [--json].',
    )
  }
  const plan = await planProjectCreation({
    destination,
    cwd,
    ...(values.builder === undefined ? {} : { builder: values.builder }),
  })
  if (!values['dry-run']) await materializeProject(plan)
  if (values.json) {
    console.log(JSON.stringify(plan))
    return
  }
  const action = values['dry-run'] ? 'Planned' : 'Created'
  console.log(`✓ ${action} ${plan.project.name} with ${plan.project.builder} at ${plan.destination}`)
  console.log(`  Template: ${plan.generator.template}@${plan.generator.version} (${plan.generator.protocol})`)
  if (values['dry-run']) {
    for (const file of plan.files) console.log(`  write ${file.path}`)
    console.log('  Dry run: no files written or commands executed.')
  }
  // JSON carries raw argv/cwd; the human POSIX-shell hint must suppress expansion.
  console.log(`  cd '${plan.destination.replace(/'/g, "'\\''")}'`)
  for (const next of plan.nextCommands) console.log(`  ${next.command} ${next.args.join(' ')}`)
}

function parseCreationArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        builder: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    throw new GeneratorError(
      'KUNLUN_CREATE_ARGUMENT_INVALID',
      error instanceof Error ? error.message : String(error),
      'Run kunlun create --help. Boolean flags --dry-run and --json take no value.',
    )
  }
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

function printHelp(): void {
  console.log(`Kunlun Engine ${VERSION}

Usage: kunlun <command> [options]

Commands:
  create <directory>   Plan or create a project (Nasti by default)
  new <directory>      Compatibility alias for create
  dev                  Start build targets and the application runtime
  build                Build configured targets
  start                Start only the application runtime
  doctor               Validate the project and environment
  engines              Show available engines and capabilities

Options:
  --builder <name>     nasti, vite, webpack, or rspack
  --dry-run            Preview creation without writes or command execution
  --json               Creation plan or diagnostic as one JSON object
  --config <file>      Config path relative to the project root
  --root <directory>   Project root
  --target <name>      Run one configured target
  --port <number>      Base build target port, or runtime port for start
  --runtime-port <n>   Runtime port for dev (default: after target ports)`)
}
