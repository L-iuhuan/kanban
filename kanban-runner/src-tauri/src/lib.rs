use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

/// 当前运行中的任务 pid
struct Running(Arc<Mutex<Option<u32>>>);

impl Default for Running {
    fn default() -> Self {
        Running(Arc::new(Mutex::new(None)))
    }
}

/// 用户主动停止标记：wait 线程据此区分「正常结束 / 失败 / 被用户停止」
struct Cancelled(Arc<AtomicBool>);

impl Default for Cancelled {
    fn default() -> Self {
        Cancelled(Arc::new(AtomicBool::new(false)))
    }
}

/// 预置共享盘路径：部署前改为实际 UNC 路径；config.json 仅用于覆盖
const DEFAULT_SHARE_PATH: &str = r"\\192.168.8.3\财务部\办公软件\SoftwareUpdate\数据分析看板";

/// 预置数据共享目录：财务投放 Excel 的位置（r14：与代码共享目录相互独立，用户拍板 2026-08-27）。
/// config.json 的 data_share_path 可覆盖；与流水线 run_chain.py/ingest_snapshot.py 的
/// DIR_DATA_SHARE 三处同源，变更时必须同步修改。
const DEFAULT_DATA_SHARE_PATH: &str = r"\\192.168.8.3\财务部\财务电子档案备份\D1经营分析";

#[derive(Serialize, Deserialize, Clone, Default)]
struct AppConfig {
    #[serde(default)]
    share_path: String,
    /// 数据文件共享目录(财务投放 Excel 的位置;与代码共享目录相互独立)。
    /// 留空 = 内置默认 DEFAULT_DATA_SHARE_PATH。
    #[serde(default)]
    data_share_path: String,
    #[serde(default = "default_true")]
    auto_sync: bool,
}
fn default_true() -> bool {
    true
}

#[derive(Serialize, Clone)]
struct SyncResult {
    ok: bool,
    version: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct ShareDataFile {
    name: String,
    size_mb: f64,
    /// 修改时间(本地展示用,格式 YYYY-MM-DD HH:MM)
    modified: String,
}

#[derive(Serialize, Clone)]
struct Status {
    /// 共享盘 code 目录存在(可同步)
    share_ok: bool,
    /// 共享盘本身可达(但可能还没有代码)
    share_reachable: bool,
    env_ok: bool,
    synced: bool,
    version: String,
    share_path: String,
    app_root: String,
    python: String,
    /// 共享盘 app/app-version.txt 中有更新版本的运行器(壳子更新提示)
    update_available: Option<String>,
    /// 当前运行器自身版本(编译期来自 Cargo.toml)
    app_version: String,
    /// 共享盘 code/version.txt 的内容(检测运行期间开发者是否推送了新代码)
    remote_version: Option<String>,
    /// 本地已有看板产物(dashboard/*.html):重启应用后也可直接打开历史看板
    has_dashboard: bool,
    /// 本地已有中间产物目录(output/):同上,重启后可直接打开
    has_output: bool,
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
    /// 本次运行的进程 pid:前端据此丢弃「停止后旧任务迟到的 done」,避免与新任务串台
    pid: u32,
}

#[derive(Serialize, Clone)]
struct HealthResult {
    ok: bool,
    python: String,
    message: String,
}

fn app_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 所有可写数据（config.json / .venv / code / 产物）的统一根目录：%LOCALAPPDATA%\KanbanRunner
/// 避免安装到 Program Files 后非管理员写失败
fn data_root() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| app_root().to_path_buf());
    let dir = base.join("KanbanRunner");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 数据文件共享目录(财务投放 Excel 的位置):data_share_path 非空用独立配置,
/// 否则回退内置默认 DEFAULT_DATA_SHARE_PATH(r14:数据共享夹独立于代码共享夹)
fn data_share_dir(cfg: &AppConfig) -> PathBuf {
    let custom = cfg.data_share_path.trim();
    if custom.is_empty() {
        PathBuf::from(DEFAULT_DATA_SHARE_PATH)
    } else {
        PathBuf::from(custom)
    }
}

fn config_path() -> PathBuf {
    data_root().join("config.json")
}

fn load_config() -> AppConfig {
    fs::read_to_string(config_path())
        .ok()
        // 容错 BOM：用户用记事本/PS 手改 config.json 可能带 BOM 头，直接解析会失败
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .map(|mut c: AppConfig| {
            // config.json 仅用于覆盖：share_path 为空时仍用预置默认值（零配置目标）
            if c.share_path.trim().is_empty() {
                c.share_path = DEFAULT_SHARE_PATH.into();
            }
            c
        })
        // 文件缺失或解析失败：显式构造，保证 share_path 不为空串
        .unwrap_or(AppConfig {
            share_path: DEFAULT_SHARE_PATH.into(),
            data_share_path: String::new(),
            auto_sync: true,
        })
}

fn write_config(cfg: &AppConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(config_path(), json).map_err(|e| e.to_string())
}

