'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { createApp } = require('../server');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wedding-browser-'));
  const password = 'browser-test-only-123456789';
  const app = createApp({ dataDir, adminPassword: password, publicUrl: '', production: false, trustProxy: '0', slideshowInterval: 2000 });
  const server = app.listen(0, '127.0.0.1');
  let browser;
  const errors = [];
  const deadline = setTimeout(() => { console.error('Browser smoke test exceeded 60 seconds'); process.exit(1); }, 60000);
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const monitor = page => {
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && /Alpine|Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
      });
    };
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const guest = await guestContext.newPage();
    monitor(guest);
    await guest.goto(base);
    await guest.waitForFunction(() => window.Alpine && Alpine.$data(document.body).ready);
    assert.equal(await guest.locator('.upload-card').isVisible(), true);
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Guest layout must fit a mobile viewport');
    await guest.getByLabel('Votre prénom').fill('Cousin Marc');
    await guest.getByLabel('Votre prénom').press('Tab');
    const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#cc9876' } }).jpeg().toBuffer();
    await guest.locator('input[multiple]').setInputFiles([
      { name: 'souvenir-01.jpg', mimeType: 'image/jpeg', buffer: image },
      { name: 'souvenir-02.jpg', mimeType: 'image/jpeg', buffer: image }
    ]);
    await guest.waitForFunction(() => Alpine.$data(document.body).completed === 2 && !Alpine.$data(document.body).processing);
    assert.equal(await guest.evaluate(() => Alpine.$data(document.body).remaining), 48);
    const token = await guest.evaluate(() => Alpine.$data(document.body).token);
    await guest.reload();
    await guest.waitForFunction(() => Alpine.$data(document.body).ready);
    assert.equal(await guest.evaluate(() => Alpine.$data(document.body).token), token);
    assert.equal(await guest.getByLabel('Votre prénom').inputValue(), 'Cousin Marc');
    assert.equal(await guest.evaluate(() => Alpine.$data(document.body).remaining), 48);

    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, httpCredentials: { username: 'admin', password } });
    const admin = await adminContext.newPage();
    monitor(admin);
    await admin.goto(base + '/admin');
    await admin.waitForFunction(() => Alpine.$data(document.body).total === 2 && !Alpine.$data(document.body).loading);
    await admin.waitForFunction(() => document.querySelector('.qr-image').naturalWidth > 0);
    const info = await admin.locator('.public-url').innerText();
    assert.equal(info, base);
    await admin.emulateMedia({ media: 'print' });
    assert.equal(await admin.locator('.admin-gallery').isVisible(), false);
    assert.equal(await admin.locator('.qr-image').isVisible(), true);
    await admin.emulateMedia({ media: 'screen' });
    const downloadPending = admin.waitForEvent('download');
    await admin.getByRole('link', { name: 'Télécharger l’album ZIP' }).click();
    const download = await downloadPending;
    assert.match(download.suggestedFilename(), /^wedding-photos-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.equal(await download.failure(), null);

    const slideshow = await guestContext.newPage();
    monitor(slideshow);
    await slideshow.setViewportSize({ width: 1920, height: 1080 });
    await slideshow.goto(base + '/slideshow');
    await slideshow.waitForFunction(() => Alpine.$data(document.body).photos.length === 2 && Alpine.$data(document.body).current);
    assert.equal(await slideshow.locator('.slideshow-author strong').innerText(), 'Cousin Marc');
    const firstId = await slideshow.evaluate(() => Alpine.$data(document.body).current.id);
    await slideshow.waitForFunction(id => Alpine.$data(document.body).current?.id !== id, firstId);
    await slideshow.getByRole('button', { name: 'Mettre le diaporama en pause' }).click();
    assert.equal(await slideshow.evaluate(() => Alpine.$data(document.body).paused), true);
    await admin.getByRole('button', { name: 'Masquer souvenir-01.jpg', exact: true }).click();
    await admin.getByRole('button', { name: 'Masquer souvenir-02.jpg', exact: true }).click();
    await slideshow.waitForFunction(() => Alpine.$data(document.body).photos.length === 0 && !Alpine.$data(document.body).current);
    assert.equal(await slideshow.locator('.slideshow-photo').isVisible(), false);
    await admin.getByRole('button', { name: 'Rendre visible souvenir-01.jpg', exact: true }).click();
    await slideshow.waitForFunction(() => Alpine.$data(document.body).photos.length === 1 && Alpine.$data(document.body).current);
    await admin.getByRole('button', { name: 'Supprimer définitivement souvenir-01.jpg', exact: true }).click();
    await admin.getByRole('dialog').waitFor({ state: 'visible' });
    await admin.getByRole('dialog').getByRole('button', { name: 'Supprimer définitivement', exact: true }).click();
    await slideshow.waitForFunction(() => !Alpine.$data(document.body).photos.length && !Alpine.$data(document.body).current);
    await admin.waitForFunction(() => Alpine.$data(document.body).total === 1);
    await admin.setViewportSize({ width: 390, height: 844 });
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Admin layout must fit a mobile viewport');
    assert.deepEqual(errors, [], 'No JavaScript or CSP errors should reach the browser');
    console.log('Browser smoke passed: mobile upload/persistence, admin/QR/print/ZIP, live slideshow/rotation/moderation/deletion, mobile layouts and CSP.');
  } finally {
    if (browser) await browser.close();
    await app.locals.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
    clearTimeout(deadline);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
