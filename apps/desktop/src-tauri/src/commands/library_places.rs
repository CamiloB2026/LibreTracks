//! Library of disk folders ("places", like Ableton's browser): list one folder
//! of the user's disk so the library can browse it and drag audio out of it.
//!
//! Lists exactly one level — never walks the tree. The UI expands a folder by
//! asking for it, so opening a place with thousands of files nested below costs
//! one directory read, not a disk scan. Only names and kinds: nothing is opened
//! or decoded here (that happens on import, as with any other audio).
//!
//! `(async)` like every library command: these read the disk, and a plain
//! command would run on the main thread (see commands/library.rs).

use std::cmp::Ordering;
use std::path::Path;

use serde::Serialize;

/// Audio the importer accepts. Keep in step with SUPPORTED_AUDIO_EXTENSIONS in
/// features/transport/library/dragDrop.ts.
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"];
const PACKAGE_EXTENSION: &str = "ltpkg";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LibraryDirEntryKind {
    Folder,
    Audio,
    Video,
    Package,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDirEntry {
    pub name: String,
    pub path: String,
    pub kind: LibraryDirEntryKind,
}

fn entry_kind(path: &Path, is_dir: bool) -> Option<LibraryDirEntryKind> {
    if is_dir {
        return Some(LibraryDirEntryKind::Folder);
    }
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        Some(LibraryDirEntryKind::Audio)
    } else if libretracks_core::VIDEO_FILE_EXTENSIONS.contains(&extension.as_str()) {
        Some(LibraryDirEntryKind::Video)
    } else if extension == PACKAGE_EXTENSION {
        Some(LibraryDirEntryKind::Package)
    } else {
        None
    }
}

