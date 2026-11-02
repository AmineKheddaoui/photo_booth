/* Shared local-only API and live-update helpers. */
(() => {
  'use strict';
  const makeId = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const memory = new Map();
  const storage = {
    available: true,
    get(key) {
      try { return localStorage.getItem(key) ?? memory.get(key) ?? null; }
      catch { this.available = false; return memory.get(key) ?? null; }
    },
    set(key, value) {
      memory.set(key, value);
      try { localStorage.setItem(key, value); }
      catch { this.available = false; }
    }
  };
  function retryDelay(header, attempt) {
    if (header) {
      const seconds = Number(header);
      const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.max(500, milliseconds);
    }
    return Math.min(1000 * (2 ** attempt), 8000) + Math.floor(Math.random() * 400);
  }
  async function api(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) {
        const error = new Error(data.error || `Le serveur a répondu avec une erreur (${response.status}).`);
        Object.assign(error, { status: response.status, code: data.code, remaining: data.remaining });
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Le serveur met trop de temps à répondre. Réessayez.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function localImage(url) {
    if (typeof url !== 'string') return '';
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin || !/^\/(media\/thumbnails|api\/admin\/thumbnails)\//.test(parsed.pathname)) return '';
      return parsed.pathname + parsed.search;
    } catch { return ''; }
  }
  // Polling remains active even when SSE is connected, recovering missed events.
  function watchPhotos(refresh) {
    let source = null;
    let timer = null;
    let stopped = false;
    let running = false;
    let pending = false;
    const run = async () => {
      if (stopped) return;
      if (running) { pending = true; return; }
      running = true;
      try { await refresh(); } catch { /* The page owns its error state. */ }
      finally {
        running = false;
        if (pending && !stopped) { pending = false; run(); }
      }
    };
    const start = () => {
      stopped = false;
      if (!timer) timer = setInterval(run, 15000);
      if (!source && 'EventSource' in window) {
        source = new EventSource('/api/events');
        source.addEventListener('photos', run);
        source.addEventListener('open', run);
      }
    };
    const suspend = () => {
      stopped = true;
      pending = false;
      clearInterval(timer);
      timer = null;
      if (source) source.close();
      source = null;
    };
    const resume = event => { if (event.persisted) { start(); run(); } };
    const visible = () => { if (!document.hidden) run(); };
    start();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
    return () => {
      suspend();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('pageshow', resume);
    };
  }
  window.Wedding = {
    api, makeId, storage, retryDelay, localImage, watchPhotos,
    bytes(value) {
      const n = Number(value) || 0;
      return n < 1048576 ? `${Math.ceil(n / 1024)} Ko` : `${(n / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
    },
    date(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? 'Date inconnue' : date.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
  };
})();
