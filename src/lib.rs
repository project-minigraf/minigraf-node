use minigraf::{MinigrafError, QueryResult, Value};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

fn js_err(e: MinigrafError) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

fn invalid(detail: String) -> Error {
    js_err(MinigrafError::invalid_argument(detail))
}

fn to_usize(n: i64, what: &str) -> Result<usize> {
    usize::try_from(n).map_err(|_| invalid(format!("{what} {n} is out of range")))
}

fn bigint_to_i64(b: &BigInt, what: &str) -> Result<i64> {
    let (n, lossless) = b.get_i64();
    if lossless {
        Ok(n)
    } else {
        Err(invalid(format!(
            "{what} does not fit in a signed 64-bit integer"
        )))
    }
}

fn bigint_to_u64(b: &BigInt, what: &str) -> Result<u64> {
    let (negative, n, lossless) = b.get_u64();
    if lossless && !negative {
        Ok(n)
    } else {
        Err(invalid(format!(
            "{what} must be a non-negative 64-bit integer"
        )))
    }
}

fn parse_uuid(s: &str, what: &str) -> Result<minigraf::EntityId> {
    minigraf::EntityId::parse_str(s).map_err(|_| invalid(format!("{what} {s:?} is not a UUID")))
}

// ─── Value → JSON ─────────────────────────────────────────────────────────────

fn value_to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::String(s) => J::String(s.clone()),
        Value::Integer(i) => serde_json::json!(i),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(J::Number)
            .unwrap_or(J::Null),
        Value::Boolean(b) => J::Bool(*b),
        Value::Ref(u) => J::String(u.to_string()),
        Value::Keyword(k) => J::String(k.clone()),
        Value::Null => J::Null,
    }
}

fn query_result_to_json(result: QueryResult) -> String {
    let val = match result {
        QueryResult::Transacted(tx_id) => {
            serde_json::json!({"transacted": tx_id})
        }
        QueryResult::Retracted(tx_id) => {
            serde_json::json!({"retracted": tx_id})
        }
        QueryResult::Ok => serde_json::json!({"ok": true}),
        QueryResult::QueryResults { vars, results } => {
            let rows: Vec<Vec<serde_json::Value>> = results
                .iter()
                .map(|r| r.iter().map(value_to_json).collect())
                .collect();
            serde_json::json!({"variables": vars, "results": rows})
        }
    };
    val.to_string()
}

fn rows_to_json(rows: &[Vec<Value>]) -> String {
    let rows: Vec<Vec<serde_json::Value>> = rows
        .iter()
        .map(|r| r.iter().map(value_to_json).collect())
        .collect();
    serde_json::Value::from(rows).to_string()
}

// ─── Options, values and fact records ────────────────────────────────────────

/// `Number.MAX_SAFE_INTEGER`, the largest integer a JS number holds exactly.
/// From it up, `walCheckpointThreshold` never checkpoints and
/// `queryMemoryLimit` is no limit: core's `usize::MAX`.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Options for `MiniGrafDb.openWithOptions` and `LogWriter.create`. Every field
/// is optional; an absent field keeps the Rust default.
#[napi(object)]
#[derive(Default)]
pub struct OpenOptions {
    /// Open read-only: shared lock, nothing written, writes throw API-014.
    pub read_only: Option<bool>,
    /// Pages (4 KB each) in the page cache. Default 256.
    pub page_cache_size: Option<i64>,
    /// Open even when the filesystem cannot lock files. Default false.
    pub allow_unlocked: Option<bool>,
    /// WAL entries before an automatic checkpoint. Default 1000.
    /// `WAL_CHECKPOINT_NEVER` (2^53 - 1, `Number.MAX_SAFE_INTEGER`) or more
    /// means never: no automatic checkpoint and none when the handle closes.
    pub wal_checkpoint_threshold: Option<i64>,
    /// Facts a recursive rule may derive per iteration. Default 1,000,000.
    pub max_derived_facts: Option<i64>,
    /// Deprecated alias of `maxDerivedFacts`; the lower of the two applies.
    pub max_results: Option<i64>,
    /// WAL durability: `"full"` (default) or `"normal"`.
    #[napi(ts_type = "'full' | 'normal'")]
    pub synchronous: Option<String>,
    /// The most bytes one query may hold; a query that would hold more throws
    /// QRY-012. Default no limit; 2^53 - 1 (`Number.MAX_SAFE_INTEGER`) or more
    /// also means no limit.
    pub query_memory_limit: Option<i64>,
}

