# 看板助手 (KanbanRunner)

给测试人员(纯小白)用的桌面应用:**双击即用,自动从共享盘拉取最新看板代码,选 Excel 一键生成看板,看进度日志,直接打开看板和结果文件**。Tauri 2 + Rust 壳 + Python 流水线。

特性:浅色/深色主题(标题栏切换并记忆)、横版自适应窗口、阶段步骤条按流水线上报动态生成、共享盘新代码/新安装包自动提醒、一键自更新、离线缓存模式(共享盘不可达时用本地缓存跑)。

## 架构

```
共享盘 \\<server>\<share>\数据分析看板\    (开发者维护)
├─ code\          ← 看板流水线代码(同步源):run_chain.py / processing/ / deps.txt ...
│   └─ version.txt    ← 发布脚本自动生成(commit 短哈希 + 时间)
└─ app\           ← 壳子自更新通道:*-setup.exe + app-version.txt

每台测试电脑
├─ %LOCALAPPDATA%\看板助手\kanban-runner.exe   ← 本应用(NSIS 安装,免管理员)
└─ %LOCALAPPDATA%\KanbanRunner\                ← 数据目录(exe 装哪都行)
    ├─ code\          ← 代码缓存(启动时自动 robocopy 同步)
    ├─ .venv\         ← Python 环境(应用自动创建/装依赖)
    └─ config.json    ← 共享盘路径(可选,已预置默认值)
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
- 窗口配置:src-tauri/tauri.conf.json(尺寸在 lib.rs setup 里按屏幕比例动态设置)

## 打包与发布

```bash
cargo tauri build --bundles nsis
```

- 安装包产出在 `src-tauri/target/release/bundle/nsis/看板助手_<版本>_x64-setup.exe`(约 3.5 MB,currentUser 安装,免管理员)。
- 随仓库分发的副本放仓库根 `installer/` 目录;GitHub Releases 也附同款安装包。
- **发流水线代码**:改完代码后运行仓库根 `tools/publish_to_share.ps1`,自动镜像代码到共享盘 `code\` 并写 version.txt;加 `-AppInstaller <setup.exe> -AppVersion <版本>` 可同时发布壳子安装包到 `app\`(客户端启动时会提示「看板助手有新版本」,点「立即更新」自动换装)。

## 配置

config.json(`%LOCALAPPDATA%\KanbanRunner\config.json`,界面「⚙ 设置」修改):

> 共享盘路径已在代码中预置默认值(lib.rs `DEFAULT_SHARE_PATH`),首次运行零配置;设置界面仅用于覆盖。

```json
{
  "share_path": "\\\\server\\share\\数据分析看板",
  "auto_sync": true
}
```

## 冒烟自检

不连共享盘也能验证全链路。在「⚙ 设置」里把共享盘路径指向本仓库的 `kanban-share-sim` 目录,然后走一遍正常流程:

1. **更新代码** → 应用把 `code\` 下的冒烟桩代码拉到本地(run_chain.py + version.txt + deps.txt)
2. **环境** → 自动创建 `.venv`;deps.txt 为空(纯标准库桩)→ 依赖检查自动跳过
3. **运行** → 勾选「跳过数据处理」→「生成看板」,桩流水线约 5 秒跑完;步骤条应动态显示 **3 个阶段**([STAGE 1/3]..[3/3],验证动态协议)
4. **看板** → 「打开看板」看到 `dashboard\dashboard_stub.html` 冒烟测试看板页

整个自检约 30 秒,端到端验证「同步→环境→运行→看板」四步。重启应用后「打开看板/结果文件」按钮应直接可用(历史产物解锁)。

## 运行器与流水线的接线协议(改流水线代码时只需遵守本节,UI 无需改动)

**阶段标记**:应用解析流水线 stdout 中的阶段标记驱动进度条。请在 run_chain.py 各阶段开头输出:

```python
print("[STAGE 1/5] 数据清洗 silver")
print("[STAGE 2/5] 客户分析")
```

格式:`[STAGE n/total] 阶段名`。阶段数和名称完全由流水线决定,前端步骤条按事件动态生成——增删阶段、改阶段名都不需要动运行器代码。没有这些行也能跑,只是没有分阶段进度。

**子阶段标记(可选)**:最后一个阶段(如生成看板)耗时长,可在其中输出 `[n/m] 说明`(如 `[3/8] 渲染图表`)推动阶段内进度并在详情行显示,分母任意。

**依赖声明(可选)**:在 code/ 下放 `deps.txt`,一行一个 import 名(`#` 开头为注释),运行前/健康检查会一次性 import 验证。文件缺失时用运行器内置清单;空文件(或全注释)表示纯标准库流水线,跳过检查。

**产物约定(仅剩的硬接线)**:看板写到 `code/dashboard/*.html`,中间产物写到 `code/output/{silver,gold,report}/`。改这套目录结构才需要动运行器代码。

## 关键实现

| 功能 | 位置 |
|---|---|
| 代码同步(robocopy /MIR,排除 .git/output/data) | lib.rs `sync_code` |
| 运行流水线(spawn .venv python,stdout 逐行 emit;done 事件带 pid 防串台) | lib.rs `run_pipeline` |
| 停止(taskkill /T /F 杀进程树) | lib.rs `stop_pipeline` |
| 打开看板(找 dashboard 下最新 html) | lib.rs `open_dashboard` |
| 环境自举(找系统 Python → venv → pip 清华镜像;deps.txt 驱动检查) | lib.rs `setup_env` / `check_deps` |
| 壳子自更新(比对 app-version.txt → 拷安装包 → 延迟静默安装重开) | lib.rs `self_update` |
| 前端状态机/动态步骤条/主题切换 | src/main.ts |

## 本机(发起开发机)备注

本机的 git/Rust 工具链有特殊配置(手动工具链、网络绕过等),以仓库根 **AGENTS.md** 为准,此处不再重复维护。
