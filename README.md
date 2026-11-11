# minigraf (Node.js)

Node.js binding for [Minigraf](https://github.com/project-minigraf/minigraf) — zero-config,
single-file, embedded bi-temporal graph database with Datalog queries.

## Installation

```bash
npm install minigraf
```

| Platform | Architecture | Support |
|----------|-------------|---------|
| Linux | x64 | ✅ |
| Linux | arm64 | ✅ |
| macOS | universal (x64 + arm64) | ✅ |
| Windows | x64 | ✅ |

Requires Node.js 18+.

## Quick start

```js
import { MiniGrafDb } from 'minigraf'

// In-memory database
const db = MiniGrafDb.inMemory()
db.execute('(transact [[:alice :name "Alice"] [:alice :age 30]])')

const result = JSON.parse(db.execute('(query [:find ?n :where [?e :name ?n]])'))
console.log(result.results[0][0])  // "Alice"

// File-backed (persisted to disk)
const db2 = new MiniGrafDb('path/to/mydb.graph')
db2.execute('(transact [[:bob :name "Bob"]])')
db2.checkpoint()
db2.close()
```

## Closing a file-backed database

Only one handle per `.graph` file may be open in a process at a time — two
would each cache their own page table and corrupt the file — so call `close()`
when you are done with one:

```js
const db = new MiniGrafDb('mydb.graph')
db.execute('(transact [[:bob :name "Bob"]])')
db.checkpoint()
db.close()

const again = new MiniGrafDb('mydb.graph') // fine: the first handle is gone
```

Letting the variable go out of scope is **not** enough. JavaScript has no
deterministic destructor: the object becomes unreachable, but the underlying
handle survives until V8 garbage-collects it, which may be arbitrarily later or
not at all before the process exits. Reopening before then throws
`Database is already open in this process`.

`close()` is idempotent; every other method throws once it has run. In-memory
databases hold no file lock, so closing them is optional.

## Open options, cursors, the fact log and the log writer

```js
const { MiniGrafDb, LogWriter } = require('minigraf')

// Read-only: shared lock, nothing written; writes throw "[API-014] ...".
const src = MiniGrafDb.openWithOptions('old.graph', { readOnly: true, pageCacheSize: 4096 })

// A cursor's answer is fixed when it opens. Iterate over rows (decoded like
// execute()'s results), or call nextBatch(n) for a JSON string of up to n rows.
for (const row of src.query('(query [:find ?n :where [?e :name ?n]])')) console.log(row)

// Copy every fact version, keeping tx and valid-time bounds, into a new file.
const out = LogWriter.create('new.graph')
try {
  const log = src.factLog({ attributePrefixes: [':app/'] })
  for (let batch; (batch = log.nextBatch(10000)) !== null; ) out.appendBatch(batch)
  out.advanceTxCount(src.currentTxCount())
  out.finish()
} finally {
  out.close() // abandons the build (no file) unless finish() ran
}
```

Options: `readOnly`, `pageCacheSize`, `allowUnlocked`, `walCheckpointThreshold`,
`maxDerivedFacts`, `maxResults`, `synchronous` (`'full'` or `'normal'`),
`queryMemoryLimit`, `allowOverrides`, `transactionChunkFacts`, `maxIterations`. Fact filter:
`attributes`, `attributePrefixes`, `entities` (UUID strings), `txFrom`/`txTo`
(inclusive, bigint), `order` (`'tx'` or `'storage'`), `window`.

A record's `txCount`, `txId`, `validFrom` and `validTo` are bigints (`validTo` is
`VALID_TIME_FOREVER` for forever), and its `value` is `{ type, value }` with `type` one
of `'string'`, `'integer'` (a bigint), `'float'`, `'boolean'`, `'ref'` (a UUID string),
`'keyword'` or `'null'`, so a record is written back exactly. Error messages start with
their code, such as `[API-015]`; `appendBatch` ends the message with `(batch index N)`.

`queryMemoryLimit` caps the bytes one query may hold, counted per entry by the operators
that keep state (join build sides, negation and `or` tables, distinct sets, aggregate
groups, window rows, rule-derived facts). A query that would hold more throws QRY-012 and
frees what it held. The default, and `Number.MAX_SAFE_INTEGER` or more, is no limit. Rows
a cursor returns are not counted, so read a large answer with `query()`.

