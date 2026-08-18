# 看板助手 · 分发前审查交接文档

> 来源:另一会话(分发前全链路终审) | 日期:2026-08-18 | 状态:待执行(P0/P1 均未施工)
> 读者:接手施工的会话。本文档自包含,不需要翻历史会话即可执行全部事项。
> 执行前先读仓库根 `AGENTS.md`(本机环境怪癖)和 `kanban-update-strategy.md`(更新链硬性约束)。
> 2026-08-18 复核:工作树为 v0.3.8(未提交,含自更新三项修复+前端更新体验改造);P0 前提已核实成立,逐项核实见文末「九、复核记录」。

## 〇、背景一句话

应用已具备分发条件(壳子链路全部验证通过),**唯一硬阻塞:目标机没有 Python**。公司镜像实测不预装 Python/Anaconda(见下"环境实测"),而当前 `setup_env` 依赖系统 Python 建 venv——财务同事的机器首跑必死在"未找到可用的 Python,请安装 Anaconda 或 Python 3.10+",小白无法自救。P0 就是消灭它。

## 一、环境实测事实(2026-08-14 本机探测,目标机同镜像)

| 事实 | 影响 |
|---|---|
| `C:\Software\Anaconda3`、`C:\ProgramData\Anaconda3`、`C:\Python31x` 全部不存在;唯一 Python 是用户自装的 `C:\Users\910373\AppData\Local\Programs\Python\Python311`(3.11.4) | **setup_env 的系统 Python 依赖在其他机器上大概率不成立** |
| WebView2 151 系统级预装;Win11 22631,LongPathsEnabled=1 | 无忧 |
| 亿赛通 DSE 透明加密在跑(DSEClient/DSEService),但 **python 进程读写 .py 均为明文**(实测) | 代码分发链路安全;Office 文件才是加密重灾区 |
| 清华 PyPI / rsproxy / npmmirror 均 HTTP 200;github.com 443 时断时续(代理时断时续),**22 端口(SSH)常年通** | 构建链无碍;推 GitHub 走代理或 SSH |
| 共享盘 `\\192.168.8.3\财务部\办公软件\SoftwareUpdate\数据分析看板` 可达(映射 F:/G:) | 已预置为 DEFAULT_SHARE_PATH |
| C 盘剩 88.2GB(08-18 复核;08-14 实测曾仅 42.6GB,期间被清理过);D: 余 281GB | 见 P2-4 磁盘堆积项 |

## 二、🔴 P0:便携 Python 随共享盘分发(分发硬阻塞)

### 目标
客户端**零 Python 安装、零 pip**:共享盘放一套自包含 Python(解释器+全部依赖),客户端随代码同步到本地直接运行。目标机只需要:WebView2(已有)+ 本应用。

### 实施步骤

**1. 组装便携包(本机一次性,~10 分钟)**

本机已有一套**实测跑通全流程**的环境,直接拼装,不要重新 pip 安装:

```powershell
# 目标组装目录(加进 .gitignore,勿提交)
$dst = "E:\3-其他资料\数据分析\kanban\portable-python"
# ① 基础解释器(重定位即可运行,Windows CPython 无注册表依赖)
robocopy "C:\Users\910373\AppData\Local\Programs\Python\Python311" $dst /MIR /MT:16
# ② 依赖:本机 venv 的 site-packages 已装齐全部依赖(requirements.txt + xlsxwriter,实测可跑)
robocopy "$env:LOCALAPPDATA\KanbanRunner\.venv\Lib\site-packages" "$dst\Lib\site-packages" /MIR /MT:16
# ③ 验证重定位可用(在任意路径跑,不依赖原 Python)
& "$dst\python.exe" -c "import pandas,numpy,sklearn,statsmodels,matplotlib,rapidfuzz,chinese_calendar,python_calamine,openpyxl,xlsxwriter; print('PORTABLE_OK')"
```

- 预期体积 ~600-800MB。打印 `PORTABLE_OK` 即组装成功。
- 失败排查:若报 DLL 缺失,检查 `python311.dll` 是否在包根;若 import 失败,检查 site-packages 是否合并完整。

**2. 发布脚本同步(publish_to_share.ps1)**

在代码同步段后加:

