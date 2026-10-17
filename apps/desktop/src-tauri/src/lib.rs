pub mod seat;

/// The shell is intentionally thin: all intelligence lives in the local engine (HTTP on 127.0.0.1:4100),
/// so the same UI runs in a browser, in Tauri, and later on mobile. The one exception is seat
/// provisioning (`seat`), which must hold the student's Instabox key outside the webview.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use seat::commands::*;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            seat_key_save,
            seat_key_present,
            seat_key_forget,
            seat_account,
            seat_list,
            seat_create,
            seat_operation,
            seat_machine,
            seat_power,
            seat_publish,
            seat_bootstrap_start,
            seat_bootstrap_status,
            seat_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Saint Elms Fire");
}
