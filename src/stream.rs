use std::sync::{Arc, Mutex};

use napi::{
    Env, Result,
    bindgen_prelude::{AsyncBlock, AsyncBlockBuilder},
};
use napi_derive::napi;

use crate::{
    cancellation::{Cancellation, NativeCancellation},
    executor::{ActiveTask, Executor},
    source::Book,
    state::{Shared, error, lock},
    workbook::NativeWorkbook,
};

/// A stream holds the same admission and concurrency permits as parsing, without
/// occupying a blocking thread while JavaScript spools its input to a file.
#[napi]
pub struct NativeStreamPermit {
    state: Shared<ActiveTask>,
    executor: Arc<Executor>,
}

impl NativeStreamPermit {
    pub(crate) fn new(active: ActiveTask, executor: Arc<Executor>) -> Self {
        Self {
            state: Arc::new(Mutex::new(Some(active))),
            executor,
        }
    }
}

#[napi]
impl NativeStreamPermit {
    #[napi]
    pub fn open_path(
        &self,
        env: Env,
        path: String,
        max_bytes: u32,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<NativeWorkbook>> {
        let active = lock(&self.state)?
            .take()
            .ok_or_else(|| error("ERR_STATE", "stream permit is already consumed"))?;
        let executor = self.executor.clone();
        let cancellation = Cancellation::from_signal(signal);

        AsyncBlockBuilder::new(active.run(cancellation, move || {
            Book::open_file(path, max_bytes).map(|book| NativeWorkbook::new(book, executor))
        }))
        .build(&env)
    }

    #[napi]
    pub fn release(&self) -> Result<()> {
        lock(&self.state)?.take();
        Ok(())
    }
}
