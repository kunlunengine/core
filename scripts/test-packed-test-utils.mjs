import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const packages = new Map()
for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifest = JSON.parse(await readFile(path.join(root, 'packages', entry.name, 'package.json'), 'utf8'))
  packages.set(manifest.name, manifest)
}

// Pack the actual dependency closure, never silently test a published workspace dependency.
const selected = new Map()
function visit(name) {
  if (selected.has(name)) return
  const manifest = packages.get(name)
  assert.ok(manifest, `Missing workspace package: ${name}`)
  selected.set(name, manifest)
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (packages.has(dependency)) visit(dependency)
  }
}
visit('@kunlun-js/test-utils')

await mkdir(path.join(root, '.kunlun'), { recursive: true })
const consumer = await mkdtemp(path.join(root, '.kunlun', 'packed-test-utils-'))
try {
  const artifacts = path.join(consumer, 'artifacts')
  await mkdir(artifacts)
  for (const name of selected.keys()) {
    await run(['--filter', name, 'pack', '--pack-destination', artifacts], root)
  }
  const dependencies = Object.fromEntries([...selected].map(([name, manifest]) => [
    name, `file:./artifacts/${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
  ]))
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    packageManager: rootManifest.packageManager,
    dependencies,
    devDependencies: { '@lightning-js/lightning': rootManifest.devDependencies['@lightning-js/lightning'] },
  }, null, 2))
  await writeFile(path.join(consumer, 'pnpm-workspace.yaml'),
    'packages: []\nautoInstallPeers: false\noverrides:\n' +
    Object.entries(dependencies).map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(file)}\n`).join(''))
  await writeFile(path.join(consumer, 'lightning.config.mjs'),
    'export default { test: { include: ["consumer.test.ts"] } }\n')
  const fixtures = path.join(root, 'test', 'fixtures', 'test-utils')
  await copyFile(path.join(fixtures, 'consumer.ts'), path.join(consumer, 'consumer.test.ts'))
  // This consumer resolves its own graph without the root lockfile. Reuse cached
  // packages, but allow downloads when transitive versions differ or the store is empty.
  await run(['install', '--prefer-offline', '--ignore-scripts'], consumer)
  await run(['exec', 'lightning', 'run'], consumer)

  await copyFile(path.join(fixtures, 'timeout.ts'), path.join(consumer, 'consumer.test.ts'))
  for (const phase of ['setup', 'late-setup', 'teardown']) {
    const marker = path.join(consumer, `${phase}.json`)
    let failed = false
    try {
      await execute('pnpm', ['exec', 'lightning', 'run'], {
        cwd: consumer,
        env: { ...process.env, TEST_UTILS_TIMEOUT_PHASE: phase, TEST_UTILS_TIMEOUT_MARKER: marker },
        timeout: 30_000,
      })
    } catch (error) {
      failed = true
      assert.equal(error.code, 1, 'The negative fixture must fail normally, not hang or crash')
      const hook = phase === 'teardown' ? 'teardown' : 'setup'
      assert.match(`${error.stdout}\n${error.stderr}`, new RegExp(`Test server ${hook} timed out`))
    }
    assert.ok(failed, `${phase} fixture must report a timeout`)
    const state = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(state.aborted, true, `${phase}: runtime signal was not aborted`)
    assert.equal(state.closed, true, `${phase}: HTTP listener survived the timeout`)
    if (phase === 'late-setup') assert.equal(state.closeCalls, 1, 'Late startup must close the returned server')
    console.log(`✓ packed test-utils: ${phase} timeout cancels and cleans up the server`)
  }
} finally {
  await rm(consumer, { recursive: true, force: true })
}

async function run(args, cwd) {
  const { stdout, stderr } = await execute('pnpm', args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
}
