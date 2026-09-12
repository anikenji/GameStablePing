<#
.SYNOPSIS
    Tu dong them Game moi va quet IP may chu cua game vao GSP - GameStablePing.
#>

param(
    [string]$GameName,
    [string]$ProcessName
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Host "==============================================================="
Write-Host "   GSP - GAMESTABLEPING: CONG CU THEM GAME & QUET IP TU DONG"
Write-Host "==============================================================="
$Host.UI.RawUI.ForegroundColor = "White"

if (-not $GameName) {
    $GameName = Read-Host "Nhap ten Game (vi du: VRChat, Valorant, CS2)"
}
if (-not $ProcessName) {
    $ProcessName = Read-Host "Nhap ten tien trinh game (vi du: VRChat.exe, VALORANT.exe)"
}

$ProcessNameClean = $ProcessName -replace "\.exe$", ""
$GameId = $GameName.ToLower() -replace "[^a-z0-9]", ""

Write-Host "
[+] Ten Game: " $GameName -ForegroundColor Green
Write-Host "[+] ID Game: " $GameId -ForegroundColor Green
Write-Host "[+] Tien trinh: " $ProcessNameClean ".exe" -ForegroundColor Green

Write-Host "
[*] Dang theo doi tien trinh..." -ForegroundColor Yellow
Write-Host "[*] Hay mo game len, vao room/tran dau de thu thap IP..." -ForegroundColor Yellow
Write-Host "[*] Bam Ctrl+C bat ky luc nao de dung quet va luu.
" -ForegroundColor DarkGray

$CapturedIps = [System.Collections.Generic.HashSet[string]]::new()

try {
    $FoundProcess = $false
    while ($true) {
        $procs = Get-Process -Name $ProcessNameClean -ErrorAction SilentlyContinue
        if ($procs) {
            if (-not $FoundProcess) {
                Write-Host "[OK] Phat hien game dang chay! Bat dau quet..." -ForegroundColor Green
                $FoundProcess = $true
            }
            foreach ($p in $procs) {
                $tcpConns = Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue
                foreach ($c in $tcpConns) {
                    $remoteIp = $c.RemoteAddress
                    if ($remoteIp -and $remoteIp -notmatch "^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.|::|0\.0\.0\.0)") {
                        if ($c.RemotePort -notin 53, 80, 443 -and $CapturedIps.Add($remoteIp)) {
                            Write-Host "  [+] Bat duoc IP: " $remoteIp " (Port: " $c.RemotePort ")" -ForegroundColor Cyan
                        }
                    }
                }
            }
        } else {
            if ($FoundProcess) {
                Write-Host "
[*] Game da dong. Hoan tat quet." -ForegroundColor Yellow
                break
            }
        }
        Start-Sleep -Milliseconds 800
    }
} catch {
    Write-Host "
[*] Da dung quet." -ForegroundColor Yellow
}

$CidrList = [System.Collections.Generic.List[string]]::new()
foreach ($ip in $CapturedIps) {
    $p = $ip.Split(".")
    if ($p.Length -eq 4) {
        $cidr = $p[0] + "." + $p[1] + "." + $p[2] + ".0/24"
        if (-not $CidrList.Contains($cidr)) {
            $CidrList.Add($cidr)
            Write-Host "  -> Dai mang: " $cidr -ForegroundColor White
        }
    }
}

$ProfilePath = Join-Path $PSScriptRoot "..\profiles\multi-game-vn.json"
if (Test-Path $ProfilePath) {
    $prof = Get-Content $ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $newGame = [PSCustomObject]@{
        id = $GameId
        name = $GameName
        processNames = @($ProcessName, $ProcessNameClean + ".exe", $ProcessNameClean)
        lobbyAddresses = @()
        regions = @(
            [PSCustomObject]@{
                id = $GameId + "-tokyo"
                name = "Tokyo (Japan)"
                source = "custom:scanned"
                note = "Quet tu dong boi Add-Game.ps1"
                landmarks = @("158.101.137.208")
                cidrs = @($CidrList)
            }
        )
    }
    $existing = $prof.games | Where-Object { $_.id -eq $GameId }
    if ($existing) {
        $existing.regions[0].cidrs = @($CidrList)
    } else {
        $prof.games += $newGame
    }
    $prof | ConvertTo-Json -Depth 10 | Set-Content $ProfilePath -Encoding UTF8
    Write-Host "
[OK] Da luu game " $GameName " vao profile " $ProfilePath " thanh cong!" -ForegroundColor Green
}
