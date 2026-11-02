'use strict';

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { ZipArchive } = require('archiver');
const { Readable } = require('node:stream');
const QRCode = require('qrcode');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const QUOTA = 50;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMATS = { jpeg: ['jpg', 'image/jpeg'], png: ['png', 'image/png'], webp: ['webp', 'image/webp'], gif: ['gif', 'image/gif'], tiff: ['tiff', 'image/tiff'], heif: ['avif', 'image/avif'] };
sharp.cache({ memory: 32, files: 0, items: 50 });
sharp.concurrency(1);

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function configuration(overrides) {
  const config = {
    dataDir: process.env.DATA_DIR || __dirname,
    adminUser: process.env.ADMIN_USER || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    publicUrl: process.env.PUBLIC_URL || '',
    eventName: process.env.EVENT_NAME || 'Nos souvenirs de mariage',
    slideshowInterval: Number(process.env.SLIDESHOW_INTERVAL_MS || 7000),
    trustProxy: process.env.TRUST_PROXY || '0',
    production: process.env.NODE_ENV === 'production',
    maxConcurrentUploads: 4,
    ...overrides
  };
  if (config.adminPassword.length < 16 || /change.me|changeme|remplacez/i.test(config.adminPassword)) {
    throw new Error('ADMIN_PASSWORD doit être un secret généré de 16 caractères minimum.');
  }
  if (!config.adminUser || config.adminUser.includes(':') || /[\r\n]/.test(config.adminUser)) throw new Error('ADMIN_USER invalide.');
  if (config.production && !config.publicUrl) throw new Error('PUBLIC_URL est obligatoire en production.');
  if (config.publicUrl) {
    const url = new URL(config.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('PUBLIC_URL doit être une origine HTTP(S), sans chemin, identifiants ni paramètres.');
    }
    config.publicUrl = url.origin;
  }
  if (!Number.isInteger(config.slideshowInterval) || config.slideshowInterval < 2000 || config.slideshowInterval > 60000) {
    throw new Error('SLIDESHOW_INTERVAL_MS doit être compris entre 2000 et 60000.');
  }
  // A fixed hop count is intentional: never trust arbitrary forwarded headers by default.
  if (!['0', '1'].includes(String(config.trustProxy))) throw new Error('TRUST_PROXY doit valoir 0 ou 1.');
  if (!Number.isInteger(config.maxConcurrentUploads) || config.maxConcurrentUploads < 1) throw new Error('Concurrence invalide.');
  return config;
}

function sanitizedName(value) {
  return String(value || 'photo').replace(/\\/g, '/').split('/').pop()
    .normalize('NFC').replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').slice(0, 180) || 'photo';
}

