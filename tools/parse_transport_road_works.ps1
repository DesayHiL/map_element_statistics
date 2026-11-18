param(
  [string]$InputPath = 'data\huizhou_transport_road_works_2026Q4.xlsx',
  [string]$OutputPath = 'data\huizhou_transport_road_works_2026Q4.json'
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $InputPath))
function Read-ZipText([string]$Name) { $e=$zip.GetEntry($Name); $r=[IO.StreamReader]::new($e.Open()); try {$r.ReadToEnd()} finally {$r.Dispose()} }
$ss=[xml](Read-ZipText 'xl/sharedStrings.xml'); $sheet=[xml](Read-ZipText 'xl/worksheets/sheet1.xml')
$strings=@($ss.sst.si | ForEach-Object {($_.t -join '')})
$rows=@()
foreach($row in $sheet.worksheet.sheetData.row | Select-Object -Skip 2){
  $v=@(); foreach($c in $row.c){$x=$c.v; if($c.t -eq 's'){$v += $strings[[int]$x]}else{$v += [string]$x}}
  if($v.Count -ge 5){$rows += [pscustomobject]@{id=$v[0]; project=$v[1]; road=$v[2]; startSerial=$v[3]; durationDays=$v[4]}}
}
$rows | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $OutputPath
$zip.Dispose()
Write-Output "wrote $OutputPath ($($rows.Count) rows)"