impl OpenOptions {
    fn to_core(&self) -> Result<minigraf::OpenOptions> {
        let mut o = minigraf::OpenOptions::new();
        if let Some(v) = self.read_only {
            o = o.read_only(v);
        }
        if let Some(v) = self.page_cache_size {
            o = o.page_cache_size(to_usize(v, "pageCacheSize")?);
        }
        if let Some(v) = self.allow_unlocked {
            o = o.allow_unlocked(v);
        }
        if let Some(v) = self.wal_checkpoint_threshold {
            // JS numbers cannot hold core's usize::MAX sentinel, so anything
            // from Number.MAX_SAFE_INTEGER up stands for it.
            let n = if v >= MAX_SAFE_INTEGER {
                usize::MAX
            } else {
                to_usize(v, "walCheckpointThreshold")?
            };
            o = o.wal_checkpoint_threshold(n);
        }
        if let Some(v) = self.max_derived_facts {
            o = o.max_derived_facts(to_usize(v, "maxDerivedFacts")?);
        }
        if let Some(v) = self.max_results {
            #[allow(deprecated)]
            {
                o = o.max_results(to_usize(v, "maxResults")?);
            }
        }
        if let Some(v) = self.query_memory_limit {
            // As for walCheckpointThreshold: anything from
            // Number.MAX_SAFE_INTEGER up stands for core's usize::MAX.
            let n = if v >= MAX_SAFE_INTEGER {
                usize::MAX
            } else {
                to_usize(v, "queryMemoryLimit")?
            };
            o = o.query_memory_limit(n);
        }
        match self.synchronous.as_deref() {
            None => {}
            Some("full") => o = o.synchronous(minigraf::SyncMode::Full),
            Some("normal") => o = o.synchronous(minigraf::SyncMode::Normal),
            Some(other) => {
                return Err(invalid(format!(
                    "synchronous {other:?} is not 'full' or 'normal'"
                )));
            }
        }
        Ok(o)
    }
}

fn options_to_core(options: Option<OpenOptions>) -> Result<minigraf::OpenOptions> {
    options.unwrap_or_default().to_core()
}

/// A fact value with its type kept: `type` is one of `"string"`, `"integer"`
/// (`value` a bigint), `"float"`, `"boolean"`, `"ref"` (an entity UUID
/// string), `"keyword"` or `"null"` (no `value`).
#[napi(object)]
pub struct FactValue {
    #[napi(
        js_name = "type",
        ts_type = "'string' | 'integer' | 'float' | 'boolean' | 'ref' | 'keyword' | 'null'"
    )]
    pub kind: String,
    pub value: Option<Either4<String, f64, BigInt, bool>>,
}

impl From<Value> for FactValue {
    fn from(v: Value) -> Self {
        let (kind, value) = match v {
            Value::String(s) => ("string", Some(Either4::A(s))),
            Value::Integer(i) => ("integer", Some(Either4::C(BigInt::from(i)))),
            Value::Float(f) => ("float", Some(Either4::B(f))),
            Value::Boolean(b) => ("boolean", Some(Either4::D(b))),
            Value::Ref(id) => ("ref", Some(Either4::A(id.to_string()))),
            Value::Keyword(k) => ("keyword", Some(Either4::A(k))),
            Value::Null => ("null", None),
        };
        FactValue {
            kind: kind.to_string(),
            value,
        }
    }
}

impl FactValue {
    fn to_core(&self) -> Result<Value> {
        let mismatch = || invalid(format!("value does not match its type {:?}", self.kind));
        Ok(match (self.kind.as_str(), &self.value) {
            ("string", Some(Either4::A(s))) => Value::String(s.clone()),
            ("integer", Some(Either4::C(b))) => Value::Integer(bigint_to_i64(b, "integer value")?),
            ("float", Some(Either4::B(f))) => Value::Float(*f),
            ("boolean", Some(Either4::D(b))) => Value::Boolean(*b),
            ("ref", Some(Either4::A(s))) => Value::Ref(parse_uuid(s, "ref value")?),
            ("keyword", Some(Either4::A(k))) => Value::Keyword(k.clone()),
            ("null", None) => Value::Null,
            _ => return Err(mismatch()),
        })
    }
}

