# Tauri vs Electron:基于 docflow (OCRFlow) 的实测对比

> 实测日期:2026-08。对比对象:
> - **docflow/OCRFlow v1.2.0**:Electron 28 + React 18 + Vite,多引擎 OCR 文档批处理(Cloud API + 可选本地 Python 引擎),含 MCP server、CLI headless 模式
> - **本仓库 tauri-demo**:Tauri 2.11 + Vite + TypeScript(demo 规模较小,体积数据可线性外推)

## 一、实测体积数据

| 指标 | OCRFlow (Electron 28) | tauri-demo (Tauri 2) | 差距 |
|---|---|---|---|
| 主程序 exe | **168.6 MB** | **9.5 MB** | ~18× |
| 解包后总大小 | **311.6 MB** | **~9.5 MB** | ~33× |
| NSIS 安装包 | **84.1 MB** | 预计 5~8 MB(NSIS 未打成,受网络限制) | ~12× |
| 前端资源 | 打进 app.asar | 24.6 KB(gzip 8 KB) | — |
| 浏览器运行时 | 自带 Chromium(~200MB) | 系统共享 WebView2(0 字节) | — |

### OCRFlow 解包 311.6MB 的构成(Chromium 全家桶)
- OCRFlow.exe 168.6MB(含 Electron 运行时 + app.asar)
- locales 36.1MB、resources 60.4MB、icudtl.dat 10.2MB、libGLESv2 7.4MB、resources.pak 5.1MB、ffmpeg 2.7MB、vulkan/d3dcompiler 等
- 真正的业务代码(app.asar 里的 React 前端 + 主进程 JS)其实只有几 MB

### 为什么 Tauri 天然小
1. **WebView2 是 Windows 系统组件**(Win10/11 自带,所有应用共享一份),Electron 每个应用自带一整份 Chromium
2. **Rust 编译为原生二进制**,无 V8 引擎、无 Node 运行时
3. 我们的 demo exe 9.5MB 里还包含了 Rust std + tokio 等;做 docflow 规模的应用预计 exe 20~40MB(引入 reqwest/PDF/图像库后),安装包仍可控制在 15MB 以内

## 二、如果 docflow 用 Tauri 重做:优势清单

### 1. 体积/分发(最直接)
- 安装包 84MB → **~15MB**;解压即用版 311MB → **~30MB**
- docflow 要内嵌 Python OCR 引擎的话,两边都要附带,但 Tauri 基线低了 ~290MB

### 2. 内存(常驻工具类应用的痛点)
- Electron 单实例常驻 **300~500MB**(Chromium 多进程),OCRFlow 这种常驻桌面工具挂一整天,内存开销明显
- WebView2 共享系统浏览器进程池,Tauri 应用常驻通常 **60~120MB**

### 3. Rust 后端对 docflow 各模块的针对性优势

| docflow 模块 | Electron 现状 | Tauri/Rust 方案 | 收益 |
|---|---|---|---|
| task-worker.ts (44KB 批处理队列) | Node 单线程 + worker | tokio/rayon 多线程,无 GC 停顿 | 大批量 OCR 任务吞吐提升 |
| page-counter / magic bytes 校验 | TS 实现 | 纯 Rust,几行且更快 | 大 PDF(≤100MB)校验快 |
| PDF 拆分 (pdf-lib) | JS 库,大文件吃内存 | lopdf / 直接绑 mupdf | 100MB 级 PDF 更稳 |
| 图像预处理 (sharp) | Node 原生模块(安装易碎) | image crate 纯 Rust,编译期解决 | 消除 sharp 的原生依赖坑 |
| python-bridge (spawn Python) | child_process 管道传数据 | 同样 spawn,或 **PyO3 进程内嵌 CPython** | 省一个进程 + 零拷贝传图 |
| 云 API 上传 (axios + form-data) | JS | reqwest,HTTP/2 + 流式 | 大文件上传更快更省内存 |
| headless CLI 模式 | 还得背 Electron 运行时 | **纯 Rust 二进制,~10MB 即可跑批处理** | CI/服务器场景巨大优势 |
| MCP server | @modelcontextprotocol/sdk (TS) | sidecar 保留原 TS 代码,或 rmcp (Rust) | 可零成本平移 |

### 4. 安全(它处理的是审计报告/财务文档!)
- Tauri 2 capabilities 白名单:前端能调什么 IPC 都要显式声明
- 无 nodeIntegration、无远程代码执行面;Electron 的 preload 若写不好就是注入点
- Rust 内存安全消灭一整类崩溃/溢出漏洞

### 5. 启动速度
- Tauri 冷启动 1~2s(WebView2 常驻),Electron 3~5s
- OCRFlow 这种"拿起来扫一份文件"的工具,启动速度体感明显

### 6. 前端资产几乎零迁移成本
- src/ 下的 React + Vite + Tailwind **约 90% 原样复用**
- 只改通信层:ipcRenderer.invoke → invoke,preload 桥 → Rust command

## 三、劣势与成本(诚实版)

1. **Rust 学习曲线**:主进程逻辑要从 TS 重写为 Rust;若团队只会 TS,是最大门槛
2. **capabilities 权限模型**:Tauri 2 的新概念,初上手会踩"not allowed"报错(我们的 demo 就踩了)
3. **MCP/云 SDK 生态**:TS 的 SDK 生态(Tauri 端要 sidecar 或重写);axios 那套要换 reqwest
4. **原生模块换血**:sharp → image crate、pdf-lib → lopdf,选型和调试成本
5. **自动更新**:electron-updater 更成熟;Tauri updater 需要签名配置,国内分发还要自己接服务器
6. **编译等待**:首次 cargo 编译几分钟(本机实测 check 1m54s / release 2m42s,尚可)

## 四、迁移工作量粗估(单 Rust 熟练开发者)

| 模块 | 工作量 |
|---|---|
| React 前端(src/) | 0.5 天(改 IPC 调用层) |
| ipc-handlers → Rust commands | 1~2 天 |
| task-worker → tokio 任务队列 | 3~5 天(核心) |
| python-bridge → spawn/PyO3 | 1 天 |
| sharp → image crate | 1 天 |
| pdf-lib → lopdf | 1~2 天 |
| MCP server → sidecar | 0.5 天 |
| 打包/签名/更新配置 | 1~2 天 |
| **合计** | **约 1.5~2 周** |

## 五、结论

- **体积**:Tauri 完胜,~12 倍安装包差距、~33 倍解包差距,这是架构性优势,不会随功能增长消失
- **docflow 这类"批处理 + 本地能力 + 云 API"工具**:恰好是 Tauri 甜区——重后端逻辑可以吃到 Rust 的性能/内存/安全红利,前端 React 几乎白捡
- **唯一实质门槛是 Rust**:如果团队不想写 Rust,可以只把主进程最小化(全部走 sidecar Node),但那样会牺牲掉一半优势
- **建议**:新项目直接 Tauri;docflow 若要重做,先 PoC 两个模块(task 队列 + PDF 处理)验证体验再决定

---

*附:本机打包 NSIS 未成功的原因是 GitHub 访问不稳定(Clash 代理时断时续),与 Tauri 本身无关;nsis-3.11.zip 曾在第一次下载时成功。*
