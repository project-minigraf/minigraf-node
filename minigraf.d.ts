export * from './index'

/** `validTo` of a fact that is valid forever. */
export declare const VALID_TIME_FOREVER: bigint

/** `walCheckpointThreshold` that never checkpoints, not even when the handle closes. */
export declare const WAL_CHECKPOINT_NEVER: number

/**
 * The override list that applies when `allowOverrides` is absent: the Rust
 * `Overridable::DEFAULTS`, read from the core library.
 */
export declare const OVERRIDABLE_DEFAULTS: ReadonlyArray<'maxDerivedFacts' | 'maxResults' | 'queryMemoryLimit' | 'maxIterations'>

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
