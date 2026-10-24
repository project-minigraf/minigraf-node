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
    ['(query [:find ?x :valid-at $v :where [:a :n ?x]])', { type: 'timestamp', value: Date.now() }],
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
