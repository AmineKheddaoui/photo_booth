(() => {
  'use strict';
  const W = window.Wedding;
  const LIMIT = 15 * 1024 * 1024;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function inspectFormat(file) {
    const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
    const text = (start, count) => String.fromCharCode(...bytes.slice(start, start + count));
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return true;
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return true;
    if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return true;
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return true;
    if (bytes.length >= 4 && ((text(0, 2) === 'II' && bytes[2] === 42 && bytes[3] === 0) || (text(0, 2) === 'MM' && bytes[2] === 0 && bytes[3] === 42))) return true;
    if (text(4, 4) === 'ftyp' && bytes.length >= 16) {
      const boxSize = new DataView(bytes.buffer).getUint32(0);
      const brands = [text(8, 4)];
      for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.length); offset += 4) brands.push(text(offset, 4));
      if (brands.includes('avif') || brands.includes('avis')) return true;
      if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))) {
        throw new Error('Le format HEIC / HEIF n’est pas pris en charge. Exportez cette photo en JPEG ou choisissez « Le plus compatible » dans les réglages de votre appareil.');
      }
    }
    if (/\.hei[cf]$/i.test(file.name)) throw new Error('Le format HEIC / HEIF n’est pas pris en charge. Convertissez votre photo en JPEG avant de l’envoyer.');
    throw new Error('Format non pris en charge. Choisissez une photo JPEG, PNG, WEBP, GIF, AVIF ou TIFF.');
  }
  function upload(file, token, uploadId, author, progress, track) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      track(xhr);
      xhr.open('POST', '/api/photos');
      xhr.timeout = 120000;
      xhr.setRequestHeader('X-Device-Token', token);
      xhr.setRequestHeader('X-Upload-Id', uploadId);
      xhr.upload.addEventListener('progress', event => {
        if (event.lengthComputable) progress(Math.min(99, Math.round(event.loaded / event.total * 100)));
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* Handled as an API error below. */ }
        if ((xhr.status === 200 || xhr.status === 201) && data.id) { resolve(data); return; }
        const error = new Error(data.error || 'L’envoi n’a pas abouti. Réessayez dans quelques instants.');
        Object.assign(error, { status: xhr.status, code: data.code, remaining: data.remaining, retryAfter: xhr.getResponseHeader('Retry-After') });
        reject(error);
      });
      const networkError = () => reject(Object.assign(new Error('Connexion interrompue. Vérifiez votre réseau puis réessayez.'), { status: 0 }));
      xhr.addEventListener('error', networkError);
      xhr.addEventListener('timeout', networkError);
      xhr.addEventListener('abort', () => reject(Object.assign(new Error('Envoi interrompu.'), { status: 0, aborted: true })));
      const form = new FormData();
      form.append('photo', file, file.name);
      if (author) form.append('author', author);
      xhr.send(form);
    });
  }
  document.addEventListener('alpine:init', () => {
    Alpine.data('guestApp', () => ({
      eventName: 'Nos souvenirs de mariage', author: '', token: '', storageUnavailable: false,
      quota: 50, remaining: null, used: 0, maxBytes: LIMIT, ready: false, loading: true,
      error: '', notice: '', queue: [], processing: false, checking: false, activeXhr: null, disposed: false,
      async init() {
        let token = W.storage.get('wedding.deviceToken');
        if (!uuidPattern.test(token || '')) token = W.makeId();
        W.storage.set('wedding.deviceToken', token);
        this.token = token;
        this.author = (W.storage.get('wedding.author') || '').slice(0, 80);
        this.storageUnavailable = !W.storage.available;
        this.onOnline = () => this.refreshQuota();
        this.onBeforeUnload = event => {
          if (this.processing || this.checking || this.queue.some(item => item.file && item.status !== 'success')) {
            event.preventDefault(); event.returnValue = '';
          }
        };
        window.addEventListener('online', this.onOnline);
        window.addEventListener('beforeunload', this.onBeforeUnload);
        await this.loadSettings();
      },
      destroy() {
        this.disposed = true;
        if (this.activeXhr) this.activeXhr.abort();
        window.removeEventListener('online', this.onOnline);
        window.removeEventListener('beforeunload', this.onBeforeUnload);
      },
      saveAuthor() {
        this.author = this.author.slice(0, 80);
        W.storage.set('wedding.author', this.author);
        this.storageUnavailable = !W.storage.available;
      },
      async loadSettings() {
        this.loading = true;
        this.error = '';
        try {
          const config = await W.api('/api/config');
          this.eventName = config.eventName || this.eventName;
          this.quota = Number(config.quota) || 50;
          this.maxBytes = Math.min(LIMIT, Number(config.maxFileBytes) || LIMIT);
          await this.refreshQuota(true);
          this.ready = true;
        } catch (error) { this.error = 'Impossible de préparer l’envoi. ' + error.message; }
        finally { this.loading = false; }
      },
      async refreshQuota(throwOnError = false) {
        try {
          const data = await W.api('/api/quota', { headers: { 'X-Device-Token': this.token } });
          this.remaining = Math.max(0, Number(data.remaining));
          this.used = Number(data.used) || 0;
          this.quota = Number(data.quota) || this.quota;
          this.error = '';
        } catch (error) {
          if (throwOnError) throw error;
          this.error = 'Le nombre de photos restantes n’a pas pu être actualisé. ' + error.message;
        }
      },
      get completed() { return this.queue.filter(item => item.status === 'success').length; },
      get pending() { return this.queue.filter(item => ['queued', 'uploading', 'retrying'].includes(item.status)).length; },
      get quotaPercent() { return Math.min(100, Math.max(0, this.used / this.quota * 100)); },
      async selectFiles(event) {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!this.ready || !files.length) return;
        this.checking = true;
        this.notice = '';
        try {
          for (const file of files) {
            if (this.disposed) return;
            const item = { id: W.makeId(), file, name: file.name, size: W.bytes(file.size), author: this.author.trim().slice(0, 80), status: 'checking', progress: 0, message: 'Vérification du format…', retryable: false, attempts: 0 };
            this.queue.push(item);
            // Read the reactive item back so asynchronous updates are observable by Alpine.
            const entry = this.queue[this.queue.length - 1];
            try {
              if (!file.size) throw new Error('Cette photo est vide. Choisissez un autre fichier.');
              if (file.size > this.maxBytes) throw new Error(`Cette photo dépasse la limite de ${W.bytes(this.maxBytes)}. Réduisez sa taille avant de l’envoyer.`);
              await inspectFormat(file);
              entry.status = 'queued';
              entry.message = 'En attente';
            } catch (error) {
              entry.status = 'failed'; entry.message = error.message; entry.file = null;
            }
          }
        } finally { this.checking = false; }
        this.processQueue();
      },
      async processQueue() {
        if (this.processing || this.disposed) return;
        this.processing = true;
        try {
          let item;
          while (!this.disposed && (item = this.queue.find(entry => entry.status === 'queued'))) {
            // An attempted upload may already be saved despite a lost response.
            // Let its stable upload ID resolve a duplicate even when the quota is now zero.
            if (this.remaining === 0 && item.attempts === 0) {
              item.status = 'failed'; item.message = 'Votre quota est atteint. Cette photo n’a pas été envoyée.'; item.retryable = false;
              continue;
            }
            let finished = false;
            for (let attempt = 0; attempt <= 3 && !finished && !this.disposed; attempt++) {
              item.status = 'uploading'; item.progress = 0; item.message = 'Envoi en cours…'; item.attempts = attempt + 1;
              try {
                const data = await upload(item.file, this.token, item.id, item.author,
                  percent => { item.progress = percent; if (percent === 99) item.message = 'Traitement de la photo…'; },
                  xhr => { this.activeXhr = xhr; });
                this.remaining = Math.max(0, Number(data.remaining));
                this.quota = Number(data.quota) || this.quota;
                this.used = this.quota - this.remaining;
                item.status = 'success'; item.progress = 100;
                item.message = data.duplicate ? 'Photo déjà reçue : aucun nouvel envoi décompté.' : 'Photo reçue, merci pour ce souvenir !';
                item.file = null; item.retryable = false; finished = true;
              } catch (error) {
                if (this.disposed || error.aborted) break;
                if (Number.isFinite(error.remaining)) {
                  this.remaining = Math.max(0, error.remaining); this.used = this.quota - this.remaining;
                }
                const quotaExceeded = error.code === 'QUOTA_EXCEEDED';
                const transient = !quotaExceeded && (error.status === 0 || error.status >= 500 || ['RATE_LIMITED', 'BUSY'].includes(error.code));
                if (quotaExceeded) {
                  this.remaining = 0; this.used = this.quota;
                  item.message = 'Votre quota est atteint. Cette photo n’a pas été envoyée.';
                } else if (transient && attempt < 3) {
                  const delay = W.retryDelay(error.retryAfter, attempt);
                  item.status = 'retrying';
                  item.message = `${['RATE_LIMITED', 'BUSY'].includes(error.code) || error.status === 503 ? 'Le service est très sollicité.' : 'Connexion momentanément indisponible.'} Nouvelle tentative ${attempt + 1}/3 dans ${Math.ceil(delay / 1000)} s…`;
                  // Small sleeps let page teardown interrupt even a long Retry-After.
                  const until = Date.now() + delay;
                  while (!this.disposed && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
                  continue;
                } else { item.message = error.message; }
                item.status = 'failed'; item.retryable = transient; finished = true;
              } finally { this.activeXhr = null; }
            }
          }
        } finally {
          this.processing = false;
          if (!this.disposed && this.completed > 0) this.notice = 'Vos souvenirs sont bien enregistrés. Vous pouvez ajouter d’autres photos ou profiter de la fête.';
        }
      },
      retry(item) {
        if (!item.retryable || !item.file) return;
        item.status = 'queued'; item.message = 'En attente'; item.retryable = false;
        this.processQueue();
      },
      remove(item) {
        if (['uploading', 'retrying', 'checking'].includes(item.status)) return;
        this.queue = this.queue.filter(entry => entry.id !== item.id);
      },
      statusLabel(status) {
        return { checking: 'Vérification', queued: 'En attente', uploading: 'Envoi', retrying: 'Nouvelle tentative', success: 'Reçue', failed: 'Non envoyée' }[status];
      }
    }));
  });
})();