Query text may override some settings with keywords such as `:max-derived-facts 1000`.
`allowOverrides` lists the keywords it may use, by name: `'maxDerivedFacts'`,
`'maxResults'`, `'queryMemoryLimit'`, `'maxIterations'`. Left out, the defaults apply:
`OVERRIDABLE_DEFAULTS`, read from the core library (today `'maxDerivedFacts'`,
`'maxResults'` and `'maxIterations'`). A list replaces the defaults, it does not add to
them, and `[]` refuses every keyword: a query that uses one throws `[API-025]` from
`execute()`, `query()` and `prepare()`. An unknown name throws `[API-017]` when the
database opens, as a bad `synchronous` value does.

```js
const { MiniGrafDb, OVERRIDABLE_DEFAULTS } = require('minigraf')
const db = MiniGrafDb.openWithOptions('app.graph', {
  allowOverrides: [...OVERRIDABLE_DEFAULTS, 'queryMemoryLimit'],
  maxIterations: 10000,          // rounds per stratum of a rule query, else INT-020
  transactionChunkFacts: 16384,  // facts staged before a large transaction is chunked
})
```

`maxIterations` defaults to 1,000,000, and `Number.MAX_SAFE_INTEGER` or more is no
limit; `transactionChunkFacts` defaults to 65,536 and is clamped to 1..=1,000,000. A
negative count throws `[API-017]`.

## Prepared queries

`db.prepare(text)` parses a query once; `execute(bindings)` and `query(bindings)` run it
with its `$slots` bound (names without the `$`). Each run reads the database as it is then.

```js
const pq = db.prepare('(query [:find ?n :where [?e :age $age] [?e :name ?n]])')
JSON.parse(pq.execute({ age: 30 })).results
for (const row of pq.query({ age: 40n })) console.log(row)
```

A boolean, a string, `null`, a `bigint` and a `number` bind as values; a `number` is an
integer when `Number.isInteger` accepts it, else a float. Use a typed form for the other
kinds: a `FactValue` such as `{ type: 'float', value: 2 }`, `{ type: 'keyword', value: ':k' }`
or `{ type: 'ref', value: uuid }`; `{ type: 'entity', value: uuid }`; `{ type: 'txCount',
value: 5 }` or `{ type: 'timestamp', value: Date.now() }` for `:as-of`; and
`{ type: 'anyValidTime' }` for `:valid-at`. Anything else throws a `TypeError`. A missing
slot throws `[API-022]`, a slot in an attribute position `[API-023]`, and a value of the
wrong kind `[API-024]`.

A set binds as a JS `Set` or `{ type: 'set', value: [...] }`, for `in?` and the other set
predicates or a set-valued attribute: `pq.execute({ ids: new Set([1, 2, 3]) })`. Its
elements are plain values or typed value forms (`{ type: 'keyword', value: ':role/admin' }`).
An element in an entity, tx count, timestamp or any-valid-time form throws `[API-017]`, a
set inside a set `[API-021]`; a plain array is not a set (`TypeError`). Set values come
back as JSON arrays from `execute()` and as `{ type: 'set', value: [FactValue, ...] }` in
fact records.

`withMaxDerivedFacts(n)`, `withQueryMemoryLimit(bytes)` and `withMaxIterations(n)` each
return a new `PreparedQuery` with that limit; the one they are called on is unchanged.
They are application code, so `allowOverrides` does not apply to them, and an allowed
keyword in the query text still overrides them. `Number.MAX_SAFE_INTEGER` or more means
no limit and a negative value throws `[API-017]`.

```js
const reach = db.prepare('(query [:find ?x ?y :where (reach ?x ?y)])')
const small = reach.withMaxDerivedFacts(10000).withQueryMemoryLimit(16 * 1024 * 1024)
small.execute() // [INT-020] or [QRY-012] past a limit; reach is unchanged
```

`db.close()` also releases every prepared query made from it, derived ones included, so the path can be opened
again; a prepared query used after that throws `[API-018] database is closed`.

## User functions

`db.registerPredicate(name, fn)` adds a predicate, called in a query as `[(name ?v)]`.
`db.registerAggregate(name, { init, step, finish })` adds an aggregate, used in `:find`
as `(name ?v)` and as a window function with `:over`: `init()` returns a new
accumulator (one per group or window partition), `step(acc, value)` returns the
accumulator after `value`, and `finish(acc, count)` returns the result, `count` being
the number of values stepped. All are called as plain functions, with no `this`.

```js
db.registerPredicate('adult?', (v) => v.type === 'integer' && v.value >= 18n)
db.registerAggregate('product', {
  init: () => 1n,
  step: (acc, v) => acc * v.value,
  finish: (acc) => acc,
})
db.execute('(query [:find ?n :where [?e :age ?a] [(adult? ?a)] [?e :name ?n]])')
db.execute('(query [:find (product ?a) :where [?e :age ?a]])')
```

