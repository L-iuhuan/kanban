import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ── 类型 ──────────────────────────────────────────────
interface AppConfig {
  share_path: string;
  auto_sync: boolean;
}
interface Status {
  share_ok: boolean;
  env_ok: boolean;
  synced: boolean;
  version: string;
  share_path: string;
  app_root: string;
  python: string;
}
interface SyncResult {
  ok: boolean;
  changed: number;
  added: number;
  deleted: number;
  version: string;
  message: string;
}
interface LogLine {
  level: string;
  text: string;
}
interface StageEvent {
  n: number;
  total: number;
  name: string;
}
interface DoneEvent {
  ok: boolean;
  code: number | null;
  duration_ms: number;
  error: string | null;
}

// ── 工具 ──────────────────────────────────────────────
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("missing #" + id);
  return el as T;
}
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? m + " 分 " + (s % 60) + " 秒" : s + " 秒";
}
function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// ── 全局状态 ──────────────────────────────────────────
let dataFile: string | null = null;
let running = false;
let lastJobId = 0;
let logLines = 0;
let pipelineTotal = 0;
let pipelineN = 0;

type AppState = "idle" | "syncing" | "setting-up" | "running" | "done" | "failed";

// ── 标题栏窗口控制 ────────────────────────────────────
const win = getCurrentWindow();
byId("btn-min").addEventListener("click", () => void win.minimize());
byId("btn-max").addEventListener("click", () => void win.toggleMaximize());
byId("btn-close").addEventListener("click", () => void win.close());

// ── 日志 ──────────────────────────────────────────────
const logBody = byId("log-body");

function appendLog(level: string, text: string, isStage = false) {
  if (logLines === 0) logBody.innerHTML = "";
  const line = document.createElement("div");
  line.className = "log-line " + (isStage ? "stage" : level);
  const t = document.createElement("span");
  t.className = "ts";
  t.textContent = ts();
  line.appendChild(t);
  line.appendChild(document.createTextNode(text));
  logBody.appendChild(line);
  logLines++;
  // 上限 5000 行
  while (logBody.childElementCount > 5000) {
    logBody.removeChild(logBody.firstElementChild!);
  }
  // 用户滚到底部附近才自动跟随
  const nearBottom =
    logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 60;
  if (nearBottom) logBody.scrollTop = logBody.scrollHeight;
}

function showBanner(text: string) {
  byId("banner-text").textContent = text;
  byId("error-banner").hidden = false;
}
function hideBanner() {
  byId("error-banner").hidden = true;
}

// ── 阶段 stepper ──────────────────────────────────────
const stepperItems = Array.from(
  byId("stepper").querySelectorAll("li")
) as HTMLLIElement[];

function setStageState(index: number, state: "active" | "done" | "failed") {
  stepperItems.forEach((li, i) => {
    li.classList.remove("active", "done", "failed");
    if (i < index) li.classList.add("done");
    else if (i === index) li.classList.add(state);
  });
}
function setProgress(pct: number) {
  byId("progress-bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
}
function setDetail(text: string) {
  byId("stage-detail").textContent = text;
}

// ── 状态机 ────────────────────────────────────────────
function setAppState(state: AppState) {
  const btnRun = byId<HTMLButtonElement>("btn-run");
  const btnStop = byId<HTMLButtonElement>("btn-stop");
  const btnDash = byId<HTMLButtonElement>("btn-open-dashboard");
  const btnSilver = byId<HTMLButtonElement>("btn-open-silver");
  const btnGold = byId<HTMLButtonElement>("btn-open-gold");
  const btnReport = byId<HTMLButtonElement>("btn-open-report");
  const btnOutput = byId<HTMLButtonElement>("btn-open-output");
  running = state === "running" || state === "syncing" || state === "setting-up";
  btnStop.disabled = !running;
  btnRun.disabled = running;
  const hasResult = state === "done";
  btnDash.disabled = !hasResult;
  btnSilver.disabled = !hasResult;
  btnGold.disabled = !hasResult;
  btnReport.disabled = !hasResult;
  btnOutput.disabled = !hasResult;
  if (state === "done") {
    setStageState(4, "done");
    setProgress(100);
  }
}

// ── 数据文件 ──────────────────────────────────────────
const dropZone = byId("drop-zone");
const dataFileEl = byId("data-file");

function setDataFile(path: string | null) {
  dataFile = path;
  if (path) {
    const name = path.split(/[\\/]/).pop();
    dataFileEl.textContent = "当前文件: " + name + "  (" + path + ")";
    dataFileEl.hidden = false;
    byId("drop-title")!.textContent = "换一个 Excel?拖进来或点击";
  } else {
    dataFileEl.hidden = true;
    byId("drop-title")!.textContent = "把 Excel 拖到这里";
  }
}
function byIdText(id: string, t: string) {
  byId(id).textContent = t;
}

// 拖拽事件(Tauri drag-drop)
getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "over") {
    dropZone.classList.add("dragover");
  } else if (p.type === "leave" || p.type === "drop") {
    dropZone.classList.remove("dragover");
    if (p.type === "drop") {
      const first = p.paths[0];
      if (first && /.(xlsx|xls)$/i.test(first)) {
        setDataFile(first);
        appendLog("info", "已选择数据文件: " + first);
      } else if (first) {
        appendLog("warn", "仅支持 .xlsx / .xls 文件,已忽略: " + first);
      }
    }
  }
});

