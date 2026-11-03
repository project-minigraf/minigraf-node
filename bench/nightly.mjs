import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { cases } from './cases.mjs'
const test = process.argv.includes('--test')
// Force the built artifact before loading the public JS conversion wrapper.
// Neither an inherited override nor an installed optional package may win.
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = fileURLToPath(new URL('../minigraf.linux-x64-gnu.node', import.meta.url))
const require = createRequire(import.meta.url)
require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH) // Fail immediately if absent.
const { MiniGrafDb } = require('../minigraf.js')
const db = MiniGrafDb.inMemory()
try {
  const { metrics, executed } = await cases(db, 'node', test)
  for (const id of executed) console.log(`ok: ${id}`)
  if (!test) writeFileSync('binding-results.json', JSON.stringify(metrics, null, 2) + '\n')
} finally { db.close() }
