# Draft render: half scale, half fps. ~8x cheaper than the 4K/JPEG production render
# (measured, not assumed - see render-log.md). Restores the production settings in a
# finally block so an interrupted draft cannot leave timing.json at draft resolution,
# which would silently produce a 1080p "final" on the next run.
$ErrorActionPreference = 'Stop'
$proj = 'C:\dev\copilot-worktrees\demo\users-jonosace-microsoft-vigilant-spork\tools\EvalLoopDemo'
$eng  = 'C:\dev\copilot-worktrees\demo\users-jonosace-microsoft-vigilant-spork\tools\SizzleCraft\src'
Set-Location $proj

Copy-Item timing.json timing.json.production -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync('timing.json','utf8'));t.project.width=1920;t.project.height=1080;fs.writeFileSync('timing.json',JSON.stringify(t,null,2)+'\n');console.log('draft: 1920x1080');"

  Write-Output '--- S5 ---'
  node "$eng\write-build-html.mjs" --apply --replace
  $t5 = $sw.Elapsed.TotalMinutes

  Write-Output '--- S6 (15 fps) ---'
  $env:SIZZLECRAFT_FPS = '15'
  node "$eng\frame-capture.mjs" --apply
  $t6 = $sw.Elapsed.TotalMinutes

  Write-Output '--- S7 ---'
  node "$eng\encode-mp4.mjs" --apply --replace
  $t7 = $sw.Elapsed.TotalMinutes

  Write-Output "TIMING-min S5=$([Math]::Round($t5,2)) S6=$([Math]::Round($t6-$t5,2)) S7=$([Math]::Round($t7-$t6,2)) TOTAL=$([Math]::Round($t7,2))"
}
finally {
  Remove-Item Env:\SIZZLECRAFT_FPS -ErrorAction SilentlyContinue
  Move-Item timing.json.production timing.json -Force
  node "$eng\write-build-html.mjs" --apply --replace | Out-Null
  Write-Output 'restored: timing.json + video-auto.html back to 3840x2160'
}
