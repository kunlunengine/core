#!/usr/bin/env node
import { GeneratorError } from './generator-types.js'
import { runCli } from './run.js'

const args = process.argv.slice(2)
runCli(args).catch((error: unknown) => {
  if (error instanceof GeneratorError) {
    const terminator = args.indexOf('--')
    const options = terminator === -1 ? args : args.slice(0, terminator)
    if (options.some((arg) => arg === '--json' || arg.startsWith('--json='))) {
      console.log(JSON.stringify(error.diagnostic))
    } else {
      console.error(`[${error.diagnostic.code}] ${error.message}\n${error.diagnostic.remediation}`)
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
})
