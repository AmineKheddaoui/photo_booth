'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const sharp = require('sharp');
const yauzl = require('yauzl');
const { createApp, MAX_FILE_BYTES } = require('../server');
const PASSWORD = 'test-only-secret-123456789';

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wedding-test-'));
  const app = createApp({ dataDir, adminPassword: PASSWORD, publicUrl: 'https://photos.example.test', production: false, ...overrides });
  const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#abcdef' } }).jpeg().withMetadata().toBuffer();
  const token = randomUUID();
  const agent = request(app);
  const upload = (options = {}) => {
    let req = agent.post('/api/photos').set('X-Device-Token', options.token || token).set('X-Upload-Id', options.uploadId || randomUUID());
    if (options.author !== undefined) req = req.field('author', options.author);
    return req.attach('photo', options.image || image, { filename: options.name || 'souvenir.jpg', contentType: options.mime || 'image/jpeg' });
  };
  const admin = (method, url) => agent[method](url).auth('admin', PASSWORD).set('X-Requested-With', 'wedding-photo-app');
  t.after(async () => { await app.locals.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, agent, upload, admin, token, image };
}

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Condition not reached');
}
async function zipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry(); });
      }));
      zip.readEntry();
    });
  });
}
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

test('configuration rejects missing secrets and unsafe public URLs', () => {
  assert.throws(() => createApp({ adminPassword: '' }), /ADMIN_PASSWORD/);
  assert.throws(() => createApp({ adminPassword: PASSWORD, production: true, publicUrl: '' }), /PUBLIC_URL/);
  for (const publicUrl of ['javascript:alert(1)', 'https://user:pass@host.test', 'https://host.test/subpath']) {
    assert.throws(() => createApp({ adminPassword: PASSWORD, publicUrl }), /PUBLIC_URL/);
  }
});

test('public pages, local assets, health, admin authentication and no raw storage access', async t => {
  const { agent, admin } = await fixture(t);
  for (const url of ['/', '/slideshow', '/css/tailwind.css', '/js/guest.js', '/vendor/alpine.min.js', '/healthz']) await agent.get(url).expect(200);
  for (const url of ['/admin', '/admin.html', '/api/admin/photos', '/api/admin/export.zip', '/api/admin/qr.svg']) await agent.get(url).expect(401);
  await admin('get', '/admin').expect(200);
  for (const url of ['/uploads/foo.jpg', '/data.db', '/thumbnails/foo.webp', '/.env', '/server.js']) await agent.get(url).expect(404);
  await agent.get('/api/quota').expect(400);
  const config = await agent.get('/api/config').expect(200);
  assert.equal(config.body.maxFileBytes, MAX_FILE_BYTES);
  assert.equal(config.body.quota, 50);
  assert.match(config.headers['content-security-policy'], /script-src 'self' 'unsafe-eval'/);
});

test('upload preserves originals, strips thumbnail metadata, sanitizes names and persists quotas', async t => {
  const { app, dataDir, agent, upload, admin, token, image } = await fixture(t);
  const response = await upload({ name: '..\\..\\photo<>.jpg', author: '  Cousin Marc  ' }).expect(201);
  assert.equal(response.body.remaining, 49);
  const row = app.locals.db.prepare('SELECT * FROM photos').get();
  assert.equal(row.author, 'Cousin Marc');
  assert.equal(row.original_name, 'photo__.jpg');
  assert.match(row.filename, /^[\da-f-]{36}\.jpg$/);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'uploads', row.filename)), image);
  const metadata = await sharp(path.join(dataDir, 'thumbnails', row.thumbnail_name)).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
  const quota = await agent.get('/api/quota').set('X-Device-Token', token).expect(200);
  assert.deepEqual(quota.body, { used: 1, remaining: 49, quota: 50 });
  const listing = await agent.get('/api/photos').expect(200);
  assert.equal(listing.body.photos.length, 1);
  assert.equal(listing.body.photos[0].device_token, undefined);
  assert.equal(listing.body.photos[0].original_url, undefined);
  const adminList = await admin('get', '/api/admin/photos').expect(200);
  assert.equal(adminList.body.photos[0].size, image.length);
  await agent.get(listing.body.photos[0].thumbnail_url).expect(200).expect('Cache-Control', 'no-store');
});

