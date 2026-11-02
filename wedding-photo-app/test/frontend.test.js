'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const sourceDirectory = path.resolve(__dirname, '../public/js');
const sources = Object.fromEntries(['common', 'guest', 'slideshow', 'admin'].map(name => [
  name, fs.readFileSync(path.join(sourceDirectory, `${name}.js`), 'utf8')
]));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    emit(name, event = {}) { return Promise.all(Array.from(listeners.get(name) || [], listener => listener(event))); }
  };
}

function virtualClock() {
  let now = 1000000;
  let sequence = 0;
  const jobs = new Map();
  class VirtualDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const add = (callback, delay, interval) => {
    const id = ++sequence;
    const milliseconds = Math.max(0, Number(delay) || 0);
    jobs.set(id, { callback, at: now + milliseconds, delay: milliseconds, interval });
    return id;
  };
  return {
    Date: VirtualDate, jobs,
    setTimeout: (callback, delay) => add(callback, delay, false),
    setInterval: (callback, delay) => add(callback, delay, true),
    clearTimeout: id => jobs.delete(id),
    clearInterval: id => jobs.delete(id),
    runNextTimeout() {
      const next = Array.from(jobs).filter(([, job]) => !job.interval).sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'An unfinished operation must have a runnable mock timeout');
      const [id, job] = next;
      jobs.delete(id);
      now = job.at;
      job.callback();
    }
  };
}

async function flushMicrotasks() {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

// No browser, real network, or live timers are used. The frontend still owns
// its API parsing, retry decisions, pagination, preloading and notice wording.
function browser(t, { storageThrows = false, autoLoadImages = true } = {}) {
  const clock = virtualClock();
  const document = Object.assign(eventTarget(), { hidden: false, documentElement: {} });
  const window = Object.assign(eventTarget(), { location: { origin: 'http://localhost:3000' }, crypto: webcrypto });
  const factories = new Map();
  const components = [];
  const requests = [];
  const uploads = [];
  const uploadResponses = [];
  const images = [];
  const eventSources = [];
  const stored = new Map();
  let fetchHandler = () => { throw new Error('Unexpected fetch'); };
  let activeUploads = 0;
  let maxActiveUploads = 0;
  const storage = {
    getItem(key) {
      if (storageThrows) throw new Error('Storage access denied');
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageThrows) throw new Error('Storage access denied');
      stored.set(key, value);
    }
  };
  class ImageStub {
    constructor() { images.push(this); }
    set src(value) {
      this.url = value;
      if (autoLoadImages) queueMicrotask(() => this.onload?.());
    }
    removeAttribute(name) { if (name === 'src') this.url = ''; }
  }
  class EventSourceStub {
    constructor(url) { Object.assign(this, eventTarget()); this.url = url; this.closed = false; eventSources.push(this); }
    close() { this.closed = true; }
  }
  window.EventSource = EventSourceStub;
  class FormDataStub {
    constructor() { this.fields = []; }
    append(...field) { this.fields.push(field); }
  }
  class XhrStub {
    constructor() {
      Object.assign(this, eventTarget());
      this.upload = eventTarget();
      this.headers = {};
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) { return this.result?.headers?.[name] ?? null; }
    send(form) {
      uploads.push({ method: this.method, url: this.url, headers: this.headers, fields: form.fields });
      this.result = uploadResponses.shift();
      assert.ok(this.result, 'Unexpected upload: no scripted response remains');
      activeUploads++;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      queueMicrotask(() => {
        activeUploads--;
        this.upload.emit('progress', { lengthComputable: true, loaded: 5, total: 10 });
        if (this.result.network) { this.emit('error'); return; }
        this.status = this.result.status;
        this.responseText = JSON.stringify(this.result.body);
        this.emit('load');
      });
    }
    abort() { this.emit('abort'); }
  }
  const sandboxMath = Object.create(Math);
  sandboxMath.random = () => 0;
  const context = vm.createContext({
    window, document, localStorage: storage, Image: ImageStub, EventSource: EventSourceStub,
    XMLHttpRequest: XhrStub, FormData: FormDataStub, URL, Uint8Array, DataView, AbortController,
    Math: sandboxMath, Date: clock.Date,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    Alpine: { data(name, factory) { factories.set(name, factory); } },
    async fetch(url, options) {
      requests.push({ url, options });
      const response = await fetchHandler(url, options);
      const status = response.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => response.body };
    }
  });
  for (const [name, source] of Object.entries(sources)) {
    vm.runInContext(source, context, { filename: path.join(sourceDirectory, `${name}.js`), timeout: 1000 });
  }
  // Dispatch synchronously, as Alpine does when registering component factories.
  document.emit('alpine:init');
  const harness = {
    clock, window, document, requests, uploads, uploadResponses, images, eventSources,
    Wedding: window.Wedding,
    get maxActiveUploads() { return maxActiveUploads; },
    fetchWith(handler) { fetchHandler = handler; },
    component(name) {
      assert.ok(factories.has(name), `Missing Alpine component ${name}`);
      const component = factories.get(name)();
      components.push(component);
      return component;
    },
    loadImages(url) { images.filter(image => image.url === url).forEach(image => image.onload?.()); },
    async complete(promise) {
      let settled = false;
      let failure;
      let value;
      promise.then(result => { value = result; settled = true; }, error => { failure = error; settled = true; });
      for (let turn = 0; turn < 128; turn++) {
        await flushMicrotasks();
        if (settled) {
          if (failure) throw failure;
          return value;
        }
        clock.runNextTimeout();
      }
      assert.fail('Operation exceeded the bounded virtual timer budget');
    }
  };
  t.after(() => {
    components.forEach(component => component.destroy?.());
    assert.equal(clock.jobs.size, 0, 'Frontend teardown must clear every mock timer');
  });
  return harness;
}

