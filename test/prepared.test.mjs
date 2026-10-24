// Prepared queries (minigraf#181).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MiniGrafDb, PreparedQuery } from '../minigraf.js'

function db () {
  const db = MiniGrafDb.inMemory()
  db.execute('(transact [[:a :n 1] [:b :n 2] [:c :n 3] [:a :s "x"] [:a :f 2.5] [:a :w 2.0] [:a :t true] [:a :k :kw] [:a :z nil]])')
  return db
}

const rows = (json) => JSON.parse(json).results
const entityA = (d) => rows(d.execute('(query [:find ?e :where [?e :s "x"]])'))[0][0]

function throwsCode (fn, code) {
  assert.throws(fn, (e) => e.message.startsWith(`[${code}]`), code)
}

test('a prepared query runs again with new bindings', () => {
  const pq = db().prepare('(query [:find ?x :where [?e :n $n] [?e :n ?x]])')
  assert.ok(pq instanceof PreparedQuery, 'PreparedQuery is exported')
  for (const n of [1, 2, 3]) assert.deepEqual(rows(pq.execute({ n })), [[n]])
  assert.deepEqual(rows(pq.execute({ n: 2n })), [[2]])
  assert.deepEqual(rows(pq.execute({ n: 9 })), [])
})

test('every plain value binds', () => {
  const d = db()
  for (const [attr, v] of [[':n', 1], [':n', 1n], [':s', 'x'], [':f', 2.5], [':t', true], [':z', null]]) {
    const pq = d.prepare(`(query [:find ?e :where [?e ${attr} $v]])`)
    assert.equal(rows(pq.execute({ v })).length, 1, `${attr}`)
  }
  // A whole-number number is an integer, so it does not match the float 2.0.
  const w = d.prepare('(query [:find ?e :where [?e :w $v]])')
  assert.deepEqual(rows(w.execute({ v: 2 })), [])
  assert.equal(rows(w.execute({ v: { type: 'float', value: 2 } })).length, 1)
})

test('every typed value binds', () => {
  const d = db()
  const a = entityA(d)
  for (const [q, v] of [
    ['(query [:find ?e :where [?e :n $v]])', { type: 'integer', value: 1n }],
    ['(query [:find ?e :where [?e :n $v]])', { type: 'integer', value: 1 }],
    ['(query [:find ?e :where [?e :s $v]])', { type: 'string', value: 'x' }],
    ['(query [:find ?e :where [?e :t $v]])', { type: 'boolean', value: true }],
    ['(query [:find ?e :where [?e :k $v]])', { type: 'keyword', value: ':kw' }],
    ['(query [:find ?e :where [?e :z $v]])', { type: 'null' }],
    ['(query [:find ?x :where [$v :n ?x]])', { type: 'entity', value: a }],
    ['(query [:find ?x :where [$v :n ?x]])', { type: 'ref', value: a }],
    ['(query [:find ?x :as-of $v :where [?e :n ?x]])', { type: 'txCount', value: 1 }],
    ['(query [:find ?x :as-of $v :where [?e :n ?x]])', { type: 'txCount', value: 1n }],
    // A minute ahead: the fact's valid-from is Rust's clock at transact, which Date.now() can trail.
    ['(query [:find ?x :valid-at $v :where [:a :n ?x]])', { type: 'timestamp', value: Date.now() + 60_000 }],
    ['(query [:find ?x :valid-at $v :where [:a :n ?x]])', { type: 'anyValidTime' }]
  ]) {
    assert.ok(rows(d.prepare(q).execute({ v })).length > 0, q)
  }
})

test('a prepared cursor gives the rows of execute()', () => {
  const pq = db().prepare('(query [:find ?e ?n :where [?e :n ?n] [(>= ?n $min)]])')
  const expected = rows(pq.execute({ min: 2 }))
  const cursor = pq.query({ min: 2 })
  assert.deepEqual(cursor.vars(), ['?e', '?n'])
  assert.deepEqual([...cursor].map(String).sort(), expected.map(String).sort())
  assert.equal(expected.length, 2)
})