/// One fact-log record: an assertion or a retraction, with its transaction
/// and valid-time bounds. `validTo` = 9223372036854775807n is forever.
#[napi(object)]
pub struct FactRecord {
    /// The entity UUID string.
    pub entity: String,
    pub attribute: String,
    pub value: FactValue,
    pub tx_count: BigInt,
    pub tx_id: BigInt,
    pub valid_from: BigInt,
    pub valid_to: BigInt,
    pub asserted: bool,
}

impl From<minigraf::FactRecord> for FactRecord {
    fn from(r: minigraf::FactRecord) -> Self {
        FactRecord {
            entity: r.entity.to_string(),
            attribute: r.attribute,
            value: r.value.into(),
            tx_count: BigInt::from(r.tx_count),
            tx_id: BigInt::from(r.tx_id),
            valid_from: BigInt::from(r.valid_from),
            valid_to: BigInt::from(r.valid_to),
            asserted: r.asserted,
        }
    }
}

impl FactRecord {
    fn to_core(&self) -> Result<minigraf::FactRecord> {
        Ok(minigraf::FactRecord {
            entity: parse_uuid(&self.entity, "entity")?,
            attribute: self.attribute.clone(),
            value: self.value.to_core()?,
            tx_count: bigint_to_u64(&self.tx_count, "txCount")?,
            tx_id: bigint_to_u64(&self.tx_id, "txId")?,
            valid_from: bigint_to_i64(&self.valid_from, "validFrom")?,
            valid_to: bigint_to_i64(&self.valid_to, "validTo")?,
            asserted: self.asserted,
        })
    }
}

/// Which records a fact log returns. Every field is optional; the ones that
/// are set must all match.
#[napi(object)]
#[derive(Default)]
pub struct FactFilter {
    /// Keep these attributes (combined with `attributePrefixes`, either matches).
    pub attributes: Option<Vec<String>>,
    /// Keep attributes starting with one of these, such as `":ingestion/"`.
    pub attribute_prefixes: Option<Vec<String>>,
    /// Keep these entity UUID strings.
    pub entities: Option<Vec<String>>,
    /// Lowest `txCount` kept (inclusive).
    pub tx_from: Option<BigInt>,
    /// Highest `txCount` kept (inclusive).
    pub tx_to: Option<BigInt>,
    /// `"tx"` (default: ascending `txCount`) or `"storage"` (cheapest order).
    #[napi(ts_type = "'tx' | 'storage'")]
    pub order: Option<String>,
    /// In `"tx"` order, the most records held in memory at once.
    pub window: Option<i64>,
}

impl FactFilter {
    fn to_core(&self) -> Result<minigraf::FactFilter> {
        let mut f = minigraf::FactFilter::new();
        if let Some(attrs) = &self.attributes {
            f = f.attributes(attrs.iter().cloned());
        }
        for prefix in self.attribute_prefixes.iter().flatten() {
            f = f.attribute_prefix(prefix);
        }
        if let Some(entities) = &self.entities {
            let ids = entities
                .iter()
                .map(|e| parse_uuid(e, "entity"))
                .collect::<Result<Vec<_>>>()?;
            f = f.entities(ids);
        }
        if self.tx_from.is_some() || self.tx_to.is_some() {
            let lo = self
                .tx_from
                .as_ref()
                .map_or(Ok(0), |b| bigint_to_u64(b, "txFrom"))?;
            let hi = self
                .tx_to
                .as_ref()
                .map_or(Ok(u64::MAX), |b| bigint_to_u64(b, "txTo"))?;
            f = f.tx_range(lo..=hi);
        }
        match self.order.as_deref() {
            None => {}
            Some("tx") => f = f.order(minigraf::FactOrder::Tx),
            Some("storage") => f = f.order(minigraf::FactOrder::Storage),
            Some(other) => {
                return Err(invalid(format!("order {other:?} is not 'tx' or 'storage'")));
            }
        }
        if let Some(w) = self.window {
            f = f.window(to_usize(w, "window")?);
        }
        Ok(f)
    }
}

// ─── MiniGrafDb ───────────────────────────────────────────────────────────────

/// Thrown by every method once `close()` has run.
const CLOSED_MSG: &str = "database is closed";