// 点击弹文件选择框
dropZone.addEventListener("click", async () => {
  try {
    const selected = await openDialog({
      multiple: false,
      title: "选择销售明细 Excel",
      filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
    });
    if (typeof selected === "string" && selected) {
      setDataFile(selected);
      appendLog("info", "已选择数据文件: " + selected);
    }
  } catch (e) {
    appendLog("error", "打开文件对话框失败: " + e);
  }
});

byId("opt-skip").addEventListener("change", () => {
  const skip = byId<HTMLInputElement>("opt-skip").checked;
  if (skip) appendLog("info", "已勾选「跳过数据处理」:将直接使用 output 缓存重新生成看板");
});

// ── 同步 ──────────────────────────────────────────────
async function runSync(silent = false) {
  setAppState("syncing");
  setStageState(0, "active");
  setProgress(4);
  setDetail("正在从共享盘同步最新代码…");
  try {
    const r = await invoke<SyncResult>("sync_code");
    appendLog(r.ok ? "ok" : "error", r.message);
    appendLog("info", "当前代码版本: " + r.version);
    byIdText("version-badge", r.version);
    setStageState(0, "done");
    setProgress(8);
    return r;
  } catch (e) {
    appendLog("error", "同步失败: " + e);
    setStageState(0, "failed");
    if (!silent) showBanner("代码同步失败: " + e);
    setAppState("failed");
    return null;
  }
}

// ── 运行 ──────────────────────────────────────────────
async function runPipeline() {
  hideBanner();
  const skip = byId<HTMLInputElement>("opt-skip").checked;
  if (!skip && !dataFile) {
    showBanner("请先拖入/选择一个 Excel 数据文件,或勾选「跳过数据处理」");
    return;
  }
  setAppState("running");
  setStageState(1, "active");
  setProgress(10);
  setDetail("检查运行环境…");
  pipelineTotal = 0;
  pipelineN = 0;
  try {
    lastJobId = await invoke<number>("run_pipeline", {
      dataPath: dataFile ?? "",
      skipProcessing: skip,
    });
  } catch (e) {
    appendLog("error", "启动失败: " + e);
    showBanner("启动失败: " + e);
    setAppState("failed");
  }
}

byId("btn-run").addEventListener("click", () => void runPipeline());

byId("btn-stop").addEventListener("click", async () => {
  try {
    await invoke("stop_pipeline");
  } catch (e) {
    appendLog("error", "停止失败: " + e);
  }
});

// ── 打开看板/产物 ─────────────────────────────────────
byId("btn-open-dashboard").addEventListener("click", async () => {
  try {
    const p = await invoke<string>("open_dashboard");
    appendLog("ok", "已打开看板: " + p);
  } catch (e) {
    appendLog("error", "打开看板失败: " + e);
    showBanner("打开看板失败: " + e);
  }
});
for (const [btnId, kind] of [
  ["btn-open-silver", "silver"],
  ["btn-open-gold", "gold"],
  ["btn-open-report", "report"],
  ["btn-open-output", "output"],
] as const) {
  byId(btnId).addEventListener("click", async () => {
    try {
      const p = await invoke<string>("open_folder", { kind });
      appendLog("info", "已打开目录: " + p);
    } catch (e) {
      appendLog("warn", e as string);
    }
  });
}

// ── 日志按钮 ──────────────────────────────────────────
byId("btn-copy-log").addEventListener("click", async () => {
  const lines = Array.from(logBody.querySelectorAll(".log-line"))
    .map((el) => el.textContent ?? "")
    .join("\n");
  if (!lines) return;
  try {
    await navigator.clipboard.writeText(lines);
    appendLog("ok", "日志已复制到剪贴板");
  } catch {
    appendLog("warn", "复制失败,请手动全选复制");
  }
});
byId("btn-clear-log").addEventListener("click", () => {
  logBody.innerHTML = '<div class="log-empty">日志将在这里实时显示</div>';
  logLines = 0;
});
byId("banner-copy").addEventListener("click", () =>
  byId("btn-copy-log").click()
);
byId("banner-close").addEventListener("click", hideBanner);

// ── 设置弹层 ──────────────────────────────────────────
const settingsModal = byId("settings-modal");

