# music-nowplaying.ps1 -- long-lived reader for Windows SMTC ("what is playing now")
#
# DELIBERATELY ASCII-ONLY (comments included):
#   PowerShell 5.1 reads a UTF-8-without-BOM script as GBK; Chinese text then swallows
#   quote characters and the script dies with cascading syntax errors. Keep this file ASCII.
#
# Emits ONE JSON line per tick on stdout, e.g.
#   {"ok":true,"ts":1758...,"sessions":[{"app":"...","status":"Playing","title":"...","artist":"...",
#     "album":"...","pos":12.3,"end":245.0,"start":0}]}
# The parent (music.js) owns all the state machine / commenting logic; this script only reports.
#
# Three WinRT-in-PS5.1 pitfalls already paid for (do not "simplify" these away):
#   1) RequestAsync() returns a bare System.__ComObject -> members are only reachable through
#      the AsTask projection below.
#   2) The FIRST RequestAsync() can take several seconds -> wait(-1), never wait(5000).
#   3) GetSessions() returns an unprojected COM collection -> .Count is unreachable
#      (silently empty); count/enumerate with foreach instead.

param([int]$IntervalMs = 3000)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

# Touch the WinRT types so they resolve (ContentType=WindowsRuntime needs this form in PS 5.1)
$MGR_TYPE = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$PROPS_TYPE = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

function Get-Manager {
  try {
    return Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $MGR_TYPE
  } catch {
    return $null
  }
}

$mgr = Get-Manager

while ($true) {
  $err = ""
  if ($null -eq $mgr) { $mgr = Get-Manager }
  $sessions = @()
  if ($null -ne $mgr) {
    try {
      $raw = $mgr.GetSessions()
      foreach ($s in $raw) {
        try {
          $props = Await ($s.TryGetMediaPropertiesAsync()) $PROPS_TYPE
          $info = $s.GetPlaybackInfo()
          $tl = $s.GetTimelineProperties()
          $sessions += [pscustomobject]@{
            app    = [string]$s.SourceAppUserModelId
            status = [string]$info.PlaybackStatus
            title  = [string]$props.Title
            artist = [string]$props.Artist
            album  = [string]$props.AlbumTitle
            pos    = [math]::Round($tl.Position.TotalSeconds, 1)
            end    = [math]::Round($tl.EndTime.TotalSeconds, 1)
            start  = [math]::Round($tl.StartTime.TotalSeconds, 1)
          }
        } catch {
          # a single session failing must not kill the loop
        }
      }
    } catch {
      $err = $_.Exception.Message
      $mgr = $null   # media service may have restarted; re-request next tick
    }
  }
  $obj = [pscustomobject]@{
    ok       = ($err -eq "")
    ts       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    err      = $err
    sessions = $sessions
  }
  [Console]::WriteLine(($obj | ConvertTo-Json -Depth 5 -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}