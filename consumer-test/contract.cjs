// The consumer contract every binding checks (spec §4), through CommonJS
// require: in memory, file-backed across a reopen, and the error for invalid
// Datalog. Usage: node contract.cjs <empty directory>
const assert = require('node:assert/strict')
const path = require('node:path')
const { MiniGrafDb, OVERRIDABLE_DEFAULTS } = require('minigraf')

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

mem.execute('(transact [[:alice :age 30] [:bob :age 12]])')
mem.registerPredicate('adult?', (v) => v.type === 'integer' && v.value >= 18n)
assert.deepEqual(names(mem.execute('(query [:find ?n :where [?e :age ?a] [(adult? ?a)] [?e :name ?n]])')), ['Alice'])
mem.registerAggregate('product', { init: () => 1n, step: (acc, v) => acc * v.value, finish: (acc) => acc })
assert.deepEqual(JSON.parse(mem.execute('(query [:find (product ?a) :where [?e :age ?a]])')).results, [[360]])
mem.registerPredicate('boom?', () => { throw new Error('no') })
assert.throws(() => mem.execute('(query [:find ?a :where [?e :age ?a] [(boom? ?a)]])'),
  (e) => e.message === '[QRY-014] user function `boom?` failed: no')
console.log('ok: user functions run, and a throw is QRY-014')

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

// minigraf#872: the override list, the new open options and a prepared setter.
assert.deepEqual([...OVERRIDABLE_DEFAULTS], ['maxDerivedFacts', 'maxResults', 'maxIterations'])
const limited = MiniGrafDb.openWithOptions(path.join(process.argv[2], 'overrides.graph'), {
  allowOverrides: [],
  transactionChunkFacts: 2,
  maxIterations: 1000,
})
limited.execute('(transact [[:a :edge :b] [:b :edge :c] [:c :edge :d]])')
limited.execute('(rule [(reach ?x ?y) [?x :edge ?y]])')
limited.execute('(rule [(reach ?x ?y) [?x :edge ?z] (reach ?z ?y)])')
assert.throws(() => limited.execute('(query [:find ?x ?y :where (reach ?x ?y) :max-derived-facts 10])'),
  (e) => e.message.startsWith('[API-025]'))
const reach = limited.prepare('(query [:find ?x ?y :where (reach ?x ?y)])')
const derived = reach.withMaxIterations(1)
assert.throws(() => derived.execute(), (e) => e.message.startsWith('[INT-020]'))
assert.equal(JSON.parse(reach.execute()).results.length, 6, 'the receiver is unchanged')
limited.close()
assert.throws(() => derived.execute(), (e) => e.message.startsWith('[API-018]'))
console.log('ok: override list, open options and a prepared setter')

