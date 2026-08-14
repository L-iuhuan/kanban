# 看板流水线 · 一键发布到共享盘
# 用途:开发者改完流水线代码后,运行本脚本把代码推到共享盘并生成版本号,
#       客户端下次启动(或点「同步代码」)即可拉到最新代码。
#
# 用法:
#   .\publish_to_share.ps1                                  # 发布代码(默认源目录)
#   .\publish_to_share.ps1 -SourceDir D:\path\to\pipeline   # 指定流水线代码目录
#   .\publish_to_share.ps1 -AppInstaller <setup.exe路径> -AppVersion 0.2.0
#       # 同时发布壳子安装包(壳子更新:客户端启动时会提示有新版本)
param(
  [string]$SourceDir = "E:\3-其他资料\数据分析\sales_analytics_platform",
  [string]$ShareRoot = "\\192.168.8.3\财务部\办公软件\SoftwareUpdate\数据分析看板",
  [string]$AppInstaller = "",
  [string]$AppVersion = ""
)

$ErrorActionPreference = "Stop"

# ── 1. 同步代码到共享盘 code/(镜像;排除运行时产物/测试/环境) ──
if (-not (Test-Path (Join-Path $SourceDir "run_chain.py"))) {
  Write-Error "源目录下没有 run_chain.py: $SourceDir (请确认流水线代码目录)"
  exit 1
}
$dst = Join-Path $ShareRoot "code"
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 人员对应表随代码分发:data/ 目录不参与同步,先提升到包根(包根文件会被 robocopy 同步),
# 客户端 run_chain.py 会在本地 data/ 缺失时从包根接入
$personnel = Join-Path $SourceDir "data\部门-人员-职务对应.md"
if (Test-Path $personnel) {
  Copy-Item $personnel (Join-Path $SourceDir "部门-人员-职务对应.md") -Force
  Write-Output "  人员对应表已提升到包根(随代码分发)"
}

Write-Output "[1/3] 同步代码: $SourceDir -> $dst"
robocopy $SourceDir $dst /MIR /XD .git output data __pycache__ .venv .pytest_cache test node_modules /XF *.pyc *.log "~`$*" /R:1 /W:1 /NFL /NDL /NJH /NP /MT:8 | Out-Null
if ($LASTEXITCODE -gt 7) {
  Write-Error "代码同步失败 (robocopy 退出码 $LASTEXITCODE)"
  exit 1
}

# ── 2. 生成版本号(优先 git commit 短哈希,仓库不可用时用时间戳) ──
$hash = "nogit"
try {
  $h = (git -C $SourceDir rev-parse --short HEAD 2>$null)
  if ($h) { $hash = $h.Trim() }
} catch {}
$ver = "v$hash @ $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
[IO.File]::WriteAllText((Join-Path $dst "version.txt"), $ver)
Write-Output "[2/3] 版本号已写入: $ver"

# ── 3. 可选:发布壳子安装包到 app/(客户端启动时提示更新) ──
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
  Write-Output "[3/3] 壳子安装包已发布: $appDir (版本 $AppVersion)"
} else {
  Write-Output "[3/3] 跳过壳子发布(未提供 -AppInstaller)"
}

Write-Output ""
Write-Output "发布完成。客户端下次启动或点「同步代码」即生效。"