/// 运行环境 Python:优先用随代码同步下来的便携版(data_root\python\python.exe,
/// 免安装分发核心);不存在才回落 .venv\Scripts\python.exe(系统 Python→venv 安装模式)。
/// get_status 的 env_ok 判定、run_pipeline/check_deps 等均走本函数,自动随此生效。
fn venv_python() -> PathBuf {
    let portable = data_root().join("python").join("python.exe");
    if portable.exists() {
        portable
    } else {
        data_root().join(".venv").join("Scripts").join("python.exe")
    }
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

/// Windows 下禁止子进程弹出控制台窗口 (CREATE_NO_WINDOW = 0x08000000)
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

// ── 配置 ──────────────────────────────────────────────
#[tauri::command]
async fn get_config() -> Result<AppConfig, String> {
    Ok(load_config())
}

#[tauri::command]
async fn save_config(cfg: AppConfig) -> Result<(), String> {
    write_config(&cfg)
}

// ── 状态 ──────────────────────────────────────────────
#[tauri::command]
async fn get_status() -> Result<Status, String> {
    // 整个状态收集涉及 SMB/UNC 同步 IO(共享盘不可达时单次超时可达数十秒),
    // 放 blocking 线程执行,避免占住 async worker(前端每 2 分钟巡检会反复调用)
    tauri::async_runtime::spawn_blocking(compute_status)
        .await
        .map_err(|e| format!("状态检查任务异常: {e}"))
}

fn compute_status() -> Status {
    let cfg = load_config();
    let share_root = Path::new(cfg.share_path.trim());
    let share_reachable = !cfg.share_path.trim().is_empty() && share_root.exists();
    let share_ok = share_reachable && share_root.join("code").exists();
    let env_ok = venv_python().exists();
    let code_dir = data_root().join("code");
    let synced = code_dir.join("run_chain.py").exists();
    let version = fs::read_to_string(code_dir.join("version.txt"))
        .unwrap_or_else(|_| "未同步".into())
        .trim()
        .to_string();
    // 共享盘不可达时跳过更新检查,避免 UNC 读取触发 SMB 超时(可达数十秒)卡住启动
    let update_available = if share_reachable {
        check_app_update(cfg.share_path.trim())
    } else {
        None
    };
    // 共享盘上代码的版本(检测运行期间开发者是否推送了新代码)
    let remote_version = if share_ok {
        fs::read_to_string(share_root.join("code").join("version.txt"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    // 本地产物存在性(重启应用后允许直接打开历史看板/中间产物)
    let has_dashboard = code_dir
        .join("dashboard")
        .read_dir()
        .map(|rd| {
            rd.filter_map(|e| e.ok()).any(|e| {
                e.path().extension().and_then(|x| x.to_str()) == Some("html")
            })
        })
        .unwrap_or(false);
    let has_output = code_dir.join("output").exists();
    Status {
        share_ok,
        share_reachable,
        env_ok,
        synced,
        version,
        share_path: cfg.share_path,
        // 字段名保留（前端兼容），值改为数据根目录
        app_root: data_root().display().to_string(),
        python: venv_python().display().to_string(),
        update_available,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        remote_version,
        has_dashboard,
        has_output,
    }
}

/// 检查共享盘 app/app-version.txt 是否有更新版本的运行器(壳子更新通道)
fn check_app_update(share_path: &str) -> Option<String> {
    if share_path.is_empty() {
        return None;
    }
    let p = Path::new(share_path).join("app").join("app-version.txt");
    let remote = fs::read_to_string(p).ok()?.trim().to_string();
    if remote.is_empty() {
        return None;
    }
    let current = env!("CARGO_PKG_VERSION");
    if version_newer(&remote, current) {
        Some(remote)
    } else {
        None
    }
}

/// 朴素 semver 比较:remote 是否比 current 新(按 . 分段数值比较,允许 v 前缀)
fn version_newer(remote: &str, current: &str) -> bool {
    fn parts(s: &str) -> Vec<u32> {
        s.trim_start_matches('v').trim_start_matches('V')
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    }
    let r = parts(remote);
    let c = parts(current);
    for i in 0..r.len().max(c.len()) {
        let rv = r.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if rv != cv {
            return rv > cv;
        }
    }
    false
}

// ── 共享盘数据拉取 ────────────────────────────────────
// 财务每月往共享盘 <share>\data\ 投放「财务分析-X月.xlsx」(约 224MB,DSE 密文)。
// 拉到本地 data_root\data\ 后由现有流水线 COM 自动解密;两个命令的 SMB/UNC
// 同步 IO 都放 spawn_blocking,避免占住 async worker(共享盘不可达时单次超时可达数十秒)。

// 标准库不提供 SystemTime → 本地时区的转换,Windows 下直接调 kernel32 的
// FileTimeToLocalFileTime + FileTimeToSystemTime(纯系统调用,不新增依赖);
// 非 Windows 编译时回落 UTC 转换(仅保证可移植编译,部署只面向 Windows)。
#[cfg(windows)]
mod local_time {
    #[repr(C)]
    struct FileTime {
        dw_low: u32,
        dw_high: u32,
    }
    #[repr(C)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn FileTimeToLocalFileTime(
            lp_file_time: *const FileTime,
            lp_local_file_time: *mut FileTime,
        ) -> i32;
        fn FileTimeToSystemTime(lp_file_time: *const FileTime, lp_system_time: *mut SystemTime) -> i32;
    }
    /// UNIX 秒 → 本地 (年,月,日,时,分);失败(极少,DST 转换异常等)返回 None
    pub fn local_civil(secs: i64) -> Option<(u32, u32, u32, u32, u32)> {
        // UNIX 秒 → FILETIME(1601-01-01 起 100 纳秒,64 位无符号);用 i128 中间量防溢出
        let ft100ns: i128 = (secs as i128 + 11_644_473_600) * 10_000_000;
        if ft100ns < 0 {
            return None;
        }
        let ft = FileTime {
            dw_low: (ft100ns as u64 & 0xFFFF_FFFF) as u32,
            dw_high: ((ft100ns as u64 >> 32) & 0xFFFF_FFFF) as u32,
        };
        let mut local = FileTime { dw_low: 0, dw_high: 0 };
        let mut st = SystemTime {
            year: 0,
            month: 0,
            day_of_week: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            milliseconds: 0,
        };
        // 两个 API 均返回 BOOL,非 0 表示成功
        let ok = unsafe {
            FileTimeToLocalFileTime(&ft, &mut local) != 0 && FileTimeToSystemTime(&local, &mut st) != 0
        };
        if !ok {
            return None;
        }
        Some((
            st.year as u32,
            st.month as u32,
            st.day as u32,
            st.hour as u32,
            st.minute as u32,
        ))
    }
}

/// 无系统 API 时回落的 UTC 转换(非 Windows 编译路径);Howard Hinnant 的 days↔civil 算法
fn utc_civil(secs: i64) -> (u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400); // [0, 86399]
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32)
}