#[napi]
pub struct MiniGrafDb {
    /// `None` once `close()` has run. JavaScript has no deterministic
    /// destructor, so the handle needs an explicit way to be dropped — see
    /// `close()`.
    inner: Arc<Mutex<Option<minigraf::Minigraf>>>,
    /// Every prepared query made from this handle, emptied by `close()` so
    /// that none keeps the file open.
    prepared: Mutex<Vec<Weak<PreparedSlot>>>,
}

#[napi]
impl MiniGrafDb {
    /// Open a file-backed database. Throws on error.
    ///
    /// Only one handle per file may be open in a process at a time. Call
    /// `close()` before reopening the same path — see `close()`.
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let db = minigraf::Minigraf::open(&path)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(db))),
            prepared: Mutex::default(),
        })
    }

    /// Open an in-memory database. Throws on error.
    #[napi(factory)]
    pub fn in_memory() -> Result<Self> {
        let db = minigraf::Minigraf::in_memory()
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(db))),
            prepared: Mutex::default(),
        })
    }

    /// Open a file-backed database with `options`. Throws on error.
    ///
    /// `MiniGrafDb.openWithOptions(path, { readOnly: true })` opens the file
    /// read-only: any number of read-only handles can share it, and writes
    /// throw API-014.
    #[napi(factory)]
    pub fn open_with_options(path: String, options: Option<OpenOptions>) -> Result<Self> {
        let db = minigraf::Minigraf::open_with_options(&path, options_to_core(options)?)
            .map_err(js_err)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(db))),
            prepared: Mutex::default(),
        })
    }

    /// Open a cursor over a `(query ...)`. Its answer is fixed when it opens.
    #[napi]
    pub fn query(&self, datalog: String) -> Result<Cursor> {
        let cursor = self.with_db(|db| db.query(&datalog))?;
        Ok(Cursor {
            vars: cursor.vars().to_vec(),
            inner: Some(cursor),
        })
    }

    /// Stream every fact record that `filter` keeps. Checkpoints wait until
    /// the log is closed or read to the end.
    #[napi]
    pub fn fact_log(&self, filter: Option<FactFilter>) -> Result<FactLog> {
        let filter = filter.unwrap_or_default().to_core()?;
        let log = self.with_db(|db| db.fact_log(&filter))?;
        Ok(FactLog { inner: Some(log) })
    }

    /// Parse and validate a `(query ...)` once, for running many times with
    /// different bind values in its `$name` slots. Throws API-005/006/007 for
    /// a transact, retract or rule, and API-023 for a slot in an attribute
    /// position.
    #[napi]
    pub fn prepare(&self, datalog: String) -> Result<PreparedQuery> {
        // Holding `inner` until the slot is listed: a `close()` cannot run in
        // between and miss it.
        let guard = self.inner.lock().map_err(|_| poisoned())?;
        let db = guard
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, CLOSED_MSG))?;
        let slot = Arc::new(Mutex::new(Some(db.prepare(&datalog).map_err(js_err)?)));
        let mut prepared = self.prepared.lock().map_err(|_| poisoned())?;
        prepared.retain(|w| w.strong_count() > 0);
        prepared.push(Arc::downgrade(&slot));
        Ok(PreparedQuery { slot })
    }

    /// The transaction counter that `:as-of N` compares against.
    #[napi]
    pub fn current_tx_count(&self) -> Result<BigInt> {
        Ok(BigInt::from(self.with_db(|db| Ok(db.current_tx_count()))?))
    }

    /// Execute a Datalog string. Returns a JSON string. Throws on error.
    #[napi]
    pub fn execute(&self, datalog: String) -> Result<String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "mutex poisoned"))?;
        let result = guard
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, CLOSED_MSG))?
            .execute(&datalog)
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(query_result_to_json(result))
    }

    /// Flush the WAL to disk. Throws on error.
    #[napi]
    pub fn checkpoint(&self) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "mutex poisoned"))?;
        guard
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, CLOSED_MSG))?
            .checkpoint()
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }

    /// Close the database, releasing its file lock immediately.
    ///
    /// Letting a `MiniGrafDb` go out of scope is **not** enough to release the
    /// file. JavaScript has no deterministic destructor: the object merely
    /// becomes unreachable, and the underlying handle lives until V8 garbage
    /// collects it — arbitrarily later, or never before the process exits.
    ///
    /// That matters because minigraf permits only one live handle per file per
    /// process (two would each cache their own page table and corrupt each
    /// other), so opening the same path again throws until the first handle is
    /// really gone. `close()` is the only way to make that happen on demand.
    /// Every other binding has the same escape hatch: UniFFI (Python, Java,
    /// Swift) exposes `destroy()`, and the C API exposes `minigraf_close`.
    ///
    /// Call `checkpoint()` first if you need to know the WAL was compacted;
    /// closing does that too, but cannot report a failure.
    ///
    /// Idempotent — closing an already-closed database is a no-op. Every other
    /// method throws afterwards.
    ///
    /// ```js
    /// const db = new MiniGrafDb(path)
    /// db.execute('(transact [[:bob :name "Bob"]])')
    /// db.checkpoint()
    /// db.close()
    ///
    /// const db2 = new MiniGrafDb(path) // fine: the first handle is gone
    /// ```
    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "mutex poisoned"))?;
        // A prepared query holds the file open too (core's PreparedQuery
        // keeps the storage), so release every one first.
        let prepared = std::mem::take(&mut *self.prepared.lock().map_err(|_| poisoned())?);
        for slot in prepared.iter().filter_map(Weak::upgrade) {
            if let Ok(mut q) = slot.lock() {
                *q = None;
            }
        }
        // Dropping the last Minigraf clone runs its Drop impl: a best-effort
        // checkpoint, then release of the sidecar `.graph.lock`.
        *guard = None;
        Ok(())
    }
}

