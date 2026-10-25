//! User functions from JavaScript: `MiniGrafDb.registerPredicate` and
//! `MiniGrafDb.registerAggregate` (minigraf#180, spec §6.2).
//!
//! A function receives each value as a `FactValue`, `{ type, value }`. An
//! aggregate's `finish` returns a value in any form a prepared query's
//! binding accepts: a plain value or a typed form. A function that throws
//! fails the query with `QRY-014`, carrying the thrown error's `message`
//! (else `String(e)`), and so does a predicate that returns anything but a
//! boolean, or a `finish` whose result is not a value.
//!
//! The core's registry is `Send + Sync`, so it holds no JavaScript value.
//! Each thread that registers a function keeps one holder object, and every
//! function and accumulator state is a property of it, keyed by an id
//! unique across threads ([`Held`]); the registry keeps only the id. A
//! holder rather than a napi reference per value, because Node-API before
//! version 10 (Node 22.14) cannot reference a primitive, and an accumulator
//! is often a number or a bigint.
//!
//! JavaScript runs only on the thread that owns its `napi_env`, and every
//! binding method is synchronous on that thread, so every call happens
//! there. A call on any other thread finds no holder and fails with
//! `called off the JavaScript thread`, never touching an env. No code path
//! reaches that today: it guards future async methods.

use crate::{BindError, FactValue, bind_value, invalid};
use minigraf::{UdfError, Value};
use napi::bindgen_prelude::*;
use napi::{JsValue, sys};
use std::cell::Cell;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};

/// This thread's env and its holder object.
#[derive(Clone, Copy, PartialEq)]
struct JsThread {
    env: sys::napi_env,
    holder: sys::napi_ref,
}

thread_local! {
    /// Set by the first registration on a JavaScript thread, cleared when
    /// its env is torn down.
    static JS: Cell<Option<JsThread>> = const { Cell::new(None) };
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

const OFF_THREAD: &str = "called off the JavaScript thread";

/// A JavaScript value in this thread's holder, removed when this drops.
/// `Send + Sync` as the registry needs, since it is only an id.
pub(crate) struct Held(u64);

impl Drop for Held {
    fn drop(&mut self) {
        // On another thread, or after the env is gone, nothing to do. Only
        // this thread's holder has the property.
        if let Ok(scope) = Scope::open() {
            let _ = scope.delete(self);
        }
    }
}

/// Make `env` this thread's JavaScript env, creating its holder.
fn attach(env: &Env) -> Result<()> {
    if let Some(js) = JS.get() {
        if js.env == env.raw() {
            return Ok(());
        }
        // Node gives each thread at most one env at a time.
        return Err(Error::new(
            Status::GenericFailure,
            "a second Node-API env on one thread",
        ));
    }
    let raw = env.raw();
    let mut holder = ptr::null_mut();
    let mut reference = ptr::null_mut();
    // SAFETY: on the env's own thread, inside a call from it.
    unsafe {
        check(sys::napi_create_object(raw, &mut holder))?;
        check(sys::napi_create_reference(raw, holder, 1, &mut reference))?;
        check(sys::napi_add_env_cleanup_hook(
            raw,
            Some(detach),
            ptr::null_mut(),
        ))?;
    }
    JS.set(Some(JsThread {
        env: raw,
        holder: reference,
    }));
    Ok(())
}

/// The env is being torn down: forget it, so that a `Held` dropped later
/// touches nothing.
unsafe extern "C" fn detach(_: *mut std::ffi::c_void) {
    if let Some(js) = JS.take() {
        // SAFETY: cleanup hooks run on the env's thread with the env alive.
        unsafe { sys::napi_delete_reference(js.env, js.holder) };
    }
}

fn check(status: sys::napi_status) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(Error::new(
            Status::from(status),
            format!("Node-API call failed: {}", Status::from(status)),
        ))
    }
}

/// Store `value` in this thread's holder; `env` is the caller's.
pub(crate) fn hold(env: &Env, value: sys::napi_value) -> Result<Held> {
    attach(env)?;
    let scope = Scope::open().map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    let held = Held(NEXT_ID.fetch_add(1, Ordering::Relaxed));
    scope
        .set(&held, value)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    Ok(held)
}

/// One call into JavaScript: this thread's env and holder, in a handle scope
/// of its own, so the values a long query creates do not pile up until the
/// binding method returns.
struct Scope {
    env: sys::napi_env,
    holder: sys::napi_value,
    scope: sys::napi_handle_scope,
}