/// 把 mtime 格式化为 "YYYY-MM-DD HH:MM"(本地时区,展示用)
fn format_mtime(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    #[cfg(windows)]
    let (y, mo, d, h, mi) = local_time::local_civil(secs).unwrap_or_else(|| utc_civil(secs));
    #[cfg(not(windows))]
    let (y, mo, d, h, mi) = utc_civil(secs);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}")
}

/// 列出共享盘 data\ 目录下的 Excel 数据文件,按修改时间倒序(最新在前)。
/// 目录不存在或不可达 → 财务可能还没投放,返回空列表而非错误。
#[tauri::command]
async fn list_share_data() -> Result<Vec<ShareDataFile>, String> {
    let cfg = load_config();
    let data_dir = data_share_dir(&cfg);
    tauri::async_runtime::spawn_blocking(move || {
        if !data_dir.exists() {
            return Ok(Vec::new());
        }
        let mut files: Vec<(std::time::SystemTime, ShareDataFile)> = Vec::new();
        for entry in fs::read_dir(&data_dir).map_err(|e| format!("读取共享盘 data 目录失败: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            // 只收 .xlsx,排除 Excel 的 ~$ 开头临时文件
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) if n.ends_with(".xlsx") && !n.starts_with("~$") => n.to_string(),
                _ => continue,
            };
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let size_mb = meta.len() as f64 / (1024.0 * 1024.0);
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            let modified = format_mtime(mtime);
            files.push((mtime, ShareDataFile { name, size_mb, modified }));
        }
        // 按真实修改时间倒序排序(字符串时间仅作展示,不参与排序)
        files.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(files.into_iter().map(|(_, f)| f).collect())
    })
    .await
    .map_err(|e| format!("扫描共享盘数据目录任务异常: {e}"))?
}

