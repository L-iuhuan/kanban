import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

interface SystemInfo {
  os: string;
  arch: string;
  cpu_cores: number;
  total_ram_gb: number;
  host_name: string;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("missing #" + id);
  return el as T;
}

// ── 自定义标题栏窗口控制 ────────────────────────────
const win = getCurrentWindow();
byId("btn-min").addEventListener("click", () => void win.minimize());
byId("btn-max").addEventListener("click", () => void win.toggleMaximize());
byId("btn-close").addEventListener("click", () => void win.close());

// ── 版本号 ──────────────────────────────────────────
getVersion()
  .then((v) => {
    byId("footer").textContent =
      "Tauri v" + v + " · Rust · WebView2 · 自定义标题栏 · 本应用由 vibe coding 生成";
  })
  .catch(() => {
    byId("footer").textContent = "Tauri · Rust · WebView2";
  });

// ── 1. Rust 命令:greet ─────────────────────────────
const nameInput = byId<HTMLInputElement>("name-input");
async function greet() {
  const name = nameInput.value.trim() || "Vibe Coder";
  try {
    const msg = await invoke<string>("greet", { name });
    byId("greet-output").textContent = msg;
  } catch (e) {
    byId("greet-output").textContent = "调用失败: " + e;
  }
}
byId("btn-greet").addEventListener("click", () => void greet());
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void greet();
});

// ── 2. 系统信息 ────────────────────────────────────
async function loadSysInfo() {
  try {
    const info = await invoke<SystemInfo>("system_info");
    byId("si-os").textContent = info.os;
    byId("si-arch").textContent = info.arch;
    byId("si-cpu").textContent = String(info.cpu_cores);
    byId("si-ram").textContent = info.total_ram_gb.toFixed(1) + " GB";
    byId("si-host").textContent = info.host_name;
  } catch (e) {
    byId("sysinfo").textContent = "读取失败: " + e;
  }
}
void loadSysInfo();
byId("btn-refresh").addEventListener("click", () => void loadSysInfo());

// ── 3. 文件对话框 ──────────────────────────────────
byId("btn-pick").addEventListener("click", async () => {
  try {
    const selected = await open({
      multiple: false,
      title: "选择一个文件",
    });
    byId("file-output").textContent = selected
      ? "已选择: " + selected
      : "未选择文件";
  } catch (e) {
    byId("file-output").textContent = "打开失败: " + e;
  }
});

// ── 4. 系统通知 ────────────────────────────────────
byId("btn-notify").addEventListener("click", async () => {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) {
      byId("notify-output").textContent = "通知权限被拒绝";
      return;
    }
    sendNotification({
      title: "Tauri Demo",
      body: "你好!这是来自 Rust 后端的系统通知 🎉",
    });
    byId("notify-output").textContent = "通知已发送,看看屏幕右下角";
  } catch (e) {
    byId("notify-output").textContent = "发送失败: " + e;
  }
});

// ── 5. 剪贴板 ──────────────────────────────────────
const clipInput = byId<HTMLInputElement>("clip-input");
byId("btn-clip-write").addEventListener("click", async () => {
  const text = clipInput.value;
  if (!text) return;
  try {
    await writeText(text);
    byId("clip-output").textContent = "已写入: " + text;
  } catch (e) {
    byId("clip-output").textContent = "写入失败: " + e;
  }
});
byId("btn-clip-read").addEventListener("click", async () => {
  try {
    const text = await readText();
    byId("clip-output").textContent = text
      ? "剪贴板内容: " + text
      : "剪贴板为空或不是文本";
  } catch (e) {
    byId("clip-output").textContent = "读取失败: " + e;
  }
});
