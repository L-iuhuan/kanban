# ============================================================================
# diagnose_excel_com.ps1 — Excel COM 通道体检（只读诊断 + 实弹探测）
#
# 用途: 排查"兼容通道读取失败 / 对方 Excel 正忙"类报错的机器侧根因:
#   ① Excel.Application ProgID 是否被 WPS 接管(注册表指向 wps/et 而非 EXCEL.EXE)
#   ② Office EXCEL.EXE 是否在册、版本、位置(自动生成修复命令用)
#   ③ 是否有残留 EXCEL/et/wps 进程占着 COM 服务器
#   ④ 实弹探测: 分别用 ProgID 和微软 Excel 显式 CLSID {00024500-...} 拉一个
#      Excel 实例再退出——直接复现"呼叫被拒",并验证 CLSID 直连能否绕过接管
#   ⑤ 可选 -TestFile: 端到端打开一个真实文件(DSE 加密文件亦可),复刻流水线读取路径
#
# 安全性: 本脚本不改文件、不改注册表; 探测拉起的 Excel 实例会 Quit,
#         5 秒未退出只 taskkill 本脚本自己拉起的 PID,不碰用户已开的窗口。
#
# 用法(目标机器 PowerShell,无需管理员):
#   powershell -ExecutionPolicy Bypass -File diagnose_excel_com.ps1
#   powershell -ExecutionPolicy Bypass -File diagnose_excel_com.ps1 -TestFile "C:\path\财务分析-7月.xlsx"
#   powershell -ExecutionPolicy Bypass -File diagnose_excel_com.ps1 -SkipProbe   # 只查注册表/进程
# ============================================================================
param(
  [string]$TestFile = "",
  [switch]$SkipProbe
)

$ErrorActionPreference = "Continue"
# 输出编码跟随本机控制台(中文 Windows 默认 GBK):子进程强设 UTF-8 反而让父窗口/Tee 显示乱码

$script:WorstState = 0   # 0=正常 1=警告 2=异常
function Set-State([int]$lv) { if ($lv -gt $script:WorstState) { $script:WorstState = $lv } }
function Sec([string]$t)  { Write-Host ""; Write-Host "===== $t =====" -ForegroundColor Cyan }
function Ok([string]$t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "  [WARN] $t" -ForegroundColor Yellow; Set-State 1 }
function Bad([string]$t)  { Write-Host "  [FAIL] $t" -ForegroundColor Red; Set-State 2 }
function Info([string]$t) { Write-Host "  [i]    $t" }

# ── HRESULT 可读化(忙码/常见注册故障码) ──
$HR_MAP = @{
  "0x80010001" = "RPC_E_CALL_REJECTED 被呼叫方拒绝(服务器忙/有弹窗)"
  "0x80010109" = "RPC_E_RETRY 服务器请稍后再试"
  "0x8001010A" = "RPC_E_SERVERCALL_RETRYLATER 服务器忙,稍后重试"
  "0x8001010B" = "RPC_E_SERVERCALL_REJECTED 呼叫被消息过滤器拒绝"
  "0x800401E3" = "MK_E_UNAVAILABLE 无可用运行对象"
  "0x800700C1" = "ERROR_BAD_EXE_FORMAT 位宽不匹配(32/64位注册错乱)"
  "0x80080005" = "CO_E_SERVER_EXEC_FAILURE COM 服务器启动失败(注册损坏?)"
}
function Read-HResult([Exception]$ex) {
  $hr = $null
  try { $hr = $ex.HResult } catch {}
  if (-not $hr -and $ex -is [System.Runtime.InteropServices.COMException]) {
    try { $hr = [int]$ex.GetType().GetProperty("HResult", [Reflection.BindingFlags]"NonPublic,Instance").GetValue($ex, $null) } catch {}
  }
  if (-not $hr) {
    if ($ex.Message -match "0x[0-9A-Fa-f]{8}") { return $Matches[0].ToUpper() + " " + $HR_MAP[$Matches[0].ToUpper()] }
    return $ex.Message
  }
  $hex = "0x{0:X8}" -f $hr
  if ($HR_MAP.ContainsKey($hex)) { return "$hex $($HR_MAP[$hex])" }
  return $hex
}

# ── 注册表读取小工具(HKCR 驱动默认不挂载,用 Registry:: 前缀) ──
function Get-RegDefault([string]$key) {
  try { return (Get-ItemProperty -LiteralPath "Registry::$key" -ErrorAction Stop)."(default)" } catch { return $null }
}

