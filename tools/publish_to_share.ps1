# 看板流水线 · 一键发布到共享盘
# 用途:开发者改完流水线代码后,运行本脚本把代码推到共享盘并生成版本号,
#       客户端下次启动(或点「同步代码」)即可拉到最新代码。
#
# 用法:
#   .\publish_to_share.ps1                                  # 发布代码(默认源目录)
#   .\publish_to_share.ps1 -SourceDir D:\path\to\pipeline   # 指定流水线代码目录
#   .\publish_to_share.ps1 -AppInstaller <setup.exe路径> -AppVersion 0.2.0
#       # 同时发布壳子安装包(壳子更新:客户端启动时会提示有新版本)
#   .\publish_to_share.ps1 -ShareRoot \\server\share\...    # 显式指定共享盘(默认读 share_config.json)
#   .\publish_to_share.ps1 -Force                           # 非交互环境:跳过"已是最新"确认,直接发布
param(
  [string]$SourceDir = "E:\3-其他资料\数据分析\sales_analytics_platform",
  [string]$ShareRoot = "",
  [string]$AppInstaller = "",
  [string]$AppVersion = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# ── 0. 共享盘根:默认读 share_config.json(单点配置,与壳端 lib.rs DEFAULT_SHARE_PATH 对齐) ──
# 批次W2:不再硬编码 UNC 默认值;配置缺失时报错引导创建,避免脚本/壳两处漂移。
$repoRoot = Split-Path -Parent $PSScriptRoot   # tools/ -> kanban/
$configPath = Join-Path $repoRoot "share_config.json"
if (-not $ShareRoot) {
  if (Test-Path $configPath) {
    try {
      $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $ShareRoot = $cfg.share_root
    } catch {
      Write-Error "share_config.json 解析失败: $($_.Exception.Message) (请检查 JSON 格式)"
      exit 1
    }
  }
}
if (-not $ShareRoot) {
  $errMsg = "未指定 -ShareRoot 且找不到 $configPath。请先创建该文件:`n" +
    '{"share_root": "\\\\192.168.8.3\\财务部\\办公软件\\SoftwareUpdate\\数据分析看板", ' +
    '"note": "壳端 lib.rs DEFAULT_SHARE_PATH 发版时需与此一致"}' +
    "`n或在调用本脚本时传 -ShareRoot 指向共享盘根。"
  Write-Error $errMsg
  exit 1
}

# ── 0.5 git commit 短哈希(健壮版) ──────────────────────────────
# 根因:本脚本常由子进程/agent 调用,进程 PATH 不继承"重开终端后"的 PATH——
#      git 是用户级安装(%LOCALAPPDATA%\Programs\Git),装完未重开的旧 shell 里
#      `git` 找不到 → version.txt 会写成 "vnogit @ ..."。
#      故先试 PATH 的 git,失败再回落已知全路径,最后才用 nogit。
function Get-GitShortHash {
  param([string]$Dir)
  $gitCandidates = @(
    "git",
    "C:\Users\910373\AppData\Local\Programs\Git\cmd\git.exe"
  )
  foreach ($g in $gitCandidates) {
    try {
      $h = (& $g -C $Dir rev-parse --short HEAD 2>$null)
      if ($LASTEXITCODE -eq 0 -and $h) { return $h.Trim() }
    } catch { }
  }
  return $null
}

if (-not (Test-Path (Join-Path $SourceDir "run_chain.py"))) {
  Write-Error "源目录下没有 run_chain.py: $SourceDir (请确认流水线代码目录)"
  exit 1
}

# ── 0.6 发布预检:比对 本地 git HEAD vs 共享盘 code/version.txt 哈希 ──
# 批次W2:同步前先自检,避免重复发布/误覆盖;已最新时提示并询问是否继续(-Force 跳过)。
$hash = Get-GitShortHash -Dir $SourceDir
if (-not $hash) { $hash = "nogit" }
$dst = Join-Path $ShareRoot "code"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
$shareHash = ""
$verFile = Join-Path $dst "version.txt"
if (Test-Path $verFile) {
  $shareVer = [IO.File]::ReadAllText($verFile)
  if ($shareVer -match '^v(\S+?)\s+@') { $shareHash = $Matches[1].Trim() }
}
$shareDisplay = if ($shareHash) { $shareHash } else { "(无有效哈希)" }
$continuePublish = $true
if ($shareHash -and ($hash -ieq $shareHash)) {
  Write-Output "共享盘已是最新,无需发布 (version.txt 哈希=$hash = 本地 HEAD)"
  if ($Force) {
    Write-Output "  (-Force) 仍继续发布..."
  } elseif ([Console]::IsInputRedirected) {
    # 非交互环境(agent/子进程)无法确认输入 → 视为取消:已最新本就无需发布,强制发布须显式 -Force
    Write-Output "  (非交互环境无法确认,已取消发布;如需强制请加 -Force)"
    $continuePublish = $false
  } else {
    $ans = Read-Host "是否仍要强制发布? (y/N)"
    if ($ans -notmatch '^[yY]') { Write-Output "已取消发布。"; $continuePublish = $false }
  }
  # exit 置于 try/catch 之外:已验证 -File 模式下 catch 内 exit 不生效,会继续执行
  if (-not $continuePublish) { exit 0 }
} else {
  Write-Output "共享盘落后: share=$shareDisplay local=$hash,继续同步"
}

# ── 1. 同步代码到共享盘 code/(镜像;排除运行时产物/测试/环境) ──

# 人员对应表随代码分发:data/ 目录不参与同步,先提升到包根(包根文件会被 robocopy 同步),
# 客户端 run_chain.py 会在本地 data/ 缺失时从包根接入
$personnel = Join-Path $SourceDir "data\部门-人员-职务对应.md"
if (Test-Path $personnel) {
  Copy-Item $personnel (Join-Path $SourceDir "部门-人员-职务对应.md") -Force
  Write-Output "  人员对应表已提升到包根(随代码分发)"
}

Write-Output "[1/4] 同步代码: $SourceDir -> $dst"
# 共享安全(2026-08-24 用户拍板):共享盘只出核心代码——排除含全量业务数据的看板产物(dashboard_a.html)、
# 预聚合缓存(preagg.json)、快照仓(data_warehouse)。历史上 dashboard_a.html 曾被同步,已手工清理。
robocopy $SourceDir $dst /MIR /XD .git output data data_warehouse __pycache__ .venv .pytest_cache test node_modules /XF *.pyc *.log dashboard_a.html preagg.json "~`$*" /R:1 /W:1 /NFL /NDL /NJH /NP /MT:8 | Out-Null
if ($LASTEXITCODE -gt 7) {
  Write-Error "代码同步失败 (robocopy 退出码 $LASTEXITCODE)"
  exit 1
}

# ── 2. 生成版本号(优先 git commit 短哈希,仓库不可用时用时间戳) ──
$ver = "v$hash @ $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
[IO.File]::WriteAllText((Join-Path $dst "version.txt"), $ver)
Write-Output "[2/4] 版本号已写入: $ver"

# 同步后复读验证写入成功
$writtenVer = [IO.File]::ReadAllText((Join-Path $dst "version.txt"))
if ($writtenVer -ne $ver) {
  Write-Error "version.txt 写入校验失败: 期望 '$ver',实际 '$writtenVer'"
  exit 1
}
Write-Output "  [验证] version.txt 复读一致: $writtenVer"

# ── deps.txt 自动生成(对接终版 check_deps 的依赖声明;UTF-8 无 BOM) ──
$requirements = Join-Path $SourceDir "requirements.txt"
if (Test-Path $requirements) {
  $deps = @()
  foreach ($line in [IO.File]::ReadAllLines($requirements)) {
    # 去注释(# 及以后)并 trim
    $item = $line.Split("#")[0].Trim()
    if (-not $item) { continue }
    # 去版本约束(>=/==/~=/>/< 及以后)
    $item = ($item -split "[>=~<]")[0].Trim()
    if (-not $item) { continue }
    # 包名 -> import 名映射(其余原样)
    switch ($item) {
      "scikit-learn"     { $item = "sklearn" }
      "python-calamine"  { $item = "python_calamine" }
      "chinese-calendar" { $item = "chinese_calendar" }
    }
    $deps += $item
  }
  [IO.File]::WriteAllText((Join-Path $dst "deps.txt"), ($deps -join "`n"), [Text.UTF8Encoding]::new($false))
  Write-Output "  deps.txt 已生成: $($deps.Count) 个依赖"
} else {
  Write-Output "  跳过 deps.txt 生成(未找到 requirements.txt)"
}

# ── 3/4 便携 Python 运行环境(免安装分发的核心) ──
$portableSrc = "E:\3-其他资料\数据分析\kanban\portable-python"
if (Test-Path (Join-Path $portableSrc "python.exe")) {
  Write-Output "[3/4] 同步便携 Python 环境到共享盘 python\ (首次约 700MB,内网几分钟;之后增量)"
  robocopy $portableSrc (Join-Path $ShareRoot "python") /MIR /XD __pycache__ /XF *.pyc /R:1 /W:1 /NFL /NDL /NJH /NP /MT:16 | Out-Null
  if ($LASTEXITCODE -gt 7) { Write-Error "Python 环境同步失败 (robocopy $LASTEXITCODE)"; exit 1 }
} else {
  Write-Output "[3/4] 跳过便携 Python(未找到 $portableSrc\python.exe)"
}

# ── 4. 可选:发布壳子安装包到 app/(客户端启动时提示更新) ──
if ($AppInstaller) {
  if (-not (Test-Path $AppInstaller)) {
    Write-Error "安装包不存在: $AppInstaller"
    exit 1
  }
  $appDir = Join-Path $ShareRoot "app"
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null
  Copy-Item $AppInstaller $appDir -Force
  if ($AppVersion) {
    [IO.File]::WriteAllText((Join-Path $appDir "app-version.txt"), $AppVersion)
  }
  Write-Output "[4/4] 壳子安装包已发布: $appDir (版本 $AppVersion)"
} else {
  Write-Output "[4/4] 跳过壳子发布(未提供 -AppInstaller)"
}

Write-Output ""
Write-Output "发布完成。客户端下次启动或点「同步代码」即生效。"