/// 把共享盘 data\ 下指定 Excel 拉到本地缓存 data_root\data\,返回本地路径。
/// 文件名安全校验防路径穿越;224MB 复制耗时数秒到几十秒,放 blocking 线程。
#[tauri::command]
async fn pull_share_data(app: AppHandle, filename: String) -> Result<String, String> {
    // 安全校验:只允许纯文件名,含路径分隔符或 .. 一律拒绝(防路径穿越)
    if filename.is_empty()
        || filename.contains('\\')
        || filename.contains('/')
        || filename.contains("..")
    {
        return Err("非法的文件名".into());
    }
    let cfg = load_config();
    let src = data_share_dir(&cfg).join(&filename);
    if !src.exists() {
        return Err(format!("共享盘上不存在数据文件: {filename}"));
    }
    let dst_dir = data_root().join("data");
    fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    let dst = dst_dir.join(&filename);
    // 本地已有同名缓存时先提示「覆盖」(仅日志,不阻断复制)
    if dst.exists() {
        emit_log(&app, "warn", format!("本地已有同名缓存,将覆盖本地缓存: {filename}"));
    }
    let size_mb = src
        .metadata()
        .map(|m| m.len() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);
    emit_log(&app, "info", format!("开始拉取数据文件: {filename} ({size_mb:.1} MB)"));

    let started = Instant::now();
    let src_c = src.clone();
    let dst_c = dst.clone();
    let copied = tauri::async_runtime::spawn_blocking(move || fs::copy(&src_c, &dst_c))
        .await
        .map_err(|e| format!("拉取数据文件任务异常: {e}"))?;
    match copied {
        Ok(_) => {
            let secs = started.elapsed().as_secs_f64();
            emit_log(&app, "ok", format!("数据文件拉取完成(耗时 {secs:.1} 秒): {filename}"));
            Ok(dst.display().to_string())
        }
        Err(e) => {
            // 目标文件被 Excel 等独占占用时,复制会报共享冲突(32)/拒绝访问(5)
            let occupied = e.kind() == std::io::ErrorKind::PermissionDenied
                || e.raw_os_error() == Some(32)
                || e.raw_os_error() == Some(5);
            if occupied {
                return Err("本地缓存文件被占用(可能正在 Excel 中打开),请关闭后重试".into());
            }
            Err(format!("拉取数据文件失败: {e}"))
        }
    }
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
    let dst = data_root().join("code");
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    emit_log(&app, "info", format!("开始同步代码: {}", src.display()));

    // robocopy 可能耗时较长，放进 blocking 线程，避免阻塞 async worker
    let src_c = src.clone();
    let dst_c = dst.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("robocopy");
        cmd.arg(&src_c)
            .arg(&dst_c)
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
            .args(["/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP", "/MT:8"]);
        no_window(&mut cmd);
        cmd.output()
    })
    .await
    .map_err(|e| format!("robocopy 任务异常: {e}"))?
    .map_err(|e| format!("无法执行 robocopy: {e}"))?;

    let code = out.status.code().unwrap_or(-1);
    let ok = (0..=7).contains(&code);

    // 便携 Python 运行环境同步:共享盘根 python\ 存在则同步到本地 data_root\python。
    // 首次约 600-800MB(1-2 分钟),之后 robocopy 增量秒级。失败不改变代码同步的 ok
    // 结果(日志提示回落本机安装模式,由 setup_env 回落路径兜底)。
    let share_root = Path::new(cfg.share_path.trim());
    if share_root.join("python").join("python.exe").exists() {
        emit_log(
            &app,
            "info",
            "检测到共享盘便携运行环境,首次同步约 600-800MB(1-2 分钟),之后增量秒级…".into(),
        );
        let py_src = share_root.join("python");
        let py_dst = data_root().join("python");
        fs::create_dir_all(&py_dst).map_err(|e| e.to_string())?;
        let py_src_c = py_src.clone();
        let py_dst_c = py_dst.clone();
        let py_out = tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = Command::new("robocopy");
            cmd.arg(&py_src_c)
                .arg(&py_dst_c)
                .args(["/MIR", "/XD", "__pycache__"])
                .args(["/XF", "*.pyc"])
                .args(["/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP", "/MT:8"]);
            no_window(&mut cmd);
            cmd.output()
        })
        .await
        .map_err(|e| format!("便携环境同步任务异常: {e}"))?
        .map_err(|e| format!("无法执行 robocopy(便携环境): {e}"))?;
        let py_code = py_out.status.code().unwrap_or(-1);
        if (0..=7).contains(&py_code) {
            emit_log(&app, "ok", "便携运行环境同步完成".into());
        } else {
            emit_log(&app, "warn", "便携环境同步失败,将回落本机安装模式".into());
        }
    }

    // 从本地读取版本号（离线时也能显示，不再依赖共享盘）
    let version = fs::read_to_string(dst.join("version.txt"))
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
    cancelled: State<'_, Cancelled>,
    data_path: String,
    skip_processing: bool,
) -> Result<u32, String> {
    let python = venv_python();
    if !python.exists() {
        return Err("运行环境未就绪(缺少 .venv),请先执行环境安装".into());
    }
    let code_dir = data_root().join("code");
    if !code_dir.join("run_chain.py").exists() {
        return Err("本地还没有代码,请先同步".into());
    }
    if !skip_processing && data_path.trim().is_empty() {
        return Err("请先选择要处理的 Excel 文件,或勾选「跳过数据处理」".into());
    }
    // 依赖健康检查（拿锁之前）
    check_deps(&python)?;
    // Excel 文件锁检查（拿锁之前）：以写方式打开失败说明正被占用
    if !skip_processing && !data_path.trim().is_empty() {
        if fs::OpenOptions::new().write(true).open(data_path.trim()).is_err() {
            return Err("数据文件被占用(可能正在 Excel 中打开),请关闭后重试".into());
        }
    }
    // 每次启动重置用户停止标记
    cancelled.0.store(false, Ordering::SeqCst);

    let mut child;
    let pid = {
        // 检查 + spawn + 写 pid 放进同一临界区，杜绝 TOCTOU 双启动
        let mut g = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_some() {
            return Err("已有任务在运行,请先停止".into());
        }
        // … 构造 cmd …
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
        no_window(&mut cmd);

        // spawn 失败时锁自然释放且不写入 pid
        child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
        let pid = child.id();
        *g = Some(pid);
        pid
    };
    emit_log(&app, "ok", format!("任务已启动 (PID {pid})"));

    // stdout / stderr 读取线程；保存 JoinHandle 供 wait 线程 join
    let h_out = match child.stdout.take() {
        Some(stdout) => {
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
            })
        }
        None => std::thread::spawn(|| {}),
    };
    let h_err = match child.stderr.take() {
        Some(stderr) => {
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
            })
        }
        None => std::thread::spawn(|| {}),
    };

    let app3 = app.clone();
    let running = state.0.clone();
    let cancelled = cancelled.0.clone();
    std::thread::spawn(move || {
        let start = Instant::now();
        let status = child.wait();
        // 等两个 reader 线程读完最后几行再 emit done，保证日志不乱序/不丢失
        let _ = h_out.join();
        let _ = h_err.join();
        let ok = status.as_ref().map(|s| s.success()).unwrap_or(false);
        let code = status.as_ref().ok().and_then(|s| s.code());
        // 仅在槽位仍是本进程时清空:stop 后立即重跑的场景下,槽位可能已被新任务占用,
        // 无条件清空会抹掉新任务的 pid(导致无法停止、可能双开)
        {
            let mut g = running.lock().unwrap_or_else(|e| e.into_inner());
            if *g == Some(pid) {
                *g = None;
            }
        }
        let stopped = cancelled.load(Ordering::SeqCst);
        if stopped {
            cancelled.store(false, Ordering::SeqCst);
        }
        let (ok, error) = if stopped {
            (false, Some("已被用户停止".into()))
        } else {
            (ok, None)
        };
        let _ = app3.emit(
            "pipeline-done",
            DoneEvent {
                ok,
                code,
                duration_ms: start.elapsed().as_millis(),
                error,
                pid,
            },
        );
    });

    Ok(pid)
}

/// 解析 "[STAGE 2/5] 客户分析" 形式的阶段标记(名称可省略:"[STAGE 2/5]")
fn parse_stage(line: &str) -> Option<StageEvent> {
    let s = line.trim();
    let rest = s.strip_prefix("[STAGE")?.trim_start();
    let end = rest.find(']')?;
    let frac = rest[..end].trim();
    let (n, total) = frac.split_once('/')?;
    Some(StageEvent {
        n: n.parse().ok()?,
        total: total.parse().ok()?,
        name: rest[end + 1..].trim().to_string(),
    })
}