impl Scope {
    fn open() -> std::result::Result<Scope, UdfError> {
        let js = JS.get().ok_or_else(|| UdfError::new(OFF_THREAD))?;
        let mut scope = ptr::null_mut();
        let mut holder = ptr::null_mut();
        // SAFETY: `JS` is set only on the env's own thread, and cleared
        // before the env goes.
        unsafe {
            napi_ok(sys::napi_open_handle_scope(js.env, &mut scope))?;
            // Built first, so that an error below closes the scope.
            let mut scope = Scope {
                env: js.env,
                holder: ptr::null_mut(),
                scope,
            };
            napi_ok(sys::napi_get_reference_value(
                js.env,
                js.holder,
                &mut holder,
            ))?;
            scope.holder = holder;
            Ok(scope)
        }
    }

    fn key(&self, held: &Held) -> std::result::Result<sys::napi_value, UdfError> {
        let mut key = ptr::null_mut();
        // Ids stay far below 2^53, so the number is exact.
        #[allow(clippy::cast_precision_loss)]
        let id = held.0 as f64;
        napi_ok(unsafe { sys::napi_create_double(self.env, id, &mut key) })?;
        Ok(key)
    }

    fn get(&self, held: &Held) -> std::result::Result<sys::napi_value, UdfError> {
        let key = self.key(held)?;
        let mut value = ptr::null_mut();
        napi_ok(unsafe { sys::napi_get_property(self.env, self.holder, key, &mut value) })?;
        Ok(value)
    }

    fn set(&self, held: &Held, value: sys::napi_value) -> std::result::Result<(), UdfError> {
        let key = self.key(held)?;
        napi_ok(unsafe { sys::napi_set_property(self.env, self.holder, key, value) })
    }

    fn delete(&self, held: &Held) -> std::result::Result<(), UdfError> {
        let key = self.key(held)?;
        let mut deleted = false;
        napi_ok(unsafe { sys::napi_delete_property(self.env, self.holder, key, &mut deleted) })
    }

    /// Call the held function `f` with no `this`. A throw is a failed call.
    fn call(
        &self,
        f: &Held,
        args: &[sys::napi_value],
    ) -> std::result::Result<sys::napi_value, UdfError> {
        let f = self.get(f)?;
        let mut this = ptr::null_mut();
        let mut result = ptr::null_mut();
        let status = unsafe {
            napi_ok(sys::napi_get_undefined(self.env, &mut this))?;
            sys::napi_call_function(self.env, this, f, args.len(), args.as_ptr(), &mut result)
        };
        if status == sys::Status::napi_pending_exception {
            let mut e = ptr::null_mut();
            napi_ok(unsafe { sys::napi_get_and_clear_last_exception(self.env, &mut e) })?;
            return Err(UdfError::new(strip_code(&self.thrown(e))));
        }
        napi_ok(status)?;
        Ok(result)
    }

    /// What a function threw, as a message: its `message` when it has a
    /// string one, else `String(e)`.
    fn thrown(&self, e: sys::napi_value) -> String {
        let e = unsafe { Unknown::from_raw_unchecked(self.env, e) };
        let message = || -> Result<Option<String>> {
            match e.get_type()? {
                ValueType::String => Ok(Some(unsafe { e.cast::<String>() }?)),
                ValueType::Object => {
                    let object: Object = unsafe { e.cast() }?;
                    match object.get::<Unknown>("message")? {
                        Some(m) if m.get_type()? == ValueType::String => {
                            Ok(Some(unsafe { m.cast::<String>() }?))
                        }
                        _ => Ok(None),
                    }
                }
                _ => Ok(None),
            }
        };
        message()
            .ok()
            .flatten()
            .or_else(|| self.string(e.raw()))
            .unwrap_or_else(|| "user function failed".to_string())
    }

    /// `String(v)`, which converts any value, as `napi_coerce_to_string`
    /// does not for a `Symbol`.
    fn string(&self, v: sys::napi_value) -> Option<String> {
        let env = Env::from_raw(self.env);
        let string: Function<Unknown, String> =
            env.get_global().ok()?.get_named_property("String").ok()?;
        let mut result = ptr::null_mut();
        let mut this = ptr::null_mut();
        unsafe {
            if sys::napi_get_undefined(self.env, &mut this) != sys::Status::napi_ok {
                return None;
            }
            let status = sys::napi_call_function(self.env, this, string.raw(), 1, &v, &mut result);
            if status != sys::Status::napi_ok {
                let mut ignored = ptr::null_mut();
                sys::napi_get_and_clear_last_exception(self.env, &mut ignored);
                return None;
            }
            String::from_napi_value(self.env, result).ok()
        }
    }

    fn value(&self, v: &Value) -> std::result::Result<sys::napi_value, UdfError> {
        unsafe { FactValue::to_napi_value(self.env, FactValue::from(v.clone())) }
            .map_err(|e| UdfError::new(e.reason.clone()))
    }

