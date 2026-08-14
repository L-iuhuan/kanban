# 看板流水线运行器 (KanbanRunner)

给测试人员(纯小白)用的桌面应用:**双击即用,自动从共享盘拉取最新代码,选 Excel 跑流水线,看进度日志,一键打开看板和中间产物**。Tauri 2 + Rust 壳 + Python 流水线。

## 架构

```
共享盘 \\<server>\<share>\kanban-repo      (开发者维护,git 仓库)
├─ run_chain.py / processing/ / dashboard/ ...   ← 看板流水线代码(同步源)
└─ version.txt                                    ← 开发者 push 钩子自动生成

每台测试电脑 %LOCALAPPDATA%\KanbanRunner\   (exe 装哪都行,数据都在这个目录)
├─ KanbanRunner.exe   ← 本应用(Tauri)
├─ code\              ← 代码缓存(启动时自动 robocopy 同步)
├─ .venv\             ← Python 环境(应用自动创建/安装依赖)
└─ config.json        ← 共享盘路径(可选,已预置默认值,见「配置」)
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

config.json(`%LOCALAPPDATA%\KanbanRunner\config.json`,界面「⚙ 设置」修改):

> 共享盘路径已在代码中预置默认值(`\\192.168.8.3\share\kanban-repo`),首次运行无需配置;设置界面仅用于覆盖。

```json
{
  "share_path": "\\\\server\\share\\kanban-repo",
  "auto_sync": true
}
```

## 冒烟自检

不连共享盘也能验证全链路。在「⚙ 设置」里把共享盘路径指向本仓库的 `kanban-share-sim` 目录(如 `E:\...\kanban\kanban-share-sim`),然后走一遍正常流程:

1. **同步** → 应用把 `code\` 下的冒烟桩代码拉到本地(`run_chain.py` + `version.txt` + `requirements.txt`)
2. **环境** → 自动创建 `.venv` 并装依赖(桩无第三方依赖,requirements.txt 只有注释,秒装)
3. **运行** → 桩流水线约 5 秒跑完三阶段,打印 `[STAGE 1/3]..[STAGE 3/3]`,在 `output\` 下生成 silver/gold/report 占位文件
4. **看板** → 「打开看板」直接看到 `dashboard\dashboard_stub.html` 暗色「冒烟测试看板」页(含版本号与数据文件名)

整个自检(含环境安装+同步)约 30 秒,端到端验证「同步→环境→运行→看板」四步。

**版本号**:开发者每次改完流水线代码、push 前,在流水线代码目录运行仓库根的 `tools\bump_version.ps1`,自动把当前 commit 短哈希 + 时间戳写入 `code\version.txt`(格式 `v<hash> @ 时间`)。客户端同步后即可看到对应版本,确认拿到的是最新代码。

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
