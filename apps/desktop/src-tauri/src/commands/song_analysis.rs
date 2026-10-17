//! "Analizar canción": read a song's click track and propose its tempo and
//! time signature markers. See `docs/plans/song-analysis/`.
//!
//! The click is bounced with the engine's offline renderer, so clip offsets,
//! trims and fades are already resolved, and with `apply_mixer: false`, so
//! the click track's own volume or mute (it is often silenced to the room)
//! does not matter. Like "Nivelar canciones", the session lock is held only to
//! copy the song out, and the analysis runs on a blocking thread.

use std::sync::atomic::{AtomicBool, Ordering};

use libretracks_analysis::{
    analyze_click, propose_tempo_markers, ClickAnalysis, ExistingTiming, ProposedSignatureMarker,
    ProposedTempoMarker, SongSpan, TempoProposal,
};
use lt_audio_engine_v2::{RenderError, RenderOutput, RenderRequest, RenderSampleFormat};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::render::JobError;
use crate::infra::error::DesktopError;
use crate::models::TransportSnapshot;
use crate::state::DesktopState;

pub const SONG_ANALYSIS_PROGRESS_EVENT: &str = "song-analysis-progress";

/// Runtime bounds may differ from the stored ones by float noise only.
const SAME_BOUND_SECONDS: f64 = 0.001;

static ANALYSIS_ACTIVE: AtomicBool = AtomicBool::new(false);
static ANALYSIS_CANCEL: AtomicBool = AtomicBool::new(false);

struct ActiveAnalysis;

impl ActiveAnalysis {
    fn acquire() -> Option<Self> {
        if ANALYSIS_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        ANALYSIS_CANCEL.store(false, Ordering::Release);
        Some(Self)
    }
}