impl MiniGrafDb {
    fn with_db<T>(
        &self,
        f: impl FnOnce(&minigraf::Minigraf) -> std::result::Result<T, MinigrafError>,
    ) -> Result<T> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "mutex poisoned"))?;
        let db = guard
            .as_ref()
            .ok_or_else(|| Error::new(Status::GenericFailure, CLOSED_MSG))?;
        f(db).map_err(js_err)
    }
}

fn poisoned() -> Error {
    Error::new(Status::GenericFailure, "mutex poisoned")
}

// ─── Prepared queries ────────────────────────────────────────────────────────

/// A prepared query, `None` once its database is closed.
type PreparedSlot = Mutex<Option<minigraf::PreparedQuery>>;

/// A query parsed once by `MiniGrafDb.prepare`, run with bind values.
///
/// A boolean, a string, `null`, a `bigint` and a `number` (an integer when
/// `Number.isInteger` accepts it, else a float) bind as values. The typed
/// forms are `FactValue` (`{ type: 'float', value: 2 }` for a float with no
/// fraction, `'keyword'`, `'ref'`, ...), `{ type: 'entity', value: uuid }`,
/// `{ type: 'txCount' | 'timestamp', value }` and `{ type: 'anyValidTime' }`.
/// Anything else is a `TypeError`. Each run reads the database as it is then;
/// after the database's `close()` every call throws API-018.
#[napi]
pub struct PreparedQuery {
    slot: Arc<PreparedSlot>,
}

#[napi]
impl PreparedQuery {
    /// Run the query with `bindings` and return its result as JSON, encoded
    /// like `MiniGrafDb.execute`. A missing slot throws API-022 and a bind
    /// value of the wrong kind API-024.
    #[napi]
    pub fn execute(
        &self,
        env: Env,
        #[napi(
            ts_arg_type = "Record<string, boolean | number | bigint | string | null | FactValue | { type: 'entity'; value: string } | { type: 'txCount' | 'timestamp'; value: number | bigint } | { type: 'anyValidTime' }>"
        )]
        bindings: Option<Unknown>,
    ) -> Result<String> {
        let binds = read_bindings(&env, bindings)?;
        let result = self.with_query(|q| q.execute(&as_slice(&binds)))?;
        Ok(query_result_to_json(result))
    }

    /// Run the query with `bindings` and return a cursor over its rows. The
    /// answer is fixed when the cursor opens.
    #[napi]
    pub fn query(
        &self,
        env: Env,
        #[napi(
            ts_arg_type = "Record<string, boolean | number | bigint | string | null | FactValue | { type: 'entity'; value: string } | { type: 'txCount' | 'timestamp'; value: number | bigint } | { type: 'anyValidTime' }>"
        )]
        bindings: Option<Unknown>,
    ) -> Result<Cursor> {
        let binds = read_bindings(&env, bindings)?;
        let cursor = self.with_query(|q| q.query(&as_slice(&binds)))?;
        Ok(Cursor {
            vars: cursor.vars().to_vec(),
            inner: Some(cursor),
        })
    }
}

