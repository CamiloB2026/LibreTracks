//! Where this crate leaves a trail of what it did, for the app's crash
//! report. The crate cannot depend on the app, so the app hands in a sink
//! at startup; without one (tests, examples) tracing is a no-op that does
//! not even format.

use std::sync::OnceLock;

/// `(message, persist)`: `persist` lines are errors worth keeping in the
/// app's error log, not only in the in-memory trail.
pub type TraceSink = fn(&str, bool);

static SINK: OnceLock<TraceSink> = OnceLock::new();

pub fn set_trace_sink(sink: TraceSink) {
    let _ = SINK.set(sink);
}

/// Record one operation. `message` runs only if a sink is installed.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub(crate) fn trace(message: impl FnOnce() -> String) {
    if let Some(sink) = SINK.get() {
        sink(&message(), false);
    }
}

/// Like [`trace`], and also into the app's error log.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub(crate) fn trace_error(message: impl FnOnce() -> String) {
    if let Some(sink) = SINK.get() {
        sink(&message(), true);
    }
}
