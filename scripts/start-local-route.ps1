[CmdletBinding()]
param([string]$ConfigPath = '')

$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'route.local.json' }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { exit 0 }
$runtimePath = Join-Path (Split-Path ([IO.Path]::GetFullPath($ConfigPath)) -Parent) 'route.runtime.json'
$credentialPath = $null
$routeProcess = $null
$startedHere = $false

function Get-RouteListener([int]$Port) {
  return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}
function Test-RouteSocket([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $pending = $client.ConnectAsync('127.0.0.1', $Port)
    return ($pending.Wait(150) -and $client.Connected)
  } catch { return $false } finally { $client.Dispose() }
}
function Same-Path([string]$A, [string]$B) {
  return [IO.Path]::GetFullPath($A).TrimEnd('\').Equals([IO.Path]::GetFullPath($B).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

try {
  # This file contains only local paths, a node label and a port. Never copy credentials into it.
  $routeSettings = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($field in @('sourcePath','corePath','nodeName','port')) {
    if (-not $routeSettings.$field) { throw 'Route settings are incomplete.' }
  }
  $port = [int]$routeSettings.port
  if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid local route port.' }
  $corePath = (Resolve-Path -LiteralPath $routeSettings.corePath).Path
  $sourcePath = (Resolve-Path -LiteralPath $routeSettings.sourcePath).Path
  $listeners = @(Get-RouteListener $port)
  if ($listeners.Count -gt 0) {
    # A different process, including an unrecorded copy of the same binary, must not be taken over.
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { throw 'Port already occupied by an unmanaged process.' }
    $runtime = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ownerIds = @($listeners.OwningProcess | Select-Object -Unique)
    if ($ownerIds.Count -ne 1 -or $ownerIds[0] -ne [int]$runtime.pid -or [int]$runtime.port -ne $port -or $runtime.nodeName -ne $routeSettings.nodeName) { throw 'Port owner does not match this route.' }
    if (@($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) { throw 'The existing listener is not loopback-only.' }
    $owner = Get-Process -Id $ownerIds[0]
    $ownerDetails = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owner.Id)
    if (-not (Same-Path $owner.Path $corePath) -or -not $runtime.workDirectory -or $ownerDetails.CommandLine.IndexOf([string]$runtime.workDirectory, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Existing listener belongs to another application.' }
    Write-Host ('Local exchange route is already ready on 127.0.0.1:' + $port)
    exit 0
  }

  # Read the user's existing node privately. No subscriptions are downloaded or changed.
  $original = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $nodes = @($original.proxies | Where-Object { $_.name -eq $routeSettings.nodeName })
  if ($nodes.Count -ne 1) { throw 'Exactly one configured node must match the selected label.' }
  $temporaryDirectory = Join-Path 'D:\codex\tmp' ('FundingArbRoute-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($temporaryDirectory)
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($currentSid, 'FullControl', $inheritance, $propagation, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', $inheritance, $propagation, $allow)))
  Set-Acl -LiteralPath $temporaryDirectory -AclObject $acl

  $nodeName = [string]$nodes[0].name
  $minimal = @{
    'mixed-port' = $port; 'allow-lan' = $false; 'bind-address' = '127.0.0.1'
    mode = 'rule'; 'log-level' = 'silent'; ipv6 = $false; 'geo-auto-update' = $false
    proxies = @($nodes[0]); 'proxy-groups' = @(); rules = @('MATCH,' + $nodeName)
    dns = @{ enable = $false }; tun = @{ enable = $false }
    profile = @{ 'store-selected' = $false; 'store-fake-ip' = $false }
  }
  $credentialPath = Join-Path $temporaryDirectory 'config.json'
  [IO.File]::WriteAllText($credentialPath, ($minimal | ConvertTo-Json -Depth 100 -Compress), (New-Object Text.UTF8Encoding($false)))
  $stdoutPath = Join-Path $temporaryDirectory 'stdout.log'
  $stderrPath = Join-Path $temporaryDirectory 'stderr.log'
  $argumentList = @('-d', ('"' + $temporaryDirectory + '"'), '-f', ('"' + $credentialPath + '"'))
  $routeProcess = Start-Process -FilePath $corePath -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $startedHere = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($routeProcess.HasExited) { break }
    if (Test-RouteSocket $port) { $ready = $true; break }
    Start-Sleep -Milliseconds 150
  }
  $verified = @(Get-RouteListener $port)
  if (-not $ready -or $verified.Count -eq 0 -or @($verified | Where-Object { $_.OwningProcess -ne $routeProcess.Id -or $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) { throw 'The isolated route did not bind its expected loopback port.' }
  # Delete the short-lived credential file once the core has loaded it. Runtime metadata is nonsecret.
  Remove-Item -LiteralPath $credentialPath -Force
  $credentialPath = $null
  $runtime = @{ pid = $routeProcess.Id; port = $port; nodeName = $nodeName; corePath = $corePath; workDirectory = $temporaryDirectory; startedAt = [DateTime]::UtcNow.ToString('o') }
  [IO.File]::WriteAllText($runtimePath, ($runtime | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Write-Host ('Local exchange route started on 127.0.0.1:' + $port)
} catch {
  if ($startedHere -and $routeProcess -and -not $routeProcess.HasExited) { Stop-Process -Id $routeProcess.Id -Force -ErrorAction SilentlyContinue }
  # Raw parser/process errors can contain connection credentials. Only print a fixed diagnosis.
  Write-Error ('Local route startup failed at validation line ' + $_.InvocationInfo.ScriptLineNumber + '. Check route.local.json paths, selected node, and port ownership. The existing system proxy was not changed.') -ErrorAction Continue
  exit 1
} finally {
  if ($credentialPath -and (Test-Path -LiteralPath $credentialPath)) { Remove-Item -LiteralPath $credentialPath -Force -ErrorAction SilentlyContinue }
}
