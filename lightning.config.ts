import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@lightning-js/lightning/config'
import ts from 'typescript'

// Exercise workspace source, not published dist files. Lightning's external
// resolver otherwise looks for workspace dependencies at the repository root.
const packagesDirectory = new URL('./packages/', import.meta.url)
const workspaceAliases = Object.fromEntries(
  readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = new URL(`${entry.name}/`, packagesDirectory)
      const { name, exports } = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8')) as {
        name: string
        exports: Record<string, { import: string }>
      }
      return Object.entries(exports).map(([subpath, entryPoint]) => {
        const source = entryPoint.import.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')
        return [subpath === '.' ? name : `${name}${subpath.slice(1)}`, fileURLToPath(new URL(source, directory))]
      })
    }),
)

export default defineConfig({
  // Nasti's SSR runner externalizes bare imports before consulting aliases.
  // Rewrite actual import/export specifiers (not strings in CLI templates) to
  // source paths so every workspace is tested through the same module graph.
  plugins: [{
    name: 'kunlun-workspace-source',
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id) || id.includes('/node_modules/')) return null
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true)
      const replacements: { start: number; end: number; value: string }[] = []
      function visit(node: ts.Node): void {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined
        if (specifier && ts.isStringLiteral(specifier) && workspaceAliases[specifier.text]) {
          replacements.push({
            start: specifier.getStart(source),
            end: specifier.getEnd(),
            value: JSON.stringify(workspaceAliases[specifier.text]),
          })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (!replacements.length) return null
      for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
        code = code.slice(0, start) + value + code.slice(end)
      }
      return { code }
    },
  }],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