test('concurrent idempotent retries consume exactly one slot and remove redundant files', async t => {
  const { app, dataDir, upload, agent, token } = await fixture(t);
  const uploadId = randomUUID();
  const results = await Promise.all([upload({ uploadId }), upload({ uploadId })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 1);
  const q = await agent.get('/api/quota').set('X-Device-Token', token);
  assert.equal(q.body.used, 1);
  await until(async () => (await fs.readdir(path.join(dataDir, 'uploads'))).filter(n => n.endsWith('.jpg')).length === 1);
  await until(async () => (await fs.readdir(path.join(dataDir, 'thumbnails'))).length === 1);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads', '.tmp')), []);
});

test('quota boundary is atomic, failed upload files are removed, deletion never restores quota', async t => {
  const { app, dataDir, upload, admin, token, agent } = await fixture(t);
  const firstId = randomUUID();
  const first = await upload({ uploadId: firstId }).expect(201);
  app.locals.db.prepare('UPDATE devices SET uploaded_count = 49 WHERE device_token = ?').run(token);
  const results = await Promise.all([upload(), upload()]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 429]);
  assert.equal(results.find(r => r.status === 429).body.code, 'QUOTA_EXCEEDED');
  assert.equal(app.locals.db.prepare('SELECT uploaded_count FROM devices WHERE device_token = ?').get(token).uploaded_count, 50);
  await until(async () => (await fs.readdir(path.join(dataDir, 'thumbnails'))).length === 2);
  await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', '.tmp'))).length === 0);
  await admin('delete', `/api/admin/photos/${first.body.id}`).expect(200);
  const duplicate = await upload({ uploadId: firstId }).expect(200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.remaining, 0);
  await upload().expect(429);
  const q = await agent.get('/api/quota').set('X-Device-Token', token);
  assert.equal(q.body.remaining, 0);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 1);
});

test('invalid, oversized and malformed multipart files never count or survive on disk', async t => {
  const { app, dataDir, upload, agent, token } = await fixture(t);
  for (const options of [
    { image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'), mime: 'image/jpeg' },
    { image: Buffer.from('not-an-image'), mime: 'image/png' },
    { image: Buffer.from('malware'), mime: 'application/pdf' },
    { image: Buffer.alloc(0), mime: 'image/jpeg' }
  ]) await upload(options).expect(415);
  await upload({ image: Buffer.alloc(MAX_FILE_BYTES + 1) }).expect(413);
  await agent.post('/api/photos').set('X-Device-Token', token).set('X-Upload-Id', randomUUID()).field('author', 'Personne').expect(400);
  await upload({ author: 'a'.repeat(81) }).expect(400);
  await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', '.tmp'))).length === 0);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'thumbnails')), []);
});

test('signature validation accepts MIME-unknown photos and all documented image formats', async t => {
  const { upload } = await fixture(t);
  await upload({ mime: 'application/octet-stream' }).expect(201);
  for (const [format, mime] of [['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['avif', 'image/avif'], ['tiff', 'image/tiff']]) {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).toFormat(format).toBuffer();
    await upload({ image, mime, name: 'photo.' + format }).expect(201);
  }
});

test('moderation hides public files; originals and hidden-inclusive ZIP remain admin-only', async t => {
  const { upload, admin, agent, image } = await fixture(t);
  const { body } = await upload().expect(201);
  const url = `/api/admin/photos/${body.id}`;
  await agent.patch(url).auth('admin', PASSWORD).send({ is_hidden: true }).expect(403);
  await admin('patch', url).set('Origin', 'https://attacker.test').send({ is_hidden: true }).expect(403);
  await admin('patch', url).send({ is_hidden: 'true' }).expect(400);
  await admin('patch', url).send({ is_hidden: true }).expect(200);
  await agent.get(`/media/thumbnails/${body.id}`).expect(404);
  await agent.get(`/api/admin/originals/${body.id}`).expect(401);
  await admin('get', `/api/admin/thumbnails/${body.id}`).expect(200);
  const photos = await agent.get('/api/photos');
  assert.equal(photos.body.photos.length, 0);
  const archive = await admin('get', '/api/admin/export.zip').buffer(true).parse(binaryParser).expect(200);
  assert.match(archive.headers['content-disposition'], /wedding-photos-\d{4}-\d{2}-\d{2}\.zip/);
  const entries = await zipEntries(archive.body);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].bytes, image);
  assert.ok(!entries[0].name.includes('../'));
  await admin('patch', url).send({ is_hidden: false }).expect(200);
  await agent.get(`/media/thumbnails/${body.id}`).expect(200);
  await admin('delete', url).expect(200);
  await agent.get(`/media/thumbnails/${body.id}`).expect(404);
});

test('QR respects configured public URL and forwarded headers only with an explicitly trusted proxy', async t => {
  const canonical = await fixture(t, { trustProxy: '0' });
  const info = await canonical.admin('get', '/api/admin/info').set('X-Forwarded-Proto', 'http').set('X-Forwarded-Host', 'evil.test').expect(200);
  assert.equal(info.body.publicUrl, 'https://photos.example.test');
  await canonical.admin('get', '/api/admin/qr.svg').expect(200).expect('Content-Type', /svg/);
  const proxy = await fixture(t, { trustProxy: '1', publicUrl: '' });
  const forwarded = await proxy.admin('get', '/api/admin/info').set('X-Forwarded-Proto', 'https').set('X-Forwarded-Host', 'wedding.example.test').expect(200);
  assert.equal(forwarded.body.publicUrl, 'https://wedding.example.test');
  const direct = await fixture(t, { trustProxy: '0', publicUrl: '' });
  const ignored = await direct.admin('get', '/api/admin/info').set('Host', 'localhost:3000').set('X-Forwarded-Proto', 'https').set('X-Forwarded-Host', 'evil.test').expect(200);
  assert.equal(ignored.body.publicUrl, 'http://localhost:3000');
});

test('paginated slideshow includes older photos beyond 500 without exposing tokens', async t => {
  const { app, token, upload, agent } = await fixture(t);
  await upload().expect(201);
  const db = app.locals.db;
  const original = db.prepare('SELECT * FROM photos').get();
  const insert = db.prepare('INSERT INTO photos(id, filename, original_name, author, device_token, created_at, size, mime, thumbnail_name) VALUES (@id,@filename,@original_name,@author,@device_token,@created_at,@size,@mime,@thumbnail_name)');
  db.transaction(() => {
    for (let i = 0; i < 501; i++) {
      const id = randomUUID();
      insert.run({ ...original, id, filename: `${id}.jpg`, thumbnail_name: `${id}.webp`, device_token: token });
    }
  })();
  const first = await agent.get('/api/photos?page=1').expect(200);
  const second = await agent.get('/api/photos?page=2').expect(200);
  assert.equal(first.body.photos.length, 500);
  assert.equal(second.body.photos.length, 2);
  assert.equal(first.body.pages, 2);
  assert.equal(first.body.revision, second.body.revision);
  assert.equal(new Set([...first.body.photos, ...second.body.photos].map(p => p.id)).size, 502);
});

test('SQLite survives restart and cleanup removes uncommitted generated files', async t => {
  const { app, dataDir, upload, token } = await fixture(t);
  await upload().expect(201);
  await app.locals.close();
  const orphan = randomUUID() + '.jpg';
  await fs.writeFile(path.join(dataDir, 'uploads', orphan), 'partial');
  await fs.writeFile(path.join(dataDir, 'uploads', '.tmp', 'interrupted.part'), 'partial');
  const second = createApp({ dataDir, adminPassword: PASSWORD, publicUrl: 'http://localhost:3000', production: false });
  try {
    const q = await request(second).get('/api/quota').set('X-Device-Token', token).expect(200);
    assert.equal(q.body.remaining, 49);
    assert.equal(second.locals.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 1);
    await until(() => second.locals.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get().n === 0);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads', '.tmp')), []);
    await assert.rejects(fs.access(path.join(dataDir, 'uploads', orphan)));
  } finally { await second.locals.close(); }
});

test('SSE broadcasts uploads and moderation, then closes cleanly', async t => {
  const { app, upload, admin } = await fixture(t);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /event-stream/);
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /event: photos/);
  const photo = await upload().expect(201);
  assert.match(Buffer.from((await reader.read()).value).toString(), /"revision":1/);
  await admin('patch', `/api/admin/photos/${photo.body.id}`).send({ is_hidden: true }).expect(200);
  assert.match(Buffer.from((await reader.read()).value).toString(), /"revision":2/);
  controller.abort();
});

