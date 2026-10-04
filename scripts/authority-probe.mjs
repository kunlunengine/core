import { Script, createContext } from 'node:vm'
import { isDeepStrictEqual } from 'node:util'

export function validateAuthorityObservations(observations, expected) {
  if (!Array.isArray(expected) || expected.length !== 2 || !isDeepStrictEqual(observations, expected)) {
    throw new Error('Actual authority observations differ from the shared contract')
  }
}

/** Execute unchanged Runtime probe bytes in one realm with two fresh request scopes. */
export async function executeAuthorityProbe(authority, source, absolutePath) {
  const context = createContext({
    requestAuthorityInputs: Object.freeze({ absolutePath }),
  })
  // The fixture is an async function body in the native runner too. Only its
  // invocation envelope is adapter-owned; the source between the braces is unchanged.
  const probe = new Script(`(async function(env) {\n${source}\n})`, {
    filename: 'request-authority.js',
  }).runInContext(context)
  const observations = []
  for (let request = 0; request < 2; request++) {
    const result = await authority.invoke((env) => probe(env), {
      signal: AbortSignal.timeout(30_000),
    })
    if (typeof result !== 'string') throw new Error('Authority probe must return a JSON string')
    observations.push(JSON.parse(result))
  }
  return observations
}
