// UI 删站抓包：地图元素列表 → 站点 tab → 找 ptv-路线1 站 → 删除按钮 → 确认
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PW = require(path.join(ROOT, '.pwtmp', 'node_modules', 'playwright-core'));

(async () => {
  const ctx = await PW.chromium.launchPersistentContext(path.join(ROOT, '.pwtmp', 'profile2'), {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1600, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('request', r => {
    const u = r.url();
    if (/delete|remove/i.test(u)) {
      console.log('[DEL-REQ]', r.method(), u.slice(60, 150));
      console.log('  body:', (r.postData() || '').slice(0, 200));
    }
  });
  page.on('response', async r => {
    if (/delete|remove/i.test(r.url())) {
      try { console.log('[DEL-RES]', r.status(), (await r.text()).slice(0, 200)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  if (page.url().includes('/login')) { console.log('!! 需要登录'); await ctx.close(); return; }
  // 切「站点」tab
  const tab = page.locator('text=站点').first();
  // 列表卡片里找 ptv-路线1 站
  const card = page.locator('[class*=card], [class*=item], li, div').filter({ hasText: 'ptv-路线1-小金口-切片点1' }).first();
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1000);
  const delBtn = page.locator('button:has-text("删除"), [class*=delete]:visible').first();
  if (await delBtn.isVisible().catch(() => false)) {
    await delBtn.click({ force: true });
    console.log('点了删除');
    await page.waitForTimeout(1500);
    // 确认弹窗
    const confirm = page.locator('.ant-popconfirm-buttons button:last-child, .ant-modal-confirm-btns .ant-btn-primary, button:has-text("确 定"), button:has-text("确定")').first();
    if (await confirm.isVisible().catch(() => false)) { await confirm.click({ force: true }); console.log('点了确认'); }
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(ROOT, 'out', 'cap_del.png') });
  } else {
    console.log('!! 删除按钮不可见');
    await page.screenshot({ path: path.join(ROOT, 'out', 'cap_del_fail.png') });
  }
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });