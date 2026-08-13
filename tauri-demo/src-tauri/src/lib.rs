use serde::Serialize;

#[derive(Serialize)]
struct SystemInfo {
    os: String,
    arch: String,
    cpu_cores: usize,
    total_ram_gb: f64,
    host_name: String,
}

// 命令 1:打招呼 —— 前端传参,Rust 处理并返回
#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好,{name}! 👋 这句话由 Rust 在桌面端生成 🦀")
}

// 命令 2:系统信息 —— Rust 采集并序列化给前端
#[tauri::command]
fn system_info() -> SystemInfo {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_cores: sys.cpus().len(),
        total_ram_gb: sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0,
        host_name: System::host_name().unwrap_or_else(|| "unknown".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![greet, system_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
