param(
  [Parameter(Mandatory=$true)][string]$SpecPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$TemplatePath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $TemplatePath) {
  $TemplatePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets\desay-sv-white-template.pptx'
}

function Resolve-File([string]$Path,[string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label not found: $Path" }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Color-Ole([string]$Hex) {
  $h=$Hex.TrimStart('#'); $r=[Convert]::ToInt32($h.Substring(0,2),16); $g=[Convert]::ToInt32($h.Substring(2,2),16); $b=[Convert]::ToInt32($h.Substring(4,2),16)
  return $r+($g*256)+($b*65536)
}

function Find-Layout($Presentation,[string]$Name) {
  foreach($design in @($Presentation.Designs)) { foreach($layout in @($design.SlideMaster.CustomLayouts)) { if([string]$layout.Name -eq $Name){return $layout} } }
  throw "Template layout not found: $Name"
}

function Find-PlaceholderByTop($Slide,[double]$Top,[double]$Tolerance=2.0) {
  foreach($shape in @($Slide.Shapes.Placeholders)) { if([math]::Abs([double]$shape.Top-$Top) -le $Tolerance){return $shape} }
  return $null
}

function Fill-Placeholder($Shape,[string]$Text) {
  if($null -eq $Shape){throw 'Required native placeholder was not created by the template layout'}
  $value = if($null -eq $Text){''}else{$Text}
  $Shape.TextFrame.TextRange.Text=$value
  $Shape.TextFrame.WordWrap=-1
  $Shape.TextFrame.AutoSize=0
}

function Add-TextBox($Slide,[double]$X,[double]$Y,[double]$W,[double]$H,[string]$Text,[double]$Size,[int]$Color,[bool]$Bold=$false,[string]$Name='') {
  $box=$Slide.Shapes.AddTextbox(1,$X,$Y,$W,$H)
  if($Name){$box.Name=$Name}
  $box.Fill.Visible=0; $box.Line.Visible=0
  $box.TextFrame.TextRange.Text=$Text
  $box.TextFrame.TextRange.Font.Name='Microsoft YaHei'
  $box.TextFrame.TextRange.Font.NameFarEast='Microsoft YaHei'
  $box.TextFrame.TextRange.Font.Size=$Size
  $box.TextFrame.TextRange.Font.Color.RGB=$Color
  $boldValue = if($Bold){-1}else{0}
  $box.TextFrame.TextRange.Font.Bold=$boldValue
  $box.TextFrame.WordWrap=-1; $box.TextFrame.AutoSize=0
  $box.TextFrame.MarginLeft=2; $box.TextFrame.MarginRight=2; $box.TextFrame.MarginTop=2; $box.TextFrame.MarginBottom=2
  return $box
}

function Add-Rect($Slide,[double]$X,[double]$Y,[double]$W,[double]$H,[int]$Fill,[Nullable[int]]$Line=$null,[string]$Name='') {
  $shape=$Slide.Shapes.AddShape(1,$X,$Y,$W,$H)
  if($Name){$shape.Name=$Name}
  $shape.Fill.ForeColor.RGB=$Fill
  $shape.Fill.Transparency=0
  if($null -eq $Line){$shape.Line.Visible=0}else{$shape.Line.ForeColor.RGB=$Line; $shape.Line.Transparency=0}
  return $shape
}

$Blue=Color-Ole '#0054A2'; $Cyan=Color-Ole '#00B9E7'; $Dark=Color-Ole '#000000'; $Gray=Color-Ole '#717171'; $Light=Color-Ole '#F2F2F2'; $Pale=Color-Ole '#E9F7FD'; $White=Color-Ole '#FFFFFF'; $Deep=Color-Ole '#0F335E'

function New-ContentSlide($Presentation,$Layout,$SlideSpec) {
  $slide=$Presentation.Slides.AddSlide($Presentation.Slides.Count+1,$Layout)
  $slide.DisplayMasterShapes=-1; $slide.FollowMasterBackground=-1
  $title=Find-PlaceholderByTop $slide 11.0
  $subtitle=Find-PlaceholderByTop $slide 61.7
  $body=Find-PlaceholderByTop $slide 92.7
  Fill-Placeholder $title ([string]$SlideSpec.title)
  Fill-Placeholder $subtitle ([string]$SlideSpec.takeaway)
  $title.Name='template-title-placeholder'
  $subtitle.Name='template-subtitle-placeholder'
  if($null -eq $body){throw 'Template body placeholder is missing'}
  $body.Delete()
  return $slide
}

function Add-Conclusion($Slide,[string]$Text) {
  if(-not $Text){return}
  Add-Rect $Slide 45.8 455 868.4 41 $Blue $null 'body-conclusion-bg' | Out-Null
  $box=Add-TextBox $Slide 72 462 816 27 $Text 15 $White $true 'body-conclusion-text'
  $box.TextFrame.TextRange.ParagraphFormat.Alignment=2
}

function Add-Bullets($Presentation,$Layout,$Spec) {
  $s=New-ContentSlide $Presentation $Layout $Spec; $y=116; $index=0
  foreach($item in @($Spec.items)){
    Add-Rect $s 67 ($y+7) 9 9 $Cyan $null ("body-bullet-{0}" -f $index) | Out-Null
    Add-TextBox $s 92 $y 760 38 ([string]$item) 15 $Dark $false ("body-text-{0}" -f $index) | Out-Null
    $y+=48; $index++
  }
  Add-Conclusion $s ([string]$Spec.conclusion); return $s
}

function Add-Progress($Presentation,$Layout,$Spec) {
  $s=New-ContentSlide $Presentation $Layout $Spec; $items=@($Spec.items)
  for($i=0;$i -lt $items.Count;$i++){
    $col=$i%2; $row=[math]::Floor($i/2); $x=75+($col*430); $y=116+($row*105)
    Add-Rect $s $x $y 380 86 $Light $null ("body-progress-card-{0}" -f $i) | Out-Null
    Add-Rect $s $x $y 7 86 $Cyan $null ("body-progress-accent-{0}" -f $i) | Out-Null
    $labelText=[string]$items[$i].label; $labelSize = if($labelText.Length -gt 16){12}elseif($labelText.Length -gt 11){13}else{15}
    Add-TextBox $s ($x+20) ($y+8) 235 30 $labelText $labelSize $Blue $true ("body-progress-label-{0}" -f $i) | Out-Null
    if($items[$i].status){
      Add-Rect $s ($x+282) ($y+10) 70 21 $Blue $null ("body-progress-status-bg-{0}" -f $i) | Out-Null
      $st=Add-TextBox $s ($x+287) ($y+12) 60 16 ([string]$items[$i].status) 9 $White $true ("body-progress-status-{0}" -f $i); $st.TextFrame.TextRange.ParagraphFormat.Alignment=2
    }
    $descText=[string]$items[$i].text; $descSize = if($descText.Length -gt 46){10}else{12}
    Add-TextBox $s ($x+20) ($y+46) 340 34 $descText $descSize $Gray $false ("body-progress-text-{0}" -f $i) | Out-Null
  }
  Add-Conclusion $s ([string]$Spec.conclusion); return $s
}

function Add-Metrics($Presentation,$Layout,$Spec) {
  $s=New-ContentSlide $Presentation $Layout $Spec; $items=@($Spec.items); $n=[math]::Max(1,$items.Count); $w=800/$n
  for($i=0;$i -lt $items.Count;$i++){
    $x=80+($i*$w)
    if($i -gt 0){Add-Rect $s ($x-12) 166 1 115 (Color-Ole '#C9DDF1') (Color-Ole '#C9DDF1') ("body-metric-separator-{0}" -f $i)|Out-Null}
    Add-TextBox $s $x 164 ($w-22) 46 ([string]$items[$i].value) 30 $Blue $true ("body-metric-value-{0}" -f $i)|Out-Null
    Add-TextBox $s $x 218 ($w-22) 52 ([string]$items[$i].label) 15 $Dark $false ("body-metric-label-{0}" -f $i)|Out-Null
    if($items[$i].note){Add-TextBox $s $x 276 ($w-22) 42 ([string]$items[$i].note) 10 $Gray $false ("body-metric-note-{0}" -f $i)|Out-Null}
  }
  Add-Conclusion $s ([string]$Spec.conclusion); return $s
}

function Add-TwoColumn($Presentation,$Layout,$Spec) {
  $s=New-ContentSlide $Presentation $Layout $Spec; $cols=@($Spec.columns)
  for($i=0;$i -lt [math]::Min(2,$cols.Count);$i++){
    $x = if($i -eq 0){70}else{515}
    Add-TextBox $s $x 112 360 28 ([string]$cols[$i].title) 17 $Blue $true ("body-column-title-{0}" -f $i)|Out-Null; $y=151
    for($j=0;$j -lt @($cols[$i].items).Count;$j++){
      Add-Rect $s $x $y 360 44 $Pale (Color-Ole '#C9DDF1') ("body-column-card-{0}-{1}" -f $i,$j)|Out-Null
      Add-TextBox $s ($x+14) ($y+9) 332 25 ([string]$cols[$i].items[$j]) 12 $Gray $false ("body-column-text-{0}-{1}" -f $i,$j)|Out-Null; $y+=55
    }
  }
  Add-Conclusion $s ([string]$Spec.conclusion); return $s
}

function Add-Architecture($Presentation,$Layout,$Spec) {
  $s=New-ContentSlide $Presentation $Layout $Spec; $layers=@($Spec.layers); $count=[math]::Max(1,$layers.Count); $gap=10; $available=306; $layerH=[math]::Min(62,[math]::Max(46,($available-(($count-1)*$gap))/$count))
  for($i=0;$i -lt $layers.Count;$i++){
    $y=112+($i*($layerH+$gap)); Add-Rect $s 68 $y 130 $layerH $Blue $null ("body-layer-label-bg-{0}" -f $i)|Out-Null
    $label=Add-TextBox $s 78 ($y+7) 110 ($layerH-14) ([string]$layers[$i].label) 13 $White $true ("body-layer-label-{0}" -f $i); $label.TextFrame.TextRange.ParagraphFormat.Alignment=2
    $items=@($layers[$i].items); $n=[math]::Max(1,$items.Count); $area = if($Spec.sideNote){560}else{675}; $itemW=[math]::Min(155,($area-(($n-1)*10))/$n)
    for($j=0;$j -lt $items.Count;$j++){
      $x=218+($j*($itemW+10)); $fill = if($i%2 -eq 0){$Pale}else{$Light}
      Add-Rect $s $x $y $itemW $layerH $fill (Color-Ole '#C9DDF1') ("body-layer-card-{0}-{1}" -f $i,$j)|Out-Null
      $box=Add-TextBox $s ($x+8) ($y+7) ($itemW-16) ($layerH-14) ([string]$items[$j]) 10 $Gray $false ("body-layer-text-{0}-{1}" -f $i,$j); $box.TextFrame.TextRange.ParagraphFormat.Alignment=2
    }
  }
  if($Spec.sideNote){$noteText=[string]$Spec.sideNote; $noteSize = if($noteText.Length -gt 12){11}else{13}; Add-Rect $s 800 114 88 302 $Deep $null 'body-side-note-bg'|Out-Null; $note=Add-TextBox $s 812 132 64 268 $noteText $noteSize $White $true 'body-side-note';$note.TextFrame.TextRange.ParagraphFormat.Alignment=2}
  Add-Conclusion $s ([string]$Spec.conclusion); return $s
}

function Add-Section($Presentation,$Layout,$Spec) {
  $s=New-ContentSlide $Presentation $Layout $Spec
  Add-Rect $s 45.8 118 868.4 300 $Deep $null 'body-section-bg'|Out-Null
  Add-Rect $s 45.8 118 370 300 $Blue $null 'body-section-accent'|Out-Null
  Add-TextBox $s 82 205 720 58 (("{0} {1}" -f $Spec.sectionNo,$Spec.title).Trim()) 32 $White $true 'body-section-title'|Out-Null
  if($Spec.takeaway){Add-TextBox $s 84 282 760 75 ([string]$Spec.takeaway) 18 $White $false 'body-section-takeaway'|Out-Null}
  return $s
}

function Update-MasterTotal($Presentation,[int]$Total) {
  $master=$Presentation.Designs.Item(1).SlideMaster
  foreach($shape in @($master.Shapes)){
    try{
      if(-not($shape.HasTextFrame -and $shape.TextFrame.HasText)){continue}
      $range=$shape.TextFrame.TextRange; $text=[string]$range.Text
      if($text -notmatch '[#‹›]'){continue}
      $slash=$text.LastIndexOf('/'); if($slash -lt 0){continue}
      $suffixLength=$text.Length-$slash-1
      if($suffixLength -gt 0){$range.Characters($slash+2,$suffixLength).Text=[string]$Total}else{$range.InsertAfter([string]$Total)|Out-Null}
      return
    }catch{}
  }
  throw 'Template master dynamic page-number field was not found'
}

$SpecPath=Resolve-File $SpecPath 'Spec'; $TemplatePath=Resolve-File $TemplatePath 'Template'
$spec=Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8|ConvertFrom-Json
$outputFull=[IO.Path]::GetFullPath($OutputPath); if($outputFull -eq [IO.Path]::GetFullPath($TemplatePath)){throw 'Output must not overwrite the template'}
$ppt=$null; $pres=$null
try{
  $ppt=New-Object -ComObject PowerPoint.Application; $ppt.Visible=-1
  $pres=$ppt.Presentations.Open($TemplatePath,$false,$false,$false)
  if([math]::Abs([double]$pres.PageSetup.SlideWidth-960)-gt .5 -or [math]::Abs([double]$pres.PageSetup.SlideHeight-540)-gt .5){throw 'Template is not 960 x 540'}
  $titleLayout=Find-Layout $pres '标题幻灯片'; $agendaLayout=Find-Layout $pres '1_空白'; $contentLayout=Find-Layout $pres '2_空白'
  while($pres.Slides.Count -gt 0){$pres.Slides.Item(1).Delete()}

  $cover=$pres.Slides.AddSlide(1,$titleLayout); $cover.DisplayMasterShapes=-1; $cover.FollowMasterBackground=-1
  Fill-Placeholder (Find-PlaceholderByTop $cover 171.3) ([string]$spec.title)
  $coverLine = if($spec.subtitle){[string]$spec.subtitle}else{[string]$spec.owner}
  Fill-Placeholder (Find-PlaceholderByTop $cover 254.8) $coverLine
  $meta=@($spec.owner,$spec.date)|Where-Object{$_}|ForEach-Object{[string]$_}; Fill-Placeholder (Find-PlaceholderByTop $cover 297.7) ($meta -join '  ')

  $agendaItems=@($spec.agenda); if($agendaItems.Count -gt 5){throw 'The native agenda layout supports at most five items'}
  $agenda=$pres.Slides.AddSlide(2,$agendaLayout); $agenda.DisplayMasterShapes=-1; $agenda.FollowMasterBackground=-1
  $agendaPlaceholders=@($agenda.Shapes.Placeholders)|Sort-Object Top
  for($i=0;$i -lt $agendaPlaceholders.Count;$i++){
    $agendaText = if($i -lt $agendaItems.Count){[string]$agendaItems[$i]}else{''}
    Fill-Placeholder $agendaPlaceholders[$i] $agendaText
  }

  foreach($slideSpec in @($spec.slides)){
    switch([string]$slideSpec.type){
      'section'{[void](Add-Section $pres $contentLayout $slideSpec)}
      'progress'{[void](Add-Progress $pres $contentLayout $slideSpec)}
      'metrics'{[void](Add-Metrics $pres $contentLayout $slideSpec)}
      'twoColumn'{[void](Add-TwoColumn $pres $contentLayout $slideSpec)}
      'architecture'{[void](Add-Architecture $pres $contentLayout $slideSpec)}
      default{[void](Add-Bullets $pres $contentLayout $slideSpec)}
    }
  }
  $actualSlides=$pres.Slides.Count
  Update-MasterTotal $pres $actualSlides
  $outDir=Split-Path -Parent $outputFull; if($outDir -and -not(Test-Path -LiteralPath $outDir)){New-Item -ItemType Directory -Force -Path $outDir|Out-Null}
  if(Test-Path -LiteralPath $outputFull){throw "Output already exists: $outputFull"}
  $pres.SaveAs($outputFull)
}finally{
  if($pres){$pres.Close()}; if($ppt){$ppt.Quit()}; foreach($obj in @($pres,$ppt)){if($obj){try{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($obj)}catch{}}}
}

[pscustomobject]@{output=$outputFull;template=$TemplatePath;slides=$actualSlides}|ConvertTo-Json
