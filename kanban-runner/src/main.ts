import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Sortable from "sortablejs";

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
  // 蛇形 S 形流程带:row1 = 前 ceil(n/2) 个(左→右),row2 = 其余(视觉右→左回绕)。
  // DOM 始终按流程顺序 append(row2 用 flex-direction:row-reverse 视觉从右往左排);
  // n<=3 时单行(不渲染 row2 与绕下连接符)。
  const rowLen = Math.ceil(total / 2);
  const row2Count = total - rowLen;
  const row1 = document.createElement("div");
  row1.className = "stepper-row";
  const row2 = row2Count > 0 ? document.createElement("div") : null;
  if (row2) row2.className = "stepper-row row-reverse";
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
    const row = i < rowLen ? row1 : row2!;
    row.appendChild(li);
    stepperItems.push(li); // 保持流程顺序,setStageState/阶段名按索引定位不变
    // 连续轨道:每节点后插 <span class="stepper-rail">(flex:1 拉伸,零 gap 贴合节点);
    // 行末节点不插轨道(最后一段由绕下肘线/无轨道承接)
    const isLastOfRow = i === rowLen - 1 || i === total - 1;
    if (!isLastOfRow) {
      const rail = document.createElement("span");
      rail.className = "stepper-rail";
      row.appendChild(rail);
    }
  }
  stepperEl.appendChild(row1);
  if (row2) {
    // 绕下肘线:纯 CSS(border-right 竖线,见 style.css),空容器
    const turn = document.createElement("div");
    turn.className = "stepper-turn";
    stepperEl.appendChild(turn);
    stepperEl.appendChild(row2);
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
    // 0.3.24：选中/拉取即亮出数据条（跑批后被 [DATA-ID] 身份细化覆盖）
    const idRow = byId("data-id-row");
    byId("data-id-text").textContent = "已选数据 · " + name;
    idRow.classList.remove("stale");
    idRow.hidden = false;
  } else {
    dataFileEl.hidden = true;
    byId("data-id-row").hidden = true;
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
  // 弹出层(色板/列菜单)Esc 统一关闭,优先于其它层级
  if (e.key === "Escape" && openPopup) closePopup();
  else if (e.key === "Escape" && !settingsModal.hidden) settingsModal.hidden = true;
  else if (e.key === "Escape" && !sharePicker.hidden) sharePicker.hidden = true;
  // 抽屉优先于编辑器关闭;编辑器走未保存拦截
  else if (e.key === "Escape" && !byId("re-drawer-mask").hidden) closeDrawer();
  else if (e.key === "Escape" && !byId("risk-modal").hidden) tryCloseRiskEditor();
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
// ── 0.3.24(r24)：数据身份（流水线 [DATA-ID] 单行 JSON 上报 → 状态条）──
listen<string>("data-identity", (e) => {
  try {
    const d = JSON.parse(e.payload);
    const parts: string[] = [];
    if (d.source_name) parts.push(d.source_name);
    if (d.source_mtime_str) parts.push("修改于 " + d.source_mtime_str);
    if (d.channel_str) parts.push(d.channel_str);
    if (d.row_count != null) parts.push(Number(d.row_count).toLocaleString() + " 行");
    const fr = d.freshness || {};
    if (fr.is_stale) {
      parts.push("⚠ 共享盘有更新: " + (fr.newest_share_file || "") + "（" + (fr.newest_share_mtime_str || "") + "）");
    }
    const idRow = byId("data-id-row");
    byId("data-id-text").textContent = "数据身份 · " + parts.join(" · ");
    idRow.classList.toggle("stale", !!fr.is_stale);
    idRow.hidden = false;
  } catch (err) {
    appendLog("warn", "数据身份解析失败: " + err);
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

// ── 风险文档编辑(0.3.26,R 面编辑功能;JSON 契约见 §9.5) ──
interface RiskKpiCard {
  title: string;
  value: string;
  sub: string;
  /** red|orange|green|gray|none */
  level: string;
  source: "derived" | "override" | "custom";
  derived_value: string;
  stale: boolean;
}
interface RiskCell {
  text: string;
  color: string;
}
interface RiskRow {
  cells: RiskCell[];
  style: { row_color: string };
}
interface RiskColMeta {
  name: string;
  locked: boolean;
}
interface RiskTable {
  columns: string[];
  col_meta: RiskColMeta[];
  rows: RiskRow[];
}
/** §9.5 JSON 协议契约(字段名与 Python 单一真源逐字一致) */
interface RiskDoc {
  month: string;
  mtime: number;
  header_raw: string;
  kpi_cards: RiskKpiCard[];
  risk_table: RiskTable;
  action_table: RiskTable;
  notes_section: string;
  caliber_raw: string;
  derived_snapshot: Record<string, number>;
  legend: Record<string, string>;
}
interface RiskMonthInfo {
  month: string;
  modified: string;
}
interface RiskMonths {
  months: RiskMonthInfo[];
  current: string;
}
interface RiskWriteResult {
  render_ok: boolean;
  log_tail: string;
}
interface RiskCellRef {
  table: RiskTable;
  row: number;
  col: number;
}

const SEMANTIC_COLORS = ["red", "orange", "green", "gray", "none"] as const;
/** 删除按钮统一用垃圾桶 SVG(与拖拽把手 ⠿ 形区分,P2 区分度修复);currentColor 继承红色 tint */
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const RISK_DATE_COL = /日期|时间|截止|期限/;
const RISK_NUM_COL = /金额|数量|合计|毛利/;
const RISK_REQ_COL = /等级|状态|事项|行动|问题|描述/;
const RISK_DATE_VALUE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;
const RISK_NUM_VALUE = /^-?[\d,]+(\.\d+)?%?(万)?$/;

let riskDoc: RiskDoc | null = null;
let riskMonths: RiskMonthInfo[] = [];
let riskCurrentMonth = "";
let riskDirty = false;
let riskSaving = false;
let riskSourceEditable = false;
let riskSortables: Sortable[] = [];
let drawerCtx: RiskCellRef | null = null;

/** 列枚举(下拉)判定:等级=高中低 / 状态=待处理·跟进中·已关闭 */
function riskColEnum(name: string): string[] | null {
  if (name.includes("等级")) return ["高", "中", "低"];
  if (name.includes("状态")) return ["待处理", "跟进中", "已关闭"];
  return null;
}
function colLocked(table: RiskTable, idx: number): boolean {
  return table.col_meta[idx]?.locked === true;
}
function fmtDateTime(secs: number): string {
  if (!secs || secs <= 0) return "—";
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
/** 数值列千分位显示(裁决 E):仅纯数字串格式化(整数位每三位逗号),带 万/% 等后缀原样保留 */
function fmtThousands(v: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(v.trim());
  if (!m) return v;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[3] ?? "");
}
function riskSetStatus(kind: "err" | "ok" | "info", text: string) {
  const el = byId("re-status");
  el.className = "re-status " + kind;
  el.textContent = text;
  el.hidden = false;
}
function riskHideStatus() {
  byId("re-status").hidden = true;
}
function riskFootStatus(text: string) {
  byId("re-foot-status").textContent = text;
}
function markRiskDirty() {
  riskDirty = true;
  byId("re-btn-open-dash").hidden = true;
}
function destroyRiskSortables() {
  riskSortables.forEach((s) => s.destroy());
  riskSortables = [];
}

// ── 统一弹出层管理(修复:色板/列菜单等浮层点击外部不消失) ──
// 单一 document mousedown 监听 + 当前打开弹出注册表:打开新弹出先关旧,
// 点击弹出外部任意处/Esc 统一关闭;所有浮层(色板/列菜单)共用,不再各写一套
let openPopup: { el: HTMLElement; close: () => void } | null = null;
function closePopup() {
  if (openPopup) {
    openPopup.close();
    openPopup = null;
  }
}
function togglePopup(wrap: HTMLElement, panel: HTMLElement, open: () => void) {
  if (openPopup && openPopup.el === wrap) {
    closePopup();
    return;
  }
  closePopup();
  // 关闭即清空面板内容(懒构建配套):同一时刻 DOM 中只存在已打开面板的选项,
  // 规避隐藏面板的色块/菜单项被全局选择器(如 .p-red)误点——CDP 实测断链根因
  openPopup = { el: wrap, close: () => { panel.hidden = true; panel.innerHTML = ""; } };
  open();
}
document.addEventListener("mousedown", (e) => {
  if (openPopup && !openPopup.el.contains(e.target as Node)) closePopup();
});
/** 浮层定位:position:fixed 挂视口(先脱离文档流,防流内重排致锚点漂移);右缘越界左移;
 *  下方空间不足自动翻转到锚点上方(防面板出视口不可点) */
function placePopup(panel: HTMLElement, anchor: HTMLElement, alignRight: boolean) {
  panel.style.position = "fixed";
  panel.style.zIndex = "80";
  const r = anchor.getBoundingClientRect();
  panel.style.left = alignRight ? "auto" : Math.max(8, Math.min(r.left, window.innerWidth - 150)) + "px";
  panel.style.right = alignRight ? Math.max(8, window.innerWidth - r.right) + "px" : "auto";
  // 先放屏外量高,再决定放锚点下方 or 上方
  panel.style.top = "-9999px";
  const h = panel.getBoundingClientRect().height || 30;
  const belowOk = r.bottom + 4 + h <= window.innerHeight - 8;
  panel.style.top = (belowOk ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + "px";
}

/** 语义色板(统一弹出层:点色块外/Esc 自动关);面板懒构建,选色即写回数据模型并即时同步状态点;
 *  label 传入时渲染为"色点+文字标签"显性入口(裁决 B:行级标色不再是裸点猜点击) */
function buildColorPalette(current: string, onPick: (c: string) => void, label?: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "re-colors" + (label ? " re-colors-row" : "");
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "s-" + current;
  dot.title = label ? "标色(整行底色)" : "语义标色";
  const pal = document.createElement("span");
  pal.className = "re-palette";
  pal.hidden = true;
  // 懒构建:打开时才生成色块,关闭即清空(见 togglePopup)——隐藏面板的色块不在 DOM,
  // 全局选择器(如 .p-red)只会命中当前打开的面板(实测断链根因修复)
  const fill = () => {
    pal.innerHTML = "";
    for (const c of SEMANTIC_COLORS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "p-" + c;
      b.title = c === "none" ? "清除颜色" : (riskDoc?.legend?.[c] ?? c);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closePopup();
        // 即时反馈①:状态色点按钮类同步(所有色板通用,不依赖外层重渲染)
        dot.className = "s-" + c;
        onPick(c);
      });
      pal.appendChild(b);
    }
  };
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    togglePopup(wrap, pal, () => {
      fill();
      pal.hidden = false;
      // 先脱离文档流再读锚点 rect:面板在流内可见会撑开表格触发同步重排,
      // 导致锚点坐标在测量瞬间漂移(实测浮层错位 376px 的根因)
      pal.style.position = "fixed";
      placePopup(pal, dot, false);
    });
  };
  dot.addEventListener("click", open);
  wrap.appendChild(dot);
  if (label) {
    const tag = document.createElement("span");
    tag.className = "re-colors-tag";
    tag.textContent = label;
    tag.addEventListener("click", open);
    wrap.appendChild(tag);
  }
  wrap.appendChild(pal);
  return wrap;
}

/** 表格列头菜单:右插列/删列/改名;核心列(locked)置灰并提示(统一弹出层管理) */
function buildColMenu(table: RiskTable, colIdx: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "th-menu";
  const sum = document.createElement("button");
  sum.type = "button";
  sum.className = "th-menu-btn";
  sum.title = "列操作";
  sum.textContent = "⋮";
  const list = document.createElement("div");
  list.className = "th-menu-list";
  list.hidden = true;
  const locked = colLocked(table, colIdx);
  const name = table.columns[colIdx] ?? "";
  const mkBtn = (label: string, disabled: boolean, tip: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.disabled = disabled;
    b.title = tip;
    b.addEventListener("click", () => {
      closePopup();
      fn();
    });
    return b;
  };
  // 懒构建:打开时才生成菜单项,关闭即清空(见 togglePopup)
  const fill = () => {
    list.innerHTML = "";
    list.appendChild(
      mkBtn("右侧插入列", false, "在此列右侧新增一列", () => {
        const newName = window.prompt("新列名", "新列");
        if (newName === null) return;
        const n = newName.trim() || "新列";
        table.columns.splice(colIdx + 1, 0, n);
        table.col_meta.splice(colIdx + 1, 0, { name: n, locked: false });
        table.rows.forEach((r) => r.cells.splice(colIdx + 1, 0, { text: "", color: "none" }));
        markRiskDirty();
        renderRiskAll();
      })
    );
    list.appendChild(
      mkBtn(
        "删除此列",
        locked,
        locked ? "核心列,禁止删除(P0-5 保护)" : "删除「" + name + "」列",
        () => {
          if (locked) return;
          if (!window.confirm("确定删除列「" + name + "」?该列所有内容将一并移除。")) return;
          table.columns.splice(colIdx, 1);
          table.col_meta.splice(colIdx, 1);
          table.rows.forEach((r) => r.cells.splice(colIdx, 1));
          markRiskDirty();
          renderRiskAll();
        }
      )
    );
    list.appendChild(
      mkBtn(
        "重命名",
        locked,
        locked ? "核心列,禁止改名(P0-5 保护)" : "修改列名",
        () => {
          if (locked) return;
          const nn = window.prompt("新的列名", name);
          if (nn === null) return;
          const n = nn.trim();
          if (!n || n === name) return;
          table.columns[colIdx] = n;
          if (table.col_meta[colIdx]) table.col_meta[colIdx].name = n;
          else table.col_meta[colIdx] = { name: n, locked: false };
          markRiskDirty();
          renderRiskAll();
        }
      )
    );
  };
  wrap.appendChild(sum);
  wrap.appendChild(list);
  sum.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopup(wrap, list, () => {
      fill();
      list.hidden = false;
      list.style.position = "fixed"; // 先脱离文档流再定位(同色板,防流内重排致锚点漂移)
      placePopup(list, sum, true);
    });
  });
  return wrap;
}

