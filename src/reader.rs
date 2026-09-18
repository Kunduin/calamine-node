use std::sync::Arc;

use napi::{
    Env, Result,
    bindgen_prelude::{
        AsyncBlock, AsyncBlockBuilder, Uint8ArraySlice, within_runtime_if_available,
    },
};
use napi_derive::napi;
use tokio::runtime::Handle;

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
    pub fn new(concurrency: Option<u32>) -> Result<Self> {
        // Follow the actual napi-rs runtime, including TOKIO_WORKER_THREADS,
        // rather than duplicating Tokio's CPU detection or environment parsing.
        let concurrency = concurrency.map(|value| value as usize).unwrap_or_else(|| {
            within_runtime_if_available(|| Handle::current().metrics().num_workers())
        });
        Ok(Self {
            executor: Executor::new(concurrency)?,
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

        // Borrow JS bytes only during this synchronous call. Queued parsing
        // retains one immutable snapshot, independent of later caller mutations.
        let snapshot = Arc::<[u8]>::from(bytes.as_ref());
        let executor = self.executor.clone();
        self.executor.submit(&env, signal, move || {
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
        let executor = self.executor.clone();

        AsyncBlockBuilder::new(async move {
            let active = executor.acquire(&cancellation).await?;
            Ok(NativeStreamPermit::new(active, executor))
        })
        .build(&env)
    }
}
