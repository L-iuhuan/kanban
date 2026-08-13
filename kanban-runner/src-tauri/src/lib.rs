use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

/// 当前运行中的任务 pid
struct Running(Arc<Mutex<Option<u32>>>);

impl Default for Running {
    fn default() -> Self {
        Running(Arc::new(Mutex::new(None)))
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct AppConfig {
    #[serde(default)]
    share_path: String,
    #[serde(default = "default_true")]
    auto_sync: bool,
}
fn default_true() -> bool {
    true
}

#[derive(Serialize, Clone)]
struct SyncResult {
    ok: bool,
    changed: u32,
    added: u32,
    deleted: u32,
    version: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct Status {
    share_ok: bool,
    env_ok: bool,
    synced: bool,
    version: String,
    share_path: String,
    app_root: String,
    python: String,
}

#[derive(Serialize, Clone)]
struct LogLine {
    level: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct StageEvent {
    n: u32,
    total: u32,
    name: String,
}

#[derive(Serialize, Clone)]
struct DoneEvent {
    ok: bool,
    code: Option<i32>,
    duration_ms: u128,
    error: Option<String>,
}

fn app_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config_path() -> PathBuf {
    app_root().join("config.json")
}

fn load_config() -> AppConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(config_path(), json).map_err(|e| e.to_string())
}

fn venv_python() -> PathBuf {
    app_root().join(".venv").join("Scripts").join("python.exe")
}

fn emit_log(app: &AppHandle, level: &str, text: String) {
    let _ = app.emit(
        "pipeline-log",
        LogLine {
            level: level.into(),
            text,
        },
    );
}

// ── 配置 ──────────────────────────────────────────────
#[tauri::command]
async fn get_config() -> Result<AppConfig, String> {
    Ok(load_config())
}

#[tauri::command]
async fn save_config(cfg: AppConfig) -> Result<(), String> {
    save_config(&cfg)
}

// ── 状态 ──────────────────────────────────────────────
#[tauri::command]
async fn get_status() -> Result<Status, String> {
    let cfg = load_config();
    let share_root = Path::new(cfg.share_path.trim());
    let share_ok = !cfg.share_path.trim().is_empty() && share_root.join("code").exists();
    let env_ok = venv_python().exists();
    let code_dir = app_root().join("code");
    let synced = code_dir.join("run_chain.py").exists();
    let version = fs::read_to_string(code_dir.join("version.txt"))
        .unwrap_or_else(|_| "未同步".into())
        .trim()
        .to_string();
    Ok(Status {
        share_ok,
        env_ok,
        synced,
        version,
        share_path: cfg.share_path,
        app_root: app_root().display().to_string(),
        python: venv_python().display().to_string(),
    })
}

// ── 代码同步 ──────────────────────────────────────────
#[tauri::command]
async fn sync_code(app: AppHandle) -> Result<SyncResult, String> {
    let cfg = load_config();
    if cfg.share_path.trim().is_empty() {
        return Err("尚未配置共享盘路径,请打开设置填写".into());
    }
    let src = PathBuf::from(cfg.share_path.trim()).join("code");
    if !src.exists() {
        return Err(format!("共享盘代码目录不存在: {}", src.display()));
    }
    let dst = app_root().join("code");
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    emit_log(&app, "info", format!("开始同步代码: {}", src.display()));

    let out = Command::new("robocopy")
        .arg(&src)
        .arg(&dst)
        .args([
            "/MIR",
            "/XD",
            ".git",
            "output",
            "data",
            "__pycache__",
            ".venv",
            ".pytest_cache",
        ])
        .args(["/XF", "*.pyc", "*.log", "~$*"])
        .args(["/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP", "/MT:8"])
        .output()
        .map_err(|e| format!("无法执行 robocopy: {e}"))?;

    let code = out.status.code().unwrap_or(-1);
    let ok = (0..=7).contains(&code);
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let t = line.trim();
        if !t.is_empty() {
            emit_log(&app, if ok { "info" } else { "error" }, t.to_string());
        }
    }

    let version = fs::read_to_string(src.join("version.txt"))
        .unwrap_or_else(|_| "未知".into())
        .trim()
        .to_string();
    let message = if ok {
        format!("同步完成 (robocopy 退出码 {code})")
    } else {
        format!("同步失败 (robocopy 退出码 {code},≥8 为失败)")
    };
    let result = SyncResult {
        ok,
        changed: if code & 1 != 0 { 1 } else { 0 },
        added: 0,
        deleted: if code & 2 != 0 { 1 } else { 0 },
        version: version.clone(),
        message: message.clone(),
    };
    emit_log(&app, if ok { "ok" } else { "error" }, message);
    let _ = app.emit("sync-done", &result);
    Ok(result)
}

// ── 运行流水线 ────────────────────────────────────────
#[tauri::command]
async fn run_pipeline(
    app: AppHandle,
    state: State<'_, Running>,
    data_path: String,
    skip_processing: bool,
) -> Result<u32, String> {
    let python = venv_python();
    if !python.exists() {
        return Err("运行环境未就绪(缺少 .venv),请先执行环境安装".into());
    }
    let code_dir = app_root().join("code");
    if !code_dir.join("run_chain.py").exists() {
        return Err("本地还没有代码,请先同步".into());
    }
    if !skip_processing && data_path.trim().is_empty() {
        return Err("请先选择要处理的 Excel 文件,或勾选「跳过数据处理」".into());
    }
    {
        let g = state.0.lock().unwrap();
        if g.is_some() {
            return Err("已有任务在运行,请先停止".into());
        }
    }

    let mut cmd = Command::new(&python);
    cmd.current_dir(&code_dir).arg("run_chain.py");
    if !data_path.trim().is_empty() {
        cmd.arg("--data").arg(data_path.trim());
    }
    if skip_processing {
        cmd.arg("--skip-processing");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8");

    let mut child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
    let pid = child.id();
    emit_log(&app, "ok", format!("任务已启动 (PID {pid})"));

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(stage) = parse_stage(&line) {
                    let _ = app2.emit("pipeline-stage", &stage);
                }
                let _ = app2.emit(
                    "pipeline-log",
                    LogLine {
                        level: "info".into(),
                        text: line,
                    },
                );
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app2.emit(
                    "pipeline-log",
                    LogLine {
                        level: "error".into(),
                        text: line,
                    },
                );
            }
        });
    }

    *state.0.lock().unwrap() = Some(pid);

    let app3 = app.clone();
    let running = state.0.clone();
    std::thread::spawn(move || {
        let start = Instant::now();
        let status = child.wait();
        let ok = status.as_ref().map(|s| s.success()).unwrap_or(false);
        let code = status.as_ref().and_then(|s| s.code());
        *running.lock().unwrap() = None;
        let _ = app3.emit(
            "pipeline-done",
            DoneEvent {
                ok,
                code,
                duration_ms: start.elapsed().as_millis(),
                error: None,
            },
        );
    });

    Ok(pid)
}