impl Drop for ActiveAnalysis {
    fn drop(&mut self) {
        ANALYSIS_ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSongTempoRequest {
    pub region_id: String,
    /// The click track(s): usually one.
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSongTempoResult {
    pub cancelled: bool,
    pub region_id: String,
    pub region_start_seconds: f64,
    pub analysis: Option<ClickAnalysis>,
    pub proposal: Option<TempoProposal>,
    pub missing_files: Vec<String>,
}

impl AnalyzeSongTempoResult {
    fn cancelled(region_id: String) -> Self {
        Self {
            cancelled: true,
            region_id,
            region_start_seconds: 0.0,
            analysis: None,
            proposal: None,
            missing_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisProgressPayload {
    fraction: f64,
}

#[tauri::command(async)]
pub fn cancel_analyze_song_tempo() {
    ANALYSIS_CANCEL.store(true, Ordering::Release);
}

/// What the analysis needs from the session, copied out under the lock.
struct AnalysisJob {
    project_json: String,
    region_id: String,
    track_ids: Vec<String>,
    span: SongSpan,
    existing: ExistingTiming,
    fallback_beats_per_bar: u32,
}

fn prepare_job(
    song_dir: &std::path::Path,
    song: &libretracks_core::Song,
    request: &AnalyzeSongTempoRequest,
) -> Result<AnalysisJob, String> {
    let region = song
        .regions
        .iter()
        .find(|region| region.id == request.region_id)
        .ok_or_else(|| format!("Region not found: {}", request.region_id))?;
    if region.warp_enabled {
        return Err("song_analysis_warp".to_string());
    }
    let (project_json, runtime_song) = crate::audio::engine::runtime_session_json(song_dir, song)
        .map_err(|error| error.to_string())?;
    // A varispeed transpose (here or in an earlier song) moves the rendered
    // timeline away from the stored one the markers live in.
    let runtime_region = runtime_song
        .regions
        .iter()
        .find(|candidate| candidate.id == region.id)
        .ok_or_else(|| format!("Region not found: {}", request.region_id))?;
    if (runtime_region.start_seconds - region.start_seconds).abs() > SAME_BOUND_SECONDS
        || (runtime_region.end_seconds - region.end_seconds).abs() > SAME_BOUND_SECONDS
    {
        return Err("song_analysis_varispeed".to_string());
    }
    let next_song_start_seconds = song
        .regions
        .iter()
        .filter(|other| {
            other.id != region.id && other.start_seconds >= region.end_seconds - SAME_BOUND_SECONDS
        })
        .map(|other| other.start_seconds)
        .min_by(f64::total_cmp);
    let existing = ExistingTiming {
        bpm: song.bpm,
        time_signature: song.time_signature.clone(),
        tempo_markers: song
            .tempo_markers
            .iter()
            .map(|marker| (marker.start_seconds, marker.bpm))
            .collect(),
        signature_markers: song
            .time_signature_markers
            .iter()
            .map(|marker| (marker.start_seconds, marker.signature.clone()))
            .collect(),
    };
    let signature_at_start = song
        .time_signature_markers
        .iter()
        .filter(|marker| marker.start_seconds <= region.start_seconds + SAME_BOUND_SECONDS)
        .max_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds))
        .map(|marker| marker.signature.as_str())
        .unwrap_or(song.time_signature.as_str());
    let fallback_beats_per_bar = signature_at_start
        .split_once('/')
        .and_then(|(numerator, _)| numerator.trim().parse::<u32>().ok())
        .filter(|numerator| *numerator > 0)
        .unwrap_or(4);
    Ok(AnalysisJob {
        project_json,
        region_id: region.id.clone(),
        track_ids: request.track_ids.clone(),
        span: SongSpan {
            start_seconds: region.start_seconds,
            end_seconds: region.end_seconds,
            next_song_start_seconds,
        },
        existing,
        fallback_beats_per_bar,
    })
}

/// Read a float WAV written by the offline renderer as mono samples.
fn read_mono_wav(path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1_i64 << (spec.bits_per_sample.max(1) - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 * scale))
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string())?
        }
    };
    let mono = if channels == 1 {
        samples
    } else {
        samples
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    Ok((mono, spec.sample_rate))
}

fn run_job(
    job: &AnalysisJob,
    sample_rate: u32,
    scratch_dir: &std::path::Path,
    on_progress: &mut dyn FnMut(f64) -> bool,
) -> Result<AnalyzeSongTempoResult, JobError> {
    std::fs::create_dir_all(scratch_dir)?;
    let wav_path = scratch_dir.join(format!(
        "click-{}-{}.wav",
        job.region_id,
        std::process::id()
    ));
    let engine_request = RenderRequest {
        project_json: job.project_json.clone(),
        sample_rate,
        start_seconds: job.span.start_seconds,
        end_seconds: job.span.end_seconds,
        outputs: vec![RenderOutput {
            path: wav_path.to_string_lossy().into_owned(),
            track_ids: job.track_ids.clone(),
            include_metronome: false,
            include_voice_guide: false,
        }],
        format: RenderSampleFormat::Float32,
        channels: 1,
        normalize: false,
        normalize_peak_db: 0.0,
        apply_mixer: false,
        dither: false,
        measure_loudness: false,
        metronome: None,
        voice_guide: None,
    };
    // Rendering is nearly all the work; the analysis takes a moment.
    let mut render_progress = |fraction: f64| on_progress(0.9 * fraction);
    let report = match lt_audio_engine_v2::render_offline(&engine_request, &mut render_progress) {
        Ok(report) => report,
        Err(RenderError::Cancelled) => {
            let _ = std::fs::remove_file(&wav_path);
            return Err(JobError::Cancelled);
        }
        Err(RenderError::Failed(error)) => {
            let _ = std::fs::remove_file(&wav_path);
            return Err(JobError::Failed(error.to_string()));
        }
    };
    let read = read_mono_wav(&wav_path);
    let _ = std::fs::remove_file(&wav_path);
    let (samples, rate) = read.map_err(JobError::Failed)?;
    if !on_progress(0.95) {
        return Err(JobError::Cancelled);
    }

    let analysis = analyze_click(&samples, rate, job.fallback_beats_per_bar);
    let proposal = propose_tempo_markers(&analysis, job.span, &job.existing);
    on_progress(1.0);
    Ok(AnalyzeSongTempoResult {
        cancelled: false,
        region_id: job.region_id.clone(),
        region_start_seconds: job.span.start_seconds,
        analysis: Some(analysis),
        proposal: Some(proposal),
        missing_files: report.missing_files,
    })
}

#[tauri::command]
pub async fn analyze_song_tempo(
    app: AppHandle,
    request: AnalyzeSongTempoRequest,
    state: State<'_, DesktopState>,
) -> Result<AnalyzeSongTempoResult, String> {
    if request.track_ids.is_empty() {
        return Err("No click track chosen".to_string());
    }
    let Some(active) = ActiveAnalysis::acquire() else {
        return Err("An analysis is already running".to_string());
    };
    let job = {
        let session = state
            .session
            .lock()
            .map_err(|_| DesktopError::StatePoisoned.to_string())?;
        let song_dir = session
            .song_dir
            .clone()
            .ok_or_else(|| "No song loaded".to_string())?;
        let song = session
            .engine
            .song()
            .cloned()
            .ok_or_else(|| "No song loaded".to_string())?;
        drop(session);
        prepare_job(&song_dir, &song, &request)?
    };
    let engine_rate = state.audio.current_sample_rate_capabilities().0;
    let sample_rate = if engine_rate > 0 { engine_rate } else { 48_000 };
    let scratch_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("song-analysis");

    tauri::async_runtime::spawn_blocking(move || {
        let _active = active;
        let mut on_progress = |fraction: f64| {
            let _ = app.emit(
                SONG_ANALYSIS_PROGRESS_EVENT,
                AnalysisProgressPayload {
                    fraction: fraction.clamp(0.0, 1.0),
                },
            );
            !ANALYSIS_CANCEL.load(Ordering::Acquire)
        };
        match run_job(&job, sample_rate, &scratch_dir, &mut on_progress) {
            Ok(result) => Ok(result),
            Err(JobError::Cancelled) => {
                Ok(AnalyzeSongTempoResult::cancelled(job.region_id.clone()))
            }
            Err(JobError::Failed(error)) => Err(error),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub fn apply_song_tempo_analysis(
    region_id: String,
    tempo_markers: Vec<ProposedTempoMarker>,
    signature_markers: Vec<ProposedSignatureMarker>,
    state: State<'_, DesktopState>,
) -> Result<TransportSnapshot, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| DesktopError::StatePoisoned.to_string())?;
    session
        .apply_song_tempo_analysis(&region_id, &tempo_markers, &signature_markers, &state.audio)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_core::{Song, SongMaster, SongRegion, TimeSignatureMarker};

    fn region(id: &str, start: f64, end: f64) -> SongRegion {
        SongRegion {
            id: id.into(),
            name: id.into(),
            start_seconds: start,
            end_seconds: end,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            voice_guide_count_style: None,
            structure: None,
        }
    }

    fn song() -> Song {
        Song {
            id: "s".into(),
            title: "s".into(),
            artist: None,
            key: None,
            bpm: 120.0,
            time_signature: "4/4".into(),
            duration_seconds: 200.0,
            tempo_markers: vec![],
            time_signature_markers: vec![TimeSignatureMarker {
                id: "sig".into(),
                start_seconds: 50.0,
                signature: "6/8".into(),
            }],
            // Out of order on purpose: the next song is found by position.
            regions: vec![
                region("c", 150.0, 200.0),
                region("a", 0.0, 60.0),
                region("b", 64.0, 140.0),
            ],
            tracks: vec![],
            clips: vec![],
            midi_clips: vec![],
            video_clips: vec![],
            section_markers: vec![],
        }
    }

    fn request(region_id: &str) -> AnalyzeSongTempoRequest {
        AnalyzeSongTempoRequest {
            region_id: region_id.into(),
            track_ids: vec!["click".into()],
        }
    }

    #[test]
    fn job_knows_the_next_song_and_the_meter_in_force() {
        let dir = tempfile::tempdir().expect("dir");
        let job = prepare_job(dir.path(), &song(), &request("b")).expect("job");
        assert_eq!(job.span.start_seconds, 64.0);
        assert_eq!(job.span.end_seconds, 140.0);
        assert_eq!(job.span.next_song_start_seconds, Some(150.0));
        assert_eq!(job.fallback_beats_per_bar, 6);

        let last = prepare_job(dir.path(), &song(), &request("c")).expect("job");
        assert_eq!(last.span.next_song_start_seconds, None);
    }

    #[test]
    fn warped_songs_are_refused() {
        let dir = tempfile::tempdir().expect("dir");
        let mut warped = song();
        warped.regions[2].warp_enabled = true;
        warped.regions[2].warp_source_bpm = Some(100.0);
        let error = prepare_job(dir.path(), &warped, &request("b")).err();
        assert_eq!(error.as_deref(), Some("song_analysis_warp"));
    }
}
