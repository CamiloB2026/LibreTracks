//! Song analysis: samples in, musical facts out (tempo map, meter…).
//!
//! Pure functions over decoded audio, with no I/O and no knowledge of the
//! session: the desktop crate renders the song, hands the samples here and
//! turns the result into markers. See `docs/plans/song-analysis/`.

pub mod click;
pub mod proposal;

pub use click::{analyze_click, ClickAnalysis, ClickWarning, ClickWarningKind, TempoSegment};
pub use proposal::{
    propose_tempo_markers, ExistingTiming, ProposedSignatureMarker, ProposedTempoMarker, SongSpan,
    TempoProposal,
};
