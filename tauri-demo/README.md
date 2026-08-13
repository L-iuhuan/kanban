# Tauri Demo 🦀

一个给 vibe coder 的 Tauri 2 入门 demo:前端 **Vite + TypeScript**,后端 **Rust**,WebView2 渲染。

## 运行效果

- 自定义无边框标题栏(最小化 / 最大化 / 关闭)
- Rust 命令调用:前端 `invoke()` → Rust `#[tauri::command]` → 返回
- 系统信息采集(Rust `sysinfo`,CPU / 内存 / 主机名)
- 原生文件对话框(plugin-dialog)
- 系统通知(plugin-notification)
- 剪贴板读写(plugin-clipboard-manager)

## 目录结构

```
tauri-demo/
├── index.html              # 前端入口
├── src/
│   ├── main.ts             # UI 逻辑:invoke / 插件调用 / 窗口控制
│   └── style.css           # 暗色玻璃拟态样式
└── src-tauri/
    ├── Cargo.toml          # Rust 依赖(tauri + 3 个插件 + sysinfo)
    ├── tauri.conf.json     # 窗口配置 / 构建命令 / 打包配置
    ├── capabilities/
    │   └── default.json    # 权限声明(IPC / 插件能力白名单)
    └── src/
        ├── main.rs         # 程序入口
        └── lib.rs          # Rust 命令定义 + 插件注册
```

## 开发

```bash
pnpm install          # 前端依赖
pnpm tauri dev        # 热更新开发模式
pnpm tauri build      # 打安装包(msi/nsis)
```

## vibe coder 要点速记

1. **通信模型**:前端 `invoke("命令名", { 参数 })` 调 Rust;Rust 侧 `#[tauri::command]` 声明,`generate_handler!` 注册。
2. **插件**:官方插件(GitHub `tauri-apps/plugins-workspace`)前后端都要装——npm 包 + Cargo crate + `.plugin(xxx::init())`。
3. **capabilities**:Tauri 2 的权限白名单。前端用到的每个 API(窗口最小化、读剪贴板…)都要在这里显式授权,少了会运行时报 not allowed。
4. **打包体积**:Tauri 打包用系统 WebView2(Windows 10/11 自带),所以一个 demo 安装包通常只有几 MB,对比 Electron 动辄 100MB+。

## 本机环境备注

本项目的 Rust 工具链是手动解压安装的(绕过被安全软件拦截的 rustup 安装器),位于 `../.rust-toolchain`。若手动跑 cargo 命令,需要:

```powershell
$env:CARGO_HOME = "D:\Files\projects\架构测试\.cargo-home"
$env:RUSTC = "D:\Files\projects\架构测试\.rust-toolchain\bin\rustc.exe"
$env:PATH = "D:\Files\projects\架构测试\.rust-toolchain\bin;" + $env:PATH
```

建议后续正式开发时用官方 rustup 安装(安全软件临时关闭即可)。
