'use strict'
// Package entry point: the native classes from index.js,
// plus JavaScript iteration over cursors and fact logs. (napi's own iterator
// support cannot throw, so a failed batch read would end the loop silently.)
const binding = require('./index.js')

const BATCH = 1000

/** Rows of the answer (decoded like `execute()`'s `results`), read in batches. */
binding.Cursor.prototype[Symbol.iterator] = function* rows() {
  for (let batch; (batch = this.nextBatch(BATCH)) !== null; ) {
    yield* JSON.parse(batch)
  }
}

/** Fact records, read in batches. */
binding.FactLog.prototype[Symbol.iterator] = function* records() {
  for (let batch; (batch = this.nextBatch(BATCH)) !== null; ) {
    yield* batch
  }
}

// A JS `Set` binds as the typed form `{ type: 'set', value: [...] }`
// (minigraf#316), in a typed set's elements too, so a set inside a set
// reaches the native reader and fails with API-021.
function setForm(v) {
  if (v instanceof Set) return { type: 'set', value: Array.from(v, setForm) }
  if (v !== null && typeof v === 'object' && v.type === 'set' && Array.isArray(v.value)) {
    return { type: 'set', value: v.value.map(setForm) }
  }
  return v
}

function bindings(b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b
  // A null prototype keeps a slot named __proto__ an own property.
  const out = Object.create(null)
  for (const [name, v] of Object.entries(b)) out[name] = setForm(v)
  return out
}

for (const method of ['execute', 'query']) {
  const native = binding.PreparedQuery.prototype[method]
  binding.PreparedQuery.prototype[method] = function (b) {
    return native.call(this, bindings(b))
  }
}

// Assigned one by one so that ESM `import { ... }` can see the names.
module.exports.Cursor = binding.Cursor
module.exports.FactLog = binding.FactLog
module.exports.LogWriter = binding.LogWriter
module.exports.MiniGrafDb = binding.MiniGrafDb
module.exports.PreparedQuery = binding.PreparedQuery
/** `validTo` of a fact that is valid forever. */
module.exports.VALID_TIME_FOREVER = 9223372036854775807n
/**
 * `walCheckpointThreshold` that never checkpoints: no automatic checkpoint and
 * none when the handle closes. Call `checkpoint()` yourself.
 */
module.exports.WAL_CHECKPOINT_NEVER = Number.MAX_SAFE_INTEGER
