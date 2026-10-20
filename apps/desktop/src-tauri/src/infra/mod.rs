//! Cross-cutting infrastructure: the desktop `DesktopError` type (`error`), the
//! dedicated application error log + panic hook (`error_log`), what a native
//! crash leaves behind (`crash_report`), the persisted
//! application settings model (`settings`), and opt-in timing instrumentation
//! for the waveform request path (`waveform_diag`).

pub mod crash_report;
pub mod error;
pub mod error_log;
pub mod settings;
pub mod ui_diagnostics;
pub mod waveform_diag;
