// Cursors (#462), open options (#465), the fact log and the log writer (#467).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MiniGrafDb, LogWriter, VALID_TIME_FOREVER, WAL_CHECKPOINT_NEVER } from '../minigraf.js'

const QUERY = '(query [:find ?e ?n :where [?e :n ?n]])'
const REF = '00000000-0000-4000-8000-000000000001'

function tmpDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigraf-node-etl-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return (name) => path.join(dir, name)
}

function throwsCode (fn, code) {
  assert.throws(fn, (e) => e.message.startsWith(`[${code}]`))
}

function numbered (n) {
  const db = MiniGrafDb.inMemory()
  for (let i = 0; i < n; i++) db.execute(`(transact [[:e${i} :n ${i}]])`)
  return db
}

function source (p) {
  const db = new MiniGrafDb(p)
  db.execute('(transact {:valid-from "2024-01-01" :valid-to "2025-01-01"} [[:alice :name "Alice"] [:alice :tag :t/admin]])')
  db.execute(`(transact [[:bob :friend #uuid "${REF}"] [:bob :score 2.5]])`)
  db.execute('(retract [[:alice :name "Alice"]])')
  return db
}

const sorted = (rows) => rows.map((r) => JSON.stringify(r)).sort()

test('cursor batches of 1, 7 and 1000 match execute()', () => {
  const db = numbered(25)
  const expected = sorted(JSON.parse(db.execute(QUERY)).results)
  for (const size of [1, 7, 1000]) {
    const cursor = db.query(QUERY)
    assert.deepEqual(cursor.vars(), ['?e', '?n'])
    const rows = []
    for (let batch; (batch = cursor.nextBatch(size)) !== null; ) {
      const decoded = JSON.parse(batch)
      assert.ok(decoded.length > 0 && decoded.length <= size)
      rows.push(...decoded)
    }
    assert.deepEqual(sorted(rows), expected)
  }
  assert.equal([...db.query(QUERY)].length, 25)
})

test('cursor is fixed at open, closes, and rejects non-queries', () => {
  const db = numbered(1)
  const cursor = db.query(QUERY)
  db.execute('(transact [[:late :n 99]])')
  assert.deepEqual([...cursor].map((r) => r[1]), [0])

  const closed = db.query(QUERY)
  assert.notEqual(closed.nextBatch(1), null)
  closed.close()
  assert.equal(closed.nextBatch(1), null)
  throwsCode(() => db.query('(transact [[:a :n 1]])'), 'API-012')
})

test('read-only open', (t) => {
  const p = tmpDir(t)
  const file = p('ro.graph')
  const db = new MiniGrafDb(file)
  db.execute('(transact [[:a :n 1] [:b :n 2]])')
  db.close()

  const ro = MiniGrafDb.openWithOptions(file, { readOnly: true, pageCacheSize: 16 })
  const ro2 = MiniGrafDb.openWithOptions(file, { readOnly: true })
  assert.equal([...ro.query(QUERY)].length, 2)
  assert.equal(ro2.currentTxCount(), 1n)
  throwsCode(() => ro.execute('(transact [[:c :n 3]])'), 'API-014')
  throwsCode(() => new MiniGrafDb(file), 'STG-025')
  ro.close()
  ro2.close()

  const missing = p('missing.graph')
  throwsCode(() => MiniGrafDb.openWithOptions(missing, { readOnly: true }), 'STG-042')
  assert.equal(fs.existsSync(missing), false)
  throwsCode(() => MiniGrafDb.openWithOptions(p('x.graph'), { synchronous: 'sometimes' }), 'API-017')
})

