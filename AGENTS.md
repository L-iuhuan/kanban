# AGENTS.md

本仓库是 Tauri 桌面应用的实验/开发工作区(非单一应用),文档与注释以中文为主。

## 项目布局

- `kanban-runner/` — **主项目**。看板流水线运行器(Tauri 2 + Rust 壳 + 外部 Python 流水线),给测试小白双击即用。README 有完整架构说明。
- `tauri-demo/` — Tauri 2 入门 demo,kanban-runner 的风格/代码参考(暗色玻璃拟态 UI、插件用法)。改 kanban-runner 前端时可对照。
- `kanban-share-sim/` — 模拟共享盘的本地测试目录(kanban-runner 的同步源)。`code/run_chain.py` 是纯标准库冒烟桩,可直接 `python run_chain.py` 跑通 `[STAGE]` 协议做端到端自检。
- `tools/publish_to_share.ps1` — 把流水线代码发布到共享盘目录的脚本。
- `installer/` — 打包好的 NSIS 安装包(随仓库分发,`cargo tauri build --bundles nsis` 后从 target/release/bundle/nsis/ 拷贝更新)。
- 根目录 `kanban-*.md`、`tauri-vs-*.md` — 方案设计/选型文档(只读参考,勿当代码)。
- 根目录无统一构建;每个子项目独立。无测试套件、无 CI、无 lint 配置。

## 本机环境怪癖(重要,不同于常规机器,已实测确认)

- **远端主分支是 `main`,本地分支也已改为 `main`**(直接 `git pull` 即可)。HTTPS fetch/push GitHub 经常被截断(schannel: server closed abruptly / early EOF),解法:加 `-c http.version=HTTP/1.1` 重试,如 `git -c http.version=HTTP/1.1 fetch origin main`。`.git-tools/` 里的 isomorphic-git 是更早的绕过方案,现作备用。
- **cargo/rustc 不在 PATH 上**:Rust 工具链由 puccinialin 管理(rustup 缓存),手动跑 cargo 前需设置:
  ```powershell
  $tc = "C:\Users\910373\AppData\Local\puccinialin\puccinialin\Cache"
  $env:CARGO_HOME = "$tc\cargo"
  $env:RUSTUP_HOME = "$tc\rustup"
  $env:PATH = "$tc\cargo\bin;" + $env:PATH
  ```
  (实测 cargo 1.95.0,2026-08-17 验证可用。旧文档曾写 `D:\Files\projects\架构测试\...`,该路径本机已不存在。)
- Cargo registry 已配置 rsproxy.cn 镜像(各项目 `.cargo/config.toml`),保留勿删。
- `.rust-toolchain/`、`.cargo-home/`、`.npm-cache/`、`.tauri-cache/` 是本地工具链/缓存目录,已 gitignore,不要提交也不要删除。

## kanban-runner 要点

- 包管理器用 **npm**(tauri-demo 用 pnpm,两者不同,别混)。
- 开发:`npm install` → `cargo tauri dev`(前端 vite dev server 端口 **1430**,见 vite.config.ts)。
- 打包:`cargo tauri build --bundles nsis`。
- 后端所有 Tauri commands 集中在 `src-tauri/src/lib.rs`;前端状态机在 `src/main.ts`。
- **跨项目耦合**:应用解析流水线 stdout 的 `[STAGE n/total] 阶段名` 标记驱动进度条——改 run_chain.py(共享盘侧)时必须保留该协议。
- 单向数据流:代码只从共享盘下拉,本地产出(output/、data/、code/、config.json)不回传且已 gitignore。

## Tauri 2 通用注意

- 前端每用一个 API(窗口控制、剪贴板、对话框…),必须在 `src-tauri/capabilities/default.json` 显式授权,否则运行时报 not allowed。
- 官方插件需三处同时安装:npm 包 + Cargo crate + Rust 侧 `.plugin(xxx::init())`。
- 验证方式:无自动化测试,改完后 `cargo tauri build`(或 dev 跑起来)确认编译与基本行为通过。