function queuedPhoto(harness, name = 'souvenir.jpg') {
  return {
    id: harness.Wedding.makeId(), file: { name }, name, author: 'Camille',
    status: 'queued', attempts: 0, progress: 0, retryable: false
  };
}

function photo(id) {
  return { id, author: 'Camille', created_at: '2026-06-20T18:00:00Z', size: 2048, thumbnail_url: `/media/thumbnails/${id}` };
}

function fetchSequence(harness, responses) {
  let index = 0;
  harness.fetchWith((url, options) => {
    const expected = responses[index++];
    assert.ok(expected, `Unexpected request ${url}`);
    assert.equal(url, expected.url);
    if (expected.check) expected.check(options);
    return { status: expected.status, body: expected.body };
  });
  return () => assert.equal(index, responses.length, 'Every scripted request must be consumed');
}

test('Guest retries a network failure with the same upload ID, then sends the next file sequentially', { timeout: 2000 }, async t => {
  const h = browser(t);
  const guest = h.component('guestApp');
  guest.token = h.Wedding.makeId(); guest.remaining = 50;
  const first = queuedPhoto(h), second = queuedPhoto(h, 'danse.jpg');
  guest.queue = [first, second];
  h.uploadResponses.push(
    { network: true },
    { status: 200, body: { id: 'received-first', remaining: 49, quota: 50, duplicate: true } },
    { status: 201, body: { id: 'received-second', remaining: 48, quota: 50, duplicate: false } }
  );
  await h.complete(guest.processQueue());
  assert.equal(h.uploads.length, 3);
  assert.equal(h.maxActiveUploads, 1);
  assert.equal(h.uploads[0].headers['X-Upload-Id'], first.id);
  assert.equal(h.uploads[1].headers['X-Upload-Id'], first.id);
  assert.equal(h.uploads[2].headers['X-Upload-Id'], second.id);
  assert.notEqual(first.id, second.id);
  for (const request of h.uploads) {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/photos');
    assert.equal(request.headers['X-Device-Token'], guest.token);
    assert.match(request.headers['X-Upload-Id'], uuidPattern);
    assert.equal(request.fields[0][0], 'photo'); assert.equal(request.fields[1][1], 'Camille');
  }
  assert.equal(first.status, 'success'); assert.match(first.message, /déjà reçue/);
  assert.equal(first.progress, 100); assert.equal(first.file, null);
  assert.equal(guest.completed, 2); assert.equal(guest.remaining, 48); assert.equal(guest.used, 2);
});

test('Guest never retries QUOTA_EXCEEDED and blocks remaining queued files', { timeout: 2000 }, async t => {
  const h = browser(t), guest = h.component('guestApp');
  guest.token = h.Wedding.makeId(); guest.remaining = 1;
  const first = queuedPhoto(h), second = queuedPhoto(h, 'danse.jpg');
  guest.queue = [first, second];
  h.uploadResponses.push({ status: 429, body: { error: 'Quota atteint', code: 'QUOTA_EXCEEDED', remaining: 0 } });
  await h.complete(guest.processQueue());
  assert.equal(h.uploads.length, 1);
  assert.equal(guest.remaining, 0); assert.equal(guest.used, guest.quota);
  for (const entry of guest.queue) {
    assert.equal(entry.status, 'failed'); assert.equal(entry.retryable, false); assert.match(entry.message, /quota/);
  }
  guest.retry(first);
  await flushMicrotasks();
  assert.equal(h.uploads.length, 1, 'Manual retry must also reject a non-retryable quota failure');
});

