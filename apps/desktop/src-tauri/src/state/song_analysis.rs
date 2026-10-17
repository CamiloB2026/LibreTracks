//! Apply the result of "Analizar canción" (tempo and meter from the click).
//!
//! The proposal comes from `libretracks_analysis::propose_tempo_markers`,
//! reviewed (and maybe edited) by the user. Applying replaces every tempo and
//! time signature marker inside the song with it, in one undoable edit. See
//! `docs/plans/song-analysis/00-DISENO.md`.

use libretracks_analysis::{ProposedSignatureMarker, ProposedTempoMarker};
use libretracks_core::{Song, TempoMarker, TimeSignatureMarker};

use crate::audio::engine::AudioController;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;

use super::{
    realign_regions_after_warp_tempo_change, song_has_active_warp, timestamp_suffix,
    validate_time_signature, AudioChangeImpact, DesktopSession, UpdatePhase,
};

/// Two positions this close are the same marker (the editors' 1 ms).
const SAME_POSITION_SECONDS: f64 = 0.0005;
/// The first song's start: a marker here sets the song's base tempo/meter.
const SONG_ORIGIN_SECONDS: f64 = 0.0001;

/// Replace the tempo and time signature markers inside `region_id` with the
/// given ones. Markers outside the song are left alone, except the ones the
/// proposal adds at the next song's start to keep its tempo.
pub(super) fn apply_tempo_analysis_to_song(
    song: &mut Song,
    region_id: &str,
    tempo_markers: &[ProposedTempoMarker],
    signature_markers: &[ProposedSignatureMarker],
) -> Result<(), DesktopError> {
    for marker in tempo_markers {
        if !marker.bpm.is_finite() || marker.bpm < 20.0 || marker.bpm > 300.0 {
            return Err(DesktopError::AudioCommand(
                "song bpm marker must be between 20.0 and 300.0".into(),
            ));
        }
        if !marker.start_seconds.is_finite() || marker.start_seconds < 0.0 {
            return Err(DesktopError::AudioCommand(
                "tempo marker position is invalid".into(),
            ));
        }
    }
    for marker in signature_markers {
        validate_time_signature(&marker.signature)?;
        if !marker.start_seconds.is_finite() || marker.start_seconds < 0.0 {
            return Err(DesktopError::AudioCommand(
                "time signature marker position is invalid".into(),
            ));
        }
    }
    let region = song
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .ok_or_else(|| DesktopError::RegionNotFound(region_id.to_string()))?;
    // The analysis reads the timeline as rendered; with warp that is not the
    // source time markers are stored in.
    if region.warp_enabled {
        return Err(DesktopError::AudioCommand(
            "song analysis does not support songs with warp".into(),
        ));
    }
    let (start, end) = (region.start_seconds, region.end_seconds);
    let inside = |position: f64| {
        position >= start - SAME_POSITION_SECONDS && position < end - SAME_POSITION_SECONDS
    };
    song.tempo_markers
        .retain(|marker| !inside(marker.start_seconds));
    song.time_signature_markers
        .retain(|marker| !inside(marker.start_seconds));

    let suffix = timestamp_suffix();
    for (index, marker) in tempo_markers.iter().enumerate() {
        if marker.start_seconds <= SONG_ORIGIN_SECONDS {
            song.bpm = marker.bpm;
        } else if let Some(existing) = song.tempo_markers.iter_mut().find(|existing| {
            (existing.start_seconds - marker.start_seconds).abs() < SAME_POSITION_SECONDS
        }) {
            existing.bpm = marker.bpm;
        } else {
            song.tempo_markers.push(TempoMarker {
                id: format!("tempo_marker_{suffix}_{index}"),
                start_seconds: marker.start_seconds,
                bpm: marker.bpm,
            });
        }
    }
    for (index, marker) in signature_markers.iter().enumerate() {
        if marker.start_seconds <= SONG_ORIGIN_SECONDS {
            song.time_signature = marker.signature.clone();
        } else if let Some(existing) = song.time_signature_markers.iter_mut().find(|existing| {
            (existing.start_seconds - marker.start_seconds).abs() < SAME_POSITION_SECONDS
        }) {
            existing.signature = marker.signature.clone();
        } else {
            song.time_signature_markers.push(TimeSignatureMarker {
                id: format!("time_signature_marker_{suffix}_{index}"),
                start_seconds: marker.start_seconds,
                signature: marker.signature.clone(),
            });
        }
    }
    song.tempo_markers
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    song.time_signature_markers
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    Ok(())
}

impl DesktopSession {
    pub fn apply_song_tempo_analysis(
        &mut self,
        region_id: &str,
        tempo_markers: &[ProposedTempoMarker],
        signature_markers: &[ProposedSignatureMarker],
        audio: &AudioController,
    ) -> Result<TransportSnapshot, DesktopError> {
        let mut song = self
            .engine
            .song()
            .cloned()
            .ok_or(DesktopError::NoSongLoaded)?;
        let previous_song = song.clone();
        apply_tempo_analysis_to_song(&mut song, region_id, tempo_markers, signature_markers)?;
        realign_regions_after_warp_tempo_change(&previous_song, &mut song);

        let impact = if song_has_active_warp(&song) {
            AudioChangeImpact::TimelineWindow
        } else {
            AudioChangeImpact::TransportOnly
        };
        // One persist, one undo step. Realigning may shift the songs after:
        // their cues go with them.
        self.persist_song_update_carrying_cues(song, audio, impact, true, UpdatePhase::Commit)?;

        Ok(self.snapshot())
    }
}

#[cfg(test)]
#[path = "song_analysis_tests.rs"]
mod tests;