function createApp(overrides = {}) {
  const config = configuration(overrides);
  const dataDir = path.resolve(config.dataDir);
  const uploadsDir = path.join(dataDir, 'uploads');
  const thumbsDir = path.join(dataDir, 'thumbnails');
  const tempDir = path.join(uploadsDir, '.tmp');
  for (const dir of [dataDir, uploadsDir, thumbsDir, tempDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'data.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_token TEXT PRIMARY KEY,
      uploaded_count INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_count BETWEEN 0 AND 50)
    );
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      device_token TEXT NOT NULL REFERENCES devices(device_token),
      is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
      created_at TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      thumbnail_name TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS photos_created ON photos(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS photos_visible ON photos(is_hidden, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS pending_deletions (filename TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS upload_receipts (
      device_token TEXT NOT NULL REFERENCES devices(device_token),
      upload_id TEXT NOT NULL,
      photo_id TEXT NOT NULL,
      PRIMARY KEY (device_token, upload_id)
    );
  `);

  // Recover only our generated files after an interrupted upload; never touch unrelated files.
  const originals = new Set(db.prepare('SELECT filename FROM photos').all().map(row => row.filename));
  const thumbnails = new Set(db.prepare('SELECT thumbnail_name FROM photos').all().map(row => row.thumbnail_name));
  for (const [dir, known] of [[uploadsDir, originals], [thumbsDir, thumbnails]]) {
    for (const name of fs.readdirSync(dir)) {
      if (/^[0-9a-f-]{36}\.(jpg|png|webp|gif|tiff|avif)$/.test(name) && !known.has(name)) {
        db.prepare('INSERT OR IGNORE INTO pending_deletions(filename) VALUES (?)').run(path.join(dir, name));
      }
    }
  }
  for (const name of fs.readdirSync(tempDir)) {
    if (fs.statSync(path.join(tempDir, name)).isFile()) db.prepare('INSERT OR IGNORE INTO pending_deletions(filename) VALUES (?)').run(path.join(tempDir, name));
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', String(config.trustProxy) === '1' ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.publicUrl.startsWith('https:') ? [] : null
    } },
    strictTransportSecurity: config.publicUrl.startsWith('https:') ? { maxAge: 31536000 } : false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path.startsWith('/admin')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const clients = new Set();
  const archives = new Set();
  const fileLeases = new Map();
  const archiveTasks = new Set();
  let revision = 0;
  let activeUploads = 0;
  let closing = false;
  const activeTasks = new Set();
  function broadcast() {
    revision++;
    for (const client of clients) {
      if (client.writableLength > 65536) { client.end(); continue; }
      client.write(`event: photos\ndata: ${JSON.stringify({ revision })}\n\n`);
    }
  }
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.writableLength > 65536) client.end();
      else client.write(': keepalive\n\n');
    }
  }, 20000);
  heartbeat.unref();
  const removeFile = async filename => {
    try { await fsp.rm(filename, { force: true }); return true; }
    catch (error) { console.error('Suppression du fichier impossible:', filename, error.message); return false; }
  };
  async function cleanupFile(filename) {
    if (await removeFile(filename)) return;
    try {
      if (db.open) db.prepare('INSERT OR IGNORE INTO pending_deletions(filename) VALUES (?)').run(filename);
    } catch (error) {
      // If the database is also unwritable, startup reconciliation remains the fallback.
      console.error('Nettoyage non enregistré; récupération nécessaire au redémarrage:', filename, error.message);
    }
  }
  async function processDeletion(filename) {
    if (fileLeases.has(filename)) return false;
    if (!await removeFile(filename)) return false;
    if (db.open) db.prepare('DELETE FROM pending_deletions WHERE filename = ?').run(filename);
    return true;
  }
  let deletionJob = null;
  const retryDeletions = () => {
    if (deletionJob || !db.open) return deletionJob;
    deletionJob = (async () => {
      for (const row of db.prepare('SELECT filename FROM pending_deletions').all()) await processDeletion(row.filename);
    })().catch(error => {
      console.error('Nettoyage différé interrompu; nouvelle tentative au prochain cycle:', error.message);
    }).finally(() => { deletionJob = null; });
    return deletionJob;
  };
  const deletionTimer = setInterval(() => { void retryDeletions(); }, 30000);
  deletionTimer.unref();
  void retryDeletions();
  async function releaseFiles(filenames) {
    for (const filename of filenames) {
      const count = (fileLeases.get(filename) || 1) - 1;
      if (count) fileLeases.set(filename, count);
      else fileLeases.delete(filename);
    }
    await retryDeletions();
  }

  const quota = token => {
    const used = db.prepare('SELECT uploaded_count FROM devices WHERE device_token = ?').get(token)?.uploaded_count || 0;
    return { used, remaining: QUOTA - used, quota: QUOTA };
  };
  const receipt = (token, uploadId) => db.prepare('SELECT photo_id FROM upload_receipts WHERE device_token = ? AND upload_id = ?').get(token, uploadId);
  const commitPhoto = db.transaction((photo, uploadId) => {
    const existing = receipt(photo.device_token, uploadId);
    if (existing) return { id: existing.photo_id, duplicate: true, ...quota(photo.device_token) };
    db.prepare('INSERT OR IGNORE INTO devices(device_token) VALUES (?)').run(photo.device_token);
    const changed = db.prepare('UPDATE devices SET uploaded_count = uploaded_count + 1 WHERE device_token = ? AND uploaded_count < ?').run(photo.device_token, QUOTA);
    if (!changed.changes) throw new HttpError(429, 'QUOTA_EXCEEDED', 'Votre quota de 50 photos est atteint.', { remaining: 0 });
    db.prepare(`INSERT INTO photos (id, filename, original_name, author, device_token, created_at, size, mime, thumbnail_name)
      VALUES (@id, @filename, @original_name, @author, @device_token, @created_at, @size, @mime, @thumbnail_name)`).run(photo);
    db.prepare('INSERT INTO upload_receipts(device_token, upload_id, photo_id) VALUES (?, ?, ?)').run(photo.device_token, uploadId, photo.id);
    return { id: photo.id, duplicate: false, ...quota(photo.device_token) };
  });

  const authHash = createHash('sha256').update(`${config.adminUser}:${config.adminPassword}`).digest();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => res.status(429).json({ error: 'Trop de tentatives de connexion. Réessayez plus tard.', code: 'RATE_LIMITED' })
  });
  function authenticate(req, res, next) {
    const header = req.get('Authorization') || '';
    let credentials = '';
    if (/^Basic [A-Za-z0-9+/]+=*$/i.test(header)) credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
    if (!credentials || !timingSafeEqual(createHash('sha256').update(credentials).digest(), authHash)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Wedding administration", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentification administrateur requise.', code: 'UNAUTHORIZED' });
    }
    next();
  }
  function publicUrl(req) {
    if (config.publicUrl) return config.publicUrl;
    const url = new URL(`${req.protocol}://${req.host}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new HttpError(400, 'INVALID_HOST', 'Nom d’hôte invalide. Configurez PUBLIC_URL.');
    }
    return url.origin;
  }
  function sameOrigin(req, res, next) {
    const origin = req.get('Origin');
    // Non-browser clients may omit Origin; custom headers prevent browser form CSRF.
    if (origin && origin !== publicUrl(req) && origin !== new URL(`${req.protocol}://${req.host}`).origin) {
      throw new HttpError(403, 'INVALID_ORIGIN', 'Origine de la requête refusée.');
    }
    next();
  }
  app.use(['/admin', '/admin.html', '/api/admin'], loginLimiter, authenticate);
  app.use('/api/admin', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Requested-With') !== 'wedding-photo-app') throw new HttpError(403, 'CSRF', 'En-tête de sécurité manquant.');
      return sameOrigin(req, res, next);
    }
    next();
  });
  app.use(express.json({ limit: '4kb' }));

  app.get('/healthz', (req, res) => {
    if (closing) return res.status(503).json({ status: 'stopping' });
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });
  app.get('/api/config', (req, res) => res.json({ quota: QUOTA, maxFileBytes: MAX_FILE_BYTES, eventName: config.eventName, slideshowInterval: config.slideshowInterval }));
  function deviceToken(req, res, next) {
    const token = req.get('X-Device-Token');
    if (!token || !UUID.test(token)) throw new HttpError(400, 'INVALID_DEVICE_TOKEN', 'Identifiant d’appareil invalide.');
    req.deviceToken = token.toLowerCase();
    next();
  }
  app.get('/api/quota', deviceToken, (req, res) => res.json(quota(req.deviceToken)));

  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 3000, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Trop d’envois simultanés depuis ce réseau. Réessayez plus tard.', code: 'RATE_LIMITED' })
  });
  const upload = multer({
    storage: multer.diskStorage({ destination: tempDir, filename: (req, file, cb) => cb(null, randomUUID() + '.part') }),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 1, parts: 2, fieldSize: 320, fieldNameSize: 32 },
    fileFilter: (req, file, cb) => {
      if ((!file.mimetype.startsWith('image/') && file.mimetype !== 'application/octet-stream') || file.mimetype === 'image/svg+xml') {
        return cb(new HttpError(415, 'INVALID_IMAGE', 'Seules les photos JPEG, PNG, WEBP, GIF, AVIF ou TIFF sont acceptées.'));
      }
      cb(null, true);
    }
  }).single('photo');
  app.post('/api/photos', uploadLimiter, deviceToken, sameOrigin, (req, res, next) => {
    const uploadId = req.get('X-Upload-Id');
    if (!uploadId || !UUID.test(uploadId)) return next(new HttpError(400, 'INVALID_UPLOAD_ID', 'Identifiant d’envoi invalide.'));
    req.uploadId = uploadId.toLowerCase();
    const existing = receipt(req.deviceToken, req.uploadId);
    if (existing) return res.json({ id: existing.photo_id, duplicate: true, ...quota(req.deviceToken) });
    if (!quota(req.deviceToken).remaining) return next(new HttpError(429, 'QUOTA_EXCEEDED', 'Votre quota de 50 photos est atteint.', { remaining: 0 }));
    if (Number(req.get('Content-Length') || 0) > MAX_FILE_BYTES + 65536) return next(new HttpError(413, 'FILE_TOO_LARGE', 'La taille maximale est de 15 Mo par photo.'));
    if (closing || activeUploads >= config.maxConcurrentUploads) {
      res.setHeader('Retry-After', '3');
      return next(new HttpError(503, 'BUSY', 'Le serveur traite d’autres photos. Réessayez dans quelques secondes.'));
    }
    activeUploads++;
    let finish;
    const task = new Promise(resolve => { finish = resolve; });
    activeTasks.add(task);
    const handle = async parseError => {
      let originalPath;
      let thumbnailPath;
      let committed = false;
      try {
        if (parseError) throw parseError;
        if (!req.file || req.aborted) throw new HttpError(400, 'MISSING_PHOTO', 'Choisissez une photo à envoyer.');
        if (Object.keys(req.body).some(key => key !== 'author') || (req.body.author !== undefined && typeof req.body.author !== 'string')) {
          throw new HttpError(400, 'INVALID_AUTHOR', 'Le nom de l’auteur doit être un texte.');
        }
        const author = String(req.body.author || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').trim();
        if (author.length > 80) throw new HttpError(400, 'INVALID_AUTHOR', 'Le nom est limité à 80 caractères.');
        const image = sharp(req.file.path, { limitInputPixels: 40000000, failOn: 'warning', animated: false });
        let metadata;
        try { metadata = await image.metadata(); }
        catch { throw new HttpError(415, 'INVALID_IMAGE', 'Photo illisible, format non pris en charge ou résolution trop grande (40 mégapixels maximum).'); }
        const format = FORMATS[metadata.format];
        if (!format || (metadata.format === 'heif' && metadata.compression !== 'av1')) throw new HttpError(415, 'INVALID_IMAGE', 'Format non pris en charge. Convertissez les fichiers HEIC / HEIF en JPEG.');
        const id = randomUUID();
        const filename = `${id}.${format[0]}`;
        const thumbnailName = `${id}.webp`;
        originalPath = path.join(uploadsDir, filename);
        thumbnailPath = path.join(thumbsDir, thumbnailName);
        try {
          await image.rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toFile(thumbnailPath);
        } catch { throw new HttpError(415, 'INVALID_IMAGE', 'La photo est endommagée ou son format ne peut pas être décodé.'); }
        if (req.aborted) throw new HttpError(400, 'UPLOAD_ABORTED', 'Envoi interrompu.');
        // rename preserves every original byte, including EXIF; names never come from the client.
        await fsp.rename(req.file.path, originalPath);
        const result = commitPhoto({ id, filename, original_name: sanitizedName(req.file.originalname), author,
          device_token: req.deviceToken, created_at: new Date().toISOString(), size: req.file.size,
          mime: format[1], thumbnail_name: thumbnailName }, req.uploadId);
        committed = !result.duplicate;
        if (committed) broadcast();
        if (!res.destroyed) res.status(result.duplicate ? 200 : 201).json(result);
      } catch (error) { if (!res.destroyed) next(error); }
      finally {
        try {
          if (req.file?.path) await cleanupFile(req.file.path);
          if (!committed) {
            if (originalPath) await cleanupFile(originalPath);
            if (thumbnailPath) await cleanupFile(thumbnailPath);
          }
        } finally {
          activeUploads--;
          activeTasks.delete(task);
          finish();
        }
      }
    };
    upload(req, res, error => {
      void handle(error).catch(failure => {
        console.error('Finalisation de l’envoi interrompue:', failure);
        if (!res.destroyed && !res.headersSent) next(failure);
      });
    });
  });

  function photoView(row, admin = false) {
    const photo = { id: row.id, author: row.author, created_at: row.created_at, size: row.size,
      thumbnail_url: admin ? `/api/admin/thumbnails/${row.id}` : `/media/thumbnails/${row.id}` };
    if (admin) Object.assign(photo, { original_name: row.original_name, is_hidden: Boolean(row.is_hidden), original_url: `/api/admin/originals/${row.id}` });
    return photo;
  }
  app.get('/api/photos', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) AS total FROM photos WHERE is_hidden = 0').get().total;
    const pages = Math.max(1, Math.ceil(total / 500));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const rows = db.prepare('SELECT * FROM photos WHERE is_hidden = 0 ORDER BY created_at DESC, id DESC LIMIT 500 OFFSET ?').all((page - 1) * 500);
    res.json({ photos: rows.map(row => photoView(row)), page, pages, total, revision });
  });
  app.get('/api/events', (req, res) => {
    if (closing || clients.size >= 200) {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({ error: 'Utilisez la mise à jour périodique.', code: 'BUSY' });
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`retry: 10000\nevent: photos\ndata: ${JSON.stringify({ revision })}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
  });
  function findPhoto(id, visibleOnly = false) {
    if (!UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', 'Photo introuvable.');
    const row = db.prepare(`SELECT * FROM photos WHERE id = ? ${visibleOnly ? 'AND is_hidden = 0' : ''}`).get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Photo introuvable.');
    return row;
  }
  app.get('/media/thumbnails/:id', (req, res, next) => {
    const row = findPhoto(req.params.id, true);
    res.sendFile(path.join(thumbsDir, row.thumbnail_name), { cacheControl: false }, error => { if (error) next(error); });
  });
  app.get('/api/admin/thumbnails/:id', (req, res, next) => {
    const row = findPhoto(req.params.id);
    res.sendFile(path.join(thumbsDir, row.thumbnail_name), { cacheControl: false }, error => { if (error) next(error); });
  });
  app.get('/api/admin/originals/:id', (req, res, next) => {
    const row = findPhoto(req.params.id);
    res.download(path.join(uploadsDir, row.filename), row.original_name, { cacheControl: false }, error => { if (error) next(error); });
  });
  app.get('/api/admin/info', (req, res) => res.json({ publicUrl: publicUrl(req), eventName: config.eventName }));
  app.get('/api/admin/qr.svg', async (req, res) => {
    const svg = await QRCode.toString(publicUrl(req) + '/', { type: 'svg', width: 1600, margin: 4, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  });
  app.get('/api/admin/photos', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 60));
    const total = db.prepare('SELECT COUNT(*) AS total FROM photos').get().total;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const rows = db.prepare('SELECT * FROM photos ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, (page - 1) * limit);
    res.json({ photos: rows.map(row => photoView(row, true)), page, total, pages });
  });
  app.patch('/api/admin/photos/:id', (req, res) => {
    const row = findPhoto(req.params.id);
    if (!req.body || typeof req.body.is_hidden !== 'boolean') throw new HttpError(400, 'INVALID_VISIBILITY', 'is_hidden doit être un booléen.');
    db.prepare('UPDATE photos SET is_hidden = ? WHERE id = ?').run(Number(req.body.is_hidden), row.id);
    broadcast();
    res.json({ id: row.id, is_hidden: req.body.is_hidden });
  });
  app.delete('/api/admin/photos/:id', async (req, res) => {
    const row = findPhoto(req.params.id);
    const filenames = [path.join(uploadsDir, row.filename), path.join(thumbsDir, row.thumbnail_name)];
    db.transaction(() => {
      for (const filename of filenames) db.prepare('INSERT OR IGNORE INTO pending_deletions(filename) VALUES (?)').run(filename);
      db.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
    })();
    broadcast();
    // Persist the cleanup obligation before retiring originals leased by an export.
    const results = await Promise.all(filenames.map(processDeletion));
    res.json({ deleted: true, pending: results.some(done => !done), id: row.id });
  });
  app.get('/api/admin/export.zip', (req, res, next) => {
    if (archives.size >= 2 || closing) {
      res.setHeader('Retry-After', '10');
      throw new HttpError(503, 'BUSY', 'Un export est déjà en cours. Réessayez plus tard.');
    }
    const rows = db.prepare('SELECT * FROM photos ORDER BY created_at, id').all();
    const filenames = rows.map(row => path.join(uploadsDir, row.filename));
    for (const filename of filenames) fileLeases.set(filename, (fileLeases.get(filename) || 0) + 1);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const inputs = [];
    const sources = new Map();
    let cleanupStarted = false;
    let complete;
    const completion = new Promise(resolve => { complete = resolve; });
    archiveTasks.add(completion);
    const cleanup = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      archive.abort();
      archive.destroy();
      for (const input of inputs) input.destroy();
      const closed = [...sources.values()];
      for (const source of sources.keys()) source.destroy();
      await Promise.allSettled(closed);
      await releaseFiles(filenames);
      archives.delete(handle);
      archiveTasks.delete(completion);
      complete();
    };
    const handle = { abort: () => { res.destroy(); void cleanup(); } };
    archives.add(handle);
    res.attachment(`wedding-photos-${new Date().toISOString().slice(0, 10)}.zip`);
    archive.on('warning', error => { archive.destroy(error); });
    archive.on('error', error => {
      console.error('Export ZIP interrompu:', error.message);
      if (!res.headersSent) next(new HttpError(500, 'EXPORT_FAILED', 'Impossible de créer l’archive. Vérifiez les fichiers du stockage.'));
      else res.destroy(error);
    });
    res.on('close', () => { void cleanup(); });
    archive.pipe(res);
    let nextIndex = 0;
    const appendNext = () => {
      if (cleanupStarted) return;
      if (nextIndex >= rows.length) {
        void archive.finalize().catch(error => { if (!res.destroyed) res.destroy(error); });
        return;
      }
      const index = nextIndex++;
      const row = rows[index];
      const base = sanitizedName(row.original_name).replace(/^[. ]+/, '') || 'photo';
      // Archiver eagerly pipes appended streams, so queue only one entry at a time.
      const input = Readable.from((async function* () {
        if (cleanupStarted) return;
        const source = fs.createReadStream(filenames[index]);
        const closed = new Promise(resolve => source.once('close', resolve));
        sources.set(source, closed);
        try { for await (const chunk of source) yield chunk; }
        finally { source.destroy(); await closed; sources.delete(source); }
      })());
      input.on('error', error => archive.destroy(error));
      inputs.push(input);
      input.once('close', () => { const i = inputs.indexOf(input); if (i !== -1) inputs.splice(i, 1); });
      archive.append(input, { name: `${String(index + 1).padStart(5, '0')}-${row.id}-${base}`, date: new Date(row.created_at) });
    };
    archive.on('entry', appendNext);
    appendNext();
  });

  const publicDir = path.join(__dirname, 'public');
  app.get(['/','/index.html'], (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get(['/admin','/admin.html'], (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
  app.get(['/slideshow','/slideshow.html'], (req, res) => res.sendFile(path.join(publicDir, 'slideshow.html')));
  app.get('/vendor/alpine.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/alpinejs/dist/cdn.min.js'), { maxAge: '1d' }));
  for (const prefix of ['css', 'js']) app.use(`/${prefix}`, express.static(path.join(publicDir, prefix), { maxAge: '1h', dotfiles: 'deny', index: false }));
  app.use((req, res) => res.status(404).json({ error: 'Ressource introuvable.', code: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500;
    let code = error.code || 'INTERNAL_ERROR';
    let message = error.message;
    if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code = error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD';
      message = error.code === 'LIMIT_FILE_SIZE' ? 'La taille maximale est de 15 Mo par photo.' : 'Envoyez une seule photo et, éventuellement, un nom de 80 caractères maximum.';
    } else if (error.type === 'entity.parse.failed') {
      status = 400; code = 'INVALID_JSON'; message = 'JSON invalide.';
    } else if (status >= 500 && !(error instanceof HttpError)) {
      console.error('Erreur serveur:', error);
      code = 'INTERNAL_ERROR'; message = 'Une erreur serveur est survenue. Réessayez dans quelques instants.';
    } else if (status === 404) { code = 'NOT_FOUND'; message = 'Ressource introuvable.'; }
    res.status(status).json({ error: message, code, ...error.details });
  });

  app.locals.db = db;
  app.locals.config = config;
  app.locals.beginShutdown = () => {
    closing = true;
    clearInterval(heartbeat);
    clearInterval(deletionTimer);
    for (const client of clients) client.end();
    for (const archive of archives) archive.abort();
  };
  app.locals.close = async () => {
    app.locals.beginShutdown();
    await Promise.allSettled([...activeTasks, ...archiveTasks]);
    await retryDeletions();
    if (db.open) { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); }
  };
  return app;
}

function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
  const server = app.listen(port, '0.0.0.0', () => console.log(`Wedding Photo App écoute sur le port ${port}`));
  server.requestTimeout = 300000;
  server.headersTimeout = 30000;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.locals.beginShutdown();
    const deadline = setTimeout(() => { console.error('Arrêt forcé après 25 secondes.'); process.exit(1); }, 25000);
    deadline.unref();
    server.close(async () => {
      try { await app.locals.close(); clearTimeout(deadline); process.exit(0); }
      catch (error) { console.error(error); process.exit(1); }
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { app, server };
}

if (require.main === module) {
  try { startServer(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createApp, startServer, QUOTA, MAX_FILE_BYTES };
