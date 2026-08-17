// The whole desktop shell.
//
// Deliberately near-empty of behaviour: no commands, no updater. The window
// loads `dist/` out of the app bundle over Tauri's local protocol, and the
// React app inside it talks to https://thestreetsignal.rqai.co.uk exactly
// as the website does — see `apiUrl` in src/lib/api.ts for the one seam that
// makes that possible, and functions/_middleware.ts for the CORS answer.
//
// ONE plugin, opener, because the web genuinely cannot do this job: Tauri
// denies new-window requests, so every `target="_blank"` news link silently
// did nothing (owner 2026-08-17: "none is clickable"). The JS side hands
// external http(s) clicks to the OS browser — installExternalLinkOpener in
// src/lib/platform.ts; the capability grant is in capabilities/default.json.
//
// Adding anything else here means adding a native surface to audit, so
// don't, unless the web app genuinely cannot do the job.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
