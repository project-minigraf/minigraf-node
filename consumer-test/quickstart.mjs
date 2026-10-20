// The README quick start, line for line (readme_sync.py checks this), plus
// the checks around it. run.sh runs it as an ES module in an empty directory,
// against minigraf installed from the tarballs or the registry.
import { MiniGrafDb } from 'minigraf'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'

// In-memory database
const db = MiniGrafDb.inMemory()
db.execute('(transact [[:alice :name "Alice"] [:alice :age 30]])')

const result = JSON.parse(db.execute('(query [:find ?n :where [?e :name ?n]])'))
console.log(result.results[0][0])  // "Alice"
assert.equal(result.results[0][0], 'Alice')

// File-backed (persisted to disk)
mkdirSync('path/to', { recursive: true })
const db2 = new MiniGrafDb('path/to/mydb.graph')
db2.execute('(transact [[:bob :name "Bob"]])')
db2.checkpoint()
db2.close()
console.log('quick start: ok')
