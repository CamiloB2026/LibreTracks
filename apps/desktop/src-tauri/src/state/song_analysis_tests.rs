use std::fs;

use libretracks_analysis::{ProposedSignatureMarker, ProposedTempoMarker};
use libretracks_core::{Song, SongMaster, SongRegion, TempoMarker, TimeSignatureMarker};
use libretracks_project::{create_song_folder, save_song, SONG_FILE_NAME};
use tempfile::tempdir;

use super::apply_tempo_analysis_to_song;
use crate::audio::engine::AudioController;
use crate::state::DesktopSession;

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

fn tempo(id: &str, start: f64, bpm: f64) -> TempoMarker {
    TempoMarker {
        id: id.into(),
        start_seconds: start,
        bpm,
    }
}

fn proposed(start: f64, bpm: f64) -> ProposedTempoMarker {
    ProposedTempoMarker {
        start_seconds: start,
        bpm,
        restores_next_song: false,
    }
}

fn proposed_signature(start: f64, signature: &str) -> ProposedSignatureMarker {
    ProposedSignatureMarker {
        start_seconds: start,
        signature: signature.into(),
        restores_next_song: false,
    }
}

/// Three songs: [0, 60), [60, 120), [120, 180).
fn setlist() -> Song {
    Song {
        id: "setlist".into(),
        title: "Setlist".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 180.0,
        tempo_markers: vec![
            tempo("before", 30.0, 100.0),
            tempo("inside_a", 60.0, 128.0),
            tempo("inside_b", 90.0, 64.0),
            tempo("next", 120.0, 140.0),
        ],
        time_signature_markers: vec![TimeSignatureMarker {
            id: "inside_sig".into(),
            start_seconds: 80.0,
            signature: "3/4".into(),
        }],
        regions: vec![
            region("r1", 0.0, 60.0),
            region("r2", 60.0, 120.0),
            region("r3", 120.0, 180.0),
        ],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![],
    }
}

fn tempo_map(song: &Song) -> Vec<(f64, f64)> {
    song.tempo_markers
        .iter()
        .map(|marker| (marker.start_seconds, marker.bpm))
        .collect()
}

#[test]
fn replaces_only_the_markers_inside_the_song() {
    let mut song = setlist();
    apply_tempo_analysis_to_song(
        &mut song,
        "r2",
        &[proposed(60.25, 92.0), proposed(100.0, 96.0)],
        &[proposed_signature(60.25, "6/8")],
    )
    .expect("apply");

    assert_eq!(
        tempo_map(&song),
        vec![(30.0, 100.0), (60.25, 92.0), (100.0, 96.0), (120.0, 140.0)]
    );
    let signatures: Vec<(f64, &str)> = song
        .time_signature_markers
        .iter()
        .map(|marker| (marker.start_seconds, marker.signature.as_str()))
        .collect();
    assert_eq!(signatures, vec![(60.25, "6/8")]);
    // Kept markers keep their ids.
    assert_eq!(song.tempo_markers[0].id, "before");
    assert_eq!(song.tempo_markers[3].id, "next");
    // New ones never collide.
    assert_ne!(song.tempo_markers[1].id, song.tempo_markers[2].id);
}

#[test]
fn a_restoring_marker_at_the_next_song_start_is_written_there() {
    let mut song = setlist();
    song.tempo_markers.retain(|marker| marker.id != "next");
    apply_tempo_analysis_to_song(
        &mut song,
        "r2",
        &[
            proposed(60.0, 92.0),
            ProposedTempoMarker {
                start_seconds: 120.0,
                bpm: 64.0,
                restores_next_song: true,
            },
        ],
        &[],
    )
    .expect("apply");
    assert_eq!(
        tempo_map(&song),
        vec![(30.0, 100.0), (60.0, 92.0), (120.0, 64.0)]
    );
}

#[test]
fn a_marker_at_zero_sets_the_base_tempo_and_meter() {
    let mut song = setlist();
    apply_tempo_analysis_to_song(
        &mut song,
        "r1",
        &[proposed(0.0, 87.0)],
        &[proposed_signature(0.0, "12/8")],
    )
    .expect("apply");
    assert_eq!(song.bpm, 87.0);
    assert_eq!(song.time_signature, "12/8");
    // The marker at 30 s was inside r1: gone.
    assert_eq!(tempo_map(&song)[0], (60.0, 128.0));
}

#[test]
fn rejects_out_of_range_values_and_warped_songs() {
    let mut song = setlist();
    assert!(apply_tempo_analysis_to_song(&mut song, "r2", &[proposed(60.0, 400.0)], &[]).is_err());
    assert!(
        apply_tempo_analysis_to_song(&mut song, "r2", &[], &[proposed_signature(60.0, "x")])
            .is_err()
    );
    assert!(apply_tempo_analysis_to_song(&mut song, "nope", &[], &[]).is_err());
    song.regions[1].warp_enabled = true;
    assert!(apply_tempo_analysis_to_song(&mut song, "r2", &[proposed(60.0, 90.0)], &[]).is_err());
    assert_eq!(
        song.tempo_markers.len(),
        4,
        "a rejected apply changes nothing"
    );
}

#[test]
fn applying_is_one_undo_step() {
    let song = setlist();
    let root = tempdir().expect("temp dir").keep();
    let song_dir = create_song_folder(&root, "song-analysis-undo").expect("song dir");
    fs::create_dir_all(song_dir.join("audio")).expect("audio dir");
    save_song(&song_dir, &song).expect("save");
    let mut session = DesktopSession::default();
    session.song_file_path = Some(song_dir.join(SONG_FILE_NAME));
    session.song_dir = Some(song_dir);
    session.engine.load_song(song.clone()).expect("load");
    let audio = AudioController::default();

    session
        .apply_song_tempo_analysis(
            "r2",
            &[proposed(60.0, 92.0), proposed(100.0, 96.0)],
            &[proposed_signature(60.0, "6/8")],
            &audio,
        )
        .expect("apply");
    let applied = session.engine.song().cloned().expect("song");
    assert_eq!(
        tempo_map(&applied),
        vec![(30.0, 100.0), (60.0, 92.0), (100.0, 96.0), (120.0, 140.0)]
    );

    session.undo_action(&audio).expect("undo");
    let undone = session.engine.song().cloned().expect("song");
    assert_eq!(tempo_map(&undone), tempo_map(&song));
    assert_eq!(undone.time_signature_markers, song.time_signature_markers);
}
