// User functions: registerPredicate and registerAggregate (minigraf#180).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { MiniGrafDb } from '../minigraf.js'

function db () {
  const db = MiniGrafDb.inMemory()
  db.execute('(transact [[:a :n 1] [:b :n 2] [:c :n 3] [:a :g :x] [:b :g :x] [:c :g :y]])')
  return db
}

const rows = (json) => JSON.parse(json).results
const sorted = (rs) => [...rs].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))

function throwsMessage (fn, message) {
  assert.throws(fn, (e) => e instanceof Error && e.message === message, message)
}

const product = {
  init: () => 1n,
  step: (acc, v) => acc * v.value,
  finish: (acc, n) => ({ type: 'integer', value: acc * BigInt(n) })
}

test('a predicate filters rows', () => {
  const d = db()
  d.registerPredicate('big?', (v) => v.type === 'integer' && v.value > 1n)
  assert.deepEqual(sorted(rows(d.execute('(query [:find ?n :where [?e :n ?n] [(big? ?n)]])'))), [[2], [3]])
})

test('values reach JavaScript as typed objects', () => {
  const d = MiniGrafDb.inMemory()
  d.execute('(transact [[:a :v "s"] [:a :v 7] [:a :v 1.5] [:a :v true] [:a :v :k] [:a :v nil] [:a :v #{2 "x"}] [:a :friend :b] [:b :name "b"]])')
  const seen = []
  d.registerPredicate('see', (v) => {
    seen.push(v)
    return true
  })
  d.execute('(query [:find ?v :where [:a :v ?v] [(see ?v)]])')
  const key = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x))
  assert.deepEqual(seen.map(key).sort(), [
    '{"type":"boolean","value":true}',
    '{"type":"float","value":1.5}',
    '{"type":"integer","value":"7n"}',
    '{"type":"keyword","value":":k"}',
    '{"type":"null"}',
    '{"type":"set","value":[{"type":"string","value":"x"},{"type":"integer","value":"2n"}]}',
    '{"type":"string","value":"s"}'
  ])
  seen.length = 0
  d.execute('(query [:find ?e :where [?e :name _] [(see ?e)]])')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].type, 'ref')
  assert.match(seen[0].value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('an aggregate in :find and :over', () => {
  const d = db()
  d.registerAggregate('product', product)
  // x: 1 * 2, times 2 values; y: 3, times 1 value.
  assert.deepEqual(sorted(rows(d.execute('(query [:find ?g (product ?n) :where [?e :n ?n] [?e :g ?g]])'))), [[':x', 4], [':y', 3]])
  // Running product times running count: 1*1, 2*2, 6*3.
  assert.deepEqual(sorted(rows(d.execute('(query [:find ?n (product ?n :over (:order-by ?n)) :where [?e :n ?n]])'))), [[1, 1], [2, 4], [3, 18]])
})

test('accumulators are separate per group and may be any value', () => {
  const d = db()
  d.registerAggregate('collect', {
    init: () => [],
    step: (acc, v) => [...acc, Number(v.value)],
    finish: (acc) => acc.sort().join(',')
  })
  d.registerAggregate('count-undefined', {
    init: () => undefined,
    step: (acc) => (acc ?? 0) + 1,
    finish: (acc, n) => `${acc}/${n}`
  })
  assert.deepEqual(sorted(rows(d.execute('(query [:find ?g (collect ?n) :where [?e :n ?n] [?e :g ?g]])'))), [[':x', '1,2'], [':y', '3']])
  assert.deepEqual(rows(d.execute('(query [:find (count-undefined ?n) :where [?e :n ?n]])')), [['3/3']])
})

test("a plain finish result is read as a bind value", () => {
  const d = db()
  d.registerAggregate('mean', { init: () => 0, step: (acc, v) => acc + Number(v.value), finish: (acc, n) => acc / n })
  assert.deepEqual(rows(d.execute('(query [:find (mean ?n) :where [?e :n ?n]])')), [[2]])
  d.registerAggregate('half', { init: () => 0, step: (acc) => acc, finish: () => 0.5 })
  assert.deepEqual(rows(d.execute('(query [:find (half ?n) :where [?e :n ?n]])')), [[0.5]])
})

test('a throw fails the query with QRY-014', () => {
  const d = db()
  d.registerPredicate('boom?', (v) => { throw new Error('bad ' + v.value) })
  d.registerPredicate('str?', () => { throw 'plain' }) // eslint-disable-line no-throw-literal
  d.registerPredicate('num?', () => 1)
  const q = (p) => `(query [:find ?n :where [:a :n ?n] [(${p} ?n)]])`
  throwsMessage(() => d.execute(q('boom?')), '[QRY-014] user function `boom?` failed: bad 1')
  throwsMessage(() => d.execute(q('str?')), '[QRY-014] user function `str?` failed: plain')
  throwsMessage(() => d.execute(q('num?')), '[QRY-014] user function `num?` failed: returned number, not a boolean')

  // Through a cursor, a prepared query and a prepared cursor too.
  const cursor = d.query(q('boom?'))
  assert.throws(() => cursor.nextBatch(10), (e) => e.message.startsWith('[QRY-014]'), 'cursor')
  const pq = d.prepare(q('boom?'))
  assert.throws(() => pq.execute(), (e) => e.message.startsWith('[QRY-014]'), 'prepared')
  assert.throws(() => pq.query().nextBatch(10), (e) => e.message.startsWith('[QRY-014]'), 'prepared cursor')
  // The database still works.
  assert.equal(rows(d.execute('(query [:find ?n :where [?e :n ?n]])')).length, 3)
})

test('aggregate failures fail the query', () => {
  const d = db()
  const ok = { init: () => 0, step: (acc) => acc, finish: () => 0 }
  const bad = () => { throw new TypeError('no') }
  for (const [name, agg, message] of [
    ['bad-init', { ...ok, init: bad }, 'no'],
    ['bad-step', { ...ok, step: bad }, 'no'],
    ['bad-finish', { ...ok, finish: bad }, 'no'],
    ['bad-ref', { ...ok, finish: () => ({ type: 'ref', value: 'nope' }) }, 'invalid argument: finish\'s result of type "ref" "nope" is not a UUID'],
    ['bad-entity', { ...ok, finish: () => ({ type: 'entity', value: '00000000-0000-0000-0000-000000000000' }) }, "invalid argument: finish's result is not a value"],
    ['bad-object', { ...ok, finish: () => ({}) }, "finish's result: a bind value is a boolean, number, bigint, string, null or {type, value} object"]
  ]) {
    d.registerAggregate(name, agg)
    for (const q of [
      `(query [:find (${name} ?n) :where [?e :n ?n]])`,
      `(query [:find ?n (${name} ?n :over (:order-by ?n)) :where [?e :n ?n]])`
    ]) {
      throwsMessage(() => d.execute(q), `[QRY-014] user function \`${name}\` failed: ${message}`)
    }
  }
})

test('registration errors', () => {
  const d = db()
  d.registerPredicate('p?', () => true)
  assert.throws(() => d.registerPredicate('q?', 1), TypeError, 'not a function')
  assert.throws(() => d.registerAggregate('a', { init: () => 0 }), TypeError, 'step missing')
  assert.throws(() => d.registerAggregate('a', null), TypeError, 'not an object')
  assert.throws(() => d.registerPredicate('p?', () => true), (e) => e.message.startsWith('[INT-040]'), 'duplicate name')
  assert.throws(() => d.registerPredicate('string?', () => true), (e) => e.message.startsWith('[INT-040]'), 'built-in name')
  d.registerAggregate('p?', { init: () => 0, step: (a) => a, finish: (a) => a })
  // The failed registrations left the names free.
  d.registerPredicate('q?', () => true)
  d.registerAggregate('a', { init: () => 0, step: (a) => a, finish: (a) => a })
})

test('a function may call back into its database', () => {
  const d = db()
  d.registerPredicate('one?', (v) => v.value === 1n)
  let registered = false
  d.registerPredicate('nested?', (v) => {
    // A nested query that runs a user function too: true only for ?n = 1.
    const nested = `(query [:find ?g :where [?e :n ${v.value}] [?e :g ?g] [?e :n ?m] [(one? ?m)]])`
    const viaExecute = rows(d.execute(nested)).length > 0
    const viaCursor = d.query(nested).nextBatch(10) !== null
    const viaPrepared = rows(d.prepare(nested).execute()).length > 0
    assert.equal(viaCursor, viaExecute)
    assert.equal(viaPrepared, viaExecute)
    d.currentTxCount()
    if (!registered) {
      d.registerPredicate('later?', () => true)
      registered = true
    }
    return viaExecute
  })
  // The outer query opened before `later?` existed.
  assert.throws(() => d.execute('(query [:find ?n :where [?e :n ?n] [(nested? ?n)] [(later? ?n)]])'), (e) => e.message.startsWith('[QRY-007]'))
  assert.deepEqual(rows(d.execute('(query [:find ?n :where [?e :n ?n] [(nested? ?n)]])')), [[1]])
  assert.ok(registered)
  assert.equal(rows(d.execute('(query [:find ?n :where [?e :n ?n] [(later? ?n)]])')).length, 3, 'visible to the next query')
})

test('a function may write and checkpoint; the query does not see the write', () => {
  const d = db()
  let wrote = false
  d.registerPredicate('write?', () => {
    if (!wrote) {
      wrote = true
      d.execute('(transact [[:d :n 4]])')
      d.checkpoint()
    }
    return true
  })
  assert.equal(rows(d.execute('(query [:find ?n :where [?e :n ?n] [(write? ?n)]])')).length, 3)
  assert.equal(rows(d.execute('(query [:find ?n :where [?e :n ?n]])')).length, 4, 'the write landed')
})

test('a prepared query may run itself from its own function', () => {
  const d = db()
  let pq
  let depth = 0
  d.registerPredicate('again?', () => {
    if (depth++ === 0) assert.equal(rows(pq.execute()).length, 3)
    return true
  })
  pq = d.prepare('(query [:find ?n :where [?e :n ?n] [(again? ?n)]])')
  assert.equal(rows(pq.execute()).length, 3)
})

test('a cursor read from inside its own query fails the call', () => {
  const d = db()
  let cursor
  d.registerPredicate('self?', () => {
    cursor.nextBatch(1)
    return true
  })
  cursor = d.query('(query [:find ?n :where [?e :n ?n] [(self? ?n)]])')
  assert.throws(() => cursor.nextBatch(10), (e) => e.message === '[QRY-014] user function `self?` failed: the cursor is already reading a batch')
})

test('close() from inside a function lets the running query finish', () => {
  const d = db()
  d.registerPredicate('close?', () => {
    d.close()
    return true
  })
  assert.equal(rows(d.execute('(query [:find ?n :where [?e :n ?n] [(close? ?n)]])')).length, 3)
  assert.throws(() => d.execute('(query [:find ?n :where [?e :n ?n]])'), /database is closed/)
  assert.throws(() => d.registerPredicate('x?', () => true), /database is closed/)
})

test('functions work on a worker thread', async () => {
  const entry = fileURLToPath(new URL('../minigraf.js', import.meta.url))
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads')
    const { MiniGrafDb } = require(${JSON.stringify(entry)})
    const d = MiniGrafDb.inMemory()
    d.execute('(transact [[:a :n 1] [:b :n 2]])')
    d.registerPredicate('two?', (v) => v.value === 2n)
    d.registerAggregate('total', { init: () => 0n, step: (a, v) => a + v.value, finish: (a) => a })
    const r1 = JSON.parse(d.execute('(query [:find ?n :where [?e :n ?n] [(two? ?n)]])')).results
    const r2 = JSON.parse(d.execute('(query [:find (total ?n) :where [?e :n ?n]])')).results
    parentPort.postMessage([r1, r2])
  `, { eval: true })
  const [r1, r2] = await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  await worker.terminate()
  assert.deepEqual(r1, [[2]])
  assert.deepEqual(r2, [[3]])
  // The main thread's functions are unaffected.
  const d = db()
  d.registerPredicate('two?', (v) => v.value === 2n)
  assert.deepEqual(rows(d.execute('(query [:find ?n :where [?e :n ?n] [(two? ?n)]])')), [[2]])
})
