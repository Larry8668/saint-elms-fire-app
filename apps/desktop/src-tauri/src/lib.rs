/// The shell is intentionally thin: all intelligence lives in the local engine (HTTP on 127.0.0.1:4100),
/// so the same UI runs in a browser, in Tauri, and later on mobile.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Saint Elms Fire");
}
