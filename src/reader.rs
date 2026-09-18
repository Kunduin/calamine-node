use std::sync::Arc;

use napi::{
    Env, Result,
    bindgen_prelude::{AsyncBlock, AsyncBlockBuilder, Uint8ArraySlice},
};
use napi_derive::napi;

use crate::{
    cancellation::{Cancellation, NativeCancellation},
    executor::Executor,
    source::Book,
    state::error,
    stream::NativeStreamPermit,
    workbook::NativeWorkbook,
};

#[napi]
pub struct NativeReader {
    executor: Arc<Executor>,
}

#[napi]
impl NativeReader {
    #[napi(constructor)]
    pub fn new(concurrency: u32, max_queued: u32) -> Result<Self> {
        Ok(Self {
            executor: Executor::new(concurrency, max_queued)?,
        })
    }

    #[napi]
    pub fn open_path(
        &self,
        env: Env,
        path: String,
        max_bytes: u32,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<NativeWorkbook>> {
        let executor = self.executor.clone();
        self.executor.submit(&env, signal, move || {
            Book::open_file(path, max_bytes).map(|book| NativeWorkbook::new(book, executor))
        })
    }

    #[napi]
    pub fn open_bytes(
        &self,
        env: Env,
        bytes: Uint8ArraySlice<'_>,
        max_bytes: u32,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<NativeWorkbook>> {
        let cancellation = Cancellation::from_signal(signal);
        cancellation.check()?;
        if bytes.len() > max_bytes as usize {
            return Err(error("ERR_INPUT_LIMIT", "buffer exceeds maxInputBytes"));
        }

        // Reject excess work before allocating a snapshot. Borrow JS bytes only
        // during this synchronous call; background parsing owns one immutable copy.
        let reservation = self.executor.reserve()?;
        let snapshot = Arc::<[u8]>::from(bytes.as_ref());
        let executor = self.executor.clone();
        reservation.run(&env, cancellation, move || {
            Book::open_bytes(snapshot, max_bytes).map(|book| NativeWorkbook::new(book, executor))
        })
    }

    #[napi]
    pub fn reserve_stream(
        &self,
        env: Env,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<NativeStreamPermit>> {
        let cancellation = Cancellation::from_signal(signal);
        cancellation.check()?;
        let reservation = self.executor.reserve()?;
        let executor = self.executor.clone();

        AsyncBlockBuilder::new(async move {
            let active = reservation.acquire(&cancellation).await?;
            Ok(NativeStreamPermit::new(active, executor))
        })
        .build(&env)
    }
}
