import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

// Every workspace runtime dependency must come from this build, not the registry.
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
visit('@kunlun-js/cli')

await mkdir(path.join(root, '.kunlun'), { recursive: true })
const consumer = await mkdtemp(path.join(root, '.kunlun', 'packed-cli-'))
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
  }, null, 2))
  await writeFile(path.join(consumer, 'pnpm-workspace.yaml'),
    'packages: []\nautoInstallPeers: false\noverrides:\n' +
    Object.entries(dependencies).map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(file)}\n`).join(''))
  await run(['install', '--prefer-offline', '--ignore-scripts'], consumer)
  const guard = path.join(consumer, 'no-side-effects.mjs')
  await copyFile(path.join(root, 'test/fixtures/cli/no-side-effects.mjs'), guard)
  // A config in the working directory must never be imported by creation.
  await writeFile(path.join(consumer, 'kunlun.config.mjs'),
    'throw new Error("Creation imported the consumer config")\n')
  const cli = path.join(consumer, 'node_modules/@kunlun-js/cli/dist/cli.js')
  const bin = path.join(consumer, 'node_modules/.bin', process.platform === 'win32' ? 'kunlun.cmd' : 'kunlun')
  const publicProbe = path.join(consumer, 'public-api.mjs')
  await writeFile(publicProbe, `