impl PreparedQuery {
    fn with_query<T>(
        &self,
        f: impl FnOnce(&minigraf::PreparedQuery) -> std::result::Result<T, MinigrafError>,
    ) -> Result<T> {
        let guard = self.slot.lock().map_err(|_| poisoned())?;
        let q = guard
            .as_ref()
            .ok_or_else(|| js_err(MinigrafError::closed("database")))?;
        f(q).map_err(js_err)
    }
}

fn as_slice(binds: &[(String, minigraf::BindValue)]) -> Vec<(&str, minigraf::BindValue)> {
    binds.iter().map(|(n, v)| (n.as_str(), v.clone())).collect()
}

/// Why a JavaScript value is not a bind value.
enum BindError {
    /// Not a bind value at all: thrown as a `TypeError`.
    Type(String),
    /// A typed value that does not fit its type, and other errors.
    Napi(Error),
}

impl From<Error> for BindError {
    fn from(e: Error) -> Self {
        BindError::Napi(e)
    }
}

fn read_bindings(
    env: &Env,
    bindings: Option<Unknown>,
) -> Result<Vec<(String, minigraf::BindValue)>> {
    read_bindings_inner(bindings).map_err(|e| match e {
        BindError::Napi(e) => e,
        BindError::Type(msg) => match env.throw_type_error(&msg, None) {
            // The TypeError is pending; this status tells napi not to replace it.
            Ok(()) => Error::new(Status::PendingException, msg),
            Err(e) => e,
        },
    })
}

fn read_bindings_inner(
    bindings: Option<Unknown>,
) -> std::result::Result<Vec<(String, minigraf::BindValue)>, BindError> {
    let Some(bindings) = bindings else {
        return Ok(Vec::new());
    };
    match bindings.get_type()? {
        ValueType::Undefined | ValueType::Null => return Ok(Vec::new()),
        ValueType::Object if !bindings.is_array()? => {}
        _ => {
            return Err(BindError::Type(
                "bindings must be an object of slot name to bind value".into(),
            ));
        }
    }
    // SAFETY: get_type() said Object.
    let object: Object = unsafe { bindings.cast() }?;
    let values: HashMap<String, Unknown> = unsafe { bindings.cast() }?;
    Object::keys(&object)?
        .into_iter()
        .map(|name| {
            let v = values
                .get(&name)
                .ok_or_else(|| BindError::Type(format!("slot ${name} has no value")))?;
            let bind = bind_value(&name, v)?;
            Ok((name, bind))
        })
        .collect()
}

fn bind_value(name: &str, v: &Unknown) -> std::result::Result<minigraf::BindValue, BindError> {
    use minigraf::BindValue as B;
    // SAFETY: each cast follows the get_type() it matches.
    Ok(match v.get_type()? {
        ValueType::Boolean => B::Val(Value::Boolean(unsafe { v.cast::<bool>() }?)),
        ValueType::Null => B::Val(Value::Null),
        ValueType::String => B::Val(Value::String(unsafe { v.cast::<String>() }?)),
        ValueType::BigInt => B::Val(Value::Integer(bigint_to_i64(
            &unsafe { v.cast::<BigInt>() }?,
            &format!("slot ${name}"),
        )?)),
        ValueType::Number => {
            let f = unsafe { v.cast::<f64>() }?;
            if is_integer(f) {
                B::Val(Value::Integer(number_to_i64(f, &format!("slot ${name}"))?))
            } else {
                B::Val(Value::Float(f))
            }
        }
        ValueType::Object if !v.is_array()? => {
            let object: Object = unsafe { v.cast() }?;
            let kind: Option<String> = object.get("type").unwrap_or(None);
            match kind.and_then(|k| typed_value(name, &k, &object).transpose()) {
                Some(bind) => bind?,
                None => return Err(not_a_bind_value(name)),
            }
        }
        _ => return Err(not_a_bind_value(name)),
    })
}

fn not_a_bind_value(name: &str) -> BindError {
    BindError::Type(format!(
        "slot ${name}: a bind value is a boolean, number, bigint, string, null or {{type, value}} object"
    ))
}

