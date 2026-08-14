// The whole desktop shell.
//
// Deliberately empty of behaviour: no commands, no plugins, no updater. The
// window loads `dist/` out of the app bundle over Tauri's local protocol, and
// the React app inside it talks to https://thestreetsignal.rqai.co.uk exactly
// as the website does — see `apiUrl` in src/lib/api.ts for the one seam that
// makes that possible, and functions/_middleware.ts for the CORS answer.
//
// Adding anything here means adding a native surface to audit, so don't,
// unless the web app genuinely cannot do the job.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
