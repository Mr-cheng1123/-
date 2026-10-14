param(
    [Parameter(Mandatory = $true)][string]$AppUrl,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ServerPid,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')][string]$InstanceToken,
    [string]$ReadyFile = '',
    [ValidateRange(0, 2147483647)][int]$TestAutoCloseAfterMs = 0
)

$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('desktop-window: startup')
# Add-Type can invoke the framework compiler. Keep its temporary files on D:.
$desktopTemp = 'D:\codex\tmp\funding-arb-desktop'
[void][IO.Directory]::CreateDirectory($desktopTemp)
$env:TEMP = $desktopTemp
$env:TMP = $desktopTemp
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FundingArbDesktopWindow {
    private delegate bool WindowEnumerator(IntPtr window, IntPtr extra);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowEnumerator callback, IntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetProp(IntPtr window, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool SetProp(IntPtr window, string name, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr RemoveProp(IntPtr window, string name);
    public static IntPtr FindInstanceWindow(string propertyName) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr extra) {
            if (GetProp(window, propertyName) == new IntPtr(1)) {
                result = window;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
'@
[Console]::Out.WriteLine('desktop-window: libraries-ready')

$appUri = [Uri]$AppUrl
if ($appUri.Scheme -ne 'http' -or $appUri.Host -ne '127.0.0.1' -or
    $appUri.Port -lt 1024 -or $appUri.Port -gt 65535 -or
    $appUri.UserInfo -or $appUri.Query -or $appUri.Fragment -or $appUri.AbsolutePath -ne '/') {
    throw '软件窗口只接受本机软件的根地址。'
}
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$stopScript = Join-Path $ProjectRoot 'scripts\stop-app.mjs'
if (-not [IO.File]::Exists($NodePath) -or -not [IO.File]::Exists($stopScript)) {
    throw '安全退出工具或 Node 运行环境不存在。'
}

if ($ReadyFile) {
    $ReadyFile = [IO.Path]::GetFullPath($ReadyFile)
    if (-not $ReadyFile.StartsWith('D:\codex\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '窗口就绪记录必须保存在 D:\codex 下。'
    }
    $readyAncestor = $ReadyFile
    while ($readyAncestor -and $readyAncestor.Length -gt 3) {
        if ([IO.File]::Exists($readyAncestor) -or [IO.Directory]::Exists($readyAncestor)) {
            if (([IO.File]::GetAttributes($readyAncestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '窗口就绪记录不能经过目录联接或符号链接。'
            }
        }
        $readyAncestor = [IO.Path]::GetDirectoryName($readyAncestor)
    }
    if ([IO.File]::Exists($ReadyFile)) { throw '窗口就绪记录已存在，请使用新的文件名。' }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($ReadyFile))
}

function Write-WindowReady([bool]$Existing) {
    if (-not $ReadyFile) { return }
    $readyJson = [pscustomobject]@{
        ready = $true
        serverPid = $ServerPid
        windowTitle = $windowTitle
        pid = $PID
        existing = $Existing
    } | ConvertTo-Json -Compress
    $pendingReady = $ReadyFile + '.writing-' + $PID
    $readyStream = $null
    try {
        $readyStream = [IO.File]::Open($pendingReady, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $readyBytes = [Text.Encoding]::UTF8.GetBytes($readyJson)
        $readyStream.Write($readyBytes, 0, $readyBytes.Length)
        $readyStream.Dispose()
        $readyStream = $null
        [IO.File]::Move($pendingReady, $ReadyFile)
    }
    finally {
        if ($null -ne $readyStream) { $readyStream.Dispose() }
        if ([IO.File]::Exists($pendingReady)) { [IO.File]::Delete($pendingReady) }
    }
}

# Separate project copies keep separate windows; only the pinned backend can be stopped.
$desktopIdentity = $ProjectRoot.TrimEnd('\', '/').ToLowerInvariant() + '|' + $appUri.Port
$identity = $desktopIdentity + '|' + $InstanceToken.ToLowerInvariant()
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '')
    $taskbarHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($desktopIdentity))).Replace('-', '')
}
finally { $hasher.Dispose() }
$windowTitle = '资金费率套利软件 · ' + $appUri.Port
$windowProperty = 'FundingArb.Desktop.' + $hash
$mutex = New-Object Threading.Mutex($false, ('Local\FundingArb.Desktop.' + $hash))
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) {
    [Console]::Out.WriteLine('desktop-window: existing-instance-window')
    try {
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $existingWindow = [FundingArbDesktopWindow]::FindInstanceWindow($windowProperty)
            if ($existingWindow -ne [IntPtr]::Zero) {
                [void][FundingArbDesktopWindow]::ShowWindow($existingWindow, 9)
                [void][FundingArbDesktopWindow]::SetForegroundWindow($existingWindow)
                if ([FundingArbDesktopWindow]::IsWindowVisible($existingWindow)) {
                    Write-WindowReady $true
                    break
                }
            }
            Start-Sleep -Milliseconds 100
        }
    }
    finally { $mutex.Dispose() }
    exit 0
}

function ConvertTo-NativeArgument([string]$Value) {
    # CommandLineToArgvW-compatible quoting; no command shell or interpolation.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

[Runtime.InteropServices.Marshal]::ThrowExceptionForHR([FundingArbDesktopWindow]::SetCurrentProcessExplicitAppUserModelID('FundingArb.Desktop.' + $taskbarHash))
[Windows.Forms.Application]::EnableVisualStyles()
$script:form = New-Object Windows.Forms.Form
$script:form.Text = $windowTitle
$script:form.ClientSize = New-Object Drawing.Size(560, 300)
$script:form.MinimumSize = New-Object Drawing.Size(576, 339)
$script:form.StartPosition = 'CenterScreen'
$script:form.ShowInTaskbar = $true
$script:form.MinimizeBox = $true
$script:form.MaximizeBox = $false
$script:form.Icon = [Drawing.SystemIcons]::Application
$script:form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$script:form.BackColor = [Drawing.Color]::FromArgb(248, 250, 252)

$heading = New-Object Windows.Forms.Label
$heading.Text = '资金费率套利软件'
$heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
$heading.Location = New-Object Drawing.Point(24, 22)
$heading.Size = New-Object Drawing.Size(510, 42)
$script:form.Controls.Add($heading)

$script:statusLabel = New-Object Windows.Forms.TextBox
$script:statusLabel.Multiline = $true
$script:statusLabel.ReadOnly = $true
$script:statusLabel.BorderStyle = 'None'
$script:statusLabel.ScrollBars = 'Vertical'
$script:statusLabel.BackColor = $script:form.BackColor
$script:statusLabel.TabStop = $false
$script:statusLabel.Text = '正在核对后台服务…'
$script:statusLabel.Location = New-Object Drawing.Point(26, 80)
$script:statusLabel.Size = New-Object Drawing.Size(508, 62)
$script:statusLabel.Anchor = 'Top, Left, Right'
$script:form.Controls.Add($script:statusLabel)

$addressLabel = New-Object Windows.Forms.Label
$addressLabel.Text = $appUri.AbsoluteUri
$addressLabel.ForeColor = [Drawing.Color]::FromArgb(71, 85, 105)
$addressLabel.Location = New-Object Drawing.Point(26, 147)
$addressLabel.Size = New-Object Drawing.Size(508, 28)
$script:form.Controls.Add($addressLabel)

$notice = New-Object Windows.Forms.Label
$notice.Text = '退出会停止本机策略和后台服务；交易所已有仓位会保留。'
$notice.ForeColor = [Drawing.Color]::FromArgb(71, 85, 105)
$notice.Location = New-Object Drawing.Point(26, 181)
$notice.Size = New-Object Drawing.Size(508, 42)
$notice.Anchor = 'Bottom, Left, Right'
$script:form.Controls.Add($notice)

$script:openButton = New-Object Windows.Forms.Button
$script:openButton.Text = '打开操作页面'
$script:openButton.Location = New-Object Drawing.Point(26, 238)
$script:openButton.Size = New-Object Drawing.Size(156, 38)
$script:openButton.Anchor = 'Bottom, Left'
$script:form.Controls.Add($script:openButton)

$script:quitButton = New-Object Windows.Forms.Button
$script:quitButton.Text = '退出软件'
$script:quitButton.Location = New-Object Drawing.Point(378, 238)
$script:quitButton.Size = New-Object Drawing.Size(156, 38)
$script:quitButton.Anchor = 'Bottom, Right'
$script:quitButton.Enabled = $false
$script:form.Controls.Add($script:quitButton)

$script:allowClose = $false
$script:changedServer = $false
$script:verifiedServer = $false
$script:stopProcess = $null
$script:stopOutput = $null
$script:stopError = $null
$script:stopFailed = $false
$script:healthTask = $null
$script:nextHealthAt = [DateTime]::UtcNow
$script:pinnedProcess = $null
try { $script:pinnedProcess = [Diagnostics.Process]::GetProcessById($ServerPid) }
catch [ArgumentException] { }

$httpHandler = New-Object Net.Http.HttpClientHandler
$httpHandler.AllowAutoRedirect = $false
$httpHandler.UseProxy = $false
$script:http = New-Object Net.Http.HttpClient($httpHandler)
$script:http.Timeout = [TimeSpan]::FromMilliseconds(1500)
$script:timer = New-Object Windows.Forms.Timer
$script:timer.Interval = 200
$script:autoCloseTimer = $null

function Set-ExitFailure([string]$Reason) {
    $script:stopFailed = $true
    $script:statusLabel.ForeColor = [Drawing.Color]::FromArgb(153, 27, 27)
    $script:statusLabel.Text = '后台尚未安全退出。' + [Environment]::NewLine + $Reason
    $script:quitButton.Text = '重试退出'
    $script:quitButton.Enabled = $script:verifiedServer -and -not $script:changedServer
}

function Start-SafeExit {
    if ($script:allowClose -or $null -ne $script:stopProcess) { return }
    if ($script:changedServer) {
        $script:allowClose = $true
        $script:form.Close()
        return
    }
    if (-not $script:verifiedServer) {
        $script:statusLabel.Text = '尚未核对后台身份，请等待后重试退出。'
        return
    }
    try {
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $NodePath
        $arguments = @($stopScript, '--url', $appUri.AbsoluteUri, '--pid', [string]$ServerPid, '--project', $ProjectRoot, '--token', $InstanceToken)
        $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
        $startInfo.WorkingDirectory = $ProjectRoot
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $script:stopProcess = New-Object Diagnostics.Process
        $script:stopProcess.StartInfo = $startInfo
        if (-not $script:stopProcess.Start()) { throw '安全退出工具未能启动。' }
        $script:stopOutput = $script:stopProcess.StandardOutput.ReadToEndAsync()
        $script:stopError = $script:stopProcess.StandardError.ReadToEndAsync()
        $script:stopFailed = $false
        $script:quitButton.Enabled = $false
        $script:quitButton.Text = '正在退出…'
        $script:statusLabel.ForeColor = [Drawing.Color]::FromArgb(71, 85, 105)
        $script:statusLabel.Text = '正在等待后台安全退出…' + [Environment]::NewLine + '窗口会在处理完成后关闭。'
    }
    catch {
        if ($null -ne $script:stopProcess) { $script:stopProcess.Dispose(); $script:stopProcess = $null }
        Set-ExitFailure $_.Exception.Message
    }
}

$script:openButton.Add_Click({
    try {
        $browserInfo = New-Object Diagnostics.ProcessStartInfo
        $browserInfo.FileName = $appUri.AbsoluteUri
        $browserInfo.UseShellExecute = $true
        [void][Diagnostics.Process]::Start($browserInfo)
    }
    catch { $script:statusLabel.Text = '页面未能打开，请在浏览器访问：' + $appUri.AbsoluteUri }
})
$script:quitButton.Add_Click({ Start-SafeExit })
$script:form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($script:allowClose) { return }
    $eventArgs.Cancel = $true
    Start-SafeExit
})

$script:timer.Add_Tick({
    try {
        if ($null -ne $script:stopProcess -and $script:stopProcess.HasExited -and
            $script:stopOutput.IsCompleted -and $script:stopError.IsCompleted) {
            $exitCode = $script:stopProcess.ExitCode
            $helperOutput = $script:stopOutput.GetAwaiter().GetResult()
            $helperError = $script:stopError.GetAwaiter().GetResult()
            $script:stopProcess.Dispose()
            $script:stopProcess = $null
            if ($exitCode -eq 0) {
                $exitProof = $helperOutput.Trim() | ConvertFrom-Json
                if ($exitProof.exited -ne $true -or $exitProof.pid -ne $ServerPid -or $exitProof.app -ne 'funding-arb') {
                    throw '退出工具未返回匹配的后台退出证明。'
                }
                $script:allowClose = $true
                $script:form.Close()
                return
            }
            $reason = $helperError.Trim()
            if (-not $reason) { $reason = $helperOutput.Trim() }
            if (-not $reason) { $reason = '退出工具未完成，请查看后台状态后重试。' }
            if ($reason.Length -gt 350) { $reason = $reason.Substring(0, 350) }
            Set-ExitFailure $reason
        }

        if ($null -ne $script:healthTask -and $script:healthTask.IsCompleted) {
            $response = $null
            try {
                $response = $script:healthTask.GetAwaiter().GetResult()
                if (-not $response.IsSuccessStatusCode) { throw '后台健康检查暂时不可用。' }
                $health = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                if ($health.ok -ne $true -or $health.app -ne 'funding-arb') { throw '后台身份核对失败。' }
                if ($health.pid -ne $ServerPid) {
                    $script:changedServer = $true
                    $script:verifiedServer = $false
                    $script:quitButton.Text = '关闭此窗口'
                    $script:quitButton.Enabled = $true
                    $script:statusLabel.ForeColor = [Drawing.Color]::FromArgb(153, 27, 27)
                    $script:statusLabel.Text = '后台服务已更换，此窗口只会关闭自身。' + [Environment]::NewLine + '请重新运行启动入口，打开对应窗口。'
                }
                elseif (-not $script:changedServer) {
                    $script:verifiedServer = $true
                    if ($null -eq $script:stopProcess -and $script:stopFailed) { $script:quitButton.Enabled = $true }
                    if ($null -eq $script:stopProcess -and -not $script:stopFailed) {
                        $script:statusLabel.ForeColor = [Drawing.Color]::FromArgb(22, 101, 52)
                        $script:statusLabel.Text = '后台正在运行。最小化后可从任务栏打开。' + [Environment]::NewLine + '关闭窗口或点击“退出软件”会安全停止后台。'
                        $script:quitButton.Enabled = $true
                    }
                }
            }
            catch {
                if ($null -eq $script:stopProcess -and -not $script:changedServer -and -not $script:stopFailed) {
                    $script:statusLabel.ForeColor = [Drawing.Color]::FromArgb(146, 64, 14)
                    $script:statusLabel.Text = '后台暂时没有响应，窗口保留，请稍候。'
                }
            }
            finally {
                if ($null -ne $response) { $response.Dispose() }
                $script:healthTask = $null
                $script:nextHealthAt = [DateTime]::UtcNow.AddSeconds(2)
            }
        }

        if (-not $script:changedServer -and $null -eq $script:stopProcess -and
            ($null -eq $script:pinnedProcess -or $script:pinnedProcess.HasExited)) {
            [Console]::Out.WriteLine('desktop-window: pinned-backend-exited')
            $script:allowClose = $true
            $script:form.Close()
            return
        }
        if ($null -eq $script:healthTask -and -not $script:changedServer -and
            [DateTime]::UtcNow -ge $script:nextHealthAt) {
            $script:healthTask = $script:http.GetAsync((New-Object Uri($appUri, 'api/health')))
        }
    }
    catch { Set-ExitFailure '无法核对退出结果，窗口保留，请检查后台状态。' }
})

$script:form.Add_Shown({
    try {
        # STARTUPINFO hides the terminal. Explicitly show the separate GUI window.
        [void][FundingArbDesktopWindow]::ShowWindow($script:form.Handle, 1)
        if (-not $script:form.Visible -or -not [FundingArbDesktopWindow]::IsWindowVisible($script:form.Handle)) {
            throw '软件窗口未能显示。'
        }
        if (-not [FundingArbDesktopWindow]::SetProp($script:form.Handle, $windowProperty, [IntPtr]1)) {
            throw '软件窗口身份未能登记。'
        }
        Write-WindowReady $false
        [Console]::Out.WriteLine('desktop-window: shown')
    }
    catch {
        [Console]::Error.WriteLine('软件窗口无法记录就绪状态，后台未被停止：' + $_.Exception.Message)
        $script:allowClose = $true
        $script:form.Close()
        return
    }
    $script:timer.Start()
    if ($TestAutoCloseAfterMs -gt 0) {
        $script:autoCloseTimer = New-Object Windows.Forms.Timer
        $script:autoCloseTimer.Interval = $TestAutoCloseAfterMs
        $script:autoCloseTimer.Add_Tick({ $script:autoCloseTimer.Stop(); $script:form.Close() })
        $script:autoCloseTimer.Start()
    }
})

try { [Windows.Forms.Application]::Run($script:form); [Console]::Out.WriteLine('desktop-window: window-closed') }
finally {
    $script:timer.Stop()
    $script:timer.Dispose()
    if ($null -ne $script:autoCloseTimer) { $script:autoCloseTimer.Stop(); $script:autoCloseTimer.Dispose() }
    $script:http.Dispose()
    $httpHandler.Dispose()
    if ($null -ne $script:pinnedProcess) { $script:pinnedProcess.Dispose() }
    if ($null -ne $script:stopProcess) { $script:stopProcess.Dispose() }
    if ($script:form.IsHandleCreated) { [void][FundingArbDesktopWindow]::RemoveProp($script:form.Handle, $windowProperty) }
    $script:form.Dispose()
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
