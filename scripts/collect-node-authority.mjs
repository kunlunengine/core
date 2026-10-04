import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { machine, tmpdir, type } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { executeAuthorityProbe, validateAuthorityObservations } from './authority-probe.mjs'

const core = fileURLToPath(new URL('..', import.meta.url))
const fixturePath = 'crates/kunlun-runtime/tests/fixtures/request-authority.js'
const contractPath = 'crates/kunlun-runtime/tests/fixtures/request-authority.contract.json'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function adapterHashes() {
  const modules = ['index.js', 'application.js', 'authority.js']
  return Object.fromEntries(await Promise.all(modules.map(async module => [
    module, sha256(await readFile(path.join(core, 'packages/runtime-node/dist', module))),
  ])))
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const fullCommit = (value) => {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Full Git source commit required')
  return value
}

const { values } = parseArgs({
  options: {
    'runtime-root': { type: 'string' },
    output: { type: 'string' },
    development: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})
if (values.help) {
  console.log('Usage: pnpm authority:node --runtime-root <Runtime checkout> --output <new directory> [--development]')
  console.log('Default evidence requires clean Core and Runtime commits. Development output is not qualifying evidence.')
  process.exit(0)
}
if (!values['runtime-root'] || !values.output) {
  throw new Error('--runtime-root and --output are required')
}
const runtime = path.resolve(values['runtime-root'])
const output = path.resolve(values.output)
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output) // Never overwrite a prior evidence run.

const report = {
  schema_version: 1,
  suite: 'request-authority/v1',
  adapter: 'node',
  status: 'failed',
}
let authority
let fixtureDirectory
try {
  const commit = fullCommit(git(runtime, 'rev-parse', 'HEAD'))
  const nodeCommit = fullCommit(git(core, 'rev-parse', 'HEAD'))
  const initialStatus = {
    core: git(core, 'status', '--porcelain', '--untracked-files=all'),
    runtime: git(runtime, 'status', '--porcelain', '--untracked-files=all'),
  }
  if (!values.development && (initialStatus.core || initialStatus.runtime)) {
    throw new Error('Qualifying authority evidence requires clean reviewed Core and Runtime commits; use --development for local observations')
  }

  const system = type()
  const arch = machine()
  let translated = false
  if (system === 'Darwin') {
    const translation = execFileSync('sysctl', ['-in', 'sysctl.proc_translated'], {
      encoding: 'utf8',
    }).trim()
    if (!['', '0', '1'].includes(translation)) throw new Error('Unknown macOS translation state')
    translated = translation === '1'
  }
  if (!['Darwin', 'Linux'].includes(system) || !['arm64', 'aarch64', 'x86_64'].includes(arch)) {
    throw new Error('Authority evidence supports physical macOS/Linux arm64/x64 runners only')
  }
  if (translated) throw new Error('Translated execution is not physical-platform qualification')
  const target = `${arch === 'x86_64' ? 'x86_64' : 'aarch64'}-${system === 'Darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`
  const [sourceBytes, contractBytes, packageBytes] = await Promise.all([
    readFile(path.join(runtime, fixturePath)),
    readFile(path.join(runtime, contractPath)),
    readFile(path.join(core, 'packages/runtime-node/package.json'), 'utf8'),
  ])
  const contract = JSON.parse(contractBytes.toString('utf8'))
  if (contract.schema_version !== 1 || contract.suite !== report.suite
      || !Array.isArray(contract.expected_observations) || contract.expected_observations.length !== 2) {
    throw new Error('Unsupported authority observation contract')
  }
  const packageMetadata = JSON.parse(packageBytes)
  if (packageMetadata.name !== '@kunlun-js/runtime-node') throw new Error('Unexpected Node adapter package')
  Object.assign(report, {
    commit,
    target,
    runner: { system, machine: arch, translated },
    fixture_sha256: sha256(sourceBytes),
    contract_sha256: sha256(contractBytes),
    node: {
      package: packageMetadata.name,
      package_version: packageMetadata.version,
      source_commit: nodeCommit,
      version: process.version,
    },
  })

  // Force emission: ignored dist/build-info can be stale or modified while Git
  // is clean. An incremental "up to date" result is not evidence of source identity.
  const build = spawnSync('pnpm', ['run', 'build', '--force'], { cwd: core, stdio: 'inherit' })
  if (build.error || build.status !== 0) throw new Error('Core package build failed')
  const emittedHashes = await adapterHashes()
  report.node.build = { command: 'pnpm run build --force', modules: emittedHashes }
  const { createRequestAuthority } = await import('../packages/runtime-node/dist/index.js')
  fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'kunlun-node-authority-'))
  const publicRoot = path.join(fixtureDirectory, 'public')
  await mkdir(publicRoot)
  await writeFile(path.join(publicRoot, 'message.txt'), 'public message')
  const escapePath = path.join(fixtureDirectory, 'escape.txt')
  await writeFile(escapePath, 'private message')
  const declarations = contract.setup?.declarations
  if (!declarations || !Array.isArray(declarations.optional)) throw new Error('Missing probe admission setup')
  authority = await createRequestAuthority({
    required: declarations.required ?? [],
    optional: declarations.optional,
  }, { fs: { 'public-data': publicRoot, undeclared: publicRoot } })
  const observations = await executeAuthorityProbe(authority, sourceBytes.toString('utf8'), escapePath)
  await authority.close()
  authority = undefined
  report.observations = observations
  validateAuthorityObservations(observations, contract.expected_observations)
  const [finalSource, finalContract] = await Promise.all([
    readFile(path.join(runtime, fixturePath)),
    readFile(path.join(runtime, contractPath)),
  ])
  if (sha256(finalSource) !== report.fixture_sha256 || sha256(finalContract) !== report.contract_sha256
      || git(core, 'rev-parse', 'HEAD') !== nodeCommit || git(runtime, 'rev-parse', 'HEAD') !== commit) {
    throw new Error('Sources or source commits changed during authority collection')
  }
  if (!isDeepStrictEqual(await adapterHashes(), emittedHashes)) {
    throw new Error('Executed adapter files changed during authority collection')
  }
  const finalStatus = {
    core: git(core, 'status', '--porcelain', '--untracked-files=all'),
    runtime: git(runtime, 'status', '--porcelain', '--untracked-files=all'),
  }
  if (!isDeepStrictEqual(initialStatus, finalStatus)) throw new Error('Working trees changed during authority collection')
  report.status = values.development ? 'development' : 'passed'
  if (values.development) {
    report.qualification = false
    report.diagnostic = 'Local development observations only; dirty sources are not reviewed-commit evidence'
  }
  console.log(`request-authority/v1: ${report.status}; not full #50/#53 qualification`)
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Authority collection failed'
  console.error(report.error)
  process.exitCode = 1
} finally {
  try {
    await authority?.close()
  } catch {
    report.status = 'failed'
    report.error = 'Authority cleanup failed'
    process.exitCode = 1
  }
  try {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  } catch {
    report.status = 'failed'
    report.error = 'Authority fixture cleanup failed'
    process.exitCode = 1
  }
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}
