$ErrorActionPreference='Stop'
$ppt=New-Object -ComObject PowerPoint.Application
$pres=$ppt.Presentations.Open('d:\workspace\map_element_statistics\out\工程介绍_惠城区ODD覆盖流水线.pptx',$true,$false,$false)
$dir='d:\workspace\map_element_statistics\out\_ppt_render'
New-Item -ItemType Directory -Force -Path $dir|Out-Null
Get-ChildItem -LiteralPath $dir -Filter *.PNG -ErrorAction SilentlyContinue|Remove-Item -Force
$pres.SaveAs($dir, 18)
$pres.Close()
$ppt.Quit()
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($pres)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($ppt)
Write-Output 'done'