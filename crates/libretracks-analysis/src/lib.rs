//! Song analysis: samples in, musical facts out (tempo map, meter…).
//!
//! Pure functions over decoded audio, with no I/O and no knowledge of the
//! session: the desktop crate renders the song, hands the samples here and
//! turns the result into markers. See `docs/plans/song-analysis/`.

pub mod click;
mod dsp;
mod fft;
pub mod guide;
pub mod guide_text;
pub mod key;
pub mod music;
pub mod proposal;

pub use click::{analyze_click, ClickAnalysis, ClickWarning, ClickWarningKind, TempoSegment};
pub use guide::{
    analyze_guide, GuideAnalysis, GuideAnnouncement, GuideGroup, GuideTemplate, Transcriber,
};
pub use guide_text::{is_count, parse_announcement, AnnouncedMarker};
pub use key::{analyze_key, transpose_key_name, KeyAnalysis, KeyCandidate, KeySection};
pub use music::analyze_music_tempo;
pub use proposal::{
    propose_tempo_markers, ExistingTiming, ProposedSignatureMarker, ProposedTempoMarker, SongSpan,
    TempoProposal,
};