/** 列类型分档(P0-1 列宽规范):枚举/日期/数值固定宽,文本弹性,操作列 92px */
function riskColClass(name: string): string {
  if (riskColEnum(name)) return "col-enum";
  if (RISK_DATE_COL.test(name)) return "col-date";
  if (RISK_NUM_COL.test(name)) return "col-num";
  return "col-text";
}

/** 渲染一张动态列表格(风险表/行动表同构);行操作=拖拽+标色+删除(拖拽替代上下移),长文本抽屉按列挂载 */
function renderRiskTable(container: HTMLElement, table: RiskTable, label: string) {
  destroyRiskSortables(); // 防多实例:每次渲染先销毁旧 Sortable(修复:行拖动动不了)
  container.innerHTML = "";
  // 结构自检:col_meta 与 columns 对齐(旧文件缺元数据时兜底)
  while (table.col_meta.length < table.columns.length) {
    const i = table.col_meta.length;
    table.col_meta.push({ name: table.columns[i], locked: false });
  }
  // 表格工具栏(裁决 C:新增列入口固定在表格上方,不随横向滚动溢出)
  const bar = document.createElement("div");
  bar.className = "re-table-bar";
  const addCol = document.createElement("button");
  addCol.type = "button";
  addCol.className = "mini-btn";
  addCol.textContent = "＋ 新增列";
  addCol.title = "在表格最右侧新增一列";
  addCol.addEventListener("click", () => {
    const newName = window.prompt("新列名", "新列");
    if (newName === null) return;
    const n = newName.trim() || "新列";
    table.columns.push(n);
    table.col_meta.push({ name: n, locked: false });
    table.rows.forEach((r) => r.cells.push({ text: "", color: "none" }));
    markRiskDirty();
    renderRiskAll();
  });
  bar.appendChild(addCol);
  container.appendChild(bar);
  // 横向滚动容器与外层解耦:工具栏不参与滚动
  const scroll = document.createElement("div");
  scroll.className = "re-table-scroll";
  const tbl = document.createElement("table");
  tbl.className = "re-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const toolsTh = document.createElement("th");
  toolsTh.className = "col-tools";
  toolsTh.innerHTML = '<div class="th-in" style="color:var(--text-faint)">操作</div>';
  hr.appendChild(toolsTh);
  table.columns.forEach((colName, ci) => {
    const th = document.createElement("th");
    th.classList.add(riskColClass(colName));
    if (colLocked(table, ci)) th.classList.add("col-locked");
    const inn = document.createElement("div");
    inn.className = "th-in";
    const nm = document.createElement("span");
    nm.textContent = colName + (colLocked(table, ci) ? " 🔒" : "");
    if (colLocked(table, ci)) nm.title = "核心列:禁止删除/改名(等级、状态列受保护)";
    inn.appendChild(nm);
    inn.appendChild(buildColMenu(table, ci));
    th.appendChild(inn);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.rows.forEach((row, ri) => {
    const tr = document.createElement("tr");
    tr.setAttribute("data-ri", String(ri));
    if (row.style?.row_color && row.style.row_color !== "none") {
      tr.classList.add("row-c-" + row.style.row_color);
    }
    // 行工具条:拖拽把手 + 行级色 + 删除(操作列 92px,P1-2)
    const toolTd = document.createElement("td");
    toolTd.className = "col-tools";
    const tools = document.createElement("div");
    tools.className = "re-row-tools";
    const drag = document.createElement("button");
    drag.type = "button";
    drag.className = "re-drag";
    drag.title = "按住拖拽排序";
    drag.textContent = "⠿";
    // 与单元格编辑事件隔离:按下把手即进入拖拽,不向单元格冒泡
    drag.addEventListener("mousedown", (e) => e.stopPropagation());
    tools.appendChild(drag);
    tools.appendChild(
      buildColorPalette(
        row.style?.row_color ?? "none",
        (c) => {
          if (!row.style) row.style = { row_color: c };
          else row.style.row_color = c;
          // 即时反馈②:直接切当前 tr 的行底色类(移除旧 row-c-*→条件加新类),
          // 不依赖整表重渲染——保证选色后 UI 立即变色
          for (const cls of Array.from(tr.classList)) {
            if (cls.startsWith("row-c-")) tr.classList.remove(cls);
          }
          if (c !== "none") tr.classList.add("row-c-" + c);
          markRiskDirty();
        },
        "标色 ▾"
      )
    );
    // P1-2:行工具条收纳(拖拽把手+标色+删除),↑↓ 移除——拖拽排序可替代
    const del = document.createElement("button");
    del.type = "button";
    del.className = "re-rm";
    del.title = "删除此行";
    del.innerHTML = TRASH_SVG;
    del.addEventListener("click", () => {
      table.rows.splice(ri, 1);
      markRiskDirty();
      renderRiskAll();
    });
    tools.appendChild(del);
    toolTd.appendChild(tools);
    tr.appendChild(toolTd);
    // 数据单元格(枚举下拉 / 日期 / 文本[数值千分位]+长文本抽屉)
    table.columns.forEach((colName, ci) => {
      const cell = row.cells[ci] ?? { text: "", color: "none" };
      if (!row.cells[ci]) row.cells[ci] = cell;
      const td = document.createElement("td");
      td.classList.add(riskColClass(colName));
      if (cell.color && cell.color !== "none") td.classList.add("cell-c-" + cell.color);
      const enumOpts = riskColEnum(colName);
      if (enumOpts) {
        const sel = document.createElement("select");
        enumOpts.forEach((opt) => {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          sel.appendChild(o);
        });
        if (cell.text && !enumOpts.includes(cell.text)) {
          const o = document.createElement("option");
          o.value = cell.text;
          o.textContent = cell.text + "(原值)";
          sel.appendChild(o);
        }
        sel.value = cell.text;
        sel.addEventListener("change", () => {
          cell.text = sel.value;
          markRiskDirty();
        });
        td.appendChild(sel);
      } else if (RISK_DATE_COL.test(colName)) {
        const inp = document.createElement("input");
        inp.type = "date";
        const m = RISK_DATE_VALUE.exec(cell.text);
        inp.value = m ? m[0].replace(/\//g, "-") : "";
        inp.title = "日期格式 YYYY-MM-DD";
        inp.addEventListener("input", () => {
          cell.text = inp.value;
          markRiskDirty();
        });
        td.appendChild(inp);
      } else {
        const inp = document.createElement("input");
        inp.type = "text";
        const isNum = RISK_NUM_COL.test(colName);
        // 裁决 E:数值列千分位显示;输入时存原始数字(去逗号),失焦重新格式化
        inp.value = isNum ? fmtThousands(cell.text) : cell.text;
        inp.placeholder = isNum ? "数值" : "";
        inp.addEventListener("input", () => {
          cell.text = isNum ? inp.value.replace(/,/g, "") : inp.value;
          markRiskDirty();
        });
        if (isNum) {
          inp.addEventListener("blur", () => {
            inp.value = fmtThousands(inp.value.replace(/,/g, ""));
          });
        }
        td.appendChild(inp);
        // P1-1:长文本宽幅抽屉入口仅在长文本列渲染(数值列不挂,避免控件堆叠)
        if (!isNum) {
          const exp = document.createElement("button");
          exp.type = "button";
          exp.className = "re-cell-expand";
          exp.title = "宽幅编辑(多条内容按 ｜ 拆行)";
          exp.textContent = "⤢";
          exp.addEventListener("click", () => openDrawer(table, ri, ci, label));
          td.appendChild(exp);
        }
      }
      // 裁决 A:格级涂色入口移除(密度灾难根源);cell.color 数据结构与 cell-c-* 渲染保留,
      // 历史 md 里的格级色照旧显色,仅不再提供逐格涂色 UI(行级标色覆盖小白场景)
      tr.appendChild(td);
    });
    // 补齐列数(防畸形数据)
    for (let ci = row.cells.length; ci < table.columns.length; ci++) {
      row.cells.push({ text: "", color: "none" });
    }
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  scroll.appendChild(tbl);
  container.appendChild(scroll);
  // 行尾追加行按钮
  const addRow = document.createElement("button");
  addRow.type = "button";
  addRow.className = "mini-btn";
  addRow.style.marginTop = "8px";
  addRow.textContent = "＋ 新增一行";
  addRow.addEventListener("click", () => {
    table.rows.push({
      cells: table.columns.map(() => ({ text: "", color: "none" })),
      style: { row_color: "none" },
    });
    markRiskDirty();
    renderRiskAll();
  });
  container.appendChild(addRow);
  // 行拖拽排序(SortableJS,P0-8;forceFallback+ghost 挂 body 规避滚动容器裁剪;结束按 DOM 顺序回写 rows)
  riskSortables.push(
    new Sortable(tbody, {
      handle: ".re-drag",
      draggable: "tr",
      animation: 150,
      forceFallback: true,
      fallbackOnBody: true,
      onEnd: () => {
        const order = Array.from(tbody.querySelectorAll("tr[data-ri]")).map((tr) =>
          Number((tr as HTMLTableRowElement).getAttribute("data-ri"))
        );
        table.rows = order.map((i) => table.rows[i]);
        markRiskDirty();
        renderRiskAll();
      },
    })
  );
}

/** KPI 卡区渲染:双行卡片(主行=标题/数值/把手/删除;副行=副文本/级别色/人工定值开关)+ 8 列 grid 预览 */
function renderKpiSection() {
  destroyRiskSortables(); // 防多实例堆叠(修复:KPI 卡拖动动不了)
  const list = byId("re-kpi-list");
  const preview = byId("re-kpi-preview");
  list.innerHTML = "";
  preview.innerHTML = "";
  const cards = riskDoc?.kpi_cards ?? [];
  cards.forEach((card, i) => {
    const row = document.createElement("div");
    row.className = "re-kpi-card";
    row.setAttribute("data-ki", String(i));
    // 主行:拖拽把手 + 标题 + 数值(收窄) + 删除
    const main = document.createElement("div");
    main.className = "re-kpi-main";
    const drag = document.createElement("span");
    drag.className = "re-drag";
    drag.title = "按住拖拽排序";
    drag.textContent = "⠿";
    drag.addEventListener("mousedown", (e) => e.stopPropagation());
    main.appendChild(drag);
    const title = document.createElement("input");
    title.value = card.title;
    title.placeholder = "标题";
    title.addEventListener("input", () => {
      card.title = title.value;
      markRiskDirty();
      renderKpiPreview();
    });
    main.appendChild(title);
    const value = document.createElement("input");
    value.className = "re-kpi-value";
    value.value = card.value;
    value.title = card.source === "derived" ? "派生卡数值自动跟随表格计算(只读)" : "人工填写的数值";
    value.readOnly = card.source === "derived";
    if (card.source !== "derived") value.placeholder = "派生值 " + (card.derived_value ?? "");
    value.addEventListener("input", () => {
      card.value = value.value;
      markRiskDirty();
      renderKpiPreview();
    });
    main.appendChild(value);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "re-kpi-del";
    del.title = "删除此卡";
    del.innerHTML = TRASH_SVG;
    del.addEventListener("click", () => {
      cards.splice(i, 1);
      markRiskDirty();
      renderKpiSection();
    });
    main.appendChild(del);
    row.appendChild(main);
    // 副行:副文本 + 级别色点 + 人工定值开关 + 「人工值」角标
    const subRow = document.createElement("div");
    subRow.className = "re-kpi-sub2";
    const sub = document.createElement("input");
    sub.className = "re-kpi-sub";
    sub.value = card.sub;
    sub.placeholder = "副文本(卡片下方的小字说明)";
    sub.addEventListener("input", () => {
      card.sub = sub.value;
      markRiskDirty();
      renderKpiPreview();
    });
    subRow.appendChild(sub);
    subRow.appendChild(
      buildColorPalette(card.level ?? "none", (c) => {
        card.level = c;
        markRiskDirty();
        renderKpiPreview();
      })
    );
    // 覆盖开关(小白语义):勾选=人工定值;派生卡=自动跟随表格计算
    const manual = document.createElement("label");
    manual.className = "re-kpi-manual";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = card.source !== "derived";
    cb.title = "勾选=人工定值(此数值不随表格自动更新);取消=自动跟随表格计算";
    cb.addEventListener("change", () => {
      if (card.source === "custom") card.source = cb.checked ? "custom" : "override";
      else card.source = cb.checked ? "override" : "derived";
      if (card.source === "derived") card.value = card.derived_value ?? card.value;
      markRiskDirty();
      renderKpiSection();
    });
    manual.appendChild(cb);
    manual.appendChild(document.createTextNode("人工定值"));
    subRow.appendChild(manual);
    if (card.source !== "derived") {
      const badge = document.createElement("span");
      badge.className = "re-kpi-stale" + (card.stale ? " warn" : "");
      badge.textContent = "人工值";
      badge.title = card.stale
        ? "人工值与当前表格计算结果不一致;此数值不随表格自动更新"
        : "此数值不随表格自动更新";
      subRow.appendChild(badge);
    }
    row.appendChild(subRow);
    list.appendChild(row);
  });
  // 布局预览:n=0 隐藏整条;否则 repeat(min(n,8),1fr) 同渲染端
  if (cards.length === 0) {
    preview.style.display = "none";
    return;
  }
  preview.style.display = "";
  preview.style.gridTemplateColumns = "repeat(" + Math.min(cards.length, 8) + ",minmax(0,1fr))";
  renderKpiPreview();
  riskSortables.push(
    new Sortable(list, {
      handle: ".re-drag",
      draggable: ".re-kpi-card",
      animation: 150,
      forceFallback: true,
      fallbackOnBody: true,
      onEnd: () => {
        const order = Array.from(list.querySelectorAll(".re-kpi-card[data-ki]")).map((el) =>
          Number((el as HTMLElement).getAttribute("data-ki"))
        );
        riskDoc!.kpi_cards = order.map((i) => riskDoc!.kpi_cards[i]);
        markRiskDirty();
        renderKpiSection();
      },
    })
  );
}

function renderKpiPreview() {
  const preview = byId("re-kpi-preview");
  preview.innerHTML = "";
  const cards = riskDoc?.kpi_cards ?? [];
  if (cards.length === 0) {
    preview.style.display = "none";
    return;
  }
  preview.style.display = "";
  preview.style.gridTemplateColumns = "repeat(" + Math.min(cards.length, 8) + ",minmax(0,1fr))";
  cards.forEach((card) => {
    const pv = document.createElement("div");
    pv.className = "re-kpi-pv";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = card.title;
    const v = document.createElement("div");
    v.className = "v";
    const dot = document.createElement("span");
    dot.className = "re-lv-dot " + (card.level ?? "none");
    v.appendChild(dot);
    v.appendChild(document.createTextNode(card.source === "derived" ? card.derived_value ?? card.value : card.value));
    const s = document.createElement("div");
    s.className = "s";
    // 小白语义:仅人工卡显示「人工值」角标;派生卡不显示任何来源标记(不渲染 source 枚举)
    s.textContent = card.sub + (card.source !== "derived" ? " · 人工值" + (card.stale ? "(与表格不一致)" : "") : "");
    pv.appendChild(t);
    pv.appendChild(v);
    pv.appendChild(s);
    preview.appendChild(pv);
  });
}

function renderRiskAll() {
  if (!riskDoc) return;
  destroyRiskSortables();
  byId("re-header").textContent = riskDoc.header_raw ?? "";
  byId("re-caliber").textContent = riskDoc.caliber_raw ?? "";
  const notes = byId<HTMLTextAreaElement>("re-notes");
  notes.value = riskDoc.notes_section ?? "";
  renderKpiSection();
  renderRiskTable(byId("re-risk-table"), riskDoc.risk_table, "风险表");
  renderRiskTable(byId("re-action-table"), riskDoc.action_table, "行动表");
  byId("re-meta").textContent =
    "文件修改:" +
    fmtDateTime(riskDoc.mtime) +
    " · KPI " +
    riskDoc.kpi_cards.length +
    " 张 · 风险 " +
    riskDoc.risk_table.rows.length +
    " 行 · 行动 " +
    riskDoc.action_table.rows.length +
    " 行";
}

function renderMonthSelect(current: string) {
  const sel = byId<HTMLSelectElement>("re-month");
  sel.innerHTML = "";
  for (const m of riskMonths) {
    const o = document.createElement("option");
    o.value = m.month;
    o.textContent = m.month + (m.modified ? " · " + m.modified : "");
    sel.appendChild(o);
  }
  sel.value = current;
}

async function loadRiskMonth(month: string) {
  if (!month) return;
  riskSetStatus("info", "正在载入 " + month + " …");
  try {
    const raw = await invoke<string>("read_risk_doc", { month });
    riskDoc = JSON.parse(raw) as RiskDoc;
    riskCurrentMonth = riskDoc.month || month;
    riskDirty = false;
    riskSourceEditable = false;
    const src = byId<HTMLTextAreaElement>("re-source");
    src.readOnly = true;
    src.value = "";
    byId("re-btn-source-edit").hidden = false;
    byId("re-btn-open-dash").hidden = true;
    riskFootStatus("");
    renderRiskAll();
    riskHideStatus();
  } catch (e) {
    riskSetStatus("err", "载入 " + month + " 失败: " + e);
  }
}

async function openRiskEditor() {
  byId("risk-modal").hidden = false;
  riskSetStatus("info", "正在读取月份列表…");
  try {
    const m = await invoke<RiskMonths>("list_risk_months");
    riskMonths = m.months;
    if (m.months.length === 0) {
      riskDoc = null;
      riskSetStatus("err", "未找到风险文档:请先运行流水线生成看板(output\\dashboard\\risk_action_YYYYMM.md)");
      return;
    }
    renderMonthSelect(m.current || m.months[0].month);
    await loadRiskMonth(m.current || m.months[0].month);
  } catch (e) {
    riskSetStatus("err", "读取月份列表失败: " + e);
  }
}

/** 关闭拦截:保存中禁止关闭;有未保存修改需 confirm */
function tryCloseRiskEditor() {
  if (riskSaving) {
    showToast("正在保存,请稍候", "info");
    return;
  }
  if (riskDirty && !window.confirm("有未保存的修改,确定关闭吗?修改将丢失。")) return;
  byId("risk-modal").hidden = true;
  riskDoc = null;
  riskDirty = false;
  destroyRiskSortables();
  riskHideStatus();
  riskFootStatus("");
}

// ── 长文本宽幅抽屉 ────────────────────────────────────
function openDrawer(table: RiskTable, row: number, col: number, label: string) {
  drawerCtx = { table, row, col };
  const cell = table.rows[row]?.cells[col];
  if (!cell) return;
  byId("re-drawer-title").textContent =
    label + " · 第 " + (row + 1) + " 行 · 「" + (table.columns[col] ?? "") + "」";
  const list = byId("re-drawer-list");
  list.innerHTML = "";
  const parts = cell.text.length === 0 ? [""] : cell.text.split("｜");
  parts.forEach((p) => addDrawerItem(p));
  byId("re-drawer-mask").hidden = false;
}
function addDrawerItem(text: string) {
  const list = byId("re-drawer-list");
  const item = document.createElement("div");
  item.className = "re-drawer-item";
  const ta = document.createElement("textarea");
  ta.rows = 2;
  ta.value = text;
  ta.addEventListener("input", () => {
    ta.classList.toggle("invalid", ta.value.includes("\n"));
  });
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "re-rm";
  rm.title = "删除此条";
  rm.innerHTML = TRASH_SVG;
  rm.addEventListener("click", () => {
    list.removeChild(item);
  });
  item.appendChild(ta);
  item.appendChild(rm);
  list.appendChild(item);
  ta.focus();
}
function closeDrawer() {
  byId("re-drawer-mask").hidden = true;
  drawerCtx = null;
}
byId("re-drawer-add").addEventListener("click", () => addDrawerItem(""));
byId("re-drawer-cancel").addEventListener("click", closeDrawer);
byId("re-drawer-mask").addEventListener("click", (e) => {
  if (e.target === byId("re-drawer-mask")) closeDrawer();
});
byId("re-drawer-save").addEventListener("click", () => {
  if (!drawerCtx) return closeDrawer();
  const tas = Array.from(byId("re-drawer-list").querySelectorAll("textarea"));
  if (tas.some((ta) => ta.value.includes("\n"))) {
    showToast("单条内容不能包含换行,请拆成多条", "err");
    return;
  }
  const joined = tas.map((ta) => ta.value.trim()).join("｜");
  const cell = drawerCtx.table.rows[drawerCtx.row]?.cells[drawerCtx.col];
  if (cell) {
    cell.text = joined;
    markRiskDirty();
    renderRiskAll();
  }
  closeDrawer();
});

// ── 保存前校验(必填/数值/日期;错误行标红+定位,阻断保存) ──
function validateRiskDoc(): string[] {
  const errs: string[] = [];
  const tables: [string, RiskTable][] = [
    ["风险表", riskDoc!.risk_table],
    ["行动表", riskDoc!.action_table],
  ];
  document.querySelectorAll("#re-risk-table tr.re-row-err,#re-action-table tr.re-row-err").forEach((tr) => {
    tr.classList.remove("re-row-err");
  });
  for (const [label, table] of tables) {
    table.rows.forEach((row, ri) => {
      table.columns.forEach((colName, ci) => {
        const text = (row.cells[ci]?.text ?? "").trim();
        if (RISK_REQ_COL.test(colName) && !text) {
          errs.push(label + " 第 " + (ri + 1) + " 行「" + colName + "」:必填,不能为空");
          markErrRow(label, ri);
        } else if (text && RISK_DATE_COL.test(colName) && !RISK_DATE_VALUE.test(text)) {
          errs.push(label + " 第 " + (ri + 1) + " 行「" + colName + "」:应为日期(YYYY-MM-DD),当前「" + text + "」");
          markErrRow(label, ri);
        } else if (text && RISK_NUM_COL.test(colName) && !RISK_NUM_VALUE.test(text)) {
          errs.push(label + " 第 " + (ri + 1) + " 行「" + colName + "」:应为数值,当前「" + text + "」");
          markErrRow(label, ri);
        }
      });
    });
  }
  return errs;
}
function markErrRow(label: string, ri: number) {
  const container = byId(label === "风险表" ? "re-risk-table" : "re-action-table");
  const tr = container.querySelector('tr[data-ri="' + ri + '"]');
  if (tr) tr.classList.add("re-row-err");
}

function setRiskSavingUi(saving: boolean) {
  byId<HTMLButtonElement>("re-btn-save").disabled = saving;
  byId<HTMLButtonElement>("re-btn-reload").disabled = saving;
  byId<HTMLButtonElement>("re-btn-source").disabled = saving;
  byId<HTMLButtonElement>("re-btn-close").disabled = saving;
  byId<HTMLSelectElement>("re-month").disabled = saving;
}

async function saveRiskDoc() {
  if (!riskDoc || riskSaving) return;
  let payload: string;
  const inSourceMode = !byId("re-source-body").hidden;
  if (inSourceMode && riskSourceEditable) {
    // 源码模式已解锁:格式风险自负,直接以源码内容写入
    const srcText = byId<HTMLTextAreaElement>("re-source").value;
    try {
      JSON.parse(srcText);
      payload = srcText;
    } catch (e) {
      riskSetStatus("err", "源码不是合法 JSON,未保存: " + e);
      return;
    }
  } else {
    const errs = validateRiskDoc();
    if (errs.length > 0) {
      riskSetStatus("err", "校验未通过(" + errs.length + " 处),已标红定位:\n" + errs.slice(0, 8).join("\n"));
      const firstErr = byId("re-risk-table").querySelector("tr.re-row-err") ?? byId("re-action-table").querySelector("tr.re-row-err");
      firstErr?.scrollIntoView({ block: "center" });
      showToast("校验未通过,请修正标红行", "err");
      return;
    }
    payload = JSON.stringify(riskDoc);
  }
  riskSaving = true;
  setRiskSavingUi(true);
  riskFootStatus("保存中:写入文档并重新渲染看板,请稍候(约 1 分钟内)…");
  try {
    const r = await invoke<RiskWriteResult>("write_risk_doc", { month: riskCurrentMonth, payload });
    riskDirty = false;
    if (r.render_ok) {
      riskSetStatus("ok", "已保存,看板重渲染完成");
      byId("re-btn-open-dash").hidden = false;
      showToast("已保存并重渲染完成", "ok");
      riskFootStatus("");
      await loadRiskMonth(riskCurrentMonth);
      riskSetStatus("ok", "已保存,看板重渲染完成");
    } else {
      riskSetStatus("err", "内容已保存,但看板重渲染失败。重渲染日志尾部:\n" + r.log_tail);
      riskFootStatus("内容已保存,重渲染失败");
      showToast("内容已保存,重渲染失败", "err");
    }
  } catch (e) {
    const msg = String(e);
    let text = "保存失败: " + msg;
    // mtime 并发冲突:文件被其它进程改过,须重新载入
    if (/mtime|已被修改|修改时间|conflict/i.test(msg)) {
      text += "\n文件已被修改,请重新打开后再编辑(点击下方「重新载入」)。";
    }
    riskSetStatus("err", text);
    riskFootStatus("保存失败");
    showToast("保存失败", "err");
  } finally {
    riskSaving = false;
    setRiskSavingUi(false);
  }
}

// ── 编辑器事件绑定 ────────────────────────────────────
byId("btn-edit-risk").addEventListener("click", openRiskEditor);
byId("re-btn-close").addEventListener("click", tryCloseRiskEditor);
byId("risk-modal").addEventListener("click", (e) => {
  if (e.target === byId("risk-modal")) tryCloseRiskEditor();
});
byId("re-btn-save").addEventListener("click", () => void saveRiskDoc());
byId("re-btn-reload").addEventListener("click", async () => {
  if (riskSaving) return;
  if (riskDirty && !window.confirm("有未保存的修改,重新载入将丢失,继续吗?")) return;
  await loadRiskMonth(riskCurrentMonth);
});
byId("re-btn-open-dash").addEventListener("click", async () => {
  try {
    const p = await invoke<string>("open_dashboard");
    appendLog("ok", "已打开看板: " + p);
  } catch (e) {
    appendLog("error", "打开看板失败: " + e);
    showToast("打开看板失败: " + e, "err");
  }
});
byId<HTMLSelectElement>("re-month").addEventListener("change", async (e) => {
  if (riskSaving) return;
  const month = (e.target as HTMLSelectElement).value;
  if (month === riskCurrentMonth) return;
  if (riskDirty && !window.confirm("有未保存的修改,切换月份将丢失,继续吗?")) {
    (e.target as HTMLSelectElement).value = riskCurrentMonth;
    return;
  }
  await loadRiskMonth(month);
});
byId("re-kpi-add").addEventListener("click", () => {
  if (!riskDoc) return;
  riskDoc.kpi_cards.push({
    title: "新卡片",
    value: "",
    sub: "",
    level: "none",
    source: "custom",
    derived_value: "",
    stale: false,
  });
  markRiskDirty();
  renderKpiSection();
});
byId<HTMLTextAreaElement>("re-notes").addEventListener("input", (e) => {
  if (!riskDoc) return;
  riskDoc.notes_section = (e.target as HTMLTextAreaElement).value;
  markRiskDirty();
});
// 源码模式:默认只读展示;解锁编辑需二次确认(格式风险自负)
byId("re-btn-source").addEventListener("click", () => {
  if (!riskDoc) return;
  const sourceBody = byId("re-source-body");
  const formBody = byId("re-form-body");
  if (sourceBody.hidden) {
    byId<HTMLTextAreaElement>("re-source").value = JSON.stringify(riskDoc, null, 2);
    sourceBody.hidden = false;
    formBody.hidden = true;
    byId("re-btn-source").textContent = "表单模式";
  } else {
    sourceBody.hidden = true;
    formBody.hidden = false;
    byId("re-btn-source").textContent = "源码模式";
  }
});
byId("re-btn-source-edit").addEventListener("click", () => {
  if (!window.confirm("直接编辑源码可能破坏格式,风险自负,仍要继续吗?")) return;
  riskSourceEditable = true;
  byId<HTMLTextAreaElement>("re-source").readOnly = false;
  byId("re-btn-source-edit").hidden = true;
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