/// 解析 "[STAGE 2/5] 客户分析" 形式的阶段标记
fn parse_stage(line: &str) -> Option<StageEvent> {
    let s = line.trim();
    let rest = s.strip_prefix("[STAGE")?;
    let inner = rest.trim_start().trim_end_matches(']');
    let mut parts = inner.splitn(2, char::is_whitespace);
    let frac = parts.next()?;
    let (n, total) = frac.split_once('/')?;
    Some(StageEvent {
        n: n.trim().parse().ok()?,
        total: total.trim().parse().ok()?,
        name: parts.next().unwrap_or("").trim().to_string(),
    })
}

// ── 停止 ──────────────────────────────────────────────
#[tauri::command]
async fn stop_pipeline(app: AppHandle, state: State<'_, Running>) -> Result<(), String> {
    let pid = { state.0.lock().unwrap().clone() };
    if let Some(pid) = pid {
        emit_log(&app, "warn", format!("正在停止任务 (PID {pid})..."));
        let out = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|e| e.to_string())?;
        emit_log(
            &app,
            if out.status.success() { "ok" } else { "warn" },
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        );
    } else {
        emit_log(&app, "warn", "没有正在运行的任务".into());
    }
    Ok(())
}

// ── 打开看板 / 产物 ───────────────────────────────────
#[tauri::command]
async fn open_dashboard() -> Result<String, String> {
    let dir = app_root().join("code").join("dashboard");
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("html") {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if latest
                .as_ref()
                .map(|(t, _)| mtime > *t)
                .unwrap_or(true)
            {
                latest = Some((mtime, p));
            }
        }
    }
    let path = latest
        .map(|(_, p)| p)
        .ok_or_else(|| "还没有生成看板,请先运行流水线".to_string())?;
    Command::new("cmd")
        .args(["/C", "start", "", path.to_str().unwrap_or("")])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
