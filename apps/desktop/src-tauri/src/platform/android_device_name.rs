//! The device's own name for network sessions: the one the user sees and
//! edits in Settings > About ("Galaxy Tab S9 de Ana"), else maker and model
//! ("samsung SM-X710"). Plain JNI on system classes, like
//! `android_multicast`; no permission needed.

#![cfg(target_os = "android")]

use jni::{
    objects::{JObject, JString, JValue},
    JNIEnv, JavaVM,
};

pub fn device_name() -> Option<String> {
    match read() {
        Ok(name) => name,
        Err(error) => {
            eprintln!("[libretracks-link] device name: {error}");
            None
        }
    }
}

fn read() -> Result<Option<String>, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;
    if let Some(name) = settings_name(&mut env)? {
        return Ok(Some(name));
    }
    let maker = build_field(&mut env, "MANUFACTURER")?;
    let model = build_field(&mut env, "MODEL")?;
    let name = match (maker, model) {
        // Some makers already start the model with their name.
        (Some(maker), Some(model)) if model.to_lowercase().starts_with(&maker.to_lowercase()) => {
            model
        }
        (Some(maker), Some(model)) => format!("{maker} {model}"),
        (None, Some(model)) => model,
        (Some(maker), None) => maker,
        (None, None) => return Ok(None),
    };
    Ok(Some(name))
}

/// `Settings.Global.DEVICE_NAME` (Android 7.1+): the name from Settings.
fn settings_name(env: &mut JNIEnv) -> Result<Option<String>, String> {
    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let resolver = env
        .call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|e| format!("getContentResolver: {e}"))?;
    let key = env.new_string("device_name").map_err(|e| e.to_string())?;
    let value = env
        .call_static_method(
            "android/provider/Settings$Global",
            "getString",
            "(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&resolver), JValue::Object(&key)],
        )
        .and_then(|value| value.l());
    let value = match value {
        Ok(value) => value,
        // An old or odd ROM: fall back to maker and model.
        Err(_) => {
            let _ = env.exception_clear();
            return Ok(None);
        }
    };
    java_string(env, value)
}

fn build_field(env: &mut JNIEnv, field: &str) -> Result<Option<String>, String> {
    let value = env
        .get_static_field("android/os/Build", field, "Ljava/lang/String;")
        .and_then(|value| value.l())
        .map_err(|e| format!("Build.{field}: {e}"))?;
    java_string(env, value)
}

fn java_string(env: &mut JNIEnv, value: JObject) -> Result<Option<String>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let text: String = env
        .get_string(&JString::from(value))
        .map_err(|e| e.to_string())?
        .into();
    let text = text.trim().to_string();
    Ok((!text.is_empty()).then_some(text))
}