# 判定某个 ProgID 实际归属于微软 Office 还是 WPS;-Soft 用于参照组件(如 Ket.Application),
# 未注册/异常只提示不拉低退出码(没装 WPS 的机器属正常)
function Test-ProgID([string]$progId, [switch]$Soft) {
  Info "ProgID: $progId"
  $clsid = Get-RegDefault "HKEY_CLASSES_ROOT\$progId\CLSID"
  if (-not $clsid) {
    if ($Soft) { Info "  未注册(本机无此组件,正常)" } else { Warn "  未注册(无 CLSID 映射)" }
    return $null
  }
  $server = Get-RegDefault "HKEY_CLASSES_ROOT\CLSID\$clsid\LocalServer32"
  $serverClean = ($server -replace '"','').Trim()
  Info "  CLSID         = $clsid"
  Info "  LocalServer32 = $serverClean"
  if (-not $serverClean) {
    if ($Soft) { Info "  LocalServer32 缺失" } else { Bad "  CLSID 已注册但 LocalServer32 缺失 → COM 服务器注册不完整" }
    return $null
  }
  $low = $serverClean.ToLower()
  # 判定顺序: WPS 特征优先(防止 WPS 目录下的兼容组件误判),再认 Office;路径尾部可能带 /automation 等参数,不能锚定结尾
  if ($low -match "wps|kingsoft|\bet\.exe") {
    if ($Soft) { Info "  归属: WPS(其自身组件,正常)" }
    else { Bad "  归属: WPS(已被 WPS 接管!) ← '对方 Excel 正忙'的头号根因" }
    return @{ Owner = "WPS"; Clsid = $clsid; Server = $serverClean }
  } elseif ($low -match "excel\.exe") {
    Ok "  归属: Microsoft Office Excel(正常)"
    return @{ Owner = "Office"; Clsid = $clsid; Server = $serverClean }
  } else {
    if ($Soft) { Info "  归属: 其他程序 → $serverClean" }
    else { Warn "  归属: 其他程序 → $serverClean" }
    return @{ Owner = "Other"; Clsid = $clsid; Server = $serverClean }
  }
}

# ── COM 进程快照/比对 ──
$COM_PROC_NAMES = @("EXCEL","et","wps","wpscloudsvr","wpscenter")
function Get-ComPids { Get-Process -Name $COM_PROC_NAMES -ErrorAction SilentlyContinue | Select-Object Name, Id, MainWindowTitle }
function Get-NewPids($before, $after) {
  $b = @($before | ForEach-Object { $_.Id })
  @($after | Where-Object { $b -notcontains $_.Id })
}

# ── 实弹探测: 创建→读版本→Quit→善后 ──
# 注意: ReleaseComObject/GC 之后不得再引用 $app 的任何 COM 成员(含 $null 比较),
# 否则抛 InvalidComObjectException —— 故先落 $created 布尔,清理后 return 布尔。
function Invoke-ComProbe([string]$label, [scriptblock]$create) {
  Sec "实弹探测: $label"
  $before = Get-ComPids
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $app = $null
  $created = $false
  try {
    $app = & $create
    $sw.Stop()
    $ver = $null; try { $ver = $app.Version } catch {}
    $created = $true
    Ok ("创建成功({0:n1}s) Version={1}" -f $sw.Elapsed.TotalSeconds, $ver)
    Info "若刚才弹出过'组件正在处理中/重试'对话框,本身就是服务器忙的直接证据"
  } catch {
    $sw.Stop()
    Bad ("创建失败({0:n1}s): {1}" -f $sw.Elapsed.TotalSeconds, (Read-HResult $_.Exception))
    $app = $null
  }
  # 善后: Quit + 只清自己拉起的进程
  if ($app) {
    try { $app.DisplayAlerts = $false } catch {}
    try { $app.Quit() } catch {}
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
    $app = $null
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
  Start-Sleep -Seconds 3
  $spawned = Get-NewPids $before (Get-ComPids)
  if ($spawned.Count -gt 0) {
    foreach ($p in $spawned) {
      if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) {
        Warn "探测实例 $($p.Name)(PID $($p.Id)) 3 秒未自行退出,taskkill 清理(仅本脚本拉起的)"
        try { taskkill /F /PID $p.Id | Out-Null } catch {}
      }
    }
  } else { Ok "探测实例已干净退出,无残留" }
  return $created
}

# ══════════════════════════ 报告开始 ══════════════════════════
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Excel COM 通道体检  $env:COMPUTERNAME  $env:USERNAME"
Write-Host " $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "============================================================" -ForegroundColor Cyan

