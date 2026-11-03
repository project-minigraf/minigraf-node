import { writeFileSync } from 'node:fs'
import { MiniGrafDb } from '../minigraf.js'
import { cases } from './cases.mjs'
const test = process.argv.includes('--test')
const db = MiniGrafDb.inMemory()
try {
  const { metrics, executed } = await cases(db, 'node', test)
  for (const id of executed) console.log(`ok: ${id}`)
  if (!test) writeFileSync('binding-results.json', JSON.stringify(metrics, null, 2) + '\n')
} finally { db.close() }
