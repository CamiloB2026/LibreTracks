//! Bench of a running host (plan song-patches/01): joins as an editor, toggles
//! the first song's warp and steps its key N times each, and measures for
//! every edit the command's round trip and the time until the host's new song
//! view arrives. Leaves the song as it found it, then prints the host's own
//! timings (`get_link_perf`): feed ticks and commands.
//! `cargo run --release -p libretracks-link --example link_bench -- 127.0.0.1:3040 1234 10`

use std::time::{Duration, Instant};

use libretracks_link::{join, GuestConfig, GuestEvent, GuestState, LinkCommand};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let address = args.next().unwrap_or_else(|| "127.0.0.1:3040".into());
    let pin = args.next().filter(|pin| !pin.is_empty() && pin != "-");
    let rounds: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(10);

    let mut runtime = join(GuestConfig {
        device_name: "link-bench".into(),
        platform: "windows".into(),
        app_version: "bench".into(),
        pin,
        ..GuestConfig::new(format!("ws://{address}"), "link-bench")
    })
    .expect("runtime");

    // Songs arrive on the event stream; keep only those, with their size.
    let (song_tx, mut songs) = tokio::sync::mpsc::unbounded_channel::<(Instant, usize)>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<bool>();
    let mut ready_tx = Some(ready_tx);
    tokio::spawn(async move {
        while let Some(event) = runtime.events.recv().await {
            match event {
                GuestEvent::State(GuestState::Connected) => {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(true);
                    }
                }
                GuestEvent::State(GuestState::Rejected { reason, .. }) => {
                    println!("rejected: {reason:?}");
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(false);
                    }
                }
                GuestEvent::Song(song) => {
                    let _ = song_tx.send((Instant::now(), song.to_string().len()));
                }
                GuestEvent::Event { name, payload, .. } => {
                    if let Ok(mut log) = EVENT_LOG.lock() {
                        log.push((Instant::now(), name, payload.to_string().len()));
                    }
                }
                _ => {}
            }
        }
    });
    if !tokio::time::timeout(Duration::from_secs(10), ready_rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false)
    {
        println!("not connected");
        return;
    }
    let handle = runtime.handle.clone();
    let invoke = |command: &'static str, args: Value| {
        let handle = handle.clone();
        async move {
            handle
                .send_command(
                    LinkCommand::Invoke {
                        command: command.into(),
                        args,
                    },
                    None,
                )
                .await
        }
    };

    let song = invoke("get_song_view", json!({ "includeWaveforms": false }))
        .await
        .expect("song view");
    let region = song["regions"][0].clone();
    let region_id = region["id"].as_str().expect("a region").to_string();
    let warp_was = region["warpEnabled"].as_bool().unwrap_or(false);
    let transpose_was = region["transposeSemitones"].as_i64().unwrap_or(0);
    let source_bpm = region["warpSourceBpm"]
        .as_f64()
        .or_else(|| song["bpm"].as_f64())
        .unwrap_or(120.0);
    println!(
        "region {:?}: warp={warp_was} transpose={transpose_was}, {} tracks, {} clips",
        region["name"],
        song["tracks"].as_array().map_or(0, Vec::len),
        song["clips"].as_array().map_or(0, Vec::len)
    );
    if rounds == 0 {
        // `... 0 off 0`: only set the first song to the given warp/key.
        let warp: bool = std::env::args().nth(4).as_deref() == Some("on");
        let key: i64 = std::env::args().nth(5).and_then(|k| k.parse().ok()).unwrap_or(0);
        restore(&handle, &region_id, warp, key, source_bpm).await;
        let song = invoke("get_song_view", json!({ "includeWaveforms": false })).await.expect("song");
        println!(
            "now: warp={} transpose={}",
            song["regions"][0]["warpEnabled"], song["regions"][0]["transposeSemitones"]
        );
        return;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    while songs.try_recv().is_ok() {}

    let mut warp = Vec::new();
    let mut key = Vec::new();
    for round in 0..rounds {
        let enabled = round % 2 == 0;
        warp.push(
            edit(
                &mut songs,
                invoke(
                    "update_song_region_warp",
                    json!({ "regionId": region_id, "warpEnabled": if enabled { !warp_was } else { warp_was }, "warpSourceBpm": source_bpm }),
                ),
            )
            .await,
        );
        let semitones = transpose_was + if round % 2 == 0 { 1 } else { 0 };
        key.push(
            edit(
                &mut songs,
                invoke(
                    "update_song_region_transpose",
                    json!({ "regionId": region_id, "transposeSemitones": semitones }),
                ),
            )
            .await,
        );
    }
    // As found. The key goes back with warp ON: with warp off a key change
    // also changes the song's length, and the host refuses it when that would
    // overlap the next song (it did, and the bench left the song at +1).
    restore(&handle, &region_id, warp_was, transpose_was, source_bpm).await;

    println!("\nfrom this guest (ms)       command  ->song   song KB");
    report("warp toggle", &warp);
    report("key change", &key);

    tokio::time::sleep(Duration::from_millis(500)).await;
    let perf = invoke("get_link_perf", json!({})).await.expect("perf");
    println!("\nhost feed ticks that rebuilt the song (ms, median / p95 of {}):", perf["feed"].as_array().map_or(0, Vec::len));
    for field in ["lockWait", "snapshot", "songBuild", "songCount", "compare"] {
        let values: Vec<f64> = perf["feed"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tick| tick[field].as_f64())
            .map(|micros| micros / 1000.0)
            .collect();
        println!("  {field:<10} {}", stats(&values));
    }
    println!("host commands (ms, median / p95):");
    let mut names: Vec<String> = perf["invokes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry[0].as_str().map(str::to_string))
        .collect();
    names.sort();
    names.dedup();
    for name in names {
        let values: Vec<f64> = perf["invokes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry[0] == name.as_str())
            .filter_map(|entry| entry[1].as_f64())
            .map(|micros| micros / 1000.0)
            .collect();
        println!("  {name:<32} {}", stats(&values));
    }
}

async fn restore(
    handle: &libretracks_link::GuestHandle,
    region_id: &str,
    warp: bool,
    transpose: i64,
    source_bpm: f64,
) {
    for (command, args) in [
        (
            "update_song_region_warp",
            json!({ "regionId": region_id, "warpEnabled": true, "warpSourceBpm": source_bpm }),
        ),
        (
            "update_song_region_transpose",
            json!({ "regionId": region_id, "transposeSemitones": transpose }),
        ),
        (
            "update_song_region_warp",
            json!({ "regionId": region_id, "warpEnabled": warp, "warpSourceBpm": source_bpm }),
        ),
    ] {
        let result = handle
            .send_command(
                LinkCommand::Invoke {
                    command: command.into(),
                    args,
                },
                None,
            )
            .await;
        if let Err(error) = result {
            println!("restore {command} failed: {error:?}");
        }
    }
}

/// Relayed app events as they arrive: when, which, bytes.
static EVENT_LOG: std::sync::Mutex<Vec<(Instant, String, usize)>> =
    std::sync::Mutex::new(Vec::new());

/// What reached this guest while a command was in flight, by event name.
fn events_between(from: Instant, to: Instant) -> String {
    let Ok(log) = EVENT_LOG.lock() else {
        return String::new();
    };
    let mut by_name: std::collections::BTreeMap<&str, (usize, usize)> = Default::default();
    for (at, name, bytes) in log.iter() {
        if *at >= from && *at <= to {
            let entry = by_name.entry(name.as_str()).or_default();
            entry.0 += 1;
            entry.1 += bytes;
        }
    }
    by_name
        .iter()
        .map(|(name, (count, bytes))| format!("{name}x{count}={}KB", bytes / 1024))
        .collect::<Vec<_>>()
        .join(" ")
}

/// One edit: the command's round trip, then the wait for the host's next
/// song view (the feed reads it within ~90 ms of the edit).
async fn edit(
    songs: &mut UnboundedReceiver<(Instant, usize)>,
    command: impl std::future::Future<Output = Result<Value, libretracks_link::CommandError>>,
) -> (f64, f64, usize) {
    while songs.try_recv().is_ok() {}
    let started = Instant::now();
    let result = command.await;
    let command_ms = started.elapsed().as_secs_f64() * 1000.0;
    if std::env::var("LINK_BENCH_EVENTS").is_ok() {
        println!("  {command_ms:6.1} ms  in flight: {}", events_between(started, Instant::now()));
    }
    if let Err(error) = result {
        println!("command failed: {error:?}");
    }
    let (song_ms, size) = match tokio::time::timeout(Duration::from_secs(5), songs.recv()).await {
        Ok(Some((at, size))) => ((at - started).as_secs_f64() * 1000.0, size),
        _ => (f64::NAN, 0),
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    (command_ms, song_ms, size)
}

fn report(label: &str, samples: &[(f64, f64, usize)]) {
    let command: Vec<f64> = samples.iter().map(|s| s.0).collect();
    let song: Vec<f64> = samples.iter().map(|s| s.1).filter(|v| v.is_finite()).collect();
    let kb = samples.iter().map(|s| s.2).max().unwrap_or(0) / 1024;
    println!("  {label:<12} {}  {}  {kb}", stats(&command), stats(&song));
}

fn stats(values: &[f64]) -> String {
    if values.is_empty() {
        return "     -".into();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    let p95 = sorted[((sorted.len() as f64 * 0.95) as usize).min(sorted.len() - 1)];
    format!("{median:6.1} / {p95:6.1}")
}