- **Values.** A function receives each value as a `FactValue`, `{ type, value }`, as in
  fact records: `type` is `'string'`, `'integer'` (`value` a `bigint`), `'float'`,
  `'boolean'`, `'ref'` (an entity UUID string), `'keyword'`, `'null'` (no `value`) or
  `'set'` (`value` an array of these). A predicate returns a boolean. An accumulator may
  be any value. `finish` returns a value in any form a prepared query's bindings accept:
  a plain value or a typed `{ type, value }` form.
- **Errors.** A function that throws fails the query with `[QRY-014]`, carrying the
  error's `message` (else `String(e)`), and so does a predicate that returns anything
  but a boolean, or a `finish` whose result is not a value. It is never read as `false`
  or a missing value. Registration throws a `TypeError` when a function is missing, and
  `[INT-040]` when the name is taken (predicates and aggregates have separate names).
- **Lifecycle.** A query that is already open (a cursor) does not see a function
  registered after it; every query opened afterwards does. The database keeps each
  function until it, and every cursor and prepared query opened from it, are released.
  There is no unregister.
- **Threading.** A function runs on the JavaScript thread that calls `execute`,
  `nextBatch` or a prepared query, which is the thread that registered it. A database
  opened in a worker thread keeps its functions in that worker.
- **Cost.** Each value is one call into JavaScript, so a function over many rows costs
  one call per value.
- **Calling the database from a function.** A function may query the same database
  (`execute`, `query`, `prepare` and the prepared query's `execute`/`query`), write,
  checkpoint, register another function, or `close()` it. The query that called it does
  not see a write it makes, and keeps running after a `close()`. A function that calls
  `nextBatch()` on the cursor whose batch called it fails its call.

## Write transactions

A write transaction stages several `transact`, `retract` and `query` statements, with
queries seeing what it staged, and then commits them as one transaction or rolls them
back (minigraf#824). First in the release built on core v3.0.0 (core commit
`639e7382`).

```js
const db = new MiniGrafDb('bank.graph')
db.execute('(transact [[:alice :balance 100] [:bob :balance 50]])')

const tx = db.beginWrite({ chunkFacts: 10000 })
try {
  tx.execute('(transact [[:alice :balance 70] [:bob :balance 80]])')
  tx.execute('(retract [[:alice :balance 100] [:bob :balance 50]])')
  const [[balance]] = JSON.parse(tx.execute('(query [:find ?b :where [:alice :balance ?b]])')).results
  if (balance >= 0) tx.commit()
} finally {
  tx.rollback() // does nothing once committed
}
```

- `db.beginWrite(options?)`: `{ synchronous?: 'full' | 'normal', chunkFacts?: number }`,
  an absent option being the database's. `synchronous` is this commit's WAL sync,
  `chunkFacts` the facts staged before a file database writes the transaction in chunks
  (negative or an unknown `synchronous` is API-017). Read-only databases throw API-014.
- `tx.execute(datalog)` returns what `db.execute` returns; a staged write returns
  `{"ok":true}`. A statement that throws stages nothing and leaves the transaction open.
  There are no cursors or prepared queries inside a transaction.
- `tx.commit()` applies everything as one transaction; a commit that throws rolls back.
  `tx.rollback()` discards it. Either way it is finished (`tx.isOpen` is false):
  `execute` and `commit` then throw API-018, and `rollback` does nothing.
- Commit is always explicit, and the garbage collector may never free an abandoned
  transaction, which keeps the write lock: end every one, in a `finally`.
- There is one JavaScript thread, so while a transaction is open every other call on
  its database that reads or writes (`execute`, `query`, `factLog`, `prepare`,
  `checkpoint`, another `beginWrite`, prepared queries) throws INT-001; nothing waits.
  A user function its statements run gets INT-001 too, also when it calls the
  transaction itself.
- `db.close()` rolls back an open transaction and finishes it (API-018 afterwards).
- Rules registered inside a transaction stay registered after a rollback.

## Building from source

Requires Rust stable toolchain and `@napi-rs/cli`.

```bash
npm install
npx napi build --platform --release --no-js
```

## Cascade release

This repo receives a `core-release` repository_dispatch from the minigraf monorepo
cascade whenever a new version of the `minigraf` core crate is published. The release
workflow pins the new version, commits, tags, builds native `.node` binaries for all
platforms, and publishes to npm.

## License

MIT OR Apache-2.0
