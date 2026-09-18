use std::sync::Arc;

use napi::{
    Env, Result,
    bindgen_prelude::{AsyncBlock, AsyncBlockBuilder, ToNapiValue},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    cancellation::{Cancellation, NativeCancellation},
    state::error,
};

/// Bound executing work; additional requests wait asynchronously without rejection.
pub(crate) struct Executor {
    workers: Arc<Semaphore>,
}

pub(crate) struct ActiveTask {
    _worker: OwnedSemaphorePermit,
}

impl Executor {
    pub(crate) fn new(concurrency: usize) -> Result<Arc<Self>> {
        if concurrency == 0 || concurrency > Semaphore::MAX_PERMITS {
            return Err(error("ERR_INPUT", "invalid reader concurrency"));
        }
        Ok(Arc::new(Self {
            workers: Arc::new(Semaphore::new(concurrency)),
        }))
    }

    pub(crate) async fn acquire(&self, cancellation: &Cancellation) -> Result<ActiveTask> {
        cancellation.check()?;
        let worker = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(error("ERR_ABORTED", "operation was cancelled")),
            result = self.workers.clone().acquire_owned() => {
                result.map_err(|_| error("ERR_STATE", "reader executor is closed"))?
            }
        };
        cancellation.check()?;
        Ok(ActiveTask { _worker: worker })
    }

    pub(crate) fn submit<T, F>(
        self: &Arc<Self>,
        env: &Env,
        signal: Option<&NativeCancellation>,
        operation: F,
    ) -> Result<AsyncBlock<T>>
    where
        T: ToNapiValue + Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        let cancellation = Cancellation::from_signal(signal);
        cancellation.check()?;
        let executor = self.clone();
        AsyncBlockBuilder::new(async move {
            executor
                .acquire(&cancellation)
                .await?
                .run(cancellation, operation)
                .await
        })
        .build(env)
    }

    pub(crate) fn cleanup<F>(self: &Arc<Self>, env: &Env, operation: F) -> Result<AsyncBlock<()>>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        // Disposal waits for a worker like other operations and cannot be cancelled.
        self.submit(env, None, operation)
    }
}

impl ActiveTask {
    pub(crate) async fn run<T, F>(self, cancellation: Cancellation, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            // Keep the worker permit until computation and cleanup actually finish.
            let _task = self;
            cancellation.check()?;
            operation()
        })
        .await
        .map_err(|failure| error("ERR_STATE", failure))?
    }
}

#[cfg(test)]
mod tests {
    use std::{future::Future, task::Poll};

    use super::*;

    #[tokio::test]
    async fn cancelling_a_waiter_does_not_release_an_active_worker() -> Result<()> {
        let executor = Executor::new(1)?;
        let active = executor.acquire(&Cancellation::default()).await?;
        let signal = NativeCancellation::new();
        let cancellation = Cancellation::from_signal(Some(&signal));
        let mut queued = Box::pin(executor.acquire(&cancellation));

        std::future::poll_fn(|context| {
            assert!(queued.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        signal.cancel();
        assert!(queued.await.is_err());
        assert_eq!(executor.workers.available_permits(), 0);

        drop(active);
        assert_eq!(executor.workers.available_permits(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn cancellation_cannot_release_a_running_blocking_task() -> Result<()> {
        let executor = Executor::new(1)?;
        let signal = NativeCancellation::new();
        let cancellation = Cancellation::from_signal(Some(&signal));
        let active = executor.acquire(&cancellation).await?;
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();

        let running = tokio::spawn(active.run(cancellation, move || {
            started
                .send(())
                .map_err(|_| error("TEST", "start receiver dropped"))?;
            blocked.recv().map_err(|failure| error("TEST", failure))?;
            Ok(42)
        }));
        entered.await.map_err(|failure| error("TEST", failure))?;
        signal.cancel();
        assert_eq!(executor.workers.available_permits(), 0);

        release.send(()).map_err(|failure| error("TEST", failure))?;
        assert_eq!(
            running.await.map_err(|failure| error("TEST", failure))??,
            42
        );
        assert_eq!(executor.workers.available_permits(), 1);
        Ok(())
    }
}