test('bad bindings are rejected', () => {
  const d = db()
  const pq = d.prepare('(query [:find ?e :where [?e :n $n]])')
  for (const bad of [undefined, { type: 'nonsense' }, [1], Symbol('s')]) {
    assert.throws(() => pq.execute({ n: bad }), TypeError)
  }
  assert.throws(() => pq.execute(1), TypeError)
  const boom = { get type () { throw new RangeError('boom') } }
  assert.throws(() => pq.execute({ n: boom }), RangeError, 'a throwing getter propagates')
  throwsCode(() => pq.execute({}), 'API-022')
  throwsCode(() => pq.execute(), 'API-022')
  throwsCode(() => pq.query({}), 'API-022')
  throwsCode(() => pq.execute({ n: { type: 'txCount', value: 1 } }), 'API-024')
  throwsCode(() => pq.execute({ n: { type: 'txCount', value: -1 } }), 'API-017')
  throwsCode(() => pq.execute({ n: { type: 'null', value: 1 } }), 'API-017')
  throwsCode(() => pq.execute({ n: 2 ** 63 }), 'API-017')
  throwsCode(() => pq.execute({ n: { type: 'entity', value: 'not-a-uuid' } }), 'API-017')
  throwsCode(() => d.prepare('(query [:find ?v :where [?e $a ?v]])'), 'API-023')
  throwsCode(() => d.prepare('(transact [[:a :n 1]])'), 'API-005')
})

test('a prepared query sees later writes', () => {
  const d = db()
  const pq = d.prepare('(query [:find ?e :where [?e :n $n]])')
  assert.deepEqual(rows(pq.execute({ n: 4 })), [])
  d.execute('(transact [[:d :n 4]])')
  assert.equal(rows(pq.execute({ n: 4 })).length, 1)
})

test('close() releases prepared queries, so the path reopens', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigraf-node-prepared-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const p = path.join(dir, 'p.graph')
  const d = new MiniGrafDb(p)
  d.execute('(transact [[:a :n 1]])')
  const pq = d.prepare('(query [:find ?e :where [?e :n $n]])')
  d.close()
  throwsCode(() => pq.execute({ n: 1 }), 'API-018')
  throwsCode(() => pq.query({ n: 1 }), 'API-018')
  const again = new MiniGrafDb(p) // the prepared query no longer holds the file
  const pq2 = again.prepare('(query [:find ?e :where [?e :n $n]])')
  assert.equal(rows(pq2.execute({ n: 1 })).length, 1)
  again.close()
})

// ─── Sets (minigraf#316) ─────────────────────────────────────────────────────

test('typed sets and JS Sets bind set values', () => {
  const pq = db().prepare('(query [:find ?e :where [?e :n ?n] [(in? ?n $s)]])')
  for (const [s, want] of [
    [{ type: 'set', value: [1, 3] }, 2],
    [{ type: 'set', value: [2, 2] }, 1],
    [new Set([2, 3n]), 2],
    [{ type: 'set', value: [] }, 0],
    [new Set(), 0]
  ]) {
    assert.equal(rows(pq.execute({ s })).length, want)
    assert.equal([...pq.query({ s })].length, want, 'query() takes sets too')
  }
})

test('set values come back as arrays and in fact records', () => {
  const d = db()
  d.execute('(transact [[:a :tags #{1 :k "x"}]])')
  const equal = d.prepare('(query [:find ?x :where [?e :tags $s] [?e :n ?x]])')
  const tags = () => [{ type: 'keyword', value: ':k' }, 1, 'x']
  assert.deepEqual(rows(equal.execute({ s: { type: 'set', value: tags() } })), [[1]])
  assert.deepEqual(rows(equal.execute({ s: new Set(tags()) })), [[1]])
  assert.deepEqual(rows(equal.execute({ s: new Set([':k', 1, 'x']) })), [], 'a string is no keyword')
  assert.deepEqual(rows(d.execute('(query [:find ?t :where [:a :tags ?t]])')), [[['x', 1, ':k']]])
  const [record] = [...d.factLog({ attributes: [':tags'] })]
  assert.deepEqual(record.value, {
    type: 'set',
    value: [{ type: 'string', value: 'x' }, { type: 'integer', value: 1n }, { type: 'keyword', value: ':k' }]
  })
})

test('bad sets are rejected', () => {
  const d = db()
  const pq = d.prepare('(query [:find ?e :where [?e :n ?n] [(in? ?n $s)]])')
  for (const nested of [
    { type: 'set', value: [{ type: 'set', value: [1] }] },
    new Set([new Set([1])]),
    { type: 'set', value: [new Set()] }
  ]) {
    throwsCode(() => pq.execute({ s: nested }), 'API-021')
  }
  for (const bad of [
    { type: 'set', value: [{ type: 'entity', value: entityA(d) }] },
    { type: 'set', value: [{ type: 'anyValidTime' }] },
    { type: 'set', value: 1 },
    { type: 'set' }
  ]) {
    throwsCode(() => pq.execute({ s: bad }), 'API-017')
  }
  for (const bad of [[1], { type: 'set', value: [undefined] }, { type: 'set', value: [{}] }, { type: 'set', value: [[1]] }]) {
    assert.throws(() => pq.execute({ s: bad }), TypeError)
  }
})
