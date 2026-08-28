import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ── 类型 ──────────────────────────────────────────────
interface AppConfig {
  share_path: string;
  data_share_path: string;
  auto_sync: boolean;
}
interface Status {
  share_ok: boolean;
  share_reachable: boolean;
  env_ok: boolean;
  synced: boolean;
  version: string;
  share_path: string;
  app_root: string;
  python: string;
  update_available: string | null;
  app_version: string;
  remote_version: string | null;
  has_dashboard: boolean;
  has_output: boolean;
}
interface SyncResult {
  ok: boolean;
  version: string;
  message: string;
}
interface ShareDataFile {
  name: string;
  size_mb: number;
  modified: string;
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
  pid: number;
}
interface HealthResult {
  ok: boolean;
  python: string;
  message: string;
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

// ── 主题(浅色/深色,默认浅色,localStorage 记忆) ──
const rootEl = document.documentElement;
function applyTheme(t: "light" | "dark") {
  rootEl.classList.add("theme-switching");
  rootEl.dataset.theme = t;
  localStorage.setItem("theme", t);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => rootEl.classList.remove("theme-switching"))
  );
}
applyTheme(localStorage.getItem("theme") === "dark" ? "dark" : "light");

// ── 全局状态 ──────────────────────────────────────────
let dataFile: string | null = null;
let running = false;
let lastJobId = 0;
let logLines = 0;
let pipelineTotal = 0;
let pipelineN = 0;
let pipelineStageName = "";
let setupInProgress = false;
let updateNoticeShown = false;
let cfgCache: AppConfig | null = null;
let appState: AppState = "idle";
// 本地产物存在性(后端 get_status 提供):重启应用后也允许打开历史看板/中间产物
let hasDashboard = false;
let hasOutput = false;

type AppState = "idle" | "syncing" | "setting-up" | "running" | "done" | "failed";

// ── 标题栏窗口控制 ────────────────────────────────────
const win = getCurrentWindow();
byId("btn-min").addEventListener("click", () => void win.minimize());
byId("btn-max").addEventListener("click", () => void win.toggleMaximize());
byId("btn-close").addEventListener("click", () => void win.close());
byId("btn-theme").addEventListener("click", () => {
  applyTheme(rootEl.dataset.theme === "light" ? "dark" : "light");
});

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

function showBanner(text: string, kind: "err" | "info" | "ok" = "err") {
  const el = byId("error-banner");
  el.classList.remove("info", "ok");
  if (kind !== "err") el.classList.add(kind);
  byId("banner-text").textContent = text;
  el.hidden = false;
}
function hideBanner() {
  byId("error-banner").hidden = true;
}
function showToast(text: string, kind: "ok" | "info" | "err" = "info") {
  const zone = document.getElementById("toast-zone");
  if (!zone) return;
  const toast = document.createElement("div");
  toast.className = "toast " + kind;
  const dot = document.createElement("span");
  dot.className = "t-dot";
  const msg = document.createElement("span");
  msg.textContent = text;
  toast.appendChild(dot);
  toast.appendChild(msg);
  while (zone.children.length >= 4) {
    zone.removeChild(zone.firstElementChild!);
  }
  zone.appendChild(toast);
  void toast.offsetHeight;
  toast.classList.add("enter");
  window.setTimeout(() => {
    toast.classList.add("exit");
    window.setTimeout(() => {
      if (toast.parentNode === zone) zone.removeChild(toast);
    }, 220);
  }, 2800);
}

// ── 阶段 stepper(按 pipeline-stage 事件动态生成,不认死阶段数/名称) ──
const stepperEl = byId("stepper");
let stepperItems: HTMLLIElement[] = [];
let stepperTotal = 0;

const S_CHECK_SVG =
  '<svg class="s-check" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const S_X_SVG =
  '<svg class="s-x" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/** 首次收到阶段事件前显示占位提示 */
function showStepperPlaceholder() {
  stepperEl.innerHTML =
    '<li class="placeholder"><span class="s-name">运行后按流水线上报的实际阶段展示</span></li>';
}

function buildStepper(total: number) {
  stepperEl.innerHTML = "";
  stepperItems = [];
  stepperTotal = total;
  for (let i = 0; i < total; i++) {
    const li = document.createElement("li");
    li.innerHTML =
      '<span class="s-idx"><span class="s-num">' +
      (i + 1) +
      "</span>" +
      S_CHECK_SVG +
      S_X_SVG +
      '</span><span class="s-name">阶段 ' +
      (i + 1) +
      "</span>";
    stepperEl.appendChild(li);
    stepperItems.push(li);
  }
}

