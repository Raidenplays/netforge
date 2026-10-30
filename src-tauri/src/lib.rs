use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

#[derive(Serialize)]
struct Opened {
    /// "pkt" = decoded Packet Tracer XML, "text" = NetForge JSON
    kind: &'static str,
    content: String,
}

struct StartupFile(Mutex<Option<String>>);

fn is_pkt(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("pkt") | Some("pka")
    )
}

/// Read a .pkt/.pka (decoded to XML) or a .netforge project.
#[tauri::command]
fn open_file(path: String) -> Result<Opened, String> {
    let p = Path::new(&path);
    let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
    if is_pkt(p) {
        let xml = pktcodec::decode_to_string(&bytes).map_err(|e| e.to_string())?;
        Ok(Opened { kind: "pkt", content: xml })
    } else {
        let text = String::from_utf8(bytes).map_err(|_| "file is not UTF-8 text".to_string())?;
        Ok(Opened { kind: "text", content: text })
    }
}

/// Write either Packet Tracer XML (encoded to .pkt) or plain text.
#[tauri::command]
fn save_file(path: String, kind: String, content: String) -> Result<(), String> {
    let data = if kind == "pkt" { pktcodec::encode(content.as_bytes()) } else { content.into_bytes() };
    // write atomically so a crash never leaves a half-written lab
    let tmp = format!("{path}.netforge-tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// A file passed on the command line ("Open with NetForge").
#[tauri::command]
fn startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let arg = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).exists());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(StartupFile(Mutex::new(arg)))
        .invoke_handler(tauri::generate_handler![open_file, save_file, startup_file])
        .run(tauri::generate_context!())
        .expect("error while running NetForge");
}