test('Guest caps automatic network retries at three and retains the failed file', { timeout: 2000 }, async t => {
  const h = browser(t), guest = h.component('guestApp');
  guest.token = h.Wedding.makeId(); guest.remaining = 50;
  const entry = queuedPhoto(h), file = entry.file;
  guest.queue = [entry];
  h.uploadResponses.push(...Array.from({ length: 4 }, () => ({ network: true })));
  await h.complete(guest.processQueue());
  assert.equal(h.uploads.length, 4);
  assert.ok(h.uploads.every(request => request.headers['X-Upload-Id'] === entry.id));
  assert.equal(entry.attempts, 4); assert.equal(entry.status, 'failed');
  assert.equal(entry.retryable, true); assert.equal(entry.file, file);
  assert.equal(guest.processing, false);
});

test('Common storage falls back to memory when localStorage reads and writes throw', t => {
  const h = browser(t, { storageThrows: true });
  assert.equal(h.Wedding.storage.get('missing'), null);
  assert.equal(h.Wedding.storage.available, false);
  h.Wedding.storage.set('wedding.author', 'Élodie');
  h.Wedding.storage.set('wedding.deviceToken', 'in-memory-token');
  assert.equal(h.Wedding.storage.get('wedding.author'), 'Élodie');
  assert.equal(h.Wedding.storage.get('wedding.deviceToken'), 'in-memory-token');
});

test('Guest initializes and reuses its device token and name despite storage exceptions', { timeout: 2000 }, async t => {
  const h = browser(t, { storageThrows: true });
  h.fetchWith((url, options) => {
    if (url === '/api/config') return { body: { eventName: 'Le mariage de Camille et Alex', quota: 50, maxFileBytes: 15728640 } };
    assert.equal(url, '/api/quota'); assert.match(options.headers['X-Device-Token'], uuidPattern);
    return { body: { used: 2, remaining: 48, quota: 50 } };
  });
  const first = h.component('guestApp');
  await first.init(); first.author = 'Élodie'; first.saveAuthor();
  const second = h.component('guestApp');
  await second.init();
  assert.equal(first.ready, true); assert.equal(second.ready, true);
  assert.equal(second.token, first.token); assert.equal(second.author, 'Élodie');
  assert.equal(second.storageUnavailable, true); assert.equal(second.remaining, 48);
});

test('Slideshow removes a hidden current photo immediately, before replacement image loading', { timeout: 2000 }, async t => {
  const h = browser(t, { autoLoadImages: false }), slide = h.component('slideshowApp');
  const a = photo('a'), b = photo('b');
  const verify = fetchSequence(h, [
    { url: '/api/photos?page=1', body: { photos: [a, b], pages: 1, revision: 1 } },
    { url: '/api/photos?page=1', body: { photos: [b], pages: 1, revision: 2 } },
    { url: '/api/photos?page=1', body: { photos: [], pages: 1, revision: 3 } }
  ]);
  await slide.refresh(); h.loadImages(a.thumbnail_url); await flushMicrotasks();
  assert.equal(slide.current.id, 'a'); assert.ok(slide.timer);
  slide.togglePause();
  await slide.refresh();
  assert.equal(slide.current, null, 'The old image cannot remain while its replacement is preloading');
  assert.equal(slide.selectedId, 'b'); assert.equal(slide.imageLoading, true); assert.equal(slide.timer, null);
  h.loadImages(b.thumbnail_url); await flushMicrotasks();
  assert.equal(slide.current.id, 'b'); assert.equal(slide.timer, null, 'Moderation refresh must preserve pause');
  await slide.refresh();
  assert.equal(slide.current, null); assert.equal(slide.selectedId, null); assert.equal(slide.photos.length, 0);
  assert.ok(h.images.every(image => !image.url || image.url.startsWith('/media/thumbnails/')));
  verify();
});

test('Slideshow does not resurrect a removed photo when an old preload finishes', { timeout: 2000 }, async t => {
  const h = browser(t, { autoLoadImages: false }), slide = h.component('slideshowApp');
  const a = photo('a');
  const verify = fetchSequence(h, [
    { url: '/api/photos?page=1', body: { photos: [a], pages: 1, revision: 1 } },
    { url: '/api/photos?page=1', body: { photos: [], pages: 1, revision: 2 } }
  ]);
  await slide.refresh(); assert.equal(slide.imageLoading, true);
  await slide.refresh(); h.loadImages(a.thumbnail_url); await flushMicrotasks();
  assert.equal(slide.current, null); assert.equal(slide.selectedId, null); assert.equal(slide.timer, null);
  verify();
});

