//! Plantillas de canción de punta a punta sobre `DesktopSession`: ajustes
//! reales en el `AudioController`, WAVs en disco y el historial de deshacer.
//! La lógica fina (matching, modos, hermanas) está probada en
//! `song_templates.rs`; aquí se prueba que los caminos de la app la usan, y
//! sobre todo que **sin plantilla nada cambia**.

use libretracks_core::{Song, TrackKind};

use super::build_empty_song;
use super::song_templates::{TemplateDropSummary, BUILTIN_BAND_TEMPLATE};
use super::tests::{session_with_song_dir, write_silent_test_wav};
use super::{CreateAudioTrackWithClipRequest, CreateClipWithAutoTrackRequest, DesktopSession};
use crate::audio::engine::AudioController;

const MULTITRACK: [&str; 5] = [
    "Way Maker - Click.wav",
    "Way Maker - EG 1.wav",
    "Way Maker - EG 2.wav",
    "Way Maker - Keys.wav",
    "Way Maker - Banjo.wav",
];

fn audio_with(template: Option<&str>, layout: Option<&str>) -> AudioController {
    let audio = AudioController::default();
    let mut settings = audio.current_settings().expect("settings");
    settings.default_song_template = template.map(str::to_string);
    settings.song_track_layout = layout.map(str::to_string);
    settings.locale = Some("es".into());
    audio.replace_settings(settings).expect("replace settings");
    audio
}

fn empty_session(name: &str) -> DesktopSession {
    session_with_song_dir(name, build_empty_song("song_1".into(), "Set".into()))
}

fn write_stems(session: &DesktopSession, files: &[&str]) -> Vec<String> {
    let song_dir = session.song_dir.clone().expect("song dir");
    files
        .iter()
        .map(|file| {
            write_silent_test_wav(&song_dir.join("audio").join(file), 4);
            format!("audio/{file}")
        })
        .collect()
}

fn loaded(session: &DesktopSession) -> Song {
    session.engine.song().cloned().expect("song loaded")
}

fn track_name_of_clip(song: &Song, file: &str) -> String {
    let clip = song
        .clips
        .iter()
        .find(|clip| clip.file_path.ends_with(file))
        .unwrap_or_else(|| panic!("no clip for {file}"));
    song.tracks
        .iter()
        .find(|track| track.id == clip.track_id)
        .expect("clip track")
        .name
        .clone()
}

fn parent_name_of_clip(song: &Song, file: &str) -> Option<String> {
    let clip = song
        .clips
        .iter()
        .find(|clip| clip.file_path.ends_with(file))?;
    let track = song.tracks.iter().find(|track| track.id == clip.track_id)?;
    let parent = track.parent_track_id.as_ref()?;
    song.tracks
        .iter()
        .find(|track| &track.id == parent)
        .map(|track| track.name.clone())
}

#[test]
fn new_song_without_a_template_comes_out_empty_as_always() {
    let mut session = empty_session("tpl-new-song-none");
    let audio = audio_with(None, None);
    session
        .create_empty_song(None, None, &audio)
        .expect("create song");
    let song = loaded(&session);
    assert_eq!(song.regions.len(), 1);
    assert!(song.tracks.is_empty());
}

#[test]
fn new_song_is_laid_out_from_the_default_template() {
    let mut session = empty_session("tpl-new-song-default");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), None);
    session
        .create_empty_song(None, None, &audio)
        .expect("first song");
    let after_first = loaded(&session).tracks.len();
    assert_eq!(after_first, 9, "the band template's nine targets");
    assert!(loaded(&session).tracks.iter().any(|t| t.name == "Batería"));

    // Shared (the default layout): the second song adds nothing.
    session
        .create_empty_song(None, None, &audio)
        .expect("second song");
    assert_eq!(loaded(&session).tracks.len(), after_first);
}

#[test]
fn an_explicit_template_wins_over_having_none_by_default() {
    let mut session = empty_session("tpl-new-song-explicit");
    let audio = audio_with(None, Some("songFolder"));
    session
        .create_empty_song(Some("Way Maker"), Some(BUILTIN_BAND_TEMPLATE), &audio)
        .expect("create song");
    let song = loaded(&session);
    let folder = &song.tracks[0];
    assert_eq!(folder.kind, TrackKind::Folder);
    assert_eq!(folder.name, "Way Maker");
    assert_eq!(folder.song_region_id.as_ref(), Some(&song.regions[0].id));
}