async fn open_folder(kind: String) -> Result<String, String> {
    let base = app_root().join("code").join("output");
    let dir = match kind.as_str() {
        "silver" | "gold" | "report" => base.join(&kind),
        "output" => base,
        _ => return Err("未知目录类型".into()),
    };
    if !dir.exists() {
        return Err(format!("目录尚不存在: {}", dir.display()));
    }
    Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

// ── 环境自举 ──────────────────────────────────────────
/// 检测系统 Python → 创建 .venv → 安装 requirements(全部流式日志)
#[tauri::command]
async fn setup_env(app: AppHandle) -> Result<bool, String> {
    let root = app_root();
    let venv = venv_python();
    let req = root.join("code").join("requirements.txt");
    if !req.exists() {
        return Err("代码尚未同步,没有 requirements.txt".into());
    }

    // 1. 找系统 Python
    let system_python = if venv.exists() {
        Some(venv.clone())
    } else {
        find_system_python()
    };
    let system_python = system_python.ok_or("未找到可用的 Python,请安装 Anaconda 或 Python 3.10+")?;
    emit_log(&app, "info", format!("使用 Python: {}", system_python.display()));

    // 2. 建 venv
    if !venv.exists() {
        emit_log(&app, "info", "创建虚拟环境 .venv ...".into());
        let out = Command::new(&system_python)
            .args(["-m", "venv", ".venv"])
            .current_dir(&root)
            .output()
            .map_err(|e| format!("创建 venv 失败: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "创建 venv 失败: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        emit_log(&app, "ok", "虚拟环境创建完成".into());
    }

    // 3. pip 安装(清华镜像,后台线程流式输出)
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&venv);
        cmd.args([
            "-m",
            "pip",
            "install",
            "-r",
            req.to_str().unwrap_or("requirements.txt"),
            "-i",
            "https://pypi.tuna.tsinghua.edu.cn/simple",
            "--disable-pip-version-check",
        ])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit_log(&app2, "error", format!("pip 启动失败: {e}"));
                let _ = app2.emit("setup-done", false);
                return;
            }
        };
        if let Some(stdout) = child.stdout.take() {
            let a = app2.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        emit_log(&a, "info", line);
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let a = app2.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        emit_log(&a, "warn", line);
                    }
                }
            });
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        emit_log(&app2, if ok { "ok" } else { "error" }, if ok { "依赖安装完成".into() } else { "依赖安装失败".into() });
        let _ = app2.emit("setup-done", ok);
    });

    Ok(true)
}

fn find_system_python() -> Option<PathBuf> {
    // 常见候选:环境变量 + py launcher + 常见安装位置
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("PYTHON_EXE") {
        candidates.push(PathBuf::from(p));
    }
    candidates.push(PathBuf::from("C:\Software\Anaconda3\python.exe"));
    candidates.push(PathBuf::from("C:\ProgramData\Anaconda3\python.exe"));
    candidates.push(PathBuf::from("C:\Python313\python.exe"));
    candidates.push(PathBuf::from("C:\Python312\python.exe"));
    candidates.push(PathBuf::from("C:\Python311\python.exe"));
    candidates.push(PathBuf::from("C:\Python310\python.exe"));
    if let Ok(home) = std::env::var("LOCALAPPDATA") {
        for ver in ["Python313", "Python312", "Python311", "Python310"] {
            candidates.push(PathBuf::from(&home).join("Programs").join("Python").join(ver).join("python.exe"));
        }
    }
    for c in candidates {
        if c.exists() {
            return Some(c);
        }
    }
    // PATH 里找 python / py -3
    for name in ["python", "python3", "py"] {
        if let Ok(out) = Command::new(name).arg("--version").output() {
            if out.status.success() {
                if let Ok(which) = Command::new("where").arg(name).output() {
                    let first = String::from_utf8_lossy(&which.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string());
                    if let Some(p) = first {
                        return Some(PathBuf::from(p));
                    }
                }
            }
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_status,
            sync_code,
            run_pipeline,
            stop_pipeline,
            open_dashboard,
            open_folder,
            setup_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
