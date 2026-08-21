import { execFile } from 'node:child_process'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const packagesRoot = path.join(root, 'packages')
const output = path.join(root, '.release')
const dryRun = process.argv.includes('--dry-run')

const packages = await readPackages()
const ordered = topologicalOrder(packages)
await rm(output, { recursive: true, force: true })

let published = 0
for (const packageJson of ordered) {
  if (await versionExists(packageJson.name, packageJson.version)) {
    console.log(`- ${packageJson.name}@${packageJson.version} already exists`)
    continue
  }

  const before = new Set(await tarballs())
  await run('pnpm', ['--filter', packageJson.name, 'pack', '--pack-destination', output])
  const tarball = (await tarballs()).find((file) => !before.has(file))
  if (!tarball) throw new Error(`pnpm did not produce a tarball for ${packageJson.name}`)

  const publishArgs = ['publish', path.join(output, tarball), '--access', 'public']
  if (dryRun) publishArgs.push('--dry-run')
  else publishArgs.push('--provenance')
  await run('npm', publishArgs)
  published++
}

const action = dryRun ? 'Prepared' : 'Published'
console.log(published === 0 ? 'All workspace versions are already published.' : `${action} ${published} package(s).`)

async function readPackages() {
  const directories = await readdir(packagesRoot, { withFileTypes: true })
  const result = []
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const packageJson = JSON.parse(await readFile(path.join(packagesRoot, directory.name, 'package.json'), 'utf8'))
    if (!packageJson.private) result.push(packageJson)
  }
  return result
}

function topologicalOrder(input) {
  const byName = new Map(input.map((packageJson) => [packageJson.name, packageJson]))
  const result = []
  const visited = new Set()
  const visiting = new Set()

  const visit = (packageJson) => {
    if (visited.has(packageJson.name)) return
    if (visiting.has(packageJson.name)) throw new Error(`Workspace dependency cycle at ${packageJson.name}`)
    visiting.add(packageJson.name)
    const dependencies = { ...packageJson.dependencies, ...packageJson.optionalDependencies }
    for (const dependency of Object.keys(dependencies)) {
      const local = byName.get(dependency)
      if (local) visit(local)
    }
    visiting.delete(packageJson.name)
    visited.add(packageJson.name)
    result.push(packageJson)
  }

  for (const packageJson of input) visit(packageJson)
  return result
}

async function versionExists(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}@${version}`)
  return true
}

async function tarballs() {
  try {
    return (await readdir(output)).filter((file) => file.endsWith('.tgz'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`)
  const { stdout, stderr } = await execute(command, args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })
  if (stdout.trim()) console.log(stdout.trim())
  if (stderr.trim()) console.error(stderr.trim())
}
