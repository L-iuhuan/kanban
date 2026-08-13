# 看板流水线运行器 (KanbanRunner)

给测试人员(纯小白)用的桌面应用:**双击即用,自动从共享盘拉取最新代码,选 Excel 跑流水线,看进度日志,一键打开看板和中间产物**。Tauri 2 + Rust 壳 + Python 流水线。

## 架构

```
共享盘 \\<server>\<share>\kanban-repo      (开发者维护,git 仓库)
├─ run_chain.py / processing/ / dashboard/ ...   ← 看板流水线代码(同步源)
└─ version.txt                                    ← 开发者 push 钩子自动生成

每台测试电脑 D:\KanbanApp\
├─ KanbanRunner.exe   ← 本应用(Tauri)
├─ code\              ← 代码缓存(启动时自动 robocopy 同步)
├─ .venv\             ← Python 环境(应用自动创建/安装依赖)
└─ config.json        ← 共享盘路径(首次运行设置)
```

**单向数据流**:代码从共享盘下拉 → 本地产出(output/看板)留在本地,不回传。

## 开发(公司电脑)

```bash
# 前提:Rust(cargo)、Node 20+、npm
git clone <本仓库>
cd kanban-runner
npm install
cargo tauri dev     # 或 npx tauri dev
```

- 前端:vite dev server 端口 1430(见 vite.config.ts)
- 后端:src-tauri/src/lib.rs 定义全部 commands
- 窗口配置:src-tauri/tauri.conf.json

## 部署到测试电脑

```bash
cargo tauri build --bundles nsis
```

产出安装包后安装到测试电脑。首次运行:设置共享盘路径 → 应用自动同步代码 → 自动创建 Python 环境(.venv,从本机 Anaconda/Python 或下载)→ 安装依赖(清华镜像)。

## 配置

config.json(应用目录下,界面「⚙ 设置」修改):

```json
{
  "share_path": "\\\\server\\share\\kanban-repo",
  "auto_sync": true
}
```

## 阶段进度协议(看板流水线侧配合修改)

应用解析流水线 stdout 中的阶段标记来驱动进度条。请在 run_chain.py 各阶段开头输出:

```python
print("[STAGE 1/5] 数据清洗 silver")
print("[STAGE 2/5] 客户分析")
print("[STAGE 3/5] 产品生命周期")
print("[STAGE 4/5] 汇总指标 gold")
print("[STAGE 5/5] 生成看板")
```

格式:`[STAGE n/total] 阶段名`。没有这些行也能跑,只是进度条只显示整体阶段。

## 关键实现

| 功能 | 位置 |
|---|---|
| 代码同步(robocopy /MIR,排除 .git/output/data) | lib.rs `sync_code` |
| 运行流水线(spawn .venv python,stdout 逐行 emit) | lib.rs `run_pipeline` |
| 停止(taskkill /T /F 杀进程树) | lib.rs `stop_pipeline` |
| 打开看板(找 dashboard 下最新 html) | lib.rs `open_dashboard` |
| 环境自举(找系统 Python → venv → pip 清华镜像) | lib.rs `setup_env` |
| 前端状态机/拖拽/日志渲染 | src/main.ts |

## 本机(发起开发机)备注

- Rust 工具链为手动解压安装,见工作区根 .rust-toolchain(公司电脑用 rustup 即可)
- 本机 git.exe 被安全软件拦截,仓库提交使用 .git-tools/isomorphic-git(公司电脑用正常 git)
- 模拟共享盘测试目录:工作区根 kanban-share-sim/
