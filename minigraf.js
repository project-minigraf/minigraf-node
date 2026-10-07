'use strict'
// Package entry point: the native classes from the napi-generated index.js,
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

// Assigned one by one so that ESM `import { ... }` can see the names.
module.exports.Cursor = binding.Cursor
module.exports.FactLog = binding.FactLog
module.exports.LogWriter = binding.LogWriter
module.exports.MiniGrafDb = binding.MiniGrafDb
/** `validTo` of a fact that is valid forever. */
module.exports.VALID_TIME_FOREVER = 9223372036854775807n