/// `Number.isInteger`.
fn is_integer(f: f64) -> bool {
    f.is_finite() && f.trunc() == f
}

/// A whole `number` as an `i64`; API-017 outside its range.
fn number_to_i64(f: f64, what: &str) -> Result<i64> {
    // -2^63 is exact as an f64, and 2^63 is the first whole f64 past i64::MAX.
    if (i64::MIN as f64..-(i64::MIN as f64)).contains(&f) {
        Ok(f as i64)
    } else {
        Err(invalid(format!(
            "{what}: {f} does not fit in a signed 64-bit integer"
        )))
    }
}

/// A typed `{ type, value }` form, or `None` if `kind` names no type.
fn typed_value(
    name: &str,
    kind: &str,
    object: &Object,
) -> std::result::Result<Option<minigraf::BindValue>, BindError> {
    use minigraf::BindValue as B;
    let what = format!("slot ${name} of type {kind:?}");
    let mismatch = || {
        BindError::Napi(invalid(format!(
            "{what}: the value does not match the type"
        )))
    };
    let value: Option<Unknown> = object.get("value")?;
    let string = || -> std::result::Result<String, BindError> {
        match &value {
            Some(v) if v.get_type()? == ValueType::String => Ok(unsafe { v.cast::<String>() }?),
            _ => Err(mismatch()),
        }
    };
    let integer = || -> std::result::Result<i64, BindError> {
        match &value {
            Some(v) if v.get_type()? == ValueType::BigInt => {
                Ok(bigint_to_i64(&unsafe { v.cast::<BigInt>() }?, &what)?)
            }
            Some(v) if v.get_type()? == ValueType::Number => {
                let f = unsafe { v.cast::<f64>() }?;
                if is_integer(f) {
                    Ok(number_to_i64(f, &what)?)
                } else {
                    Err(mismatch())
                }
            }
            _ => Err(mismatch()),
        }
    };
    Ok(Some(match kind {
        "string" => B::Val(Value::String(string()?)),
        "keyword" => B::Val(Value::Keyword(string()?)),
        "boolean" => match &value {
            Some(v) if v.get_type()? == ValueType::Boolean => {
                B::Val(Value::Boolean(unsafe { v.cast::<bool>() }?))
            }
            _ => return Err(mismatch()),
        },
        "integer" => B::Val(Value::Integer(integer()?)),
        "float" => match &value {
            Some(v) if v.get_type()? == ValueType::Number => {
                B::Val(Value::Float(unsafe { v.cast::<f64>() }?))
            }
            _ => return Err(mismatch()),
        },
        "ref" => B::Val(Value::Ref(parse_uuid(&string()?, &what)?)),
        "entity" => B::Entity(parse_uuid(&string()?, &what)?),
        "txCount" => {
            let n = integer()?;
            B::TxCount(u64::try_from(n).map_err(|_| invalid(format!("{what}: {n} is negative")))?)
        }
        "timestamp" => B::Timestamp(integer()?),
        // These two take no value.
        "null" if value.is_none() => B::Val(Value::Null),
        "anyValidTime" if value.is_none() => B::AnyValidTime,
        "null" | "anyValidTime" => return Err(mismatch()),
        _ => return Ok(None),
    }))
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

/// The rows of one query answer, in batches. Iterable over rows.
#[napi]
pub struct Cursor {
    vars: Vec<String>,
    /// `None` after `close()` or the end.
    inner: Option<minigraf::Cursor>,
}

#[napi]
impl Cursor {
    /// The `:find` variables, in column order.
    #[napi]
    pub fn vars(&self) -> Vec<String> {
        self.vars.clone()
    }

    /// The next batch of at most `maxRows` rows (0 counts as 1), as a JSON
    /// array of rows encoded like `execute()`'s `results`; `null` at the end
    /// or after `close()`. A batch is never empty.
    #[napi]
    pub fn next_batch(&mut self, max_rows: u32) -> Result<Option<String>> {
        let Some(cursor) = self.inner.as_mut() else {
            return Ok(None);
        };
        match cursor.next_batch(max_rows as usize).map_err(js_err)? {
            Some(batch) => Ok(Some(rows_to_json(batch.rows()))),
            None => {
                self.inner = None;
                Ok(None)
            }
        }
    }

    /// Release the cursor. Later `nextBatch()` calls return `null`.
    #[napi]
    pub fn close(&mut self) {
        self.inner = None;
    }
}

// ─── FactLog ─────────────────────────────────────────────────────────────────

/// A forward-only stream of fact records from `MiniGrafDb.factLog`.
/// Iterable over records.
#[napi]
pub struct FactLog {
    /// `None` after `close()` or the end, which releases the database.
    inner: Option<minigraf::FactLog>,
}

#[napi]
impl FactLog {
    /// The next batch of at most `maxRecords` records (0 counts as 1); `null`
    /// at the end or after `close()`. A batch is never empty.
    #[napi]
    pub fn next_batch(&mut self, max_records: u32) -> Result<Option<Vec<FactRecord>>> {
        let Some(log) = self.inner.as_mut() else {
            return Ok(None);
        };
        match log.next_batch(max_records as usize) {
            Ok(Some(batch)) => Ok(Some(batch.into_iter().map(FactRecord::from).collect())),
            Ok(None) => {
                self.inner = None;
                Ok(None)
            }
            Err(e) => {
                self.inner = None;
                Err(js_err(e))
            }
        }
    }

    /// Stop reading and release the database.
    #[napi]
    pub fn close(&mut self) {
        self.inner = None;
    }
}

// ─── LogWriter ───────────────────────────────────────────────────────────────

/// Builds a new database file from fact records, keeping their transaction
/// and valid-time bounds. The file is built at `<path>.partial` and renamed
/// into place by `finish()`. Call `close()` (for example in `finally`) to
/// abandon an unfinished build; it is a no-op after `finish()`.
#[napi]
pub struct LogWriter {
    /// `None` after `finish()` or `close()`.
    inner: Option<minigraf::LogWriter>,
}

fn writer_closed() -> Error {
    js_err(MinigrafError::closed("log writer"))
}

#[napi]
impl LogWriter {
    /// Start building a new database at `path` (STG-043 if it exists).
    #[napi(factory)]
    pub fn create(path: String, options: Option<OpenOptions>) -> Result<Self> {
        let writer =
            minigraf::LogWriter::create(&path, options_to_core(options)?).map_err(js_err)?;
        Ok(Self {
            inner: Some(writer),
        })
    }

    /// Append one record. A rejected record changes nothing.
    #[napi]
    pub fn append(&mut self, record: FactRecord) -> Result<()> {
        let record = record.to_core()?;
        let writer = self.inner.as_mut().ok_or_else(writer_closed)?;
        writer.append(&record).map_err(js_err)
    }

    /// Append `records` in order, stopping at the first rejected one. Its
    /// error ends with `(batch index N)`; the records before it stay appended.
    #[napi]
    pub fn append_batch(&mut self, records: Vec<FactRecord>) -> Result<()> {
        let writer = self.inner.as_mut().ok_or_else(writer_closed)?;
        for (i, record) in records.iter().enumerate() {
            record
                .to_core()
                .and_then(|r| writer.append(&r).map_err(js_err))
                .map_err(|e| Error::new(e.status, format!("{} (batch index {i})", e.reason)))?;
        }
        Ok(())
    }

    /// Close the open transaction and raise the counter to `txCount`.
    #[napi]
    pub fn advance_tx_count(&mut self, tx_count: BigInt) -> Result<()> {
        let tx_count = bigint_to_u64(&tx_count, "txCount")?;
        let writer = self.inner.as_mut().ok_or_else(writer_closed)?;
        writer.advance_tx_count(tx_count).map_err(js_err)
    }

    /// The highest `txCount` appended or advanced to.
    #[napi]
    pub fn tx_count(&self) -> Result<BigInt> {
        let writer = self.inner.as_ref().ok_or_else(writer_closed)?;
        Ok(BigInt::from(writer.tx_count()))
    }

    /// Commit every record and rename the file into place. Later calls throw
    /// API-018.
    #[napi]
    pub fn finish(&mut self) -> Result<()> {
        let writer = self.inner.take().ok_or_else(writer_closed)?;
        writer.finish().map_err(js_err)
    }

    /// Abandon an unfinished build, deleting `<path>.partial`. A no-op after
    /// `finish()` or `close()`.
    #[napi]
    pub fn close(&mut self) {
        self.inner = None;
    }

    /// `false` once `finish()` or `close()` has been called.
    #[napi]
    pub fn is_open(&self) -> bool {
        self.inner.is_some()
    }
}
