//! Keep the Wi-Fi radio awake while this device hosts or follows a network
//! session.
//!
//! Android's Wi-Fi power save lets the radio doze between beacons; the access
//! point holds what arrives meanwhile. Measured on the Samsung tablet
//! (2026-10-11): pinging it from the PC took 2-138 ms, mean 67-73 ms, while
//! the router answered in 1 ms. Every command a guest sent to the tablet, and
//! everything the tablet pushed, paid that on top. A `WifiLock` in
//! `WIFI_MODE_FULL_LOW_LATENCY` (Android 10+) turns power save off while the
//! app is in the foreground; older versions get `WIFI_MODE_FULL_HIGH_PERF`.
//!
//! Held only while hosting or joined (`link::keep_awake`): it costs battery.
//! Needs `WAKE_LOCK` (normal permission). Same plain-JNI approach as
//! `android_multicast`.

#![cfg(target_os = "android")]

use std::collections::BTreeSet;
use std::sync::Mutex;

use jni::{
    objects::{GlobalRef, JObject, JValue},
    JNIEnv, JavaVM,
};

struct State {
    reasons: BTreeSet<String>,
    lock: Option<GlobalRef>,
}

static STATE: Mutex<State> = Mutex::new(State {
    reasons: BTreeSet::new(),
    lock: None,
});

const WIFI_MODE_FULL_HIGH_PERF: i32 = 3;
const WIFI_MODE_FULL_LOW_LATENCY: i32 = 4;

fn vm() -> Result<JavaVM, String> {
    let ctx = ndk_context::android_context();
    unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM::from_raw: {e}"))
}

/// Ask for (`on`) or give up low Wi-Fi latency for `reason`; the lock is
/// held while any reason wants it. Failures are logged and ignored: the
/// session works, just with the radio's own latency.
pub fn set_low_latency(reason: &str, on: bool) {
    if let Err(error) = set(reason, on) {
        eprintln!("[libretracks-link] wifi low-latency lock: {error}");
    }
}

fn set(reason: &str, on: bool) -> Result<(), String> {
    let mut state = STATE.lock().map_err(|_| "lock poisoned".to_string())?;
    if on {
        state.reasons.insert(reason.to_string());
    } else {
        state.reasons.remove(reason);
    }
    let want = !state.reasons.is_empty();
    if want == state.lock.is_some() {
        return Ok(());
    }
    let vm = vm()?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;

    if !want {
        if let Some(lock) = state.lock.take() {
            env.call_method(lock.as_obj(), "release", "()V", &[])
                .map_err(|e| format!("release: {e}"))?;
        }
        return Ok(());
    }

    let lock = create_lock(&mut env)?;
    env.call_method(&lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)])
        .map_err(|e| format!("setReferenceCounted: {e}"))?;
    env.call_method(&lock, "acquire", "()V", &[])
        .map_err(|e| format!("acquire: {e}"))?;
    state.lock = Some(env.new_global_ref(&lock).map_err(|e| e.to_string())?);
    Ok(())
}

fn create_lock<'local>(env: &mut JNIEnv<'local>) -> Result<JObject<'local>, String> {
    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let app_context = env
        .call_method(
            &context,
            "getApplicationContext",
            "()Landroid/content/Context;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getApplicationContext: {e}"))?;
    let service = env.new_string("wifi").map_err(|e| e.to_string())?;
    let wifi = env
        .call_method(
            &app_context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service)],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getSystemService: {e}"))?;
    if wifi.is_null() {
        return Err("no WifiManager".into());
    }
    let sdk = env
        .get_static_field("android/os/Build$VERSION", "SDK_INT", "I")
        .and_then(|value| value.i())
        .map_err(|e| format!("SDK_INT: {e}"))?;
    let mode = if sdk >= 29 {
        WIFI_MODE_FULL_LOW_LATENCY
    } else {
        WIFI_MODE_FULL_HIGH_PERF
    };
    let tag = env
        .new_string("libretracks-link")
        .map_err(|e| e.to_string())?;
    env.call_method(
        &wifi,
        "createWifiLock",
        "(ILjava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;",
        &[JValue::Int(mode), JValue::Object(&tag)],
    )
    .and_then(|value| value.l())
    .map_err(|e| format!("createWifiLock: {e}"))
}