test('ZIP streams stay bounded, aborted exports close sources and deletion preserves a running snapshot', async t => {
  const { app, dataDir, upload, admin } = await fixture(t);
  for (let i = 0; i < 5; i++) await upload().expect(201);
  const rows = app.locals.db.prepare('SELECT * FROM photos ORDER BY created_at,id').all();
  const large = Buffer.alloc(2 * 1024 * 1024, 42);
  for (const row of rows) await fs.writeFile(path.join(dataDir, 'uploads', row.filename), large);
  const nativeFs = require('node:fs');
  const originalCreate = nativeFs.createReadStream;
  let active = 0;
  let maximum = 0;
  nativeFs.createReadStream = function (filename, ...args) {
    const source = originalCreate.call(this, filename, ...args);
    if (String(filename).startsWith(path.join(dataDir, 'uploads'))) {
      active++; maximum = Math.max(maximum, active);
      source.once('close', () => active--);
    }
    return source;
  };
  t.after(() => { nativeFs.createReadStream = originalCreate; });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Basic ' + Buffer.from('admin:' + PASSWORD).toString('base64') };
  const response = await fetch(base + '/api/admin/export.zip', { headers });
  const deleted = await admin('delete', `/api/admin/photos/${rows[rows.length - 1].id}`).expect(200);
  assert.equal(deleted.body.pending, true);
  const entries = await zipEntries(Buffer.from(await response.arrayBuffer()));
  assert.equal(entries.length, 5);
  assert.ok(entries.every(e => e.bytes.equals(large)));
  await until(() => active === 0);
  assert.equal(maximum, 1, 'Only the entry currently archived may open its source');
  await until(() => app.locals.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get().n === 0);
  await assert.rejects(fs.access(path.join(dataDir, 'uploads', rows[rows.length - 1].filename)));
  const controller = new AbortController();
  const interrupted = await fetch(base + '/api/admin/export.zip', { headers, signal: controller.signal });
  const reader = interrupted.body.getReader();
  await reader.read();
  controller.abort();
  await until(() => active === 0);
});

