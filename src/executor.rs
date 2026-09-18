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

/// Admission is reserved before copying input or starting a Rust future.
pub(crate) struct Executor {
    admission: Arc<Semaphore>,
    workers: Arc<Semaphore>,
}

pub(crate) struct Reservation {
    admission: Option<OwnedSemaphorePermit>,
    workers: Arc<Semaphore>,
}

pub(crate) struct ActiveTask {
    _admission: Option<OwnedSemaphorePermit>,
    _worker: OwnedSemaphorePermit,
}

impl Executor {
    pub(crate) fn new(concurrency: u32, max_queued: u32) -> Result<Arc<Self>> {
        if !(1..=128).contains(&concurrency) || max_queued > 65_536 {
            return Err(error(
                "ERR_INPUT",
                "invalid reader concurrency or queue size",
            ));
        }
        Ok(Arc::new(Self {
            admission: Arc::new(Semaphore::new((concurrency + max_queued) as usize)),
            workers: Arc::new(Semaphore::new(concurrency as usize)),
        }))
    }

    pub(crate) fn reserve(&self) -> Result<Reservation> {
        let admission = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("ERR_QUEUE_FULL", "reader queue is full"))?;
        Ok(Reservation {
            admission: Some(admission),
            workers: self.workers.clone(),
        })
    }

    pub(crate) fn submit<T, F>(
        &self,
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
        self.reserve()?.run(env, cancellation, operation)
    }

    pub(crate) fn cleanup<F>(&self, env: &Env, operation: F) -> Result<AsyncBlock<()>>
    where
        F: FnOnce() -> Result<()> + Send + 'static,
    {
        // Disposal bypasses a full admission queue, but still respects worker concurrency.
        let reservation = Reservation {
            admission: None,
            workers: self.workers.clone(),
        };
        reservation.run(env, Cancellation::default(), operation)
    }
}

impl Reservation {
    pub(crate) async fn acquire(self, cancellation: &Cancellation) -> Result<ActiveTask> {
        cancellation.check()?;
        let worker = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(error("ERR_ABORTED", "operation was cancelled")),
            result = self.workers.acquire_owned() => {
                result.map_err(|_| error("ERR_STATE", "reader executor is closed"))?
            }
        };
        cancellation.check()?;
        Ok(ActiveTask {
            _admission: self.admission,
            _worker: worker,
        })
    }

    pub(crate) fn run<T, F>(
        self,
        env: &Env,
        cancellation: Cancellation,
        operation: F,
    ) -> Result<AsyncBlock<T>>
    where
        T: ToNapiValue + Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        AsyncBlockBuilder::new(async move {
            self.acquire(&cancellation)
                .await?
                .run(cancellation, operation)
                .await
        })
        .build(env)
    }
}

impl ActiveTask {
    pub(crate) async fn run<T, F>(self, cancellation: Cancellation, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T> + Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            // Keep both permits inside the blocking task until computation and cleanup end.
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

    #[test]
    fn admission_is_bounded_and_released_on_drop() -> Result<()> {
        let executor = Executor::new(1, 1)?;
        let active = executor.reserve()?;
        let queued = executor.reserve()?;
        assert!(executor.reserve().is_err());

        drop(queued);
        let replacement = executor.reserve()?;
        assert!(executor.reserve().is_err());
        drop((active, replacement));
        assert_eq!(executor.admission.available_permits(), 2);
        Ok(())
    }

    #[tokio::test]
    async fn cancelling_a_waiter_releases_admission_without_a_worker() -> Result<()> {
        let executor = Executor::new(1, 1)?;
        let active = executor
            .reserve()?
            .acquire(&Cancellation::default())
            .await?;
        let signal = NativeCancellation::new();
        let cancellation = Cancellation::from_signal(Some(&signal));
        let mut queued = Box::pin(executor.reserve()?.acquire(&cancellation));

        std::future::poll_fn(|context| {
            assert!(queued.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        signal.cancel();
        assert!(queued.await.is_err());
        assert_eq!(executor.workers.available_permits(), 0);
        assert!(executor.reserve().is_ok());

        drop(active);
        assert_eq!(executor.workers.available_permits(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn cancellation_cannot_release_a_running_blocking_task() -> Result<()> {
        let executor = Executor::new(1, 0)?;
        let signal = NativeCancellation::new();
        let cancellation = Cancellation::from_signal(Some(&signal));
        let active = executor.reserve()?.acquire(&cancellation).await?;
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
        assert!(executor.reserve().is_err());
        assert_eq!(executor.workers.available_permits(), 0);

        release.send(()).map_err(|failure| error("TEST", failure))?;
        assert_eq!(
            running.await.map_err(|failure| error("TEST", failure))??,
            42
        );
        assert!(executor.reserve().is_ok());
        assert_eq!(executor.workers.available_permits(), 1);
        Ok(())
    }
}
