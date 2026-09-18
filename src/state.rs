use std::sync::{Arc, Mutex, MutexGuard};

use napi::{Error, Result, Status};

pub(crate) type Shared<T> = Arc<Mutex<Option<T>>>;

pub(crate) fn error(code: &str, message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}: {message}"))
}

pub(crate) fn lock<T>(state: &Shared<T>) -> Result<MutexGuard<'_, Option<T>>> {
    state
        .lock()
        .map_err(|_| error("ERR_STATE", "native state was poisoned"))
}
