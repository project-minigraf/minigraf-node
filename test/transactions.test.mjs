// Write transactions (minigraf#824).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MiniGrafDb, WriteTransaction } from '../minigraf.js'

const NAMES = '(query [:find ?n :where [?e :person/name ?n]])'
const SETUP = '(transact [[:alice :person/name "Alice"] [:bob :person/name "Bob"]])'

const names = (json) => JSON.parse(json).results.map((r) => r[0]).sort()

function throwsCode (fn, code, what) {
  assert.throws(fn, (e) => e.message.startsWith(`[${code}]`), what ?? code)
}

function tmp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minigraf-tx-'))
}

function memDb () {
  const db = MiniGrafDb.inMemory()
  db.execute(SETUP)
  return db
}

test('a transaction reads its own writes and commits', () => {
  const dir = tmp()
  const file = path.join(dir, 'g.graph')
  const db = new MiniGrafDb(file)
  db.execute(SETUP)
  assert.deepEqual(names(db.execute(NAMES)), ['Alice', 'Bob'], 'before the begin')
  const tx = db.beginWrite()
  assert.ok(tx instanceof WriteTransaction, 'WriteTransaction is exported')
  assert.deepEqual(JSON.parse(tx.execute('(transact [[:carol :person/name "Carol"]])')), { ok: true })
  assert.deepEqual(JSON.parse(tx.execute('(retract [[:bob :person/name "Bob"]])')), { ok: true })
  assert.deepEqual(names(tx.execute(NAMES)), ['Alice', 'Carol'])
  assert.equal(tx.isOpen, true)
  tx.commit()
  assert.equal(tx.isOpen, false)
  assert.deepEqual(names(db.execute(NAMES)), ['Alice', 'Carol'])
  db.close()
  const again = new MiniGrafDb(file)
  assert.deepEqual(names(again.execute(NAMES)), ['Alice', 'Carol'], 'after reopening')
  again.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a rollback leaves the database as it was', () => {
  const dir = tmp()
  const file = path.join(dir, 'g.graph')
  const db = new MiniGrafDb(file)
  db.execute(SETUP)
  const tx = db.beginWrite()
  tx.execute('(transact [[:carol :person/name "Carol"]])')
  tx.execute('(retract [[:bob :person/name "Bob"]])')
  tx.rollback()
  assert.deepEqual(names(db.execute(NAMES)), ['Alice', 'Bob'], 'after the rollback')
  db.close()
  const again = new MiniGrafDb(file)
  assert.deepEqual(names(again.execute(NAMES)), ['Alice', 'Bob'], 'after reopening')
  again.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('try/finally rolls back when a statement throws', () => {
  const db = memDb()
  assert.throws(() => {
    const tx = db.beginWrite()
    try {
      tx.execute('(transact [[:dave :person/name "Dave"]])')
      throw new Error('boom')
    } finally {
      tx.rollback()
    }
  }, /boom/)
  assert.deepEqual(names(db.execute(NAMES)), ['Alice', 'Bob'])
  db.execute('(transact [[:erin :person/name "Erin"]])') // the lock is free
})

test('a failed statement stages nothing and leaves the transaction open', () => {
  const db = memDb()
  const tx = db.beginWrite()
  throwsCode(() => tx.execute('(transact [[:a'), 'PRS-004')
  throwsCode(() => tx.execute('(transact [[:x :p/v 1 {:valid-from "2020-01-01T00:00:00Z"}] [:x :p/v 1 {:valid-from "2021-01-01T00:00:00Z"}]])'), 'API-011')
  tx.execute('(transact [[:carol :person/name "Carol"]])')
  tx.commit()
  assert.deepEqual(names(db.execute(NAMES)), ['Alice', 'Bob', 'Carol'])
})

test('a finished transaction is API-018; rollback does nothing', () => {
  const db = memDb()
  const committed = db.beginWrite()
  committed.commit()
  const rolledBack = db.beginWrite()
  rolledBack.rollback()
  for (const tx of [committed, rolledBack]) {
    throwsCode(() => tx.execute(NAMES), 'API-018', 'execute')
    throwsCode(() => tx.commit(), 'API-018', 'commit')
    tx.rollback()
  }
})

test('every database call is INT-001 while a transaction is open', () => {
  const db = memDb()
  const pq = db.prepare(NAMES)
  const tx = db.beginWrite()
  const calls = {
    execute: () => db.execute(NAMES),
    query: () => db.query(NAMES),
    factLog: () => db.factLog(),
    prepare: () => db.prepare(NAMES),
    checkpoint: () => db.checkpoint(),
    beginWrite: () => db.beginWrite(),
    'prepared execute': () => pq.execute(),
    'prepared query': () => pq.query()
  }
  for (const [name, call] of Object.entries(calls)) throwsCode(call, 'INT-001', name)
  tx.rollback()
  for (const call of Object.values(calls)) {
    const r = call()
    if (r instanceof WriteTransaction) r.rollback()
  }
})

test('options: chunkFacts, synchronous and read-only', () => {
  const dir = tmp()
  const file = path.join(dir, 'g.graph')
  const db = new MiniGrafDb(file)
  throwsCode(() => db.beginWrite({ chunkFacts: -1 }), 'API-017', 'negative chunkFacts')
  throwsCode(() => db.beginWrite({ synchronous: 'sometimes' }), 'API-017', 'bad synchronous')
  const tx = db.beginWrite({ synchronous: 'normal', chunkFacts: 2 })
  for (let i = 0; i < 5; i++) tx.execute(`(transact [[:p${i} :person/name "P${i}"]])`)
  assert.equal(names(tx.execute(NAMES)).length, 5, 'a large transaction reads its writes')
  tx.commit()
  const full = db.beginWrite({ synchronous: 'full' })
  full.execute('(transact [[:q :person/name "Q"]])')
  full.commit()
  db.close()
  const again = new MiniGrafDb(file)
  assert.equal(names(again.execute(NAMES)).length, 6, 'every fact after reopening')
  again.close()
  const ro = MiniGrafDb.openWithOptions(file, { readOnly: true })
  throwsCode(() => ro.beginWrite(), 'API-014')
  ro.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('close() rolls back an open transaction and finishes it', () => {
  const dir = tmp()
  const file = path.join(dir, 'g.graph')
  const db = new MiniGrafDb(file)
  db.execute(SETUP)
  const tx = db.beginWrite()
  tx.execute('(transact [[:carol :person/name "Carol"]])')
  db.close()
  throwsCode(() => tx.execute(NAMES), 'API-018', 'execute after close')
  throwsCode(() => tx.commit(), 'API-018', 'commit after close')
  tx.rollback()
  const again = new MiniGrafDb(file) // the file lock was released
  assert.deepEqual(names(again.execute(NAMES)), ['Alice', 'Bob'])
  again.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a user function sees staged values; a call back into the database is QRY-014', () => {
  const db = memDb()
  db.registerPredicate('carol?', (v) => v.value === 'Carol')
  db.registerPredicate('calls-back?', () => { db.execute(NAMES); return true })
  let tx
  db.registerPredicate('calls-tx?', () => { tx.execute(NAMES); return true })
  tx = db.beginWrite()
  tx.execute('(transact [[:carol :person/name "Carol"]])')
  assert.deepEqual(names(tx.execute('(query [:find ?n :where [?e :person/name ?n] [(carol? ?n)]])')), ['Carol'])
  assert.throws(() => tx.execute('(query [:find ?n :where [?e :person/name ?n] [(calls-back? ?n)]])'),
    (e) => e.message.startsWith('[QRY-014]') && e.message.includes('already in progress'))
  assert.throws(() => tx.execute('(query [:find ?n :where [?e :person/name ?n] [(calls-tx? ?n)]])'),
    (e) => e.message.startsWith('[QRY-014]') && e.message.includes('already in progress'))
  tx.commit()
  assert.deepEqual(names(db.execute(NAMES)), ['Alice', 'Bob', 'Carol'])
})

test('rules registered inside a transaction stay after a rollback', () => {
  const db = memDb()
  const tx = db.beginWrite()
  tx.execute('(rule [(named ?e ?n) [?e :person/name ?n]])')
  tx.rollback()
  assert.deepEqual(names(db.execute('(query [:find ?n :where (named ?e ?n)])')), ['Alice', 'Bob'])
})

test('empty and query-only transactions take no transaction number', () => {
  const db = memDb()
  const before = db.currentTxCount()
  db.beginWrite().commit()
  const tx = db.beginWrite()
  tx.execute(NAMES)
  tx.commit()
  assert.equal(db.currentTxCount(), before)
})