test('Slideshow fetches all pages beyond 500 photos without losing their order', { timeout: 2000 }, async t => {
  const h = browser(t), slide = h.component('slideshowApp');
  const album = Array.from({ length: 501 }, (_, index) => photo(`photo-${index}`));
  const verify = fetchSequence(h, [
    { url: '/api/photos?page=1', body: { photos: album.slice(0, 500), pages: 2, revision: 10 } },
    { url: '/api/photos?page=2', body: { photos: album.slice(500), pages: 2, revision: 10 } }
  ]);
  await slide.refresh(); await flushMicrotasks();
  assert.equal(slide.photos.length, 501);
  assert.deepEqual(Array.from(slide.photos, entry => entry.id), album.map(entry => entry.id));
  assert.equal(slide.current.id, album[0].id); assert.equal(slide.error, '');
  assert.equal(h.clock.jobs.get(slide.timer).delay, slide.interval);
  verify();
});

test('Slideshow restarts page one on revision mismatch and discards the partial snapshot', { timeout: 2000 }, async t => {
  const h = browser(t), slide = h.component('slideshowApp');
  const stale = Array.from({ length: 500 }, (_, index) => photo(`stale-${index}`));
  const current = Array.from({ length: 501 }, (_, index) => photo(`current-${index}`));
  const verify = fetchSequence(h, [
    { url: '/api/photos?page=1', body: { photos: stale, pages: 2, revision: 10 } },
    { url: '/api/photos?page=2', body: { photos: [photo('mixed-revision')], pages: 2, revision: 11 } },
    { url: '/api/photos?page=1', body: { photos: current.slice(0, 500), pages: 2, revision: 11 } },
    { url: '/api/photos?page=2', body: { photos: current.slice(500), pages: 2, revision: 11 } }
  ]);
  await slide.refresh(); await flushMicrotasks();
  assert.deepEqual(Array.from(slide.photos, entry => entry.id), current.map(entry => entry.id));
  assert.equal(slide.current.id, 'current-0'); assert.equal(slide.error, '');
  assert.ok(h.images.every(image => !image.url.includes('stale-') && !image.url.includes('mixed-revision')));
  verify();
});

test('Slideshow bounds revision restarts to three and clears a potentially moderated current image', { timeout: 2000 }, async t => {
  const h = browser(t), slide = h.component('slideshowApp');
  slide.photos = [{ ...photo('old'), thumb: '/media/thumbnails/old' }];
  slide.current = slide.photos[0]; slide.selectedId = 'old'; slide.schedule();
  const responses = [];
  for (let revision = 1; revision <= 3; revision++) {
    responses.push(
      { url: '/api/photos?page=1', body: { photos: [photo(`revision-${revision}`)], pages: 2, revision } },
      { url: '/api/photos?page=2', body: { photos: [], pages: 2, revision: revision + 1 } }
    );
  }
  const verify = fetchSequence(h, responses);
  await slide.refresh();
  assert.equal(slide.current, null); assert.equal(slide.selectedId, null); assert.equal(slide.timer, null);
  assert.equal(slide.loading, false); assert.match(slide.error, /L’album évolue rapidement/);
  assert.equal(h.images.length, 0);
  verify();
});

for (const pending of [true, false]) {
  test(`Admin deletion reports ${pending ? 'pending file cleanup' : 'completed permanent deletion'}`, { timeout: 2000 }, async t => {
    const h = browser(t), admin = h.component('adminApp');
    const removed = { ...photo('removed'), original_name: 'danse.jpg' }, survivor = photo('survivor');
    admin.photos = [removed, survivor]; admin.confirmPhoto = removed;
    let closed = 0, focused = 0;
    admin.$refs = {
      deleteDialog: { close() { closed++; } },
      galleryHeading: { focus() { focused++; } }
    };
    const verify = fetchSequence(h, [
      {
        url: '/api/admin/photos/removed', status: pending ? 202 : 200, body: { pending },
        check(options) {
          assert.equal(options.method, 'DELETE');
          assert.equal(options.headers['X-Requested-With'], 'wedding-photo-app');
          assert.equal(options.credentials, 'same-origin');
        }
      },
      { url: '/api/admin/photos?page=1&limit=60', body: { photos: [survivor], page: 1, total: 1, pages: 1 } }
    ]);
    await admin.deletePhoto();
    assert.deepEqual(Array.from(admin.photos, entry => entry.id), ['survivor']);
    assert.equal(admin.confirmPhoto, null); assert.equal(admin.deleting, false); assert.equal(admin.actionError, '');
    assert.equal(closed, 1); assert.equal(focused, 1);
    if (pending) {
      assert.match(admin.notice, /Photo retirée de l’album/);
      assert.match(admin.notice, /suppression des fichiers est en attente/);
      assert.doesNotMatch(admin.notice, /supprimés définitivement/);
    } else {
      assert.match(admin.notice, /supprimés définitivement/);
      assert.doesNotMatch(admin.notice, /en attente/);
    }
    verify();
  });
}