test('fact log records and filters', (t) => {
  const p = tmpDir(t)
  const db = source(p('s.graph'))
  const records = [...db.factLog()]
  assert.equal(records.length, 5)
  assert.deepEqual(records.map((r) => r.txCount), records.map((r) => r.txCount).sort())
  assert.deepEqual(records.find((r) => r.attribute === ':friend').value, { type: 'ref', value: REF })
  assert.deepEqual(records.find((r) => r.attribute === ':tag').value, { type: 'keyword', value: ':t/admin' })
  assert.equal(records.find((r) => r.attribute === ':score').validTo, VALID_TIME_FOREVER)
  assert.equal(records.filter((r) => !r.asserted).length, 1)

  assert.deepEqual(new Set([...db.factLog({ attributes: [':name'] })].map((r) => r.attribute)), new Set([':name']))
  assert.deepEqual(new Set([...db.factLog({ txFrom: 2n, txTo: 2n })].map((r) => r.txCount)), new Set([2n]))
  assert.equal([...db.factLog({ order: 'storage' })].length, 5)
  throwsCode(() => db.factLog({ entities: ['alice'] }), 'API-017')
  db.close()
})

test('log writer round trip and a hole', (t) => {
  const p = tmpDir(t)
  const src = source(p('s.graph'))
  const records = [...src.factLog()]

  const out = p('out.graph')
  const w = LogWriter.create(out)
  w.append(records[0])
  w.appendBatch(records.slice(1))
  w.advanceTxCount(src.currentTxCount())
  assert.equal(w.txCount(), 3n)
  w.finish()
  assert.equal(w.isOpen(), false)
  assert.equal(fs.existsSync(out + '.partial'), false)

  const copy = MiniGrafDb.openWithOptions(out, { readOnly: true })
  assert.equal(copy.currentTxCount(), src.currentTxCount())
  assert.deepEqual([...copy.factLog()], records)
  copy.close()

  const hole = p('hole.graph')
  const h = LogWriter.create(hole, {})
  h.appendBatch(records.filter((r) => r.txCount !== 2n))
  h.advanceTxCount(3n)
  h.finish()
  const hdb = MiniGrafDb.openWithOptions(hole, { readOnly: true })
  assert.deepEqual(new Set([...hdb.factLog()].map((r) => r.txCount)), new Set([1n, 3n]))
  assert.equal(
    hdb.execute('(query [:find ?a :as-of 2 :any-valid-time :where [?e ?a _]])'),
    hdb.execute('(query [:find ?a :as-of 1 :any-valid-time :where [?e ?a _]])'),
  )
  hdb.close()
  src.close()
})

test('log writer errors and close without finish', (t) => {
  const p = tmpDir(t)
  const src = source(p('s.graph'))
  const records = [...src.factLog()]
  const last = records[records.length - 1]

  const out = p('err.graph')
  const w = LogWriter.create(out)
  w.append(last)
  assert.throws(
    () => w.appendBatch([last, records[0]]),
    (e) => e.message.startsWith('[API-015]') && e.message.endsWith('(batch index 1)'),
  )
  throwsCode(() => w.append({ ...records[0], entity: 'alice', txCount: 9n }), 'API-017')
  throwsCode(() => w.append({ ...last, txCount: 9n, value: { type: 'integer', value: 'x' } }), 'API-017')
  w.finish()
  throwsCode(() => w.finish(), 'API-018')
  w.close()
  throwsCode(() => LogWriter.create(out), 'STG-043')
  throwsCode(() => LogWriter.create(p('ro.graph'), { readOnly: true }), 'API-014')

  const abandoned = p('abandoned.graph')
  const a = LogWriter.create(abandoned)
  a.appendBatch(records)
  a.close()
  assert.equal(fs.existsSync(abandoned), false)
  assert.equal(fs.existsSync(abandoned + '.partial'), false)
  src.close()
})

test('WAL_CHECKPOINT_NEVER keeps the WAL on close (#322)', (t) => {
  const p = tmpDir(t)
  const never = p('never.graph')
  const db = MiniGrafDb.openWithOptions(never, { walCheckpointThreshold: WAL_CHECKPOINT_NEVER })
  db.execute('(transact [[:a :n 1]])')
  db.close()
  assert.equal(fs.existsSync(never + '.wal'), true)

  const ordinary = p('ordinary.graph')
  const db2 = MiniGrafDb.openWithOptions(ordinary, { walCheckpointThreshold: WAL_CHECKPOINT_NEVER - 1 })
  db2.execute('(transact [[:a :n 1]])')
  db2.close()
  assert.equal(fs.existsSync(ordinary + '.wal'), false)
})
