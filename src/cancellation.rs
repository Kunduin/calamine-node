use napi::Result;
use napi_derive::napi;
use tokio::sync::watch;

use crate::state::error;

/// Owned cancellation state; it never retains a JavaScript signal or callback.
/// Operations without a signal do not allocate a channel.
#[derive(Clone, Default)]
pub(crate) struct Cancellation {
    sender: Option<watch::Sender<bool>>,
}

impl Cancellation {
    pub(crate) fn check(&self) -> Result<()> {
        if self.sender.as_ref().is_some_and(|sender| *sender.borrow()) {
            return Err(error("ERR_ABORTED", "operation was cancelled"));
        }
        Ok(())
    }

    pub(crate) async fn cancelled(&self) {
        if let Some(sender) = &self.sender {
            let mut receiver = sender.subscribe();
            let _ = receiver.wait_for(|cancelled| *cancelled).await;
        } else {
            std::future::pending::<()>().await;
        }
    }

    pub(crate) fn from_signal(signal: Option<&NativeCancellation>) -> Self {
        Self {
            sender: signal.map(|signal| signal.sender.clone()),
        }
    }
}

#[napi]
pub struct NativeCancellation {
    sender: watch::Sender<bool>,
}

impl Default for NativeCancellation {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }
}

#[napi]
impl NativeCancellation {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }
}

#[cfg(test)]
mod tests {
    use std::{future::Future, task::Poll};

    use super::*;

    #[tokio::test]
    async fn dropping_the_js_wrapper_does_not_cancel_owned_state() -> Result<()> {
        let signal = NativeCancellation::new();
        let cancellation = Cancellation::from_signal(Some(&signal));
        drop(signal);

        cancellation.check()?;
        let mut waiting = Box::pin(cancellation.cancelled());
        std::future::poll_fn(|context| {
            assert!(waiting.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        Ok(())
    }
}
