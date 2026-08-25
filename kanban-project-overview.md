# 看板助手 · 项目总览与开发实录

> 定位:Tauri 2 壳 + 外部 Python 流水线 + 共享盘分发/自更新,给财务测试小白双击即用。
> 本文是 2026-08-17~08-18 开发周期的完整梳理:架构、数据传递、更新链路、回退方案、踩坑实录。
> 配套文档:`kanban-update-strategy.md`(更新链专述)、`kanban-distribution-review.md`(分发审查)、`AGENTS.md`(本机环境怪癖)。

## 一、仓库与关键路径

| 位置 | 路径 | 说明 |
|---|---|---|
| 壳仓库 | `E:\3-其他资料\数据分析\kanban` | Tauri 应用 + 发布脚本 + 文档;主项目 `kanban-runner/` |
| 流水线仓库 | `E:\3-其他资料\数据分析\sales_analytics_platform` | Python 流水线(run_chain.py 编排) |
| 便携 Python 源 | `kanban\portable-python\`(669MB,已 gitignore) | 解释器+全部依赖,组装自本机 Python311+venv site-packages |
| 共享盘(生产) | `\\192.168.8.3\财务部\办公软件\SoftwareUpdate\数据分析看板` | 下设 `app\`/`code\`/`python\` 三通道 |
| 安装目录 | `%LOCALAPPDATA%\看板助手\` | NSIS currentUser 模式,免管理员,**productName 固定永不再改** |
| 数据根 | `%LOCALAPPDATA%\KanbanRunner\` | config.json / code\(本地缓存) / python\(便携环境) / .venv\(托底) / update-result.txt |
| 更新临时 | `%TEMP%\KanbanPipeline-update.exe` + `.cmd` | 每次更新覆盖,批处理自删除 |
| 模拟共享盘(测试用) | 任意本地目录放 `app\`+`code\`(+`python\`),设置里把共享盘路径指过去 | 本周期全部 E2E 均先在模拟盘验证后投产 |

**版本号双源**:`src-tauri/Cargo.toml`(编译期 `env!("CARGO_PKG_VERSION")`,自更新比较用)+ `src-tauri/tauri.conf.json`(安装包/注册表版本)。**必须同步改**,漏一边出幽灵更新提示。

## 二、系统架构与数据传递

### 组件关系
```
开发者机                          共享盘(192.168.8.3)                    客户机(财务)
┌──────────────┐   publish_to_share.ps1   ┌─────────────┐   sync_code    ┌──────────────────┐
│ sales_..plat │ ──[1/4]代码+deps.txt──▶ │ \code\      │ ──robocopy──▶ │ KanbanRunner\code │
│ portable-py  │ ──[3/4]便携Python────▶  │ \python\    │ ──robocopy──▶ │ KanbanRunner\python│
│ tauri build  │ ──[4/4]壳子+版本号──▶   │ \app\       │ ──self_update▶│ 看板助手\(安装目录) │
└──────────────┘                         └─────────────┘               └──────────────────┘
```

### 四条数据通道

**① 发布侧(开发者跑 `tools\publish_to_share.ps1`)**,四段式:
- [1/4] 代码:流水线仓库 → `share\code\`(robocopy /MIR,排除 `.git/output/data/__pycache__/.venv/.pytest_cache/node_modules/test`);人员对应表从 data\ 提升到包根随代码分发
- [2/4] 版本:`code\version.txt` = `v<git短哈希> @ <时间>`;同时从 requirements.txt 生成 `code\deps.txt`(映射 scikit-learn→sklearn、python-calamine→python_calamine、chinese-calendar→chinese_calendar,去版本约束,UTF-8 无 BOM)
- [3/4] 便携 Python:`portable-python\` → `share\python\`(/MIR,排 `__pycache__`/`*.pyc`;首推 ~700MB,之后增量秒级)
- [4/4] 壳子(可选参数):`-AppInstaller <setup.exe> -AppVersion <x.y.z>` → `share\app\` + `app-version.txt`(纯语义化版本号)

**② 客户端代码同步(启动时/「更新代码」按钮/2 分钟巡检)**:
- `share\code\` → `KanbanRunner\code\`(robocopy /MIR,同样排除产出目录——**单向数据流,本地产出不回传**)
- 同步后若 `share\python\python.exe` 存在 → 二段 robocopy 拉便携环境到 `KanbanRunner\python\`
- 巡检对比远端/本地 `version.txt`,有新代码 → 「更新代码」按钮呼吸高亮 + 日志通报

**③ 运行时(跑流水线)**:
- 用户拖入 Excel → 壳以 `--data <路径>` 启动 `run_chain.py`
- run_chain 把该 Excel 拷入 `code\data\` 并抬升 mtime(后段按 mtime 取最新),人员表缺失时从包根接入
- 前段 processing 写 `output\silver\gold\report`,后段生成 `dashboard\*.html`,壳调系统默认浏览器打开
- **`[STAGE n/total] 阶段名`** 协议驱动前端步骤条;看板阶段内部用 `[n/m]` 子阶段标记防"假死"误判——**流水线侧改动必须保留此协议**
- Python 解释器选择 `venv_python()`:`python\python.exe`(便携,优先)→ 不存在回落 `.venv\Scripts\python.exe`;`env_ok` 随之自动判定

**④ 壳子自更新(详见第三节)**。

## 三、更新链路(完整)

### 1. 检查(读)
- 时机:启动 + 设置页「检查更新」;前提:共享盘可达(**不可达直接跳过,避免 UNC/SMB 超时数十秒卡启动**)
- `app\app-version.txt` vs `CARGO_PKG_VERSION`,朴素 semver 分段比较(允许 v 前缀,缺段按 0;已 7 用例单测)
- 有新版 → 蓝色横幅(z-index 高于设置弹层)+ 设置弹层内同排「立即更新 vX」按钮(**无需关弹层**)

### 2. 一键更新(self_update 命令)
1. 复核版本(区分「已最新」与「未找到」)
2. 扫 `share\app\` 下 **`-setup.exe` 结尾**的 exe,按**修改时间**取最新
3. 拷贝到 `%TEMP%\KanbanPipeline-update.exe`
4. 生成 `%TEMP%\KanbanPipeline-update.cmd`(**全 ASCII、CRLF 行尾**),隐藏 cmd 执行,**三个运行时路径经环境变量传入**(Windows 环境块 UTF-16,中文路径零损失)
5. 前端先弹全屏三步遮罩(关闭应用→静默安装约10-30秒→自动重启),**2 秒后**本进程才退出(让遮罩可被看清)

批处理模板(最终版,0.3.7+):
```cmd
@echo off
set /a WAITCNT=0
:waitloop
tasklist /FI "IMAGENAME eq kanban-runner.exe" 2>nul | find /I "kanban-runner.exe" >nul
if not %ERRORLEVEL%==0 goto install
ping -n 2 127.0.0.1 >nul
set /a WAITCNT+=1
if %WAITCNT% GEQ 60 taskkill /IM kanban-runner.exe /F >nul 2>&1
goto waitloop
:install
"%KANBAN_SETUP%" /S
set EC=%ERRORLEVEL%
>"%KANBAN_RESULT%" echo %EC%
start "" "%KANBAN_RELAUNCH%"
del "%~f0"
```
每行都是血泪教训,动之前先看第六节踩坑实录对应条目:
- **tasklist 轮询**而非固定延时:旧进程退干净才装(0.3.4 教训);60 次×1s 封顶 + taskkill 兜底
- **单行 if**:多行括号块内 `%VAR%` 按解析期展开,计数器永远不触发(0.3.7 教训)
- **ping 睡眠**而非 `timeout`:无控制台时 timeout 会挂死
- **重定向在句首** `>"%KANBAN_RESULT%" echo %EC%`:`echo %EC%>文件` 在 EC 为单数字(0/1/2)时被解析成句柄重定向,文件写空 → 启动误报 fail:invalid(0.3.10 教训)
- **ASCII + env 传参**:cmd 按系统代码页(GBK)解析批处理文件,UTF-8 中文路径必乱码(0.3.6 教训)

### 3. 结果回执(take_update_result 命令)
- 安装器退出码写入 `KanbanRunner\update-result.txt`;装完 `start` 重开应用(同路径已换新二进制)
- 重开后 init 调 `take_update_result`:读文件→**删除**(一次性消费)→`"ok"`/**绿色横幅**5 秒自动消失;`"fail:N"`/`"fail:invalid"` 红色横幅+写入日志面板(「复制日志」可带走)

### 4. 横幅体系
`.banner` 红(默认/错误)/ `.banner.info` 蓝(更新提示)/ `.banner.ok` 绿(成功);`showBanner(text, kind)` 三态;深浅主题各有专用文字色令牌。

## 四、回退与自愈矩阵

| 故障场景 | 行为 | 恢复路径 |
|---|---|---|
| 共享盘不可达 | 更新检查跳过;代码同步失败但**离线模式**可用本地缓存跑 | 网络恢复后点「更新代码」 |
| 共享盘无 `python\` 通道 | venv 托底:检测系统 Python → 建 .venv → pip(三阶段进度提示) | 发布便携包后下次同步自动切换 |
| 便携已就位 | `setup_env` 直接短路("无需安装") | — |
| .venv 半残(装一半关窗) | 健康检查不过 → `autoRepairEnv` 自动重跑 setup_env(pip 幂等补齐) | 自动 |
| 更新时安装器失败(退出码≠0) | 旧版原样保留(NSIS 覆盖只在新装成功时发生),回执 fail:N,横幅可重试 | 重点「立即更新」(%TEMP% 安装包被覆盖重拷) |
| 更新后回执文件损坏/为空 | 报 fail:invalid(0.3.10 已修掉空文件成因) | 同上重试 |
| 流水线运行中关窗 | `RunEvent::Exit` → `taskkill /PID <pid> /T /F` 连 python 子进程链回收,防孤儿互踩 output | 下次正常运行 |
| 勾「跳过数据处理」但无缓存 | run_chain 前置校验中文报错退出(不再炸英文 traceback) | 取消勾选先完整跑一次 |
| deps.txt 缺失 | check_deps 回落内置依赖清单 | 发布脚本已自动生成 |
| config.json 带 BOM | 读取端 trim FEFF 容错 | — |
| data/ 每月堆积 ~220MB | 手册建议季度清空 `code\data`;中期做 staging 后自动清理 | 人工/后续 |

## 五、环境准备策略(便携为主、venv 托底)

- **主路径**:共享盘 `python\`(自包含解释器+十依赖:pandas/numpy/sklearn/statsmodels/matplotlib/rapidfuzz/chinese_calendar/python_calamine/openpyxl/xlsxwriter),随代码同步,目标机**零 Python 安装、零 pip**(公司镜像实测无 Python,这是分发硬阻塞,已消灭)
- **托底**:共享盘无便携包时走 系统 Python → venv → pip(venv 与便携共存时便携优先)
- **关键细节**:`setup_env` 短路条件判的是**便携路径本身**而非 `venv_python()`——否则 .venv 半残时的 pip 自愈会被误跳过
- 组装便携包(本机一次性):robocopy Python311 解释器 + venv site-packages → 重定位自检 `PORTABLE_OK`(Windows CPython 无注册表依赖,拷走即用)

## 六、踩坑实录(按发现时间)

### 更新链四连坑(每个都真机复现过)

| # | 版本 | 现象 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | 0.3.3→0.3.4 | 点更新:应用关了,没装上,没重开,无任何提示 | `ping -n 3` 固定等 2s,旧进程没退净,NSIS 检测到运行中静默中止,`&&` 链断 | 0.3.5:tasklist 轮询(60s 封顶+强杀兜底)+ 结果回执文件 + 全屏遮罩 |
| 2 | 0.3.5→0.3.6 | 装上了,但报"找不到文件 C:\...\媒潜鍔\kanban-runner.exe",不自动重开 | .cmd 按 UTF-8 写出,中文 Windows cmd 按 GBK 解析,`看板助手`→`鐪嬫澘鍔╂墜` | 0.3.7:模板全 ASCII,运行时路径走环境变量(UTF-16) |
| 3 | (潜伏) | waitloop 60 次上限永不触发 | 多行 `if (...)` 块内 `%WAITCNT%` 解析期展开,值恒为初始 0 | 0.3.7:拆成单行 if |
| 4 | 0.3.9→0.3.10 | 装上了也重开了,却报"上次自动更新失败(退出码 invalid)" | `echo %EC%>文件`,EC=0 时 `0>` 是句柄重定向,回执写成 0 字节空文件 | 0.3.10:`>文件 echo %EC%`(实测旧写法 0B/新写法 3B) |

附:0.3.10→0.3.11 验证绿色回执时发现成功横幅是红色(复用了错误容器)→ 0.3.12 加 `.banner.ok`;失败信息曾只进横幅不进日志面板(「复制日志」缺失)→ 0.3.10 起两处同步。

**教训总纲:更新器修复有"一代自证"规律——新修复只存在于新二进制中,必须再发一版用新版发起更新才能验证修复本身。测试更新链永远要"装旧→发新→跳两版"。**

### 历史坑(0.3.3 之前,文档留档)
- **productName 改名 = 自更新死循环**:0.3.1 KanbanPipeline → 0.3.3 看板助手,安装目录跟着变,旧版卸不净双图标;更糟:`current_exe` 重开的是旧 exe → "更新完还是旧版"+每次启动再提示。**红线:productName 永不再改**(未分发所以无事故)。
- **重开路径硬编码** → 装完静默失败:改用 `current_exe`(0.3.3 期已修)。

### 环境与工具链坑(本机)

| 坑 | 现象 | 解法 |
|---|---|---|
| PS 5.1 读 UTF-8 无 BOM 脚本 | 中文路径乱码 → Set-Location 静默失败 → npm 跑错目录 | 脚本纯 ASCII + 路径经参数/-WorkingDirectory 传;含中文的 ps1 **必须 UTF-8 带 BOM**(publish_to_share.ps1 改完必查 `EF BB BF`) |
| GBK 控制台 | 回显"乱码"但文件内容正确 | 显示层加 `[Console]::OutputEncoding=UTF8`;判断真伪用 `[IO.File]::ReadAllText` 核字节 |
| `npx tauri` 失败 | "could not determine executable to run" | 用 `npm run tauri -- build --bundles nsis` |
| cargo 不在 PATH | 找不到命令 | puccinialin 缓存 env 三件套(见 AGENTS.md,已修正旧 D:\ 路径) |
| GitHub HTTPS 截断 | schannel early EOF | `-c http.version=HTTP/1.1` 重试;或 SSH(22 常通) |
| NSIS 时间戳 | 装完文件还是"旧日期"以为没装上 | NSIS 保留编译期时间戳,以 exe 版本/注册表为准 |
| robocopy 退出码 | 3 吓人 | 0-7 都是成功(3=有拷贝+有多余文件),≥8 才失败 |
| cmd 无控制台睡眠 | `timeout` 挂死 | `ping -n 2 127.0.0.1 >nul` |
| 设置弹层"假保存" | 改了路径没生效 | 必须点「保存并同步」;诊断时直接看 `KanbanRunner\config.json` 落盘内容 |

## 七、版本历史(本周期)

| 版本 | 内容 |
|---|---|
| 0.3.3 | 远端基线(UI 重构/协议解耦/NSIS 投产) |
| 0.3.4 | E2E 测试版(暴露坑#1) |
| 0.3.5 | 更新链重构:批处理轮询+回执文件+setup-stage 事件+前端更新体验(设置内更新/三步遮罩/结果横幅/环境进度) |
| 0.3.6 | 测试版(暴露坑#2/#3) |
| 0.3.7 | ASCII 模板+env 传参+单行 if+2s 退出延迟 |
| 0.3.8 | **E2E 全链路通过**(0.3.7→0.3.8,含中文路径自动重开) |
| 0.3.9 | 分发加固:便携 Python 随共享盘分发(P0)+孤儿进程回收+半残自愈+deps.txt 生成+流水线 skip 前置校验 |
| 0.3.10 | 回执重定向陷阱修复+失败信息进日志面板(暴露横幅红色问题) |
| 0.3.11 | 测试版(验证回执 OK) |
| 0.3.12 | 绿色成功横幅(.banner.ok);真实共享盘就绪 |
| 0.3.13 | **当前生产版**（安装包 `installer\看板助手_0.3.13_x64-setup.exe`，2026-08-25 用户确认） |

对应提交:kanban 仓库 `9a7763f`(0.3.5~0.3.8)、`f3cd5b6`(0.3.9)、本次(0.3.10~0.3.12);流水线仓库 `e42c52c`(skip 前置校验)。

## 八、日常操作 Runbook

**发流水线代码**(改了 Python 侧):
```powershell
cd E:\3-其他资料\数据分析\kanban
.\tools\publish_to_share.ps1     # 代码+deps.txt+便携python 全量刷新
```
**发壳子新版本**:改代码 → Cargo.toml+tauri.conf.json 双源升版 → `npm run tauri -- build --bundles nsis` → `.\tools\publish_to_share.ps1 -AppInstaller <bundle\nsis\*_setup.exe> -AppVersion <版本>`

**新机器装机**:双击 `share\app\看板助手_x.y.z_x64-setup.exe`(或 `installer\` 里随仓库分发的包)→ 启动 → 自动同步(首启含 ~517MB 便携 Python,约 1 分钟)→ 拖 Excel 跑。全程免管理员/免装 Python。

**本地测试更新链(不碰生产共享盘)**:
```powershell
# 模拟盘:app\app-version.txt(写比已装新的版本号)+ *_setup.exe;[+code\+python\ 可选]
# 应用设置里共享盘路径指向模拟盘目录 → 检查更新 → 立即更新
```

**常用诊断**:
```powershell
# 已装版本/注册表
(Get-Item "$env:LOCALAPPDATA\看板助手\kanban-runner.exe").VersionInfo.ProductVersion
# 落盘配置(别信控制台回显,读字节)
[IO.File]::ReadAllText("$env:LOCALAPPDATA\KanbanRunner\config.json")
# 更新回执残留(正常应被消费,存在=上次更新后应用没起来过)
Test-Path "$env:LOCALAPPDATA\KanbanRunner\update-result.txt"
# 当前生效的解释器(便携 or venv)
Test-Path "$env:LOCALAPPDATA\KanbanRunner\python\python.exe"
```

## 九、遗留与后续(2026-08-18 收官时状态)

- ~~P1-1/P1-2 运行时抽查~~ ✅ 用户实测通过:运行中关窗→重开再拖文件正常,且复用缓存
- ~~手册话术~~ ✅ 已写 `kanban-操作手册.md`(装机/月度三步/双更新通道/常见问题/数据安全)
- ~~共享盘旧安装包~~ ✅ 已清理,KanbanPipeline_0.2.0~0.3.3 及中间测试版全删,`app\` 只留 0.3.12
- **流水线深坑:评审完毕、未开工** — 裁决书在流水线仓库 `深度分析评审裁决-2026-08-18.md`(P0-1 部分确认/P0-2~4 确认;四批次施工方案+验收标准;口径问题需业务终审)。开工按批次①缓存正确性起步
- 壳侧小隐患(记录备用):`SETUP_ACTIVE` 守卫 pip 线程 panic 理论上不复位,可加 catch_unwind,不紧急
- 两仓库推 GitHub:443 时断时续,走代理或 SSH(公钥已生成待登记)
