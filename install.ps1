# site-selection skill 安装脚本（WorkBuddy / DSH 通用）
# 用法：pwsh -File install.ps1            → 装到 ~/.dsh/skills/site-selection
#       pwsh -File install.ps1 -Target X   → 装到自定义目录

param([string]$Target = "$env:USERPROFILE\.dsh\skills\site-selection")

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "安装到: $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item "$here\*" $Target -Recurse -Force
Write-Host "[1/3] 文件已复制"

# Python 依赖检查
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { Write-Warning "未找到 python，脚本类功能不可用" }
else {
    python -c "import openpyxl" 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "[2/3] 提示: pip install openpyxl（仅 import-benchmarks.py 需要）" }
    else { Write-Host "[2/3] Python 依赖就绪" }
}

# 高德 Key 检查
if ($env:AMAP_API_KEY) { Write-Host "[3/3] 已检测到 AMAP_API_KEY" }
else {
    $keyFile = "$env:USERPROFILE\.dsh\secrets\amap.key"
    if (Test-Path $keyFile) { Write-Host "[3/3] 已找到 $keyFile" }
    else { Write-Warning "[3/3] 未配置高德 Key：设环境变量 AMAP_API_KEY，或写入 $keyFile" }
}

Write-Host ""
Write-Host "完成。两种用法："
Write-Host "  A. 任意运行时 → python scripts/site_core.py <finance|crs|veto|dedupe|geo|benchmark> --help"
Write-Host "  B. DSH 原生工具 → 按 dsh/cordis.patch.yml 里的注释把插件挂上，重启 DSH"