#[test]
fn a_missing_default_template_file_counts_as_no_template() {
    let mut session = empty_session("tpl-missing-file");
    let audio = audio_with(Some("C:/no/such/template.lttemplate"), None);
    session
        .create_empty_song(None, None, &audio)
        .expect("create song");
    assert!(loaded(&session).tracks.is_empty());
}

#[test]
fn compact_drop_without_a_template_keeps_one_auto_track_per_file() {
    let mut session = empty_session("tpl-drop-none");
    let audio = audio_with(None, None);
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateClipWithAutoTrackRequest {
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    session
        .create_clips_with_auto_tracks(&requests, &audio)
        .expect("drop");
    let song = loaded(&session);
    assert_eq!(song.tracks.len(), MULTITRACK.len());
    assert!(song
        .tracks
        .iter()
        .all(|t| t.auto_created && t.parent_track_id.is_none()));
    assert_eq!(
        track_name_of_clip(&song, "Way Maker - Click.wav"),
        "Way Maker - Click"
    );
    assert_eq!(
        session.last_template_drop, None,
        "nothing organised, no toast"
    );
}

#[test]
fn compact_drop_with_a_template_organises_the_stems_in_one_undo_step() {
    let mut session = empty_session("tpl-drop-shared");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), None);
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateClipWithAutoTrackRequest {
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    let undo_depth = session.undo_stack.len();
    session
        .create_clips_with_auto_tracks(&requests, &audio)
        .expect("drop");

    let song = loaded(&session);
    assert_eq!(track_name_of_clip(&song, "Click.wav"), "Click");
    assert_eq!(track_name_of_clip(&song, "EG 1.wav"), "EG 1");
    assert_eq!(
        parent_name_of_clip(&song, "EG 1.wav").as_deref(),
        Some("Guitarras")
    );
    assert_eq!(
        parent_name_of_clip(&song, "EG 2.wav").as_deref(),
        Some("Guitarras")
    );
    assert_eq!(
        parent_name_of_clip(&song, "Keys.wav").as_deref(),
        Some("Teclados")
    );
    // The banjo has no place: it gets its auto track at the root, as always.
    assert_eq!(track_name_of_clip(&song, "Banjo.wav"), "Way Maker - Banjo");
    assert_eq!(parent_name_of_clip(&song, "Banjo.wav"), None);
    assert_eq!(
        session.last_template_drop,
        Some(TemplateDropSummary {
            matched: 4,
            unmatched: 1
        })
    );

    // One step back undoes the whole drop, template tracks included.
    assert_eq!(session.undo_stack.len(), undo_depth + 1);
    session.undo_action(&audio).expect("undo");
    let undone = loaded(&session);
    assert!(undone.clips.is_empty());
    assert!(undone.tracks.is_empty());
}

#[test]
fn timeline_drop_in_song_folder_mode_keeps_each_song_together() {
    let mut session = empty_session("tpl-drop-folder");
    let audio = audio_with(Some(BUILTIN_BAND_TEMPLATE), Some("songFolder"));
    let files = write_stems(&session, &MULTITRACK);
    let requests: Vec<_> = files
        .iter()
        .map(|file_path| CreateAudioTrackWithClipRequest {
            track_name: file_path
                .trim_start_matches("audio/")
                .trim_end_matches(".wav")
                .into(),
            file_path: file_path.clone(),
            timeline_start_seconds: 0.0,
        })
        .collect();
    session
        .create_audio_tracks_with_clips(&requests, &audio)
        .expect("drop");

    let song = loaded(&session);
    let region = &song.regions[0];
    let folder = song
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Folder && t.parent_track_id.is_none())
        .expect("song folder");
    assert_eq!(folder.name, region.name);
    // Every track lives inside the song and belongs to it — the unmatched
    // banjo too, which is a persistent track because it came from the DAW.
    assert!(song
        .tracks
        .iter()
        .all(|t| t.song_region_id.as_ref() == Some(&region.id)));
    assert_eq!(
        parent_name_of_clip(&song, "Banjo.wav").as_deref(),
        Some(region.name.as_str())
    );
    let banjo_track = song
        .tracks
        .iter()
        .find(|t| t.name == "Way Maker - Banjo")
        .expect("banjo track");
    assert!(!banjo_track.auto_created);
    assert_eq!(banjo_track.audio_to, "inherit");
}