```powershell
# 便携 Python 运行环境(免安装分发的核心)
$portableSrc = "E:\3-其他资料\数据分析\kanban\portable-python"
if (Test-Path (Join-Path $portableSrc "python.exe")) {
  Write-Output "[+] 同步便携 Python 环境到共享盘 python\"
  robocopy $portableSrc (Join-Path $ShareRoot "python") /MIR /XD __pycache__ /XF *.pyc /R:1 /W:1 /NFL /NDL /NJH /NP /MT:16 | Out-Null
  if ($LASTEXITCODE -gt 7) { Write-Error "Python 环境同步失败 (robocopy $LASTEXITCODE)"; exit 1 }
}
```

首次推送 ~700MB 上共享盘(内网几分钟);之后 robocopy 增量,几乎零成本。

**3. 运行器接入(kanban-runner/src-tauri/src/lib.rs)**

> 注意:以下基于 v0.3.3 时期的结构描述,终版(v0.3.5+)可能已重构,**施工前重读当前实现**,按现状对齐。

- `venv_python()`:优先返回 `data_root()\python\python.exe`(同步下来的便携版),不存在才回落 `.venv\Scripts\python.exe`
- `sync_code`:代码同步后,若共享盘存在 `python\python.exe`,再 robocopy 一次到 `data_root()\python`(/MIR,排除 __pycache__/*.pyc;首次约 1-2 分钟,日志提示"首次同步运行环境,请耐心等待")
- `setup_env`:便携 python 已就位时直接短路(记日志"运行环境已随代码同步,无需安装",emit setup-done true);保留现有"系统 Python→venv→pip"作为**回落路径**(共享盘无 python/ 时用)
- `get_status`:`env_ok` 判定随 `venv_python()` 自动生效
- `.gitignore`:加 `portable-python/`

**4. 验证(模拟全新机器)**

```powershell
# 把本机数据目录整个移走 = 一台从未装过的机器
Rename-Item "$env:LOCALAPPDATA\KanbanRunner" "KanbanRunner.bak"
# 启动应用,预期:同步 code + python(首次几分钟) → env_ok → 健康检查通过 → 可运行
# 全程不应出现 "未找到可用的 Python"
# 验证完删除新目录,把 .bak 改回来(或直接用新目录,后续正常用)
```

通过标准:全程无 Python 安装动作、无 pip 动作、健康检查通过、桩流水线可跑。

## 三、🟠 P1:第二梯队修复(随 P0 一并施工)

### 1. 孤儿进程回收(中途关窗 → python 孤儿互踩 output)
现状:`.run(tauri::generate_context!())` 无退出事件处理。用户关窗后,运行中的流水线(最长 ~17 分钟看板生成)变孤儿继续跑,占着 output/ 文件锁;下次启动再跑 → 双进程互踩,产出错乱。
修法(lib.rs `run()` 尾部,改为 build+run 回调):

```rust
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let state = app.state::<Running>();
                let pid = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(pid) = pid {
                    let mut c = Command::new("taskkill");
                    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
                    no_window(&mut c);
                    let _ = c.output();
                }
            }
        });
```

### 2. 半残环境自愈(装环境装一半关窗 → 之后永远"环境不完整"且无恢复入口)
现状:venv 存在但依赖不全时,`env_ok=true` 不会触发自动安装,`check_deps` 拦截报错后用户无路可走。
修法(main.ts):init 里的 `health_check` 回调中,`!h.ok` 时自动重跑 `setup_env`(pip 幂等,会补齐缺失包),复用现有 `setupInProgress` 守卫和 catch 复位逻辑。

### 3. 「跳过数据处理」无缓存中文前置校验(流水线侧)
现状:新机器首跑就勾"跳过"→ output/gold 为空 → 后段炸英文 traceback,小白看不懂。
修法(`sales_analytics_platform/run_chain.py`,在"# ── 步骤 1/2:数据处理"注释之前插入):

```python
    # 跳过数据处理的前置校验:无缓存产出时中文报错,避免后段炸英文 traceback
    if args.skip_processing:
        gold_dir = os.path.join(DIR_OUT, "gold")
        if not (os.path.isdir(gold_dir) and any(f.endswith(".csv") for f in os.listdir(gold_dir))):
            print("[错误] 勾选了「跳过数据处理」但本地没有处理缓存(output/gold 为空)。")
            print("       请取消勾选,先完整运行一次数据处理。")
            sys.exit(1)
```

改完跑 `publish_to_share.ps1` 分发。注意流水线侧改动要**提交到工作区根仓库**(上次提交 c8eaf95)。

### 4. deps.txt 自动生成(对接终版的依赖声明机制)
现状:终版 `check_deps` 优先读 `code/deps.txt`,缺失时回落内置清单(可能过时)。发布脚本目前不写 deps.txt。
修法(publish_to_share.ps1,代码同步后):从 `requirements.txt` 转换生成,写入 `$dst\deps.txt`(UTF-8 无 BOM,用 `[IO.File]::WriteAllText`):

```
包名→import名 映射:scikit-learn→sklearn, python-calamine→python_calamine,
chinese-calendar→chinese_calendar, 其余同包名(pandas/numpy/openpyxl/statsmodels/matplotlib/rapidfuzz/xlsxwriter)
去掉版本约束(>=)、注释(#)、空行
```

## 四、🟡 表述/易误操作点(手册话术级,可选改文案)

| # | 点 | 处理建议 |
|---|---|---|
| 1 | 「跳过数据处理」易被首跑误勾 | P1-3 已拦截;文案可补"(首次使用请勿勾选)" |
| 2 | 两条更新通道并存(蓝色横幅=壳子 / 按钮高亮=代码) | 操作手册写明"点哪个都对,都会变好" |
| 3 | 版本徽章(代码 v63e2504) vs 设置里版本(壳 0.3.x) | 手册点一句区别即可 |
| 4 | **data/ 每月堆积 ~220MB Excel 副本**(staging 接入所致),数据目录在 C 盘(仅剩 42.6GB) | 短期:手册注明"每季度可清空 `%LOCALAPPDATA%\KanbanRunner\code\data`";中期:staging 时自动清理旧副本(注意:本机开发目录的 data/ 有真实数据,清理逻辑只在"本次发生了接入拷贝"时才执行) |
| 5 | 未签名安装包可能被杀软/SmartScreen 拦 | 手册附"点'仍要运行'或找 IT 加白名单" |
| 6 | 拖错 Excel(非销售明细)→ 英文 pandas 报错 | 手册写明"把红色日志用「复制」按钮发给开发者" |

## 五、分发操作清单(施工完成后照走)

1. 便携 Python 上共享盘(第二节),确认 `share\python\python.exe` 存在
2. 流水线最新代码发布(deps.txt 同步生成)
3. 测试机:双击 `share\app\看板助手_<版本>_x64-setup.exe` → 免管理员安装
4. 启动 → 自动同步(首次含 python 环境,约 2-3 分钟)→ 拖真实 Excel → 生成看板(~24 分钟,进度条+子阶段通报)
5. 异常抽查:断共享盘(应进离线模式)/开着 Excel 跑(应提示关闭)/中途停止(应干净停止)/中途关窗(下次运行不应互踩)
6. 更新通道抽查:发代码 → 2 分钟内按钮高亮;发壳子 → 横幅 → 一键更新 → update-result.txt 回执

## 六、硬性约束汇总(违反即断链,施工红线)

1. **`productName` 永不再改**(现为「看板助手」)——改名=安装目录变=自更新死循环(详见 kanban-update-strategy.md 第三节)
2. 安装包文件名必须 `-setup.exe` 结尾;`app-version.txt` 为纯语义化版本号、UTF-8 无 BOM
3. **版本号双源同步**:Cargo.toml + tauri.conf.json 必须一起改(env! 宏读 Cargo.toml,安装包读 tauri.conf.json,漏一边就出幽灵更新提示)
4. `[STAGE n/total]` 与 `[n/m]` 子阶段协议:流水线侧改动必须保留(前端步骤条/进度条依赖)
5. 同步排除项 `.git/output/data/__pycache__/.venv/.pytest_cache` 保护本地产出,勿动
6. **编码双向坑**:ps1 脚本必须 UTF-8 **带** BOM(PS5.1 按 GBK 误读无 BOM 文件);config.json 读取端要**容忍** BOM(记事本手改会带入)
7. 本机 cargo 不在 PATH,用 AGENTS.md 里的 puccinialin 环境变量;crates 走 rsproxy 镜像(.cargo/config.toml 勿删)
8. GitHub 推送:443 时断时续,代理开了直接推;不开走 SSH(22 端口常通,公钥已生成于 `~/.ssh/id_ed25519.pub`,需先在 GitHub 登记)
9. 远端与本地分支均为 `main`,直接 `git pull` 即可(AGENTS.md 已同步更新;HTTPS 被截断时加 `-c http.version=HTTP/1.1` 重试)

## 七、已验证事实(不必重复验证)

- 全链路 e2e 通过(0.3.x 系列):同步→建环境→跑桩→出看板;真实流水线契约(--data/--skip-processing)原生兼容
- 真实流水线全量校准:总耗时 1433.5s,silver 48s / product 89s / customer 262s / kpi 1s / cross_ref 2s / **dashboard 1031s(占 72%)**
- `--data` 后段缺口已修(run_chain.py 把指定 Excel 接入 data/,复制+mtime 抬升);人员对应表随代码分发(发布脚本提升到包根,run_chain.py 接入 data/)
- requirements.txt 已补 xlsxwriter(漏装曾在客户分析阶段必炸)
- 自更新链路(至 v0.3.8 定稿,三轮实测迭代):0.3.3→0.3.4 ❌(ping 固定等 2s 不够,安装中止且无提示)→ v0.3.5 重构(tasklist 轮询等退出+结果回执文件+全屏遮罩);0.3.5→0.3.6 ❌(UTF-8 写出的 .cmd 被 GBK cmd 误读,中文安装路径乱码 `鐪嬫澘鍔╂墜` 无法自动重开)→ v0.3.7 修复(批处理模板全 ASCII+运行时路径走环境变量 UTF-16);**0.3.7→0.3.8 ✅ 全链路用户实测通过**(2026-08-18,详见 kanban-update-strategy.md 第四节)

## 八、流水线侧的已知深坑(不属于本交接的施工范围,大改参考)

ora 审查 + 实战确认,按优先级:
1. 🔴 Silver 缓存哈希只覆盖配置文件不覆盖数据 → 新月份数据可能复用旧缓存产出旧看板
2. 🔴 缓存命中路径缺 fillna("未知客户") → 客户数漂移
3. 🔴 客户/产品管道口径不一致(负数量、毛利率钳制)
4. 🟠 dashboard 独立王国(硬编码 sheet/列索引、绕过 Gold 层、占 72% 耗时)
5. 🟠 双管道死代码 / 三套配置 / silver 三处构建

大改时:oracle 出方案 → fixer 分车道 → 每步 golden-diff 对拍验证业务结果不变。

## 九、复核记录(2026-08-18,对本文档逐项核实)

| 项 | 核实结果 |
|---|---|
| P0 前提(Python311 源 + venv 依赖齐全) | ✅ 成立:`VENV_DEPS_OK` 全量导入通过。该 venv 曾被整体删除后由应用 setup_env 自动重建,依赖依然装齐——侧面验证回落路径可用 |
| P0 施工状态 | 未开工:portable-python/ 不存在,.gitignore 未加该项 |
| P1-1 孤儿进程回收 | 未施工:lib.rs 1136 行仍是 `.run(tauri::generate_context!())` 无退出回调(v0.3.5~0.3.8 的改动没动这里) |
| P1-2 半残环境自愈 | 未施工:main.ts 两处 health_check(setup-done 后 770 行 / init 838 行)均只记日志,`!h.ok` 不会自动重跑 setup_env |
| P1-3 跳过数据处理前置校验 | 未施工(流水线仓库 sales_analytics_platform 侧,不在本仓库) |
| P1-4 deps.txt 自动生成 | 未施工:publish_to_share.ps1 未改。注:kanban-share-sim/code/deps.txt 是桩的清单,别误当作已实现 |
| 共享盘可达 | ✅ 间接证实:本机 KanbanRunner\code 已从真实共享盘同步到真实流水线代码(首次启动默认路径自动同步成功) |
| 版本双源同步 | ✅ 当前 0.3.8 双源一致(未提交) |
| ⚠ 改动堆积提醒 | v0.3.5~v0.3.8 全部修复 + 前端更新体验改造 + 两份文档 + AGENTS.md 修正**均未提交**;P0 施工会继续叠加改动,建议先提交固化一版 |
