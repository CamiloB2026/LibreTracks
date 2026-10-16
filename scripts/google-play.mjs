// Talks to the Google Play Developer API (androidpublisher v3) for the
// `build-android` job in .github/workflows/release.yml. Two commands:
//
//   node scripts/google-play.mjs check
//     Fails if the versionCode pinned in tauri.android.conf.json is not higher
//     than every bundle Play already has. Runs BEFORE the NDK build: Play
//     rejects a duplicate versionCode only at upload time, and the pin does not
//     follow the version string (see docs/RELEASE_PROCESS.md, step 4), so a
//     forgotten bump would otherwise cost the whole build to find out.
//
//   node scripts/google-play.mjs upload <file.aab> <track>
//     Uploads the bundle and assigns it to the track (internal, alpha, beta,
//     production) in one edit. Testing tracks roll out at once; production is
//     left as a DRAFT so sending it to review stays a decision made by hand in
//     Play Console, as with the App Store.
//
// Credentials come from PLAY_SERVICE_ACCOUNT_JSON (the whole key file of the
// github-play-upload service account, invited in Play Console with release
// permissions). No dependencies on purpose: the key never passes through a
// third-party action, and the OAuth exchange is a single signed JWT.

import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "com.libretracks.app";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}`;
const UPLOAD_API = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}`;
const TRACKS = ["internal", "alpha", "beta", "production"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const readServiceAccount = () => {
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) fail("PLAY_SERVICE_ACCOUNT_JSON is not set.");
  try {
    return JSON.parse(raw);
  } catch {
    fail("PLAY_SERVICE_ACCOUNT_JSON is not valid JSON; paste the whole key file, braces included.");
  }
};

const accessToken = async ({ client_email, private_key, token_uri }) => {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64url");
  const response = await fetch(token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
};

const client = (token) => async (method, url, { json, data, contentType } = {}) => {
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (data !== undefined) {
    headers["Content-Type"] = contentType;
    body = data;
  }
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    // A 403 right after inviting the service account is usually the
    // permission still propagating (it can take up to a day and a half).
    throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
};

const pinnedVersionCode = () => {
  const conf = JSON.parse(
    readFileSync(path.join(repoRoot, "apps/desktop/src-tauri/tauri.android.conf.json"), "utf8"),
  );
  const code = conf?.bundle?.android?.versionCode;
  if (!Number.isInteger(code)) fail("tauri.android.conf.json has no integer bundle.android.versionCode.");
  return code;
};

// Highest versionCode Play knows, from the uploaded bundles AND the tracks:
// a code stays taken after its release is superseded or halted.
const highestKnownVersionCode = async (call, editId) => {
  const bundles = await call("GET", `${API}/edits/${editId}/bundles`);
  const tracks = await call("GET", `${API}/edits/${editId}/tracks`);
  const codes = [
    ...(bundles.bundles ?? []).map((bundle) => Number(bundle.versionCode)),
    ...(tracks.tracks ?? []).flatMap((track) =>
      (track.releases ?? []).flatMap((release) => (release.versionCodes ?? []).map(Number)),
    ),
  ];
  return codes.length ? Math.max(...codes) : 0;
};

const check = async (call) => {
  const pinned = pinnedVersionCode();
  const edit = await call("POST", `${API}/edits`, { json: {} });
  try {
    const highest = await highestKnownVersionCode(call, edit.id);
    if (pinned <= highest) {
      throw new Error(
        `versionCode ${pinned} in tauri.android.conf.json is not above ${highest}, the highest Play already has. ` +
          "Bump bundle.android.versionCode (major*1000000 + minor*1000 + counter).",
      );
    }
    console.log(`versionCode ${pinned} is free (Play's highest is ${highest}).`);
  } finally {
    await call("DELETE", `${API}/edits/${edit.id}`);
  }
};

const upload = async (call, aabPath, track) => {
  if (!aabPath || !TRACKS.includes(track)) {
    fail(`usage: google-play.mjs upload <file.aab> <${TRACKS.join("|")}>`);
  }
  const sizeMb = (statSync(aabPath).size / 1024 / 1024).toFixed(1);
  const edit = await call("POST", `${API}/edits`, { json: {} });
  let committed = false;
  try {
    console.log(`Uploading ${path.basename(aabPath)} (${sizeMb} MB)...`);
    const bundle = await call("POST", `${UPLOAD_API}/edits/${edit.id}/bundles?uploadType=media`, {
      data: readFileSync(aabPath),
      contentType: "application/octet-stream",
    });
    const status = track === "production" ? "draft" : "completed";
    const versionName = JSON.parse(
      readFileSync(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    ).version;
    await call("PUT", `${API}/edits/${edit.id}/tracks/${track}`, {
      json: {
        track,
        releases: [{ name: versionName, versionCodes: [String(bundle.versionCode)], status }],
      },
    });
    await call("POST", `${API}/edits/${edit.id}:commit`);
    committed = true;
    console.log(`Committed versionCode ${bundle.versionCode} (${versionName}) to '${track}' as ${status}.`);
    if (status === "draft") {
      console.log("Production release is a draft: add the release notes and send it to review in Play Console.");
    }
  } finally {
    // An uncommitted edit would expire on its own, but delete it so a failed
    // run leaves the console exactly as it found it.
    if (!committed) await call("DELETE", `${API}/edits/${edit.id}`).catch(() => {});
  }
};

const [command, ...args] = process.argv.slice(2);
if (command !== "check" && command !== "upload") fail("usage: google-play.mjs check | upload <file.aab> <track>");
try {
  const call = client(await accessToken(readServiceAccount()));
  if (command === "check") await check(call);
  else await upload(call, ...args);
} catch (error) {
  fail(error.message);
}