/// 运行所需依赖清单:优先读共享盘代码里的 code/deps.txt(流水线侧声明,
/// 一行一个 import 名,# 开头为注释);文件不存在时回退到内置清单。
/// 空文件(或全是注释)= 跳过检查(纯标准库流水线/冒烟桩场景)。
fn required_deps() -> Vec<String> {
    let f = data_root().join("code").join("deps.txt");
    match fs::read_to_string(f) {
        Ok(s) => s
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(String::from)
            .collect(),
        Err(_) => [
            "pandas",
            "numpy",
            "sklearn",
            "statsmodels",
            "matplotlib",
            "rapidfuzz",
            "chinese_calendar",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    }
}

/// 运行环境依赖健康检查:一次性 import 所需依赖,缺任何一个即报错
fn check_deps(python: &Path) -> Result<(), String> {
    let deps = required_deps();
    if deps.is_empty() {
        return Ok(());
    }
    let mut cmd = Command::new(python);
    cmd.args(["-c", &format!("import {}", deps.join(","))]);
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("无法启动 Python: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let tail = String::from_utf8_lossy(&out.stderr)
            .lines()
            .last()
            .unwrap_or("")
            .to_string();
        Err(format!(
            "运行环境不完整(依赖缺失),请等待自动安装完成或重新执行环境安装。{tail}"
        ))
    }
}

// ── 停止 ──────────────────────────────────────────────
#[tauri::command]
async fn stop_pipeline(
    app: AppHandle,
    state: State<'_, Running>,
    cancelled: State<'_, Cancelled>,
) -> Result<(), String> {
    let pid = { state.0.lock().unwrap_or_else(|e| e.into_inner()).clone() };
    if let Some(pid) = pid {
        emit_log(&app, "warn", format!("正在停止任务 (PID {pid})..."));
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        no_window(&mut cmd);
        let out = cmd.output().map_err(|e| e.to_string())?;
        // taskkill 输出是 GBK 编码,不再透传;只按退出状态报自有中文信息
        emit_log(
            &app,
            if out.status.success() { "ok" } else { "warn" },
            if out.status.success() {
                format!("已停止任务 (PID {pid})")
            } else {
                "停止指令发送失败,任务可能已自行退出".into()
            },
        );
        // taskkill 后立即清状态 + 标记用户停止，避免 wait 线程卡住导致永远无法再运行
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
        cancelled.0.store(true, Ordering::SeqCst);
    } else {
        emit_log(&app, "warn", "没有正在运行的任务".into());
    }
    Ok(())
}

// ── 打开看板 / 产物 ───────────────────────────────────
#[tauri::command]
async fn open_dashboard() -> Result<String, String> {
    let dir = data_root().join("code").join("dashboard");
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
    // 直接用 explorer + PathBuf，避免非 UTF-8 路径在 cmd /C start 下打开空路径
    let mut cmd = Command::new("explorer");
    cmd.arg(&path);
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_folder(kind: String) -> Result<String, String> {
    let base = data_root().join("code").join("output");
    let dir = match kind.as_str() {
        "silver" | "gold" | "report" => base.join(&kind),
        "output" => base,
        _ => return Err("未知目录类型".into()),
    };
    if !dir.exists() {
        return Err(format!("目录尚不存在: {}", dir.display()));
    }
    let mut cmd = Command::new("explorer");
    cmd.arg(&dir);
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

// ── 环境自举 ──────────────────────────────────────────
/// 检测系统 Python → 创建 .venv → 安装 requirements(全部流式日志)
/// 文件级并发守卫：同一时刻只允许一个环境安装流程
static SETUP_ACTIVE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
async fn setup_env(app: AppHandle) -> Result<bool, String> {
    if SETUP_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("环境安装正在进行中,请稍候".into());
    }
    let root = data_root();
    // 便携 Python 短路:运行环境已随代码同步(data_root\python\python.exe 存在),
    // 无需任何安装动作,直接完成。注意:短路条件必须是便携路径本身,不能用
    // venv_python()——否则 .venv 半残时会跳过 pip 补装的自愈路径。
    let portable = root.join("python").join("python.exe");
    if portable.exists() {
        SETUP_ACTIVE.store(false, Ordering::SeqCst);
        emit_log(&app, "info", "运行环境已随代码同步(便携 Python),无需安装".into());
        let _ = app.emit("setup-done", true);
        return Ok(true);
    }
    let venv = venv_python();
    let req = root.join("code").join("requirements.txt");
    if !req.exists() {
        SETUP_ACTIVE.store(false, Ordering::SeqCst);
        return Err("代码尚未同步,没有 requirements.txt".into());
    }

    // 1. 找系统 Python
    // 阶段进度事件(独立事件名 setup-stage,避免和流水线的 pipeline-stage 串台)
    let _ = app.emit(
        "setup-stage",
        &StageEvent {
            n: 1,
            total: 3,
            name: "检测系统 Python".into(),
        },
    );
    let system_python = if venv.exists() {
        Some(venv.clone())
    } else {
        find_system_python()
    };
    let system_python = match system_python {
        Some(p) => p,
        None => {
            SETUP_ACTIVE.store(false, Ordering::SeqCst);
            return Err("未找到可用的 Python,请安装 Anaconda 或 Python 3.10+".into());
        }
    };
    emit_log(&app, "info", format!("使用 Python: {}", system_python.display()));

    // 2. 建 venv（可能耗时 10-30 秒，放 blocking 线程）
    let _ = app.emit(
        "setup-stage",
        &StageEvent {
            n: 2,
            total: 3,
            name: "创建虚拟环境(约 10-30 秒)".into(),
        },
    );
    if !venv.exists() {
        emit_log(&app, "info", "创建虚拟环境 .venv ...".into());
        let sys = system_python.clone();
        let vroot = root.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = Command::new(&sys);
            cmd.args(["-m", "venv", ".venv"]).current_dir(&vroot);
            no_window(&mut cmd);
            cmd.output()
        })
        .await;
        // 失败路径必须复位并发守卫,否则后续 setup_env 永远报「正在进行中」,只能重启应用
        let out = match out {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                SETUP_ACTIVE.store(false, Ordering::SeqCst);
                return Err(format!("创建 venv 失败: {e}"));
            }
            Err(e) => {
                SETUP_ACTIVE.store(false, Ordering::SeqCst);
                return Err(format!("创建 venv 任务异常: {e}"));
            }
        };
        if !out.status.success() {
            SETUP_ACTIVE.store(false, Ordering::SeqCst);
            return Err(format!(
                "创建 venv 失败: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        emit_log(&app, "ok", "虚拟环境创建完成".into());
    }

    // 3. pip 安装(清华镜像,后台线程流式输出)
    let _ = app.emit(
        "setup-stage",
        &StageEvent {
            n: 3,
            total: 3,
            name: "安装依赖包(首次约 1-3 分钟,取决于网络)".into(),
        },
    );
    let app2 = app.clone();
    let req2 = req.clone();
    let root2 = root.clone();
    let venv2 = venv.clone();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&venv2);
        cmd.args([
            "-m",
            "pip",
            "install",
            "-r",
            req2.to_str().unwrap_or("requirements.txt"),
            "-i",
            "https://pypi.tuna.tsinghua.edu.cn/simple",
            "--disable-pip-version-check",
        ])
        .current_dir(&root2)
        // 中文版 Windows 上 pip 默认按 GBK 读 requirements.txt,UTF-8 文件会炸(UnicodeDecodeError)
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        no_window(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                SETUP_ACTIVE.store(false, Ordering::SeqCst);
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
        // pip 后台线程结束：重置并发守卫
        SETUP_ACTIVE.store(false, Ordering::SeqCst);
        emit_log(
            &app2,
            if ok { "ok" } else { "error" },
            if ok { "依赖安装完成".into() } else { "依赖安装失败".into() },
        );
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
    candidates.push(PathBuf::from(r"C:\Software\Anaconda3\python.exe"));
    candidates.push(PathBuf::from(r"C:\ProgramData\Anaconda3\python.exe"));
    candidates.push(PathBuf::from(r"C:\Python313\python.exe"));
    candidates.push(PathBuf::from(r"C:\Python312\python.exe"));
    candidates.push(PathBuf::from(r"C:\Python311\python.exe"));
    candidates.push(PathBuf::from(r"C:\Python310\python.exe"));
    if let Ok(home) = std::env::var("LOCALAPPDATA") {
        for ver in ["Python313", "Python312", "Python311", "Python310"] {
            candidates.push(
                PathBuf::from(&home)
                    .join("Programs")
                    .join("Python")
                    .join(ver)
                    .join("python.exe"),
            );
        }
    }
    // 逐个候选做版本检查，避免选中 Anaconda 自带的老版本 Python
    for c in candidates {
        if c.exists() && python_ok(&c) {
            return Some(c);
        }
    }
    // PATH 里找 python / python3 / py（同样校验版本）
    for name in ["python", "python3", "py"] {
        let mut vcmd = Command::new(name);
        vcmd.arg("--version");
        no_window(&mut vcmd);
        if let Ok(out) = vcmd.output() {
            if out.status.success() {
                let text = if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
                    String::from_utf8_lossy(&out.stderr).into_owned()
                } else {
                    String::from_utf8_lossy(&out.stdout).into_owned()
                };
                if !parse_python_version(&text)
                    .map(|(major, minor)| major > 3 || (major == 3 && minor >= 10))
                    .unwrap_or(false)
                {
                    continue;
                }
                let mut wcmd = Command::new("where");
                wcmd.arg(name);
                no_window(&mut wcmd);
                if let Ok(which) = wcmd.output() {
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

/// 检查候选 python 的版本是否 >= 3.10
fn python_ok(python: &Path) -> bool {
    let mut cmd = Command::new(python);
    cmd.arg("--version");
    no_window(&mut cmd);
    cmd.output()
        .ok()
        .and_then(|out| {
            let text = if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
                String::from_utf8_lossy(&out.stderr).into_owned()
            } else {
                String::from_utf8_lossy(&out.stdout).into_owned()
            };
            parse_python_version(&text).map(|(major, minor)| major > 3 || (major == 3 && minor >= 10))
        })
        .unwrap_or(false)
}

/// 解析 "Python 3.x.y" 输出，返回 (major, minor)
fn parse_python_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim().strip_prefix("Python")?;
    let mut parts = rest.trim().split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next()?.trim().parse().ok()?;
    Some((major, minor))
}

// ── 健康检查 ──────────────────────────────────────────
#[tauri::command]
async fn health_check() -> Result<HealthResult, String> {
    let python = venv_python();
    if !python.exists() {
        return Ok(HealthResult {
            ok: false,
            python: python.display().to_string(),
            message: "运行环境未安装".into(),
        });
    }
    let p = python.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let deps = required_deps();
        if deps.is_empty() {
            return Ok(None);
        }
        let mut cmd = Command::new(&p);
        cmd.args(["-c", &format!("import {}", deps.join(","))]);
        no_window(&mut cmd);
        cmd.output().map(Some)
    })
    .await
    .map_err(|e| e.to_string())?;
    match r {
        Ok(None) => Ok(HealthResult {
            ok: true,
            python: python.display().to_string(),
            message: "流水线未声明依赖(deps.txt),跳过检查".into(),
        }),
        Ok(Some(out)) if out.status.success() => Ok(HealthResult {
            ok: true,
            python: python.display().to_string(),
            message: "依赖检查通过".into(),
        }),
        Ok(Some(out)) => Ok(HealthResult {
            ok: false,
            python: python.display().to_string(),
            message: String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("依赖检查失败")
                .to_string(),
        }),
        Err(e) => Ok(HealthResult {
            ok: false,
            python: python.display().to_string(),
            message: format!("无法启动 Python: {e}"),
        }),
    }
}

// ── 壳子自更新 ─────────────────────────────────────────
/// 一键自动更新：共享盘 <share>\app\ 下有 app-version.txt + *-setup.exe
/// 1. 比对版本(不复用 check_app_update 的 None 语义,需区分「已最新」与「未找到」)
/// 2. 按修改时间取最新安装包 → 拷到临时目录 → 生成隐藏 cmd 批处理(全 ASCII,
///    运行时路径走环境变量;轮询等旧进程退出 → 静默安装 → 写退出码
///    update-result.txt → 重开新 exe → 自删)→ 本进程延迟退出
#[tauri::command]
async fn self_update(app: AppHandle) -> Result<String, String> {
    // 1. 版本比对
    let cfg = load_config();
    let share_path = cfg.share_path.trim();
    if share_path.is_empty() {
        return Err("尚未配置共享盘路径".into());
    }
    let app_dir = Path::new(share_path).join("app");
    let remote = fs::read_to_string(app_dir.join("app-version.txt"))
        .map_err(|_| "无法读取共享盘版本文件 app-version.txt".to_string())?
        .trim()
        .to_string();
    if remote.is_empty() {
        return Err("共享盘版本文件内容为空".into());
    }
    if !version_newer(&remote, env!("CARGO_PKG_VERSION")) {
        return Err("已是最新版本".into());
    }

    // 2. 找 *-setup.exe（按修改时间取最新）
    let mut setups: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&app_dir).map_err(|e| format!("读取共享盘 app 目录失败: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_setup = path
            .file_name()
            .and_then(|n| n.to_str())
            .map_or(false, |n| n.ends_with("-setup.exe"));
        if path.extension().and_then(|e| e.to_str()) == Some("exe") && is_setup {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            setups.push((mtime, path));
        }
    }
    setups.sort_by(|a, b| b.0.cmp(&a.0));
    let setup_exe = setups
        .into_iter()
        .next()
        .map(|(_, p)| p)
        .ok_or_else(|| "共享盘上未找到安装包".to_string())?;

    // 3. 拷贝到临时目录(覆盖旧文件)
    let target = std::env::temp_dir().join("KanbanPipeline-update.exe");
    fs::copy(&setup_exe, &target).map_err(|e| format!("拷贝安装包失败: {e}"))?;

    // 4. 生成隐藏 cmd 批处理脚本:先轮询等旧进程退出(最多 60 秒,超时强杀)→
    //    静默安装 NSIS → 写退出码到 update-result.txt(下次启动 take_update_result
    //    读取后反馈给前端)→ 重新启动新 exe → 自删。
    //    重开路径必须用 current_exe(当前运行的 exe 自己):实测 Tauri NSIS currentUser
    //    装到 %LOCALAPPDATA%\KanbanPipeline(无 Programs 层),之前硬编码错误路径
    //    导致装完静默失败、用户以为"什么都没弹出来"。
    //    编码:批处理必须 ASCII-only —— cmd 按系统代码页(中文 Windows 为 GBK/936)
    //    解析脚本文件,直接写进 .cmd 的中文路径(如 %LOCALAPPDATA%\看板助手\)会变
    //    乱码,导致 start 重开失败。三个运行时路径(安装包/结果文件/重开 exe)一律
    //    不写进模板,改由本进程 Command::env() 传入(Windows 环境块是 UTF-16,无编码
    //    损失),批处理内用 %KANBAN_SETUP%/%KANBAN_RESULT%/%KANBAN_RELAUNCH% 引用。
    //    时序:轮询 tasklist 等旧进程真正退出后再安装(用 ping 睡 1 秒,不用 timeout
    //    —— 无控制台时 timeout 会挂)。上限用单行 if 判断,避免括号块内 %WAITCNT%
    //    按解析期展开导致 60 次兜底永不触发。
    let temp_exe = target.to_string_lossy().into_owned();
    let current_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let result_file = data_root().join("update-result.txt");
    let cmd_file = std::env::temp_dir().join("KanbanPipeline-update.cmd");
    let script_lines = [
        "@echo off",
        "set /a WAITCNT=0",
        ":waitloop",
        "tasklist /FI \"IMAGENAME eq kanban-runner.exe\" 2>nul | find /I \"kanban-runner.exe\" >nul",
        "if not %ERRORLEVEL%==0 goto install",
        "ping -n 2 127.0.0.1 >nul",
        "set /a WAITCNT+=1",
        "if %WAITCNT% GEQ 60 taskkill /IM kanban-runner.exe /F >nul 2>&1",
        "goto waitloop",
        ":install",
        "\"%KANBAN_SETUP%\" /S",
        "set EC=%ERRORLEVEL%",
        // 重定向必须放句首:echo %EC%>file 在 EC 为单数字(0/1/2)时会被 cmd 解析成
        // 句柄重定向(0>/1>/2>),文件被写成空的 -> 启动回执误报 fail:invalid
        ">\"%KANBAN_RESULT%\" echo %EC%",
        "start \"\" \"%KANBAN_RELAUNCH%\"",
        "del \"%~f0\"",
    ]
    .join("\r\n");
    // 必须 CRLF 行尾:cmd 批处理对 LF-only 的解析有坑(标签跳转可能出错)
    fs::write(&cmd_file, script_lines).map_err(|e| format!("生成更新脚本失败: {e}"))?;
    let cmd_file_str = cmd_file.to_string_lossy().into_owned();
    let mut cmd = Command::new("cmd");
    cmd.arg("/c")
        .arg(&cmd_file_str)
        .env("KANBAN_SETUP", &temp_exe)
        .env("KANBAN_RESULT", &result_file)
        .env("KANBAN_RELAUNCH", &current_exe);
    no_window(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(|e| format!("启动更新程序失败: {e}"))?;

    // 5. 先让 IPC 响应送达前端,再延迟退出本进程。
    //    延迟 2 秒而非 500ms:给前端更新遮罩至少约 2 秒的可见时间,
    //    让用户看清"应用即将关闭安装新版本",不误以为有弹窗被自动关掉。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2000));
        app.exit(0);
    });

    Ok("正在更新:应用将关闭并自动安装新版本,完成后会自动重新打开".into())
}

/// 读取上次自更新结果(update-result.txt),供应用重启后向前端反馈"更新成功/失败"。
/// 文件由 self_update 生成的批处理写入;本命令读取后即删除,保证只反馈一次。
#[tauri::command]
async fn take_update_result() -> Result<Option<String>, String> {
    let result_file = data_root().join("update-result.txt");
    let content = match fs::read_to_string(&result_file) {
        Ok(c) => c,
        // 不存在 → 没有发生过更新(或正常返回 None)
        Err(_) => return Ok(None),
    };
    // 读完即删,防止重启后重复提示
    let _ = fs::remove_file(&result_file);
    match content.trim().parse::<i32>() {
        // 0 = NSIS 静默安装成功
        Ok(0) => Ok(Some("ok".into())),
        // 非零退出码:安装失败,把退出码带给前端
        Ok(code) => Ok(Some(format!("fail:{code}"))),
        // 内容无法解析也按失败处理(仍删文件,避免反复提示)
        Err(_) => Ok(Some("fail:invalid".into())),
    }
}

/// 0.3.16 迁移缺口：productName 从「看板助手」改为「KanbanAssistant」后，新装包写到
/// %LOCALAPPDATA%\KanbanAssistant\，而存量旧版（0.3.13-0.3.15，装在 %LOCALAPPDATA%\看板助手\）
/// 自更新到 0.3.16 不会搬走/卸载——旧安装会残留孤儿目录、卸载器与注册表键。
/// 启动时检测旧目录并静默清理；整个函数必须快速返回，耗时操作（卸载器 / reg delete /
/// 目录延迟删除）全部异步 spawn，绝不阻塞启动。
fn cleanup_legacy_install(app: &AppHandle) {
    // 1) legacy_dir = %LOCALAPPDATA%\看板助手；不存在 → 直接返回
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let legacy_dir = std::path::Path::new(&local).join("看板助手");
    if !legacy_dir.is_dir() {
        return;
    }
    // 2) 防自删守卫：当前 exe 就在旧目录下 → 返回（旧版无此代码不会走到，但守卫必须有）
    if let Ok(exe) = std::env::current_exe() {
        let exe_l = exe.to_string_lossy().to_lowercase();
        let legacy_l = legacy_dir.to_string_lossy().to_lowercase();
        if exe_l.starts_with(&legacy_l) {
            return;
        }
    }
    // 3) 通报
    emit_log(app, "info", "检测到旧版安装（看板助手目录），正在自动清理…".into());
    // 4) 静默卸载旧版：NSIS 卸载器会自复制到 TEMP 异步执行，不能 wait（会卡启动）→ fire-and-forget
    let uninstaller = legacy_dir.join("uninstall.exe");
    if uninstaller.is_file() {
        let mut c = std::process::Command::new(&uninstaller);
        c.arg("/S");
        no_window(&mut c);
        let _ = c.spawn();
    }
    // 5) 注册表残留清理：NSIS 卸载器实测会留下该键；用 reg 直接传参（不走 cmd，避免中文路径编码坑）
    let reg_key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\看板助手";
    let mut c = std::process::Command::new("reg");
    c.args(["delete", reg_key, "/f"]);
    no_window(&mut c);
    let _ = c.spawn();
    // 6) 目录延迟清理：卸载器自删后目录可能有残余，延迟 10s 再整体删除（失败仅告警，不 panic）
    let app2 = app.clone();
    let legacy2 = legacy_dir.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        match std::fs::remove_dir_all(&legacy2) {
            Ok(()) => emit_log(&app2, "ok", "旧版安装目录已清理".into()),
            Err(e) => emit_log(
                &app2,
                "warn",
                format!("旧版安装目录延迟清理失败（可能已被卸载器移除）: {e}"),
            ),
        }
    });
    // 7) 通报完成（第 6 步结果在延迟线程里另行 log）
    emit_log(app, "ok", "旧版安装已清理".into());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 启动时按主显示器尺寸把窗口设为横版:宽 62%、高 62%,居中;
            // 不小于 tauri.conf.json 的最小尺寸(960x660)。
            // 失败(拿不到显示器信息)时静默回退到 tauri.conf.json 的固定尺寸。
            // 窗口以 visible:false 创建(见 tauri.conf.json),消除「先 1280x800 再放大
            // 到屏幕 62%」的跳变;显示时机进一步推迟到前端首帧绘制完成(防 WebView2
            // 白闪):前端 main.ts 首帧后 emit("frontend-ready"),此处监听后再 show。
            // 3.5 秒兜底显示:前端异常(白屏/脚本报错)时窗口不至于永不出现。
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(Some(m)) = w.current_monitor() {
                    let scale = m.scale_factor();
                    let logical_w = m.size().width as f64 / scale;
                    let logical_h = m.size().height as f64 / scale;
                    let _ = w.set_size(tauri::LogicalSize::new(
                        (logical_w * 0.62).max(960.0),
                        (logical_h * 0.62).max(660.0),
                    ));
                    let _ = w.center();
                }
                use tauri::Listener;
                let w2 = w.clone();
                app.listen("frontend-ready", move |_| {
                    let _ = w2.show();
                    let _ = w2.set_focus();
                });
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(3500));
                    // show() 幂等:与 frontend-ready 竞争时最多多调一次,无害
                    let _ = w.show();
                });
            }
            // 0.3.16 迁移缺口补：旧版（看板助手目录）安装启动时自动清理（全异步，不阻塞启动）
            cleanup_legacy_install(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 防止双击启动第二个实例(两个 pip install/robocopy 会互踩坏环境);
            // 重复启动时聚焦已有窗口
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Running::default())
        .manage(Cancelled(Arc::new(AtomicBool::new(false))))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_status,
            list_share_data,
            pull_share_data,
            sync_code,
            run_pipeline,
            stop_pipeline,
            open_dashboard,
            open_folder,
            setup_env,
            health_check,
            self_update,
            take_update_result
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出时回收孤儿流水线进程:用户中途关窗,后台 python 继续跑会占着
            // output/ 文件锁,下次启动再跑 → 双进程互踩、产出错乱。
            // 在 Exit 事件(关窗默认 ExitRequested→Exit 的最终阶段)按 pid
            // 连子进程(/T)一起强杀,兜底回收。
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let state = app.state::<Running>();
                let pid = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(pid) = pid {
                    let mut c = Command::new("taskkill");
                    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
                    no_window(&mut c);
                    let _ = c.output();
                }
            }
        });
}