function setStageState(index: number, state: "active" | "done" | "failed") {
  if (stepperItems.length === 0) return;
  const idx = Math.max(0, Math.min(index, stepperItems.length - 1));
  stepperItems.forEach((li, i) => {
    li.classList.remove("active", "done", "failed");
    if (i < idx) li.classList.add("done");
    else if (i === idx) li.classList.add(state);
  });
}
function setProgress(pct: number) {
  byId("progress-bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
}
function setDetail(text: string) {
  byId("stage-detail").textContent = text;
}

// ── 精确进度:按真实流水线实测的各阶段预期耗时做时间插值 ──
// 校准值(2026-08-14 --force-silver 全量实测,总耗时 1433.5s;毫秒)
// 耗时随数据量伸缩,阶段内进度最多走到 95%,下一阶段标记到达时校准
// 仅作「按序号」的兜底估计:阶段数由流水线事件决定,超出本表长度的阶段用 60s 默认值
const STAGE_EXPECTED_MS: number[] = [
  48000, // 1 silver 数据清洗(实测 48s)
  89000, // 2 product 产品生命周期(实测 89s)
  262000, // 3 customer 客户分析(实测 4 分 22 秒)
  3000, // 4 kpi 准实时(实测 1s,给 3s 下限避免进度条瞬跳)
  3000, // 5 cross_ref 交叉关联(实测 2s,给 3s 下限)
  1031000, // 6 dashboard 生成看板(实测 17 分 11 秒,占全程约 72%)
];
const PROGRESS_BASE = 0; // 进度条全部用于流水线 6 阶段(同步/环境不属于看板生成流程)
let stageTimer: number | null = null;
let stageBase = PROGRESS_BASE;
let stageSpan = 0;
let stageStartTs = 0;
let stageExpected = 60000;
let stageFloor = 0; // 子阶段通报抬升的进度下限(0~1),保证进度只前进不后退

function stageProgressStop() {
  if (stageTimer !== null) {
    window.clearInterval(stageTimer);
    stageTimer = null;
  }
}

/** 子阶段通报抬升进度下限(如看板阶段日志中的 [3/8] 标记) */
function stageProgressFloor(sub: number) {
  stageFloor = Math.max(stageFloor, sub * 0.95);
}

function beginStageProgress(n: number, total: number, name: string) {
  stageProgressStop();
  // 按预期耗时占比分配 10%~100% 区间
  const exp = Array.from({ length: total }, (_, i) => STAGE_EXPECTED_MS[i] ?? 60000);
  const sum = exp.reduce((a, b) => a + b, 0);
  const spans = exp.map((e) => ((100 - PROGRESS_BASE) * e) / sum);
  stageBase = PROGRESS_BASE + spans.slice(0, n - 1).reduce((a, b) => a + b, 0);
  stageSpan = spans[n - 1] ?? 0;
  stageExpected = exp[n - 1] ?? 60000;
  stageStartTs = Date.now();
  stageFloor = 0;
  const eta = Math.round(stageExpected / 1000);
  const etaText = eta >= 60 ? Math.round(eta / 60) + " 分钟" : eta + " 秒";
  setDetail("阶段 " + n + "/" + total + (name ? ":" + name : "") + " — 处理中(约 " + etaText + ")");
  setProgress(stageBase);
  stageTimer = window.setInterval(() => {
    // 时间插值与子阶段通报取较大者,进度只前进不后退
    const f = Math.min(Math.max((Date.now() - stageStartTs) / stageExpected, stageFloor), 0.95);
    setProgress(stageBase + stageSpan * f);
  }, 500);
}

// ── 状态机 ────────────────────────────────────────────
function setAppState(state: AppState) {
  appState = state;
  const btnRun = byId<HTMLButtonElement>("btn-run");
  const btnStop = byId<HTMLButtonElement>("btn-stop");
  const btnDash = byId<HTMLButtonElement>("btn-open-dashboard");
  const btnSilver = byId<HTMLButtonElement>("btn-open-silver");
  const btnGold = byId<HTMLButtonElement>("btn-open-gold");
  const btnOutput = byId<HTMLButtonElement>("btn-open-output");
  running = state === "running" || state === "syncing" || state === "setting-up";
  btnStop.disabled = !running;
  btnRun.disabled = running;
  byId<HTMLButtonElement>("btn-sync").disabled = running;
  // 本次跑出结果,或本地已有历史产物(重启应用后)都可打开
  const canViewDash = state === "done" || hasDashboard;
  const canViewOut = state === "done" || hasOutput;
  btnDash.disabled = !canViewDash;
  btnSilver.disabled = !canViewOut;
  btnGold.disabled = !canViewOut;
  btnOutput.disabled = !canViewOut;
  if (state === "done" && stepperItems.length > 0) {
    setStageState(stepperItems.length - 1, "done");
    setProgress(100);
  }
}

// ── 数据文件 ──────────────────────────────────────────
const dropZone = byId("drop-zone");
const dataFileEl = byId("data-file");

function setDataFile(path: string | null) {
  dataFile = path;
  // 切换文件卡片态:选中后占位提示整体隐藏,文件卡片成为拖拽区唯一主体
  dropZone.classList.toggle("has-file", !!path);
  if (path) {
    const name = path.split(/[\\/]/).pop() ?? path;
    byId("data-file-name").textContent = name;
    byId("data-file-path").textContent = path;
    dataFileEl.hidden = false;
  } else {
    dataFileEl.hidden = true;
  }
}

// 移除已选文件(阻止冒泡,避免触发拖拽区的文件对话框)
byId("btn-clear-file").addEventListener("click", (e) => {
  e.stopPropagation();
  setDataFile(null);
  appendLog("info", "已移除数据文件");
  showToast("已移除数据文件", "info");
});
function byIdText(id: string, t: string) {
  byId(id).textContent = t;
}
/** 版本徽章:只显示版本号,完整信息(含发布时间)放 tooltip,避免被误认为系统时间 */
function setVersionBadge(v: string) {
  const badge = byId("version-badge");
  badge.textContent = v.split(" @")[0];
  badge.title = "代码版本: " + v;
}

// ── 代码更新巡检:共享盘出现新代码时高亮「更新代码」按钮并通报 ──
let lastNotifiedRemote: string | null = null;

function checkCodeUpdate(s: Status) {
  if (
    s.remote_version &&
    s.remote_version !== s.version &&
    s.remote_version !== lastNotifiedRemote
  ) {
    lastNotifiedRemote = s.remote_version;
    byId("btn-sync").classList.add("attention");
    const short = s.remote_version.split(" @")[0];
    appendLog("warn", "检测到共享盘有新代码: " + short + ",点击「更新代码」获取");
    setDetail("有新代码可更新: " + short);
  }
}

// 使用中每 2 分钟巡检一次(仅空闲时;巡检失败静默,不打断使用)
window.setInterval(() => {
  if (running || setupInProgress) return;
  invoke<Status>("get_status")
    .then((s) => checkCodeUpdate(s))
    .catch(() => {});
}, 120000);

// 拖拽事件(Tauri drag-drop)
getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "over") {
    dropZone.classList.add("dragover");
  } else if (p.type === "leave" || p.type === "drop") {
    dropZone.classList.remove("dragover");
    if (p.type === "drop") {
      const first = p.paths[0];
      if (first && /\.(xlsx|xls)$/i.test(first)) {
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

// 从共享盘一键拉取最新数据文件(月度 Excel 投放到数据共享目录)。
// 后端 list_share_data 已按修改时间倒序,这里取第一个即最新;拉取成功复用
// setDataFile 选中本地缓存,无需刷新状态(数据文件与 get_status 无关)。
const btnPullShare = byId<HTMLButtonElement>("btn-pull-share");
btnPullShare.addEventListener("click", async () => {
  if (btnPullShare.disabled) return; // 防重入
  btnPullShare.disabled = true;
  setDetail("正在从共享盘获取数据文件…");
  try {
    const files = await invoke<ShareDataFile[]>("list_share_data");
    if (files.length === 0) {
      const msg = "数据共享目录暂无 Excel 数据文件(尚未投放新数据)";
      appendLog("warn", msg);
      showBanner(msg, "info");
      setDetail("暂无可拉取的数据文件");
      return;
    }
    const f = files[0];
    appendLog(
      "info",
      "发现共享盘数据文件: " + f.name + " (" + f.size_mb.toFixed(1) + "MB, " + f.modified + ")"
    );
    const localPath = await invoke<string>("pull_share_data", { filename: f.name });
    setDataFile(localPath);
    appendLog("ok", "数据文件已拉取到本地: " + localPath);
    showToast("数据文件已拉取到本地", "ok");
    setDetail("数据文件已就绪,可生成看板");
  } catch (e) {
    appendLog("error", "从共享盘拉取数据文件失败: " + e);
    showBanner("从共享盘拉取数据文件失败: " + e);
    setDetail("拉取失败,请查看上方日志");
  } finally {
    btnPullShare.disabled = false;
  }
});

// 共享盘文件选择(可选入口:列出共享盘 data 目录全部 Excel 供点选;默认取最新按钮逻辑不动)。
// 复用 list_share_data / pull_share_data 双命令 + setDataFile / appendLog / showToast 反馈体系;
// 面板复用设置弹层的 modal-mask/modal 形态,行为:点击行拉取该文件→选中→关面板;
// 空列表提示(与拉取按钮口径一致)、点击遮罩/Esc 关闭、拉取期间行禁用防重入。
const sharePicker = byId("share-picker-modal");
const sharePickerList = byId("share-picker-list");
const sharePickerEmpty = byId("share-picker-empty");
let pickingShare = false;

function closeSharePicker() {
  sharePicker.hidden = true;
  sharePickerList.innerHTML = "";
  sharePickerEmpty.hidden = true;
}

function renderSharePicker(files: ShareDataFile[]) {
  sharePickerList.innerHTML = "";
  if (files.length === 0) {
    sharePickerEmpty.hidden = false;
    return;
  }
  for (const f of files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "btn";
    row.style.cssText =
      "width:100%;justify-content:flex-start;padding:9px 12px";
    row.title = "拉取 " + f.name;
    const nameSpan = document.createElement("span");
    nameSpan.style.cssText =
      "flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    nameSpan.textContent = f.name;
    const metaSpan = document.createElement("span");
    metaSpan.style.cssText = "color:var(--text-dim);flex-shrink:0;font-size:12px";
    metaSpan.textContent = f.size_mb.toFixed(1) + "MB · " + f.modified;
    row.appendChild(nameSpan);
    row.appendChild(metaSpan);
    row.addEventListener("click", async () => {
      if (pickingShare) return; // 防重入
      pickingShare = true;
      const rows = sharePickerList.querySelectorAll("button");
      rows.forEach((b) => ((b as HTMLButtonElement).disabled = true));
      appendLog("info", "正在从共享盘拉取: " + f.name + " (" + f.size_mb.toFixed(1) + "MB)");
      try {
        const localPath = await invoke<string>("pull_share_data", { filename: f.name });
        setDataFile(localPath);
        appendLog("ok", "数据文件已拉取到本地: " + localPath);
        showToast("数据文件已拉取到本地", "ok");
        closeSharePicker();
      } catch (e) {
        appendLog("error", "从共享盘拉取数据文件失败: " + e);
        showBanner("从共享盘拉取数据文件失败: " + e);
      } finally {
        pickingShare = false;
        rows.forEach((b) => ((b as HTMLButtonElement).disabled = false));
      }
    });
    sharePickerList.appendChild(row);
  }
}
byId("btn-pick-share").addEventListener("click", async () => {
  try {
    const files = await invoke<ShareDataFile[]>("list_share_data");
    renderSharePicker(files);
    sharePicker.hidden = false;
  } catch (e) {
    appendLog("error", "获取共享盘文件列表失败: " + e);
    showToast("获取共享盘文件列表失败", "err");
  }
});
byId("btn-close-picker").addEventListener("click", closeSharePicker);
// 点击遮罩(面板外部)关闭
sharePicker.addEventListener("click", (e) => {
  if (e.target === sharePicker) closeSharePicker();
});

byId("opt-skip").addEventListener("change", () => {
  const skip = byId<HTMLInputElement>("opt-skip").checked;
  if (skip) appendLog("info", "已勾选「跳过数据处理」:将直接使用 output 缓存重新生成看板");
});

// ── 同步 ──────────────────────────────────────────────
async function runSync(silent = false) {
  // 记录进入前状态,成功后复位:此前成功路径不复位,手动同步后 appState 卡在
  // syncing → btnRun 禁用/btnStop 启用(状态机 bug,用户表现为"无法运行")
  const prevState = appState;
  setAppState("syncing");
  setDetail("正在从共享盘同步最新代码…");
  try {
    const r = await invoke<SyncResult>("sync_code");
    appendLog(r.ok ? "ok" : "error", r.message);
    if (r.ok) {
      appendLog("info", "当前代码版本: " + r.version);
      setVersionBadge(r.version);
      byId("btn-sync").classList.remove("attention");
      lastNotifiedRemote = null;
      // 同步完成的明确通报(步骤条已不含同步阶段,用详情行反馈)
      setDetail("代码已同步,当前版本 " + r.version.split(" @")[0]);
      // 瞬态(syncing/setting-up)兜底回 idle;running/done/failed 原样恢复
      setAppState(prevState === "syncing" || prevState === "setting-up" ? "idle" : prevState);
    }
    return r;
  } catch (e) {
    appendLog("error", "同步失败: " + e);
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
  setProgress(2);
  stageProgressStop();
  setDetail("检查运行环境…");
  pipelineTotal = 0;
  pipelineN = 0;
  pipelineStageName = "";
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

// 手动同步/重试:共享盘恢复或代码推送后点击
byId("btn-sync").addEventListener("click", async () => {
  hideBanner();
  const r = await runSync();
  if (r && r.ok) await refreshStatus();
});

function markUpdateStep(n: number) {
  byId("update-steps").querySelectorAll("li").forEach((li) => {
    const s = Number(li.getAttribute("data-step"));
    li.classList.remove("active", "done");
    if (s < n) li.classList.add("done");
    else if (s === n) li.classList.add("active");
  });
}

async function startSelfUpdate(targetVer: string) {
  byId<HTMLElement>("settings-modal").hidden = true;
  byIdText("update-target-ver", targetVer);
  byId<HTMLElement>("update-overlay").hidden = false;
  markUpdateStep(1);
  appendLog("info", "开始自动更新:正在从共享盘获取安装包…");
  try {
    const msg = await invoke<string>("self_update");
    appendLog("ok", msg);
    markUpdateStep(2);
  } catch (e) {
    byId<HTMLElement>("update-overlay").hidden = true;
    appendLog("error", "自动更新失败: " + e);
    showBanner("自动更新失败: " + e);
  }
}

// 一键自动更新:从共享盘取安装包静默安装,完成后自动重启到新版本
byId("btn-update").addEventListener("click", async () => {
  const s = await refreshStatus();
  const ver = s?.update_available ?? "";
  if (!ver) return;
  void startSelfUpdate(ver);
});
byId("btn-update-close").addEventListener("click", () => {
  updateNoticeShown = true;
  byId("update-banner").hidden = true;
});

function renderInlineUpdate(s: Status | null) {
  const inlineBtn = byId<HTMLButtonElement>("btn-inline-update");
  const hint = byId<HTMLElement>("update-hint");
  if (s && s.update_available) {
    inlineBtn.hidden = false;
    inlineBtn.textContent = "立即更新 v" + s.update_available;
    hint.hidden = false;
    hint.textContent = "当前 v" + s.app_version + " → 发现 v" + s.update_available;
  } else {
    inlineBtn.hidden = true;
    hint.hidden = false;
    hint.textContent = "已是最新 (v" + (s ? s.app_version : "?") + ")";
  }
}

// 设置里的「检查更新」:刷新状态,有新版时在同一行显示主按钮
byId("btn-check-update").addEventListener("click", async () => {
  appendLog("info", "正在检查更新…");
  const s = await refreshStatus();
  renderInlineUpdate(s);
  if (s && s.update_available) {
    appendLog("ok", "发现新版本 v" + s.update_available);
  } else {
    appendLog("ok", "已是最新版本 (v" + (s ? s.app_version : "?") + ")");
  }
});
byId("btn-inline-update").addEventListener("click", () => {
  const ver = byId("btn-inline-update").textContent?.replace("立即更新 v", "") ?? "";
  if (ver) void startSelfUpdate(ver);
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
    showToast("日志已复制到剪贴板", "ok");
  } catch {
    appendLog("warn", "复制失败,请手动全选复制");
    showToast("复制失败,请手动全选复制", "err");
  }
});
function renderLogEmpty() {
  logBody.innerHTML =
    '<div class="log-empty">' +
    '<span class="log-empty-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>' +
    '<span class="log-empty-title">日志将在这里实时显示</span>' +
    '<span class="log-empty-sub">运行、同步、更新的过程都会记录在这里</span>' +
    "</div>";
}
byId("btn-clear-log").addEventListener("click", () => {
  renderLogEmpty();
  logLines = 0;
});
byId("banner-copy").addEventListener("click", () =>
  byId("btn-copy-log").click()
);
byId("banner-close").addEventListener("click", hideBanner);

// ── 设置弹层 ──────────────────────────────────────────
const settingsModal = byId("settings-modal");

function openSettings() {
  byId<HTMLInputElement>("share-path-input").value = cfgCache?.share_path ?? "";
  byId<HTMLInputElement>("cfg-data-share-path").value = cfgCache?.data_share_path ?? "";
  byId<HTMLInputElement>("opt-auto-sync").checked = cfgCache?.auto_sync ?? true;
  settingsModal.hidden = false;
}
byId("btn-settings").addEventListener("click", openSettings);
byId("btn-cancel-config").addEventListener("click", () => {
  settingsModal.hidden = true;
});
byId("btn-save-config").addEventListener("click", async () => {
  const sharePath = byId<HTMLInputElement>("share-path-input").value.trim();
  const dataSharePath = byId<HTMLInputElement>("cfg-data-share-path").value.trim();
  const autoSync = byId<HTMLInputElement>("opt-auto-sync").checked;
  try {
    await invoke("save_config", {
      cfg: { share_path: sharePath, data_share_path: dataSharePath, auto_sync: autoSync },
    });
    cfgCache = { share_path: sharePath, data_share_path: dataSharePath, auto_sync: autoSync };
    appendLog("ok", "设置已保存");
    showToast("设置已保存", "ok");
    settingsModal.hidden = true;
    if (sharePath) {
      await runSync(true);
      await refreshStatus();
    }
  } catch (e) {
    appendLog("error", "保存失败: " + e);
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModal.hidden) settingsModal.hidden = true;
  if (e.key === "Escape" && !sharePicker.hidden) sharePicker.hidden = true;
});
byId("share-path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    byId("btn-save-config").click();
  }
});

// ── 状态刷新 ──────────────────────────────────────────
async function refreshStatus() {
  try {
    const s = await invoke<Status>("get_status");
    // cfgCache 的权威来源是 init 的 get_config 和设置弹层的保存流程,
    // 这里只负责在缺失时初始化,并跟随状态同步 share_path,绝不覆盖用户保存的 auto_sync。
    if (!cfgCache) {
      cfgCache = { share_path: s.share_path, data_share_path: "", auto_sync: true };
    } else {
      cfgCache = { ...cfgCache, share_path: s.share_path };
    }
    // 产物存在性:本次运行跑出结果,或本地已有历史产物,都解锁对应按钮
    hasDashboard = s.has_dashboard;
    hasOutput = s.has_output;
    setAppState(appState);
    setVersionBadge(s.synced ? s.version : "未同步");
    byIdText("app-version-text", "当前版本 V" + s.app_version);
    const net = byId("net-status");
    const netText = byId("net-text");
    net.classList.remove("ok", "bad");
    if (!s.share_path) {
      net.classList.add("bad");
      netText.textContent = "未配置共享盘";
    } else if (s.share_ok) {
      net.classList.add("ok");
      netText.textContent = "共享盘已连接";
    } else if (s.share_reachable && !s.synced) {
      net.classList.add("bad");
      netText.textContent = "已连接,等待代码推送";
    } else if (s.synced) {
      net.classList.add("bad");
      netText.textContent = "离线模式(缓存可用)";
    } else {
      net.classList.add("bad");
      netText.textContent = "共享盘不可达";
    }
    // 壳子更新提示:发现新版本时显示更新横幅(一键自动更新)
    if (s.update_available && !updateNoticeShown) {
      byIdText("update-text", "发现新版本 v" + s.update_available + ",可一键自动更新(约 1 分钟,无需卸载)");
      byId("update-banner").hidden = false;
    }
    if (!s.update_available) {
      byId<HTMLButtonElement>("btn-inline-update").hidden = true;
      byId<HTMLElement>("update-hint").hidden = true;
    }
    if (s.env_ok) {
      appendLog("ok", "运行环境就绪: " + s.python);
    } else if (s.synced) {
      if (!setupInProgress) {
        appendLog("warn", "运行环境未就绪,正在自动安装(首次需要几分钟,请耐心等待)…");
        setupInProgress = true;
        setAppState("setting-up");
        setDetail("首次安装运行环境(约 5-10 分钟,仅一次,之后启动秒开)…");
        byId<HTMLElement>("setup-progress").hidden = false;
        byIdText("setup-progress-count", "0/3");
        byIdText("setup-progress-name", "准备中…");
        byId<HTMLElement>("setup-progress-fill").style.width = "0%";
        byId<HTMLElement>("setup-progress-fill").classList.remove("failed");
        void invoke("setup_env").catch((e) => {
          // 后端启动失败不会发 setup-done,必须在此复位,否则会一直卡在 setting-up
          setupInProgress = false;
          appendLog("error", "环境安装启动失败: " + e);
          setAppState("failed");
        });
      }
    } else {
      appendLog("warn", "运行环境未就绪,同步代码后将自动安装");
    }
    checkCodeUpdate(s);
    return s;
  } catch (e) {
    appendLog("error", "获取状态失败: " + e);
    return null;
  }
}

// ── 半残环境自愈 ──────────────────────────────────────
// health_check 不通过(venv 存在但依赖缺失)时自动重跑 setup_env,补装缺失包。
// 复用 setupInProgress 守卫,避免并发重复安装;setup-done 监听器负责复位守卫。
function autoRepairEnv() {
  if (setupInProgress) return;
  appendLog("warn", "环境自检未通过,自动修复中…");
  setupInProgress = true;
  setAppState("setting-up");
  setDetail("环境自检未通过,正在自动修复…");
  byId<HTMLElement>("setup-progress").hidden = false;
  byIdText("setup-progress-name", "环境自检未通过,自动修复中…");
  byId<HTMLElement>("setup-progress-fill").classList.remove("failed");
  void invoke("setup_env").catch((e) => {
    // 后端启动失败不会发 setup-done,必须在此复位,否则会一直卡在 setting-up
    setupInProgress = false;
    appendLog("error", "环境修复启动失败: " + e);
    setAppState("failed");
  });
}

// ── 事件监听 ──────────────────────────────────────────
listen<LogLine>("pipeline-log", (e) => {
  appendLog(e.payload.level, e.payload.text);
  // 最后阶段(生成看板,长耗时)的子阶段通报:解析日志中的 [n/m] 标记,
  // 持续反馈活动,避免长时间无进展误以为假死。分母取日志里的真实值,不写死。
  if (pipelineTotal > 0 && pipelineN === pipelineTotal && running) {
    const text = e.payload.text.trim();
    if (!text.startsWith("[STAGE")) {
      const m = text.match(/^\[(\d+)\/(\d+)\]\s*(.+)/);
      if (m) {
        const sub = parseInt(m[1], 10);
        const subTotal = parseInt(m[2], 10);
        if (subTotal > 0) {
          stageProgressFloor(sub / subTotal);
          setDetail(
            (pipelineStageName || "最后阶段") +
              " — " +
              m[3].slice(0, 30) +
              " (" +
              sub +
              "/" +
              subTotal +
              ")"
          );
        }
      }
    }
  }
});
listen<StageEvent>("pipeline-stage", (e) => {
  const { n, total, name } = e.payload;
  pipelineTotal = total;
  pipelineN = n;
  pipelineStageName = name;
  // 步骤条完全由流水线上报驱动:阶段数变化时重建,名称以事件为准
  if (total !== stepperTotal) buildStepper(total);
  const li = stepperItems[n - 1];
  if (li && name) {
    const nameEl = li.querySelector(".s-name");
    if (nameEl) nameEl.textContent = name;
  }
  setStageState(n - 1, "active");
  // 精确进度:按各阶段实测耗时加权 + 阶段内时间插值
  beginStageProgress(n, total, name);
  appendLog("stage", "[STAGE " + n + "/" + total + "] " + name, true);
});
listen<DoneEvent>("pipeline-done", (e) => {
  // 停止后立即重跑时,旧任务的 done 会迟到:pid 对不上说明不是当前任务,直接丢弃
  if (e.payload.pid !== lastJobId) return;
  stageProgressStop();
  // error 非空 = 用户手动停止
  if (e.payload.error) {
    appendLog(
      "warn",
      "任务已被用户停止 (耗时 " + fmtDuration(e.payload.duration_ms) + ")"
    );
    setDetail("已停止");
    setAppState("idle");
    return;
  }
  const { ok, code, duration_ms } = e.payload;
  const msg =
    (ok ? "流水线执行完成" : "流水线执行失败") +
    " (退出码 " +
    (code ?? "—") +
    ",耗时 " +
    fmtDuration(duration_ms) +
    ")";
  appendLog(ok ? "ok" : "error", msg);
  if (ok) {
    setDetail("完成!可打开看板查看结果");
    setAppState("done");
  } else {
    // 标红实际失败的阶段(没有收到过阶段事件时退化为不标)
    if (pipelineN >= 1) setStageState(pipelineN - 1, "failed");
    setDetail("执行失败,请查看上方红色日志");
    setAppState("failed");
    showBanner("流水线执行失败(退出码 " + (code ?? "—") + ")。点右侧「复制日志」把日志发给开发者。");
  }
});
listen<SyncResult>("sync-done", (e) => {
  setVersionBadge(e.payload.version);
  appendLog("info", "版本: " + e.payload.version);
});
listen<{ n: number; total: number; name: string }>("setup-stage", (e) => {
  byId<HTMLElement>("setup-progress").hidden = false;
  byIdText("setup-progress-count", e.payload.n + "/" + e.payload.total);
  byIdText("setup-progress-name", e.payload.name);
  (byId<HTMLElement>("setup-progress-fill").style as any).width =
    (e.payload.n / e.payload.total * 100) + "%";
});
listen<boolean>("setup-done", (e) => {
  const ok = e.payload;
  setupInProgress = false;
  appendLog(ok ? "ok" : "error", ok ? "环境安装完成" : "环境安装失败");
  setAppState(ok ? "idle" : "failed");
  void refreshStatus();
  if (ok) {
    byId<HTMLElement>("setup-progress-fill").style.width = "100%";
    byIdText("setup-progress-name", "环境准备完成");
    window.setTimeout(() => {
      byId<HTMLElement>("setup-progress").hidden = true;
      byId<HTMLElement>("setup-progress-fill").style.width = "0%";
      byIdText("setup-progress-name", "");
      byId<HTMLElement>("setup-progress-fill").classList.remove("failed");
    }, 2000);
    void invoke<HealthResult>("health_check")
      .then((h) => {
        appendLog(h.ok ? "ok" : "warn", "环境检查: " + h.message);
        // 半残环境自愈:依赖缺失时自动重跑 setup_env 补齐
        if (!h.ok) autoRepairEnv();
      })
      .catch((err) => appendLog("warn", "环境检查失败: " + err));
  } else {
    byIdText("setup-progress-name", "环境准备失败,请查看日志");
    byId<HTMLElement>("setup-progress-fill").classList.add("failed");
  }
});

// ── 启动流程 ──────────────────────────────────────────
async function init() {
  hideBanner();
  showStepperPlaceholder();
  appendLog("info", "看板助手启动…");
  const cfg = await invoke<AppConfig>("get_config").catch(() => null);
  if (cfg) {
    cfgCache = cfg;
  }
  // 启动时反馈上次更新结果
  try {
    const r = await invoke<string | null>("take_update_result");
    if (r === "ok") {
      appendLog("ok", "已成功更新到当前版本");
      showBanner("已成功更新到当前版本", "ok");
      window.setTimeout(() => hideBanner(), 5000);
    } else if (r && r.startsWith("fail:")) {
      const code = r.slice(5);
      const msg = "上次自动更新失败(安装器退出码 " + code + "),已回退旧版,可重试";
      appendLog("error", msg);
      showBanner(msg);
    }
  } catch {
    // 忽略
  }
  const s = await refreshStatus();
  if (!cfg || !cfg.share_path) {
    appendLog("warn", "首次使用:请点击右上角「设置」填写共享盘代码目录");
    openSettings();
    if (!setupInProgress) setAppState("idle");
    return;
  }
  if (!s) return;
  if (cfg.auto_sync && s.share_ok) {
    await runSync(true);
    // 同步完成后必须重新评估状态:首次运行时上面的 refreshStatus 在同步前执行,
    // 彼时 synced=false 不会触发环境安装;这里补齐「首次运行:同步→自动装环境」链路
    await refreshStatus();
  } else if (!s.share_ok) {
    if (s.synced) {
      appendLog(
        "warn",
        "共享盘不可达,进入离线模式:使用本地缓存代码 (版本 " + s.version + ")"
      );
      if (!setupInProgress) setAppState("idle");
    } else if (s.share_reachable) {
      appendLog(
        "warn",
        "共享盘已连接,但上面还没有代码(等开发者推送后可点「更新代码」重试)"
      );
      if (!setupInProgress) setAppState("idle");
    } else {
      appendLog(
        "error",
        "共享盘不可达且本地无代码缓存: " + cfg.share_path + ",请检查网络后点「更新代码」重试"
      );
      setAppState("failed");
    }
  }
  if (s.env_ok) {
    // 启动时做一次环境健康检查,不阻塞启动流程
    void invoke<HealthResult>("health_check")
      .then((h) => {
        appendLog(h.ok ? "ok" : "warn", "环境检查: " + h.message);
        // 半残环境自愈:venv 存在但依赖缺失时自动重跑 setup_env 补齐
        if (!h.ok) autoRepairEnv();
      })
      .catch((e) => appendLog("warn", "环境检查失败: " + e));
  }
  if (!setupInProgress) setAppState("idle");
}

void init();

// 首帧绘制完成后通知壳显示窗口(lib.rs 监听 frontend-ready 后才 show,
// 配合 visible:false 创建,消除启动白闪)。双 rAF 保证至少一帧已实际渲染。
// 壳侧另有 3.5 秒兜底显示,此处失败(emit 异常)也不会导致窗口永不出现。
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    void emit("frontend-ready");
  })
);
