use minigraf::{QueryResult, Value};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

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

// ─── MiniGrafDb ───────────────────────────────────────────────────────────────

/// Thrown by every method once `close()` has run.
const CLOSED_MSG: &str = "database is closed";

#[napi]
pub struct MiniGrafDb {
    /// `None` once `close()` has run. JavaScript has no deterministic
    /// destructor, so the handle needs an explicit way to be dropped — see
    /// `close()`.
    inner: Arc<Mutex<Option<minigraf::Minigraf>>>,
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
        })
    }

    /// Open an in-memory database. Throws on error.
    #[napi(factory)]
    pub fn in_memory() -> Result<Self> {
        let db = minigraf::Minigraf::in_memory()
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(db))),
        })
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
        // Dropping the last Minigraf clone runs its Drop impl: a best-effort
        // checkpoint, then release of the sidecar `.graph.lock`.
        *guard = None;
        Ok(())
    }
}