# ── 1. ProgID 归属(核心诊断) ──
Sec "1. Excel.Application ProgID 归属(是否被 WPS 接管)"
$excelProg = Test-ProgID "Excel.Application"
$curVer = Get-RegDefault "HKEY_CLASSES_ROOT\Excel.Application\CurVer"
if ($curVer) { Info "CurVer = $curVer" }
Info "--- 参照: WPS 表格自身的 ProgID(存在即装了 WPS,属正常) ---"
Test-ProgID "Ket.Application" -Soft | Out-Null

# ── 2. Office EXCEL.EXE 在册情况(生成修复命令用) ──
Sec "2. Office EXCEL.EXE 位置与版本"
$excelPath = $null
foreach ($k in @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe",
                 "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe")) {
  try {
    $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop)."(default)"
    if ($v) { $excelPath = ($v -replace '"','').Trim(); break }
  } catch {}
}
if (-not $excelPath) {
  foreach ($p in @("$env:ProgramFiles\Microsoft Office\root\Office16\EXCEL.EXE",
                   "${env:ProgramFiles(x86)}\Microsoft Office\root\Office16\EXCEL.EXE",
                   "$env:ProgramFiles\Microsoft Office\Office16\EXCEL.EXE",
                   "${env:ProgramFiles(x86)}\Microsoft Office\Office16\EXCEL.EXE",
                   "$env:ProgramFiles\Microsoft Office\root\Office15\EXCEL.EXE",
                   "${env:ProgramFiles(x86)}\Microsoft Office\root\Office15\EXCEL.EXE")) {
    if (Test-Path $p) { $excelPath = $p; break }
  }
}
if ($excelPath -and (Test-Path $excelPath)) {
  $vi = (Get-Item $excelPath).VersionInfo.ProductVersion
  Ok "找到: $excelPath (版本 $vi)"
} else {
  Warn "标准路径与 App Paths 均未找到 EXCEL.EXE —— 本机可能未装桌面版 Office(仅 WPS?),COM 解密通道无从谈起"
}

# ── 3. 残留/常驻 COM 相关进程 ──
Sec "3. EXCEL / WPS 相关进程"
$procs = Get-ComPids
if (-not $procs) {
  Ok "当前无 EXCEL/et/wps 进程在跑"
} else {
  foreach ($p in $procs) {
    if ($p.MainWindowTitle) {
      Info "$($p.Name) PID=$($p.Id) | 窗口: $($p.MainWindowTitle)(开着窗口时,COM 附加到它的实例可能被拒)"
    } elseif ($p.Name -eq "EXCEL") {
      Warn "$($p.Name) PID=$($p.Id) | 无窗口的 EXCEL.EXE = 残留嫌疑(占住 COM 服务器,建议结束)"
    } else {
      Info "$($p.Name) PID=$($p.Id) | 无窗口(WPS 后台服务/首页常驻,属正常现象)"
    }
  }
}
$dse = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "esafe|dse|cdg" } | Select-Object -First 5
if ($dse) { Info "疑似 DSE/加密客户端进程: $(($dse | ForEach-Object Name | Select-Object -Unique) -join ', ')(透明解密的前提)" }
else { Info "未探测到 DSE 客户端进程(名称匹配可能不全,仅供参考)" }

