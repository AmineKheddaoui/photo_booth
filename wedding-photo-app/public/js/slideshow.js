(() => {
  'use strict';
  const W = window.Wedding;
  document.addEventListener('alpine:init', () => {
    Alpine.data('slideshowApp', () => ({
      eventName: 'Nos souvenirs de mariage', photos: [], current: null, selectedId: null,
      interval: 7000, paused: false, loading: true, imageLoading: false, error: '', fullscreenError: '',
      fullscreen: false, timer: null, stopWatching: null, selectionVersion: 0, disposed: false, preloadJobs: [],
      async init() {
        this.onKey = event => this.handleKey(event);
        this.onFullscreen = () => { this.fullscreen = Boolean(document.fullscreenElement); };
        this.onHide = () => {
                  clearTimeout(this.timer); this.timer = null;
                  this.selectionVersion++;
                  this.preloadJobs.slice().forEach(cancel => cancel());
                  this.imageLoading = false;
                  this.selectedId = this.current ? this.current.id : null;
                };
        this.onShow = event => { if (event.persisted) this.schedule(); };
        this.onVisibility = () => { if (document.hidden) this.onHide(); else this.schedule(); };
        window.addEventListener('keydown', this.onKey);
        document.addEventListener('fullscreenchange', this.onFullscreen);
        document.addEventListener('visibilitychange', this.onVisibility);
        window.addEventListener('pagehide', this.onHide);
        window.addEventListener('pageshow', this.onShow);
        try {
          const config = await W.api('/api/config');
          if (this.disposed) return;
          this.eventName = config.eventName || this.eventName;
          this.interval = Math.max(1000, Number(config.slideshowInterval) || 7000);
        } catch { this.error = 'Les réglages sont indisponibles. Rotation réglée à 7 secondes.'; }
        await this.refresh();
        if (!this.disposed) this.stopWatching = W.watchPhotos(() => this.refresh());
      },
      destroy() {
        this.disposed = true; this.selectionVersion++;
        clearTimeout(this.timer);
        this.preloadJobs.slice().forEach(cancel => cancel());
        if (this.stopWatching) this.stopWatching();
        window.removeEventListener('keydown', this.onKey);
        document.removeEventListener('fullscreenchange', this.onFullscreen);
        document.removeEventListener('visibilitychange', this.onVisibility);
        window.removeEventListener('pagehide', this.onHide);
        window.removeEventListener('pageshow', this.onShow);
      },
      async refresh() {
        try {
          let page = 1;
          let data;
          let collection;
          // A revision mismatch means moderation changed during pagination: restart the snapshot.
          for (let attempt = 0; attempt < 3; attempt++) {
            page = 1; collection = []; data = null;
            const first = await W.api('/api/photos?page=1');
            const revision = first.revision;
            collection.push(...(first.photos || []));
            let changed = false;
            while (page < first.pages) {
              data = await W.api(`/api/photos?page=${++page}`);
              if (this.disposed) return;
              if (data.revision !== revision) { changed = true; break; }
              collection.push(...(data.photos || []));
            }
            if (!changed) break;
            if (attempt === 2) throw new Error('L’album évolue rapidement, nouvelle tentative au prochain cycle.');
          }
          if (this.disposed) return;
          this.photos = collection.map(photo => ({ ...photo, thumb: W.localImage(photo.thumbnail_url) })).filter(photo => photo.thumb);
          this.error = '';
          // Never leave a newly hidden/deleted photo on screen until the next rotation.
          if (this.current && !this.photos.some(photo => photo.id === this.current.id)) this.current = null;
          if (!this.photos.length) {
            this.selectionVersion++; this.selectedId = null; this.current = null; this.imageLoading = false;
            clearTimeout(this.timer); this.timer = null;
          } else if (!this.selectedId || !this.photos.some(photo => photo.id === this.selectedId)) {
            this.current = null;
            this.showPhoto(this.photos[0]);
          } else if (this.current) {
            const updated = this.photos.find(photo => photo.id === this.current.id);
            if (updated) this.current = updated;
          }
        } catch (error) {
          this.error = 'Synchronisation interrompue. Nouvelle vérification automatique dans quelques instants. ' + error.message;
          // With no reliable visibility information, avoid showing a potentially moderated photo.
          this.selectionVersion++; this.current = null; this.selectedId = null; this.imageLoading = false;
          clearTimeout(this.timer); this.timer = null;
        } finally { this.loading = false; }
      },
      async showPhoto(photo) {
        if (!photo || this.disposed) return;
        clearTimeout(this.timer); this.timer = null;
        const version = ++this.selectionVersion;
        this.selectedId = photo.id; this.imageLoading = true;
        const loaded = await this.preload(photo.thumb);
        if (version !== this.selectionVersion || this.disposed) return;
        this.imageLoading = false;
        const latest = this.photos.find(entry => entry.id === photo.id);
        if (!latest) return;
        if (loaded) {
          this.current = latest;
          this.error = '';
          this.preloadNext();
        } else {
          this.current = null;
          this.error = 'Cette miniature est indisponible. La lecture continue avec les autres souvenirs.';
        }
        this.schedule();
      },
      preload(url) {
        return new Promise(resolve => {
          const image = new Image();
          let done = false;
          const finish = ok => {
            if (done) return;
            done = true; clearTimeout(timeout); image.onload = null; image.onerror = null;
            this.preloadJobs = this.preloadJobs.filter(job => job !== cancel);
            if (!ok) image.removeAttribute('src');
            resolve(ok);
          };
          const cancel = () => finish(false);
          this.preloadJobs.push(cancel);
          const timeout = setTimeout(cancel, 15000);
          image.onload = () => finish(true);
          image.onerror = () => finish(false);
          image.src = url;
        });
      },
      preloadNext() {
        if (this.photos.length < 2) return;
        const index = this.photos.findIndex(photo => photo.id === this.selectedId);
        const next = this.photos[(index + 1) % this.photos.length];
        if (next) this.preload(next.thumb);
      },
      schedule() {
        clearTimeout(this.timer); this.timer = null;
        if (this.paused || this.disposed || document.hidden || !this.photos.length || this.imageLoading || !this.selectedId) return;
        this.timer = setTimeout(() => this.advance(1), this.interval);
      },
      advance(direction) {
        if (!this.photos.length) return;
        const index = this.photos.findIndex(photo => photo.id === this.selectedId);
        const next = (Math.max(0, index) + direction + this.photos.length) % this.photos.length;
        this.showPhoto(this.photos[next]);
      },
      togglePause() { this.paused = !this.paused; this.schedule(); },
      async toggleFullscreen() {
        this.fullscreenError = '';
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
          else this.fullscreenError = 'Le plein écran n’est pas disponible dans ce navigateur.';
        } catch { this.fullscreenError = 'Le navigateur n’a pas autorisé le plein écran. Réessayez avec le bouton.'; }
      },
      handleKey(event) {
        if (event.altKey || event.ctrlKey || event.metaKey || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName)) return;
        if (event.key === 'ArrowRight') { event.preventDefault(); this.advance(1); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); this.advance(-1); }
        else if (event.key === ' ') { event.preventDefault(); this.togglePause(); }
        else if (event.key.toLowerCase() === 'f') { event.preventDefault(); this.toggleFullscreen(); }
      },
      get position() {
        const index = this.photos.findIndex(photo => photo.id === (this.current ? this.current.id : this.selectedId));
        return index < 0 ? 0 : index + 1;
      }
    }));
  });
})();