test('failed physical deletions survive restart and are retried when storage recovers', async t => {
  const { app, dataDir, upload, admin } = await fixture(t);
  const photo = await upload().expect(201);
  const row = app.locals.db.prepare('SELECT * FROM photos WHERE id = ?').get(photo.body.id);
  const target = path.join(dataDir, 'uploads', row.filename);
  const originalRemove = fs.rm;
  let blocked = true;
  let restarted;
  fs.rm = async (filename, ...args) => {
    if (filename === target && blocked) throw Object.assign(new Error('Simulated storage lock'), { code: 'EBUSY' });
    return originalRemove(filename, ...args);
  };
  try {
    const result = await admin('delete', `/api/admin/photos/${row.id}`).expect(200);
    assert.equal(result.body.pending, true);
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get().n, 1);
    await app.locals.close();
    restarted = createApp({ dataDir, adminPassword: PASSWORD, production: false, publicUrl: 'http://localhost:3000' });
    await request(restarted).get('/healthz').expect(200);
    assert.equal(restarted.locals.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get().n, 1);
    blocked = false;
    await restarted.locals.close();
    await assert.rejects(fs.access(target));
  } finally {
    blocked = false;
    fs.rm = originalRemove;
    if (restarted?.locals.db.open) await restarted.locals.close();
  }
});

test('failed upload cleanup is persisted for retry instead of losing its obligation', async t => {
  const { app, dataDir, upload } = await fixture(t);
  const originalRemove = fs.rm;
  fs.rm = async (filename, ...args) => {
    if (String(filename).startsWith(path.join(dataDir, 'uploads', '.tmp'))) throw new Error('Simulated temporary file lock');
    return originalRemove(filename, ...args);
  };
  try {
    await upload({ image: Buffer.from('not a valid image') }).expect(415);
    await until(() => app.locals.db.prepare('SELECT COUNT(*) AS n FROM pending_deletions').get().n === 1);
  } finally { fs.rm = originalRemove; }
  await app.locals.close();
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads', '.tmp')), []);
});

test('combined filesystem and SQLite cleanup failures never leak upload slots or tracked tasks', async t => {
  const { app, dataDir, upload } = await fixture(t, { maxConcurrentUploads: 1 });
  const db = app.locals.db;
  const originalRemove = fs.rm;
  const originalPrepare = db.prepare;
  let injected = false;
  fs.rm = async (filename, ...args) => {
    if (String(filename).startsWith(path.join(dataDir, 'uploads', '.tmp'))) throw new Error('Simulated temporary file lock');
    return originalRemove(filename, ...args);
  };
  db.prepare = function (sql) {
    if (sql.startsWith('INSERT OR IGNORE INTO pending_deletions')) {
      injected = true;
      throw Object.assign(new Error('Simulated database full'), { code: 'SQLITE_FULL' });
    }
    return originalPrepare.call(this, sql);
  };
  try {
    await upload({ image: Buffer.from('invalid image') }).expect(415);
    await until(() => injected);
  } finally {
    fs.rm = originalRemove;
    db.prepare = originalPrepare;
  }
  await upload().expect(201);
  await app.locals.close();
  const restarted = createApp({ dataDir, adminPassword: PASSWORD, production: false, publicUrl: 'http://localhost:3000' });
  try {
    await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', '.tmp'))).length === 0);
    assert.equal(restarted.locals.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 1);
  } finally { await restarted.locals.close(); }
});

test('upload disconnection removes partial temporary files without consuming quota', async t => {
  const { app, dataDir, token, agent } = await fixture(t);
  const http = require('node:http');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const boundary = 'wedding-test-boundary';
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/photos', method: 'POST', headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'X-Device-Token': token, 'X-Upload-Id': randomUUID()
  } });
  req.on('error', () => {});
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="partial.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  req.write(Buffer.alloc(65536, 1));
  await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', '.tmp'))).length === 1);
  req.destroy();
  await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', '.tmp'))).length === 0);
  const q = await agent.get('/api/quota').set('X-Device-Token', token).expect(200);
  assert.equal(q.body.used, 0);
});
