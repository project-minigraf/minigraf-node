export * from './index'

/** `validTo` of a fact that is valid forever. */
export declare const VALID_TIME_FOREVER: bigint

declare module './index' {
  interface Cursor {
    /** Rows of the answer (decoded like `execute()`'s `results`), read in batches. */
    [Symbol.iterator](): Iterator<unknown[]>
  }
  interface FactLog {
    /** Fact records, read in batches. */
    [Symbol.iterator](): Iterator<FactRecord>
  }
}
