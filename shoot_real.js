// 用 playwright 截取 odd_coverage.html 各节真实截图
const path = require('path');
const { chromium } = require(path.join(__dirname, '.pwtmp', 'node_modules', 'playwright-core'));
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('file:///d:/workspace/map_element_statistics/out/odd_coverage.html', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  // 各节位置
  const secs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('h1, h2').forEach(h => out.push({
      text: h.textContent.slice(0, 30).trim(),
      y: Math.round(h.getBoundingClientRect().top + window.scrollY)
    }));
    return out;
  });
  console.log(JSON.stringify(secs));
  const shots = [
    { name: 'real_top', y: 0 },
    { name: 'real_A', y: (secs.find(s => s.text.startsWith('A ·')) || {}).y - 80 },
    { name: 'real_A_table', y: ((secs.find(s => s.text.startsWith('A ·')) || {}).y || 0) + 200 },
    { name: 'real_B', y: (secs.find(s => s.text.startsWith('B ·')) || {}).y - 80 },
    { name: 'real_C', y: (secs.find(s => s.text.startsWith('C ·')) || {}).y - 80 },
    { name: 'real_E', y: (secs.find(s => s.text.startsWith('E ·')) || {}).y - 80 },
  ];
  for (const s of shots) {
    if (s.y === undefined || isNaN(s.y)) continue;
    await page.evaluate(y => window.scrollTo(0, y), Math.max(0, s.y));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(__dirname, 'out', s.name + '.png') });
    console.log('shot', s.name, 'at', s.y);
  }
  await browser.close();
})();