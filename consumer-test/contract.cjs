// The consumer contract every binding checks (spec §4), through CommonJS
// require: in memory, file-backed across a reopen, and the error for invalid
// Datalog. Usage: node contract.cjs <empty directory>
const assert = require('node:assert/strict')
const path = require('node:path')
const { MiniGrafDb } = require('minigraf')

const QUERY = '(query [:find ?n :where [?e :name ?n]])'
const names = (json) => JSON.parse(json).results.map((row) => row[0])

const mem = MiniGrafDb.inMemory()
mem.execute('(transact [[:alice :name "Alice"]])')
assert.deepEqual(names(mem.execute(QUERY)), ['Alice'])
console.log('ok: in memory')

mem.execute('(transact [[:bob :name "Bob"]])')
const pq = mem.prepare('(query [:find ?n :where [?e :name $name] [?e :name ?n]])')
for (const name of ['Alice', 'Bob']) assert.deepEqual(names(pq.execute({ name })), [name])
assert.deepEqual(names(pq.execute({ name: { type: 'string', value: 'Alice' } })), ['Alice'])
console.log('ok: prepared query runs with plain and typed bind values')

mem.execute('(transact [[:alice :tags #{1 "x"}]])')
const tags = JSON.parse(mem.execute('(query [:find ?t :where [?e :tags ?t]])')).results
assert.deepEqual(tags, [[['x', 1]]], 'a set value comes back as an array')
const member = mem.prepare('(query [:find ?t :where [?e :tags ?t] [(in? 1 $s)]])')
assert.deepEqual(JSON.parse(member.execute({ s: new Set([1, 2]) })).results, [[['x', 1]]], 'a set binds')
console.log('ok: set values come back and bind')

assert.throws(() => mem.execute('(query [:find'), (e) => e instanceof Error && e.message.length > 0)
console.log('ok: invalid Datalog throws')

const file = path.join(process.argv[2], 'test.graph')
const db = new MiniGrafDb(file)
db.execute('(transact [[:bob :name "Bob"]])')
db.checkpoint()
db.close()
const again = new MiniGrafDb(file)
assert.deepEqual(names(again.execute(QUERY)), ['Bob'])
again.close()
console.log('ok: file-backed survives reopen')
