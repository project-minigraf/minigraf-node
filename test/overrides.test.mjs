// Override list, the transactionChunkFacts and maxIterations open options and
// the prepared limit setters (minigraf#872).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LogWriter, MiniGrafDb, OVERRIDABLE_DEFAULTS, PreparedQuery } from '../minigraf.js'

const REACH = '(query [:find ?x ?y :where (reach ?x ?y)])'
const GROUPED = '(query [:find ?v (count ?e) :where [?e :v ?v]])'
const DERIVED = '(query [:find ?x ?y :where (reach ?x ?y) :max-derived-facts 100])'
const MEMORY = '(query [:find ?x ?y :where (reach ?x ?y) :query-memory-limit 1000000])'
const NO_LIMIT = Number.MAX_SAFE_INTEGER

const rows = (json) => JSON.parse(json).results
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigraf-overrides-'))
const p = (name) => path.join(dir, name)

function throwsCode (fn, code) {
  assert.throws(fn, (e) => e.message.startsWith(`[${code}]`), code)
}

function reachDb (name, options) {
  const db = MiniGrafDb.openWithOptions(p(`${name}.graph`), options)
  db.execute('(transact [[:a :edge :b] [:b :edge :c] [:c :edge :d] [:d :edge :e] [:p :v 1] [:q :v 1] [:r :v 2]])')
  db.execute('(rule [(reach ?x ?y) [?x :edge ?y]])')
  db.execute('(rule [(reach ?x ?y) [?x :edge ?z] (reach ?z ?y)])')
  return db
}

test('the defaults are read from core', () => {
  assert.deepEqual([...OVERRIDABLE_DEFAULTS], ['maxDerivedFacts', 'maxResults', 'maxIterations'])
  assert.ok(Object.isFrozen(OVERRIDABLE_DEFAULTS))
})

test('allowOverrides replaces the defaults', () => {
  const cases = [
    ['absent', undefined, true, false],
    ['defaults', [...OVERRIDABLE_DEFAULTS], true, false],
    ['empty', [], false, false],
    ['memory', ['queryMemoryLimit', 'queryMemoryLimit'], false, true],
    ['all', ['maxDerivedFacts', 'maxResults', 'queryMemoryLimit', 'maxIterations'], true, true],
  ]
  for (const [name, allowOverrides, derivedOk, memoryOk] of cases) {
    const db = reachDb(name, allowOverrides === undefined ? {} : { allowOverrides })
    for (const [q, ok] of [[DERIVED, derivedOk], [MEMORY, memoryOk]]) {
      if (ok) {
        assert.equal(rows(db.execute(q)).length, 10, name)
        db.query(q).close()
        db.prepare(q)
      } else {
        throwsCode(() => db.execute(q), 'API-025')
        throwsCode(() => db.query(q), 'API-025')
        throwsCode(() => db.prepare(q), 'API-025')
      }
    }
    db.close()
  }
})

test('an unknown override name is refused as a bad synchronous value is', () => {
  throwsCode(() => MiniGrafDb.openWithOptions(p('bad-name.graph'), { allowOverrides: ['maxRows'] }), 'API-017')
  throwsCode(() => MiniGrafDb.openWithOptions(p('bad-name.graph'), { synchronous: 'sometimes' }), 'API-017')
})

test('transactionChunkFacts commits a large transaction', () => {
  const file = p('chunk.graph')
  const db = MiniGrafDb.openWithOptions(file, { transactionChunkFacts: 2 })
  const facts = Array.from({ length: 10 }, (_, i) => `[:e${i} :n ${i}]`).join('')
  db.execute(`(transact [${facts}])`)
  db.close()
  const again = new MiniGrafDb(file)
  assert.equal(rows(again.execute('(query [:find ?n :where [?e :n ?n]])')).length, 10)
  again.close()
  throwsCode(() => MiniGrafDb.openWithOptions(p('bad-chunk.graph'), { transactionChunkFacts: -1 }), 'API-017')
})

test('maxIterations limits rule rounds', () => {
  const d = reachDb('it-default')
  assert.equal(rows(d.execute(REACH)).length, 10)
  d.close()
  const one = reachDb('it-one', { maxIterations: 1 })
  throwsCode(() => one.execute(REACH), 'INT-020')
  one.close()
  const max = reachDb('it-max', { maxIterations: NO_LIMIT })
  assert.equal(rows(max.execute(REACH)).length, 10)
  max.close()
  throwsCode(() => MiniGrafDb.openWithOptions(p('bad-it.graph'), { maxIterations: -1 }), 'API-017')
})

test('the log writer takes the new options', () => {
  const out = p('out.graph')
  const w = LogWriter.create(out, { allowOverrides: [], transactionChunkFacts: 2, maxIterations: 5 })
  w.finish()
  assert.ok(fs.existsSync(out))
  throwsCode(() => LogWriter.create(p('bad-out.graph'), { allowOverrides: ['nope'] }), 'API-017')
})

test('each setter derives a new query and leaves the receiver unchanged', () => {
  // The setters are not gated: every override keyword is refused here.
  const db = reachDb('setters', { allowOverrides: [] })
  for (const [q, setter, n, code] of [
    [REACH, 'withMaxDerivedFacts', 1, 'INT-020'],
    [REACH, 'withMaxIterations', 1, 'INT-020'],
    [GROUPED, 'withQueryMemoryLimit', 16, 'QRY-012'],
  ]) {
    const pq = db.prepare(q)
    const before = rows(pq.execute())
    const derived = pq[setter](n)
    assert.ok(derived instanceof PreparedQuery)
    throwsCode(() => derived.execute(), code)
    throwsCode(() => [...derived.query()], code)
    assert.deepEqual(rows(pq.execute()), before)
    assert.equal(rows(derived[setter](NO_LIMIT).execute()).length, before.length)
    throwsCode(() => pq[setter](-1), 'API-017')
  }
  db.close()
})

test('chained setters keep the limits not set again', () => {
  const db = reachDb('chain')
  const chained = db.prepare(REACH).withMaxDerivedFacts(1).withMaxIterations(1).withMaxIterations(NO_LIMIT)
  throwsCode(() => chained.execute(), 'INT-020')
  assert.equal(rows(chained.withMaxDerivedFacts(NO_LIMIT).execute()).length, 10)
  db.close()
})

test('close() closes derived queries too', () => {
  const db = reachDb('close')
  const pq = db.prepare(REACH)
  const cursor = pq.query()
  const derived = pq.withMaxIterations(10)
  assert.equal([...cursor].length, 10, 'deriving leaves an open cursor alone')
  assert.equal(rows(derived.execute()).length, 10)
  db.close()
  throwsCode(() => derived.execute(), 'API-018')
  throwsCode(() => derived.query(), 'API-018')
  throwsCode(() => derived.withMaxIterations(5), 'API-018')
  throwsCode(() => pq.withMaxDerivedFacts(5), 'API-018')
  // The file is released: it opens again.
  new MiniGrafDb(p('close.graph')).close()
})