import assert from 'node:assert/strict'
import { planProjectCreation, GeneratorError } from '@kunlun-js/cli'
assert.equal(typeof planProjectCreation, 'function')
assert.equal(typeof GeneratorError, 'function')
try {
  await planProjectCreation({ destination: 'public-invalid', builder: 'unknown' })
  assert.fail('Unknown builder was accepted')
} catch (error) {
  assert.ok(error instanceof GeneratorError)
  assert.equal(error.diagnostic.code, 'KUNLUN_CREATE_BUILDER_UNKNOWN')
}
console.log(JSON.stringify(await planProjectCreation({
  destination: process.argv[2], builder: process.argv[3], cwd: process.cwd(),
})))
`)

  for (const builder of ['nasti', 'vite', 'webpack', 'rspack']) {
    const destination = `projects/${builder}-app`
    const absolute = path.join(consumer, destination)
    const api = json(await node([publicProbe, destination, builder]))
    checkPlan(api, absolute, builder)
    const dry = json(await node([cli, 'create', destination, '--builder', builder, '--dry-run', '--json']))
    assert.deepEqual(dry, api, `${builder}: public planner and CLI differ`)
    const alias = json(await node([cli, 'new', destination, `--builder=${builder}`, '--dry-run', '--json']))
    assert.deepEqual(alias, dry, `${builder}: new is not an exact create alias`)
    await absent(path.join(consumer, 'projects'))
    const created = json(await node([cli, 'create', destination, '--builder', builder, '--json'], true))
    assert.deepEqual(created, dry, `${builder}: materialization changed the plan`)
    assert.deepEqual(await filesAt(absolute), dry.files.map((file) => file.path))
    for (const file of dry.files) {
      assert.deepEqual(await readFile(path.join(absolute, file.path)), Buffer.from(file.contents),
        `${builder}: on-disk bytes differ for ${file.path}`)
    }
    await absent(path.join(absolute, 'node_modules'))
    // Optional development middleware peers must work in a clean generated app,
    // not just be present in a self-consistent manifest. Keep source aliases out.
    if (builder === 'webpack' || builder === 'rspack') {
      const overrides = Object.entries(dependencies).map(([name, file]) =>
        `  ${JSON.stringify(name)}: ${JSON.stringify(file.replace('file:./artifacts/', 'file:../../artifacts/'))}\n`).join('')
      await writeFile(path.join(absolute, 'pnpm-workspace.yaml'), `packages: []\nautoInstallPeers: false\noverrides:\n${overrides}`)
      await copyFile(path.join(root, 'test/fixtures/cli/peer-smoke.mjs'), path.join(absolute, 'peer-smoke.mjs'))
      await run(['install', '--prefer-offline', '--ignore-scripts'], absolute)
      const smoke = await execute(process.execPath, ['peer-smoke.mjs'], { cwd: absolute, timeout: 30_000 })
      process.stdout.write(smoke.stdout)
      process.stderr.write(smoke.stderr)
    }
    // Remove each generated app so the next guarded dry run also proves that
    // even the missing parent directory remains absent.
    await rm(path.join(consumer, 'projects'), { recursive: true })
    console.log(`✓ packed CLI: ${builder} public plan, guarded dry run, alias, and exact creation`)
  }

  // Exercise the installed executable shim as well as its guarded Node entry.
  const binEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(guard)}`,
    KUNLUN_PACKED_ALLOW_WRITES: '0',
  }
  const binPlan = json(await invoke(bin, ['new', 'bin-app', '--dry-run', '--json'], 0, binEnv))
  checkPlan(binPlan, path.join(consumer, 'bin-app'), 'nasti')
  await absent(path.join(consumer, 'bin-app'))
  const binCreated = json(await invoke(bin, ['create', 'bin-app', '--json'], 0, {
    ...binEnv, KUNLUN_PACKED_ALLOW_WRITES: '1',
  }))
  assert.deepEqual(binCreated, binPlan)
  assert.deepEqual(await filesAt(binCreated.destination), binPlan.files.map((file) => file.path))
  for (const file of binPlan.files) {
    assert.deepEqual(await readFile(path.join(binCreated.destination, file.path)), Buffer.from(file.contents))
  }

  await mkdir(path.join(consumer, 'occupied'))
  await writeFile(path.join(consumer, 'occupied/keep.txt'), 'do not overwrite\n')
  await writeFile(path.join(consumer, 'file-destination'), 'not a directory\n')
  const cases = [
    { args: [], code: 'ARGUMENT_INVALID' },
    { args: ['one', 'two'], code: 'ARGUMENT_INVALID' },
    { args: ['invalid', '--unknown'], code: 'ARGUMENT_INVALID' },
    { args: ['invalid', '--builder'], code: 'ARGUMENT_INVALID' },
    { args: ['invalid', '--dry-run=false'], code: 'ARGUMENT_INVALID' },
    { args: ['invalid', '--json=true'], code: 'ARGUMENT_INVALID' },
    { args: ['invalid', '--builder', 'unknown'], code: 'BUILDER_UNKNOWN' },
    { args: [' '], code: 'DESTINATION_INVALID' },
    { args: [path.parse(consumer).root], code: 'DESTINATION_INVALID' },
    { args: ['file-destination'], code: 'DESTINATION_INVALID' },
    { args: ['occupied'], code: 'DESTINATION_NOT_EMPTY' },
  ]
  for (const command of ['create', 'new']) {
    for (const { args, code } of cases) {
      const expected = `KUNLUN_CREATE_${code}`
      const result = await node([cli, command, ...args, '--json'], false, 1)
      const diagnostic = json(result)
      assert.equal(diagnostic.schema, 'kunlun.generator-diagnostic/v1')
      assert.equal(diagnostic.code, expected)
      assert.equal(typeof diagnostic.message, 'string')
      assert.ok(diagnostic.message.length > 0)
      assert.equal(typeof diagnostic.remediation, 'string')
      assert.ok(diagnostic.remediation.length > 0)
      // A malformed JSON flag is still a machine-output request, not a human
      // invocation. The other invalid arguments must have human diagnostics.
      if (!args.some((arg) => arg.startsWith('--json'))) {
        const human = await node([cli, command, ...args], false, 1)
        assert.equal(human.stdout, '')
        assert.ok(human.stderr.includes(expected), `${command} ${args.join(' ')}: ${human.stderr}`)
        assert.ok(human.stderr.includes(diagnostic.remediation))
      }
    }
  }
  assert.equal(await readFile(path.join(consumer, 'occupied/keep.txt'), 'utf8'), 'do not overwrite\n')
  await absent(path.join(consumer, 'invalid'))
  for (const command of ['create', 'new']) {
    const malformed = json(await node([cli, command, 'invalid', '--json=true'], false, 1))
    assert.equal(malformed.code, 'KUNLUN_CREATE_ARGUMENT_INVALID')
    const help = json(await node([cli, command, '--help', '--json'], false, 1))
    assert.equal(help.code, 'KUNLUN_CREATE_ARGUMENT_INVALID')
    const denied = json(await node([cli, command, 'write-denied', '--json'], false, 1, 'fs/promises.mkdir'))
    assert.equal(denied.schema, 'kunlun.generator-diagnostic/v1')
    assert.equal(denied.code, 'KUNLUN_CREATE_WRITE_FAILED')
    assert.ok(denied.message.includes('Packed CLI side-effect guard: fs/promises.mkdir'))
    assert.ok(denied.remediation.length > 0)
    await absent(path.join(consumer, 'write-denied'))
  }
  console.log('✓ packed CLI: installed bin, default builder, strict arguments, JSON and human diagnostics')
  console.log('✓ packed CLI: denied real creation reports a structured write failure')
  console.log('Packed CLI validation passed (not a full-stack scaffold/build gate).')

  async function node(args, allowWrites = false, status = 0, expectedDenial = '') {
    return invoke(process.execPath, ['--import', guard, ...args], status, {
      ...process.env,
      KUNLUN_PACKED_ALLOW_WRITES: allowWrites ? '1' : '0',
      KUNLUN_PACKED_EXPECT_DENIAL: expectedDenial,
    })
  }

  async function invoke(executable, args, status = 0, env = process.env) {
    let result
    try {
      result = await execute(executable, args, { cwd: consumer, env, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
    } catch (error) {
      assert.equal(error.code, status, `${args.join(' ')}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
      result = error
    }
    if (!('code' in result)) assert.equal(status, 0, `Expected failure: ${args.join(' ')}`)
    assert.ok(!result.stderr.includes('Packed CLI side-effect guard:'), result.stderr)
    return result
  }
} finally {
  await rm(consumer, { recursive: true, force: true })
}

function json(result) {
  assert.equal(result.stderr, '', 'JSON mode must not emit stderr prose')
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 1, 'JSON mode must emit exactly one JSON object and no prose')
  const value = JSON.parse(lines[0])
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

function checkPlan(plan, destination, builder) {
  assert.equal(plan.schema, 'kunlun.generator-plan/v1')
  assert.deepEqual(plan.generator, {
    protocol: 'kunlun.generator/v1', template: '@kunlun-js/client-fetch', version: '1.0.0',
  })
  assert.equal(plan.destination, destination)
  assert.ok(path.isAbsolute(plan.destination))
  assert.deepEqual(plan.project, { name: path.basename(destination), builder, packageManager: 'pnpm@11.22.0' })
  const paths = plan.files.map((file) => file.path)
  assert.deepEqual(paths, [...paths].sort())
  assert.equal(new Set(paths).size, paths.length)
  assert.deepEqual(paths, ['.gitignore', 'index.html', 'kunlun.config.mjs', 'package.json', 'src/main.js'])
  for (const file of plan.files) {
    assert.equal(typeof file.contents, 'string')
    assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'))
  }
  const manifest = JSON.parse(plan.files.find((file) => file.path === 'package.json').contents)
  assert.equal(manifest.name, plan.project.name)
  assert.equal(manifest.packageManager, plan.project.packageManager)
  assert.deepEqual(plan.dependencies, { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies })
  assert.ok(plan.dependencies.dependencies[`@kunlun-js/builder-${builder}`])
  assert.ok(plan.dependencies.devDependencies['@kunlun-js/cli'])
  for (const peer of Object.keys(packages.get(`@kunlun-js/builder-${builder}`).peerDependencies ?? {})) {
    assert.ok(plan.dependencies.devDependencies[peer], `${builder}: missing adapter peer ${peer}`)
  }
  assert.deepEqual(plan.nextCommands, [
    { cwd: destination, command: 'pnpm', args: ['install'] },
    { cwd: destination, command: 'pnpm', args: ['dev'] },
  ])
}

async function absent(file) {
  await assert.rejects(stat(file), { code: 'ENOENT' }, `${file} must not exist`)
}

async function filesAt(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await filesAt(path.join(directory, entry.name), relative))
    else {
      assert.ok(entry.isFile(), `Unexpected non-file output: ${relative}`)
      files.push(relative)
    }
  }
  return files.sort()
}

async function run(args, cwd) {
  const { stdout, stderr } = await execute('pnpm', args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
}
