//! What a device remembers about network sessions, in its own file next to
//! the settings. NOT inside `AppSettings`: the settings are published to the
//! remote's browser clients, and PINs or trusted-device hashes must not be.

use std::{collections::HashMap, fs, path::PathBuf};

use libretracks_link::TrustedDevice;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CONFIG_FILE_NAME: &str = "network-session.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkSessionConfig {
    /// Stable id of this install, as host (`hostId`) and as guest
    /// (`deviceId`). Generated once.
    pub device_id: String,
    /// What other devices see. Empty = the machine name.
    pub device_name: String,
    /// Empty = that role cannot be requested.
    pub control_pin: String,
    pub edit_pin: String,
    pub keep_hosting_after_restart: bool,
    /// Whether this device was hosting when it last stopped. Only used with
    /// `keep_hosting_after_restart`.
    pub was_hosting: bool,
    /// Host side: devices that may rejoin without a PIN.
    pub trusted: Vec<TrustedDevice>,
    /// Guest side: token per host id, from a `welcome` with remember.
    pub host_tokens: HashMap<String, String>,
    /// Guest side: which host id answered at each `host:port`, so the token
    /// can be sent before the host has said who it is.
    pub host_ids_by_address: HashMap<String, String>,
}

impl NetworkSessionConfig {
    /// Fill what a fresh or older file lacks.
    pub fn normalized(mut self, new_id: impl FnOnce() -> String, machine_name: &str) -> Self {
        if self.device_id.trim().is_empty() {
            self.device_id = new_id();
        }
        // Also the placeholders older versions saved on phones and tablets,
        // and iOS's generic "iPhone"/"iPad": the device's real name replaces
        // them (and, on iOS, the user's own name once the app holds Apple's
        // user-assigned-device-name entitlement). A name typed by the user is
        // kept.
        let current = self.device_name.trim();
        if current.is_empty()
            || (GENERIC_NAMES.contains(&current) && current != machine_name.trim())
        {
            self.device_name = machine_name.to_string();
        }
        self
    }

    pub fn pin(value: &str) -> Option<String> {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    }
}

/// Names that only say what kind of device this is.
const GENERIC_NAMES: [&str; 4] = ["Android", "iPhone / iPad", "iPhone", "iPad"];

pub fn machine_name() -> String {
    #[cfg(target_os = "android")]
    if let Some(name) = crate::platform::android_device_name::device_name() {
        return name;
    }
    #[cfg(target_os = "ios")]
    if let Some(name) = crate::platform::ios_link::device_name() {
        return name;
    }
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let name = raw.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    if cfg!(target_os = "ios") {
        "iPhone / iPad".into()
    } else if cfg!(target_os = "android") {
        "Android".into()
    } else {
        "LibreTracks".into()
    }
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(CONFIG_FILE_NAME))
}

pub fn load(app: &AppHandle) -> NetworkSessionConfig {
    let stored = config_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<NetworkSessionConfig>(&text).ok())
        .unwrap_or_default();
    let normalized = stored
        .clone()
        .normalized(|| libretracks_link::random_hex(16), &machine_name());
    if normalized != stored {
        save(app, &normalized);
    }
    normalized
}

pub fn save(app: &AppHandle, config: &NetworkSessionConfig) {
    let Some(path) = config_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(config) {
        if let Err(error) = fs::write(&path, text) {
            eprintln!(
                "[libretracks-link] could not save {}: {error}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_config_gets_an_id_and_the_machine_name() {
        let config = NetworkSessionConfig::default().normalized(|| "id-1".into(), "PC-ESTUDIO");
        assert_eq!(config.device_id, "id-1");
        assert_eq!(config.device_name, "PC-ESTUDIO");
    }

    #[test]
    fn existing_id_and_name_are_kept() {
        let config = NetworkSessionConfig {
            device_id: "keep".into(),
            device_name: "iPad de Ana".into(),
            ..Default::default()
        }
        .normalized(|| unreachable!(), "PC");
        assert_eq!(config.device_id, "keep");
        assert_eq!(config.device_name, "iPad de Ana");
    }

    #[test]
    fn a_generic_name_gives_way_to_the_real_one() {
        let named = |name: &str| NetworkSessionConfig {
            device_id: "keep".into(),
            device_name: name.into(),
            ..Default::default()
        };
        // What older versions saved on a tablet.
        assert_eq!(
            named("Android")
                .normalized(|| unreachable!(), "Galaxy Tab S9")
                .device_name,
            "Galaxy Tab S9"
        );
        assert_eq!(
            named("iPhone / iPad")
                .normalized(|| unreachable!(), "iPhone")
                .device_name,
            "iPhone"
        );
        // iOS's generic name, once the real one is available.
        assert_eq!(
            named("iPhone")
                .normalized(|| unreachable!(), "iPhone de Ana")
                .device_name,
            "iPhone de Ana"
        );
        // Typed by the user: kept.
        assert_eq!(
            named("iPhone-Oto")
                .normalized(|| unreachable!(), "iPhone")
                .device_name,
            "iPhone-Oto"
        );
    }

    #[test]
    fn older_file_without_new_fields_parses() {
        let config: NetworkSessionConfig = serde_json::from_str(r#"{ "deviceId": "x" }"#).unwrap();
        assert_eq!(config.device_id, "x");
        assert!(config.trusted.is_empty());
        assert!(config.host_tokens.is_empty());
    }

    #[test]
    fn blank_pin_disables_the_role() {
        assert_eq!(NetworkSessionConfig::pin("  "), None);
        assert_eq!(NetworkSessionConfig::pin(" 12 "), Some("12".into()));
    }
}