function openSettings() {
  byId<HTMLInputElement>("share-path-input").value =
    (window as unknown as { _cfg?: AppConfig })._cfg?.share_path ?? "";
  byId<HTMLInputElement>("opt-auto-sync").checked =
    (window as unknown as { _cfg?: AppConfig })._cfg?.auto_sync ?? true;
  settingsModal.hidden = false;
}
byId("btn-settings").addEventListener("click", openSettings);
byId("btn-cancel-config").addEventListener("click", () => {
  settingsModal.hidden = true;
});
byId("btn-save-config").addEventListener("click", async () => {
  const sharePath = byId<HTMLInputElement>("share-path-input").value.trim();
  const autoSync = byId<HTMLInputElement>("opt-auto-sync").checked;
  try {
    await invoke("save_config", {
      cfg: { share_path: sharePath, auto_sync: autoSync },
    });
    (window as unknown as { _cfg?: AppConfig })._cfg = {
      share_path: sharePath,
      auto_sync: autoSync,
    };
    appendLog("ok", "设置已保存");
    settingsModal.hidden = true;
    if (sharePath) {
      await runSync(true);
      await refreshStatus();
    }
  } catch (e) {
    appendLog("error", "保存失败: " + e);
  }
});

// ── 状态刷新 ──────────────────────────────────────────
async function refreshStatus() {
  try {
    const s = await invoke<Status>("get_status");
    (window as unknown as { _cfg?: AppConfig })._cfg = {
      share_path: s.share_path,
      auto_sync: true,
    };
    byIdText("version-badge", s.synced ? s.version : "未同步");
    const net = byId("net-status");
    const netText = byId("net-text");
    net.classList.remove("ok", "bad");
    if (!s.share_path) {
      net.classList.add("bad");
      netText.textContent = "未配置共享盘";
    } else if (s.share_ok) {
      net.classList.add("ok");
      netText.textContent = "共享盘已连接";
    } else {
      net.classList.add("bad");
      netText.textContent = "共享盘不可达";
    }
    if (s.env_ok) {
      appendLog("ok", "运行环境就绪: " + s.python);
    } else if (s.synced) {
      appendLog("warn", "运行环境未就绪,正在自动安装(首次需要几分钟,请耐心等待)…");
      void invoke("setup_env").catch((e) => {
        appendLog("error", "环境安装启动失败: " + e);
      });
    } else {
      appendLog("warn", "运行环境未就绪,同步代码后将自动安装");
    }
    return s;
  } catch (e) {
    appendLog("error", "获取状态失败: " + e);
    return null;
  }
}

// ── 事件监听 ──────────────────────────────────────────
listen<LogLine>("pipeline-log", (e) => {
  appendLog(e.payload.level, e.payload.text);
});
listen<StageEvent>("pipeline-stage", (e) => {
  const { n, total, name } = e.payload;
  pipelineTotal = total;
  pipelineN = n;
  setStageState(2, "active");
  setStageState(3, "active");
  // 流水线内部阶段映射到 10%~90% 区间
  const pct = 10 + (n / Math.max(1, total)) * 80;
  setProgress(pct);
  setDetail(
    "阶段 " + n + "/" + total + (name ? ":" + name : "") + " — 处理中"
  );
  appendLog("stage", "[STAGE " + n + "/" + total + "] " + name, true);
});
listen<DoneEvent>("pipeline-done", (e) => {
  const { ok, code, duration_ms } = e.payload;
  const msg =
    (ok ? "✅ 流水线执行完成" : "❌ 流水线执行失败") +
    " (退出码 " +
    code +
    ",耗时 " +
    fmtDuration(duration_ms) +
    ")";
  appendLog(ok ? "ok" : "error", msg);
  if (ok) {
    setDetail("完成!可打开看板查看结果");
    setAppState("done");
  } else {
    setStageState(3, "failed");
    setDetail("执行失败,请查看上方红色日志");
    setAppState("failed");
    showBanner("流水线执行失败(退出码 " + code + ")。点右侧「复制日志」把日志发给开发者。");
  }
});
listen<SyncResult>("sync-done", (e) => {
  byIdText("version-badge", e.payload.version);
  appendLog("info", "版本: " + e.payload.version);
});
listen<boolean>("setup-done", (e) => {
  const ok = e.payload;
  appendLog(ok ? "ok" : "error", ok ? "环境安装完成" : "环境安装失败");
  setAppState(ok ? "idle" : "failed");
  void refreshStatus();
});

// ── 启动流程 ──────────────────────────────────────────
async function init() {
  hideBanner();
  appendLog("info", "看板流水线运行器启动…");
  const cfg = await invoke<AppConfig>("get_config").catch(() => null);
  if (cfg) {
    (window as unknown as { _cfg?: AppConfig })._cfg = cfg;
  }
  const s = await refreshStatus();
  if (!cfg || !cfg.share_path) {
    appendLog("warn", "首次使用:请点击右上角 ⚙ 设置,填写共享盘代码目录");
    openSettings();
    setAppState("idle");
    return;
  }
  if (!s) return;
  if (cfg.auto_sync && s.share_ok) {
    await runSync(true);
  } else if (!s.share_ok) {
    appendLog("error", "共享盘不可达: " + cfg.share_path + ",请检查网络或重新设置");
    setAppState("failed");
  }
  setAppState("idle");
}

void init();