# ── 4. 实弹探测 ──
$probeAok = $null; $probeBok = $null
if ($SkipProbe) {
  Sec "4. 实弹探测(已用 -SkipProbe 跳过)"
} else {
  Info "提示: 若弹出'组件正在处理中'对话框,点'重试'或'切换至'无妨,诊断继续"
  $probeAok = Invoke-ComProbe "A. ProgID 通道: New-Object -ComObject Excel.Application(与流水线现状同款)" {
    New-Object -ComObject Excel.Application
  }
  $probeBok = Invoke-ComProbe "B. 显式 CLSID 通道: {00024500-0000-0000-C000-000000000046}(绕过 ProgID 接管,方案②将采用)" {
    [Activator]::CreateInstance([Type]::GetTypeFromCLSID("00024500-0000-0000-C000-000000000046"))
  }

  # ── 5. 端到端读文件(可选) ──
  if ($TestFile) {
    Sec "5. 端到端打开测试: $TestFile"
    if (-not (Test-Path $TestFile)) { Bad "文件不存在" }
    else {
      $local = $TestFile
      $tmpCopy = $null
      if ($TestFile.StartsWith("\\")) {
        $tmpCopy = Join-Path $env:TEMP ("diag_com_" + [IO.Path]::GetFileName($TestFile))
        Copy-Item $TestFile $tmpCopy -Force
        $local = $tmpCopy
        Info "UNC 源已复制到本地: $local"
      }
      $head = $null
      try { $fs = [IO.File]::OpenRead($local); $head = $fs.ReadByte(); $null = $fs.ReadByte(); $null = $fs.ReadByte(); $null = $fs.ReadByte(); $fs.Close() } catch {}
      Info ("文件头: 0x{0:X2}... ({1})" -f $head, $(if ($head -eq 0x50) { "PK=明文 xlsx" } else { "非PK=DSE等加密,必须走 COM 解密" }))
      $before = Get-ComPids
      $app = $null; $wb = $null; $sw = [Diagnostics.Stopwatch]::StartNew()
      try {
        $app = [Activator]::CreateInstance([Type]::GetTypeFromCLSID("00024500-0000-0000-C000-000000000046"))
        $wb = $app.Workbooks.Open($local, 0, $true)
        $n = $wb.Sheets.Count
        $ur = $wb.Worksheets.Item(1).UsedRange
        $dims = "$($ur.Rows.Count) 行 x $($ur.Columns.Count) 列"
        $sw.Stop()
        Ok ("打开成功({0:n1}s): Sheets={1}, 首表 UsedRange = {2}" -f $sw.Elapsed.TotalSeconds, $n, $dims)
      } catch {
        $sw.Stop()
        Bad ("打开失败({0:n1}s): {1}" -f $sw.Elapsed.TotalSeconds, (Read-HResult $_.Exception))
      } finally {
        if ($wb) { try { $wb.Close($false) } catch {} }
        if ($app) { try { $app.Quit() } catch {} }
        try { if ($wb) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb) } } catch {}
        try { if ($app) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } } catch {}
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        Start-Sleep -Seconds 2
        foreach ($p in (Get-NewPids $before (Get-ComPids))) {
          if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) {
            try { taskkill /F /PID $p.Id | Out-Null; Warn "已清理探测残留 PID $($p.Id)" } catch {}
          }
        }
      }
      if ($tmpCopy) { Remove-Item $tmpCopy -Force -ErrorAction SilentlyContinue }
    }
  }
}

# ══════════════════════════ 结论与处方 ══════════════════════════
Sec "结论与处方"
$regOk = ($excelProg -and $excelProg.Owner -eq "Office")
if (-not $SkipProbe) {
  if ($regOk -and $probeAok) { Ok "总评: COM 通道健康(ProgID=Office 且实弹通过) —— 报错多半是当时残留进程/弹窗,清理后重跑即可" }
  elseif ($regOk -and $null -eq $probeAok) { Warn "总评: 注册表正常但 ProgID 实弹失败 → 当时有忙占用(关掉所有 WPS/Excel 窗口+杀残留后重试)" }
  elseif (-not $regOk) {
    Bad "总评: Excel.Application 已被 WPS(或其他程序)接管 —— '对方 Excel 正忙'的根因"
    if ($probeBok) { Ok "好消息: 显式 CLSID 通道可用 → 代码加固(CLSID 直连)能在此机根治" }
    else { Bad "显式 CLSID 通道也不可用 → 需先修复 Office COM 注册(见处方②)" }
  }
} else {
  if ($regOk) { Ok "总评(仅注册表): ProgID 归属 Office,未见接管" } else { Bad "总评(仅注册表): ProgID 已被接管,详见第 1 节" }
}
Write-Host ""
Write-Host "处方(按需执行,①→②→重跑本脚本验证):" -ForegroundColor Magenta
Write-Host "  ① 关闭所有 WPS/Excel 窗口;任务管理器结束残留 EXCEL.EXE / et.exe / wps.exe"
Write-Host "     命令: taskkill /F /IM et.exe /IM wps.exe /IM EXCEL.EXE  (会杀所有实例,先保存文档)"
if ($excelPath) {
  Write-Host "  ② 恢复 Office 对 COM 的注册(管理员 CMD,标准修,副作用:.xlsx 双击关联可能回到 Office):"
  Write-Host "       `"$excelPath`" /unregserver"
  Write-Host "       `"$excelPath`" /regserver"
  Write-Host "     或精准修(只改 COM 解析,不动文件关联,管理员 CMD):"
  Write-Host "       reg add `"HKLM\Software\Classes\Excel.Application\CLSID`" /ve /d `"{00024500-0000-0000-C000-000000000046}`" /f"
} else {
  Write-Host "  ② 本机未找到 EXCEL.EXE —— 需先安装桌面版 Office(仅 WPS 无法走 COM 解密通道)"
}
Write-Host "  ③ WPS 侧开关(可选,改默认打开方式,影响日常使用,慎重):"
Write-Host "     开始 → WPS Office → 配置工具 → 高级 → 兼容设置 → 取消'WPS Office 兼容第三方系统和软件'"
Write-Host ""
Write-Host "留档: powershell -ExecutionPolicy Bypass -File diagnose_excel_com.ps1 | Tee-Object diag.log"
exit $script:WorstState