/// Folders first, then files; each group by name, case-insensitively and with
/// numbers in order ("2 Bass" before "10 Keys"), the way a file browser does.
fn compare_entries(left: &LibraryDirEntry, right: &LibraryDirEntry) -> Ordering {
    let left_folder = left.kind == LibraryDirEntryKind::Folder;
    let right_folder = right.kind == LibraryDirEntryKind::Folder;
    right_folder
        .cmp(&left_folder)
        .then_with(|| natural_cmp(&left.name, &right.name))
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let mut left_number = String::new();
                while let Some(c) = left_chars.peek().copied().filter(char::is_ascii_digit) {
                    left_number.push(c);
                    left_chars.next();
                }
                let mut right_number = String::new();
                while let Some(c) = right_chars.peek().copied().filter(char::is_ascii_digit) {
                    right_number.push(c);
                    right_chars.next();
                }
                let left_trimmed = left_number.trim_start_matches('0');
                let right_trimmed = right_number.trim_start_matches('0');
                let ordering = left_trimmed
                    .len()
                    .cmp(&right_trimmed.len())
                    .then_with(|| left_trimmed.cmp(right_trimmed));
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            (Some(l), Some(r)) => {
                let ordering = l.to_lowercase().cmp(r.to_lowercase());
                if ordering != Ordering::Equal {
                    return ordering;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

/// One level of `dir`: subfolders and the files the app can use. Hidden
/// entries (dot-files, and on Windows the hidden attribute) are left out.
pub fn list_dir_entries(dir: &Path) -> Result<Vec<LibraryDirEntry>, String> {
    let read = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || is_hidden(&entry) {
            continue;
        }
        // file_type() does not follow symlinks; metadata() does, so a linked
        // folder still browses like a folder.
        let Ok(metadata) = std::fs::metadata(entry.path()) else {
            continue;
        };
        let path = entry.path();
        let Some(kind) = entry_kind(&path, metadata.is_dir()) else {
            continue;
        };
        entries.push(LibraryDirEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            kind,
        });
    }
    entries.sort_by(compare_entries);
    Ok(entries)
}

#[cfg(windows)]
fn is_hidden(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    entry
        .metadata()
        .map(|metadata| metadata.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_hidden(_entry: &std::fs::DirEntry) -> bool {
    false
}

/// Android: a folder of a picked SAF tree. The kind comes from the MIME type
/// the provider reports, falling back to the name's extension.
#[cfg(target_os = "android")]
fn list_tree_entries(folder_uri: &str) -> Result<Vec<LibraryDirEntry>, String> {
    let mut entries: Vec<LibraryDirEntry> =
        crate::platform::android_library_tree::list_library_tree(folder_uri)?
            .into_iter()
            .filter(|child| !child.name.starts_with('.'))
            .filter_map(|child| {
                let kind = if child.mime == "vnd.android.document/directory" {
                    LibraryDirEntryKind::Folder
                } else if child.mime.starts_with("audio/") {
                    LibraryDirEntryKind::Audio
                } else if child.mime.starts_with("video/") {
                    LibraryDirEntryKind::Video
                } else {
                    entry_kind(Path::new(&child.name), false)?
                };
                Some(LibraryDirEntry {
                    name: child.name,
                    path: child.uri,
                    kind,
                })
            })
            .collect();
    entries.sort_by(compare_entries);
    Ok(entries)
}

#[tauri::command(async)]
pub fn list_library_dir(path: String) -> Result<Vec<LibraryDirEntry>, String> {
    list_any(&path)
}

/// How far below a folder "add it as a song" looks for its audio. Enough for
/// the usual project layouts (Reaper `Media/`, Ableton `Samples/Imported/`)
/// without turning a drop of a whole disk into a scan of it.
const FOLDER_AUDIO_MAX_DEPTH: usize = 3;
/// More audio than one song plausibly has: a folder of several songs.
const FOLDER_AUDIO_MAX_FILES: usize = 128;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderAudio {
    pub paths: Vec<String>,
    /// Stopped at FOLDER_AUDIO_MAX_FILES; `paths` is not the whole folder.
    pub truncated: bool,
}

/// The audio of a folder dropped as a song. Each branch goes down only to its
/// first level with audio: a song folder whose stems sit in a subfolder
/// (`Song/Media/*.wav`) gives those stems, while one with the stems at the top
/// ignores its subfolders (backups, alternate mixes). A folder's own audio
/// comes before its subfolders', each in listing order. A subfolder that
/// cannot be read is skipped; the folder itself must be readable.
fn collect_folder_audio(
    root: &str,
    list: &dyn Fn(&str) -> Result<Vec<LibraryDirEntry>, String>,
) -> Result<LibraryFolderAudio, String> {
    let mut out = LibraryFolderAudio {
        paths: Vec::new(),
        truncated: false,
    };
    let entries = list(root)?;
    collect_level(entries, 0, list, &mut out);
    Ok(out)
}

fn collect_level(
    entries: Vec<LibraryDirEntry>,
    depth: usize,
    list: &dyn Fn(&str) -> Result<Vec<LibraryDirEntry>, String>,
    out: &mut LibraryFolderAudio,
) {
    let (folders, files): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|entry| entry.kind == LibraryDirEntryKind::Folder);
    let audio: Vec<_> = files
        .into_iter()
        .filter(|entry| entry.kind == LibraryDirEntryKind::Audio)
        .collect();
    if !audio.is_empty() {
        for entry in audio {
            if out.paths.len() == FOLDER_AUDIO_MAX_FILES {
                out.truncated = true;
                return;
            }
            out.paths.push(entry.path);
        }
        return;
    }
    if depth == FOLDER_AUDIO_MAX_DEPTH {
        return;
    }
    for folder in folders {
        if out.truncated {
            return;
        }
        if let Ok(children) = list(&folder.path) {
            collect_level(children, depth + 1, list, out);
        }
    }
}

fn list_any(path: &str) -> Result<Vec<LibraryDirEntry>, String> {
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        return list_tree_entries(path);
    }
    list_dir_entries(Path::new(path))
}

#[tauri::command(async)]
pub fn list_library_folder_audio(path: String) -> Result<LibraryFolderAudio, String> {
    collect_folder_audio(&path, &list_any)
}

/// The user removed a place. Android: give back its persistable permission,
/// so they do not pile up (the system caps how many an app may hold).
/// Elsewhere there is nothing to release.
#[tauri::command(async)]
pub fn forget_library_place(path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        return crate::platform::android_library_tree::release_library_tree(&path);
    }
    let _ = path;
    Ok(())
}