    fn number(&self, n: usize) -> std::result::Result<sys::napi_value, UdfError> {
        let mut v = ptr::null_mut();
        // A count past 2^53 is not exact as a number; no query gets near.
        #[allow(clippy::cast_precision_loss)]
        let n = n as f64;
        napi_ok(unsafe { sys::napi_create_double(self.env, n, &mut v) })?;
        Ok(v)
    }

    fn unknown(&self, v: sys::napi_value) -> Unknown<'_> {
        unsafe { Unknown::from_raw_unchecked(self.env, v) }
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        unsafe { sys::napi_close_handle_scope(self.env, self.scope) };
    }
}

fn napi_ok(status: sys::napi_status) -> std::result::Result<(), UdfError> {
    check(status).map_err(|e| UdfError::new(e.reason.clone()))
}

/// `message` without a leading `[ABC-123] ` error code: a code from the
/// bind reader belongs to the bind API, not to the query's `QRY-014`.
fn strip_code(message: &str) -> &str {
    let code = message.get(1..8).unwrap_or_default();
    let is_code = code.len() == 7
        && code.char_indices().all(|(i, c)| match i {
            0..=2 => c.is_ascii_uppercase(),
            3 => c == '-',
            _ => c.is_ascii_digit(),
        });
    match message.get(10..) {
        Some(rest) if is_code && message.starts_with('[') && message.get(8..10) == Some("] ") => {
            rest
        }
        _ => message,
    }
}

fn type_of(v: &Unknown) -> &'static str {
    match v.get_type() {
        Ok(ValueType::Undefined) => "undefined",
        Ok(ValueType::Boolean) => "boolean",
        Ok(ValueType::Number) => "number",
        Ok(ValueType::String) => "string",
        Ok(ValueType::Symbol) => "symbol",
        Ok(ValueType::Function) => "function",
        Ok(ValueType::BigInt) => "bigint",
        _ => "object",
    }
}

// ─── The calls the registry makes ────────────────────────────────────────────

pub(crate) fn test(f: &Held, v: &Value) -> std::result::Result<bool, UdfError> {
    let scope = Scope::open()?;
    let arg = scope.value(v)?;
    let result = scope.unknown(scope.call(f, &[arg])?);
    match result.get_type() {
        Ok(ValueType::Boolean) => {
            unsafe { result.cast::<bool>() }.map_err(|e| UdfError::new(e.reason.clone()))
        }
        _ => Err(UdfError::new(format!(
            "returned {}, not a boolean",
            type_of(&result)
        ))),
    }
}

pub(crate) fn init(init: &Held) -> std::result::Result<Held, UdfError> {
    let scope = Scope::open()?;
    let acc = scope.call(init, &[])?;
    let held = Held(NEXT_ID.fetch_add(1, Ordering::Relaxed));
    scope.set(&held, acc)?;
    Ok(held)
}

pub(crate) fn step(step: &Held, acc: &Held, v: &Value) -> std::result::Result<(), UdfError> {
    let scope = Scope::open()?;
    let args = [scope.get(acc)?, scope.value(v)?];
    let next = scope.call(step, &args)?;
    scope.set(acc, next)
}

pub(crate) fn finish(
    finish: &Held,
    acc: &Held,
    count: usize,
) -> std::result::Result<Value, UdfError> {
    let scope = Scope::open()?;
    let args = [scope.get(acc)?, scope.number(count)?];
    let result = scope.unknown(scope.call(finish, &args)?);
    match bind_value("finish's result", &result) {
        Ok(minigraf::BindValue::Val(v)) => Ok(v),
        Ok(_) => Err(UdfError::new(strip_code(
            &invalid("finish's result is not a value".into()).reason,
        ))),
        Err(BindError::Type(msg)) => Err(UdfError::new(msg)),
        Err(BindError::Napi(e)) => Err(UdfError::new(strip_code(&e.reason))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_off_the_javascript_thread_fails_without_an_env() {
        let held = Held(u64::MAX);
        let message = std::thread::spawn(move || {
            let e = test(&held, &Value::Integer(1)).err().map(|e| e.to_string());
            drop(held);
            e
        })
        .join()
        .expect("no panic");
        assert_eq!(message.as_deref(), Some(OFF_THREAD));
        for e in [
            init(&Held(u64::MAX)).err(),
            step(&Held(u64::MAX), &Held(u64::MAX), &Value::Null).err(),
            finish(&Held(u64::MAX), &Held(u64::MAX), 1).err(),
        ] {
            assert_eq!(e.map(|e| e.to_string()).as_deref(), Some(OFF_THREAD));
        }
    }

    #[test]
    fn strip_code_drops_only_a_leading_code() {
        assert_eq!(strip_code("[API-017] bad"), "bad");
        assert_eq!(strip_code("[api-017] bad"), "[api-017] bad");
        assert_eq!(strip_code("bad [API-017] x"), "bad [API-017] x");
        assert_eq!(strip_code("[API-017]"), "[API-017]");
    }
}