/// Ask the user for a folder to add to the library. `None` = cancelled.
///
/// iOS: the same picker sessions use. It keeps a security-scoped bookmark of
/// the folder and reopens access to it at every launch (IosFolderPickerPlugin
/// `restoreBookmarks`), so the folder can be listed with `std::fs` and its
/// audio imported by reference after a restart. Android: the SAF folder
/// picker, with a persistable permission on the whole tree (see
/// platform/android_library_tree.rs).
#[tauri::command]
pub async fn pick_library_place(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    {
        libretracks_ios_folder_picker::pick_folder(app).await
    }

    #[cfg(target_os = "android")]
    {
        let _ = app;
        // The picker blocks until the user answers; keep it off the async
        // runtime's threads.
        tauri::async_runtime::spawn_blocking(crate::platform::android_library_tree::pick_library_tree)
            .await
            .map_err(|error| format!("folder picker worker failed: {error}"))?
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let picked = crate::platform::file_dialog::FileDialog::new()
            .set_title("Añadir carpeta a la biblioteca")
            .pick_folder();
        Ok(picked.map(|path| path.to_string_lossy().into_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_folders_first_then_usable_files_in_natural_order() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("Stems")).unwrap();
        fs::create_dir(dir.path().join("2 Live")).unwrap();
        for name in [
            "10 Keys.wav",
            "2 Bass.WAV",
            "Click.mp3",
            "notes.txt",
            ".hidden.wav",
            "Song.ltpkg",
            "Clip.mp4",
        ] {
            fs::write(dir.path().join(name), b"").unwrap();
        }

        let entries = list_dir_entries(dir.path()).expect("list");
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            ["2 Live", "Stems", "2 Bass.WAV", "10 Keys.wav", "Click.mp3", "Clip.mp4", "Song.ltpkg"]
        );
        let kinds: Vec<_> = entries.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds[0], LibraryDirEntryKind::Folder);
        assert_eq!(kinds[2], LibraryDirEntryKind::Audio);
        assert_eq!(kinds[5], LibraryDirEntryKind::Video);
        assert_eq!(kinds[6], LibraryDirEntryKind::Package);
    }

    #[test]
    fn lists_one_level_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("Song")).unwrap();
        fs::write(dir.path().join("Song").join("Drums.wav"), b"").unwrap();

        let entries = list_dir_entries(dir.path()).expect("list");
        assert_eq!(entries.len(), 1, "the nested file is not listed");
        assert_eq!(entries[0].kind, LibraryDirEntryKind::Folder);
    }

    fn folder_audio(root: &Path) -> LibraryFolderAudio {
        collect_folder_audio(&root.to_string_lossy(), &list_any).expect("collect")
    }

    fn names(audio: &LibraryFolderAudio, root: &Path) -> Vec<String> {
        audio
            .paths
            .iter()
            .map(|path| {
                Path::new(path)
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn folder_audio_finds_stems_in_a_subfolder() {
        // A Reaper project: the .rpp at the top, the stems under Media/ and
        // Reaper's own peak files one level further down.
        let dir = tempfile::tempdir().expect("temp dir");
        let media = dir.path().join("Media");
        fs::create_dir_all(media.join("peaks")).unwrap();
        fs::write(dir.path().join("Song.rpp"), b"").unwrap();
        for name in ["GUIA_01.wav", "CLICK_02.wav", "CLICK_02.wav.asd"] {
            fs::write(media.join(name), b"").unwrap();
        }
        fs::write(media.join("peaks").join("CLICK_02.wav.reapeaks"), b"").unwrap();

        let audio = folder_audio(dir.path());
        assert_eq!(names(&audio, dir.path()), ["Media/CLICK_02.wav", "Media/GUIA_01.wav"]);
        assert!(!audio.truncated);
    }

    #[test]
    fn folder_audio_at_the_top_ignores_subfolders() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("Backup")).unwrap();
        fs::write(dir.path().join("Backup").join("Old Bass.wav"), b"").unwrap();
        fs::write(dir.path().join("Bass.wav"), b"").unwrap();

        assert_eq!(names(&folder_audio(dir.path()), dir.path()), ["Bass.wav"]);
    }

    #[test]
    fn folder_audio_stops_at_the_depth_limit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut deep = dir.path().to_path_buf();
        for level in 1..=FOLDER_AUDIO_MAX_DEPTH + 1 {
            deep = deep.join(format!("L{level}"));
            fs::create_dir(&deep).unwrap();
            if level == FOLDER_AUDIO_MAX_DEPTH {
                fs::write(deep.join("Reached.wav"), b"").unwrap();
            }
        }
        fs::write(deep.join("TooDeep.wav"), b"").unwrap();

        let found = names(&folder_audio(dir.path()), dir.path());
        assert_eq!(found, ["L1/L2/L3/Reached.wav"]);

        fs::remove_file(dir.path().join("L1/L2/L3/Reached.wav")).unwrap();
        assert!(folder_audio(dir.path()).paths.is_empty(), "the file below the limit is not reached");
    }

    #[test]
    fn folder_audio_of_many_songs_is_truncated() {
        let dir = tempfile::tempdir().expect("temp dir");
        for song in 0..3 {
            let song_dir = dir.path().join(format!("Song {song}"));
            fs::create_dir(&song_dir).unwrap();
            for stem in 0..FOLDER_AUDIO_MAX_FILES / 2 {
                fs::write(song_dir.join(format!("{stem}.wav")), b"").unwrap();
            }
        }

        let audio = folder_audio(dir.path());
        assert!(audio.truncated);
        assert_eq!(audio.paths.len(), FOLDER_AUDIO_MAX_FILES);
    }

    #[test]
    fn folder_audio_of_a_missing_folder_is_an_error() {
        assert!(collect_folder_audio("/definitely/not/here/lt", &list_any).is_err());
    }

    #[test]
    fn a_missing_folder_is_an_error_not_a_panic() {
        assert!(list_dir_entries(Path::new("/definitely/not/here/lt")).is_err());
    }
}
