(() => {
  'use strict';
  const W = window.Wedding;
  document.addEventListener('alpine:init', () => {
    Alpine.data('adminApp', () => ({
      eventName: 'Nos souvenirs de mariage', publicUrl: '', photos: [], page: 1, pages: 1, total: 0,
      loading: true, loadError: '', actionError: '', notice: '', busyIds: [], confirmPhoto: null,
      deleting: false, lastUpdated: '', infoError: '', stopWatching: null, loadVersion: 0, disposed: false,
      async init() {
        await Promise.all([this.loadInfo(), this.loadPhotos()]);
        if (!this.disposed) this.stopWatching = W.watchPhotos(() => this.loadPhotos(false));
      },
      destroy() { this.disposed = true; if (this.stopWatching) this.stopWatching(); this.loadVersion++; },
      async loadInfo() {
        this.infoError = '';
        try {
          const info = await W.api('/api/admin/info');
          this.eventName = info.eventName || this.eventName;
          // The public URL is displayed as text, never fetched from the browser.
          this.publicUrl = info.publicUrl || '';
        } catch (error) { this.infoError = 'Les informations de partage sont indisponibles. ' + error.message; }
      },
      async loadPhotos(showLoading = true) {
        const version = ++this.loadVersion;
        if (showLoading) this.loading = true;
        try {
          let data = await W.api(`/api/admin/photos?page=${this.page}&limit=60`);
          if (version !== this.loadVersion) return;
          if (this.page > Math.max(1, data.pages || 1)) {
            this.page = Math.max(1, data.pages || 1);
            data = await W.api(`/api/admin/photos?page=${this.page}&limit=60`);
            if (version !== this.loadVersion) return;
          }
          this.photos = (data.photos || []).map(photo => ({ ...photo, thumb: W.localImage(photo.thumbnail_url), imageFailed: false }));
          this.total = Number(data.total) || 0;
          this.pages = Math.max(1, Number(data.pages) || 1);
          this.page = Number(data.page) || this.page;
          this.lastUpdated = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          this.loadError = '';
        } catch (error) {
          if (version === this.loadVersion) this.loadError = 'Impossible d’actualiser les photos. ' + error.message;
        } finally { if (version === this.loadVersion) this.loading = false; }
      },
      goTo(page) {
        if (this.loading || page < 1 || page > this.pages) return;
        this.page = page;
        this.loadPhotos();
        this.$nextTick(() => this.$refs.galleryHeading.focus());
      },
      isBusy(photo) { return this.busyIds.includes(photo.id); },
      originalUrl(photo) { return `/api/admin/originals/${encodeURIComponent(photo.id)}`; },
      async toggleVisibility(photo) {
        if (this.isBusy(photo)) return;
        this.busyIds.push(photo.id); this.actionError = ''; this.notice = '';
        const hidden = !photo.is_hidden;
        try {
          await W.api(`/api/admin/photos/${encodeURIComponent(photo.id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wedding-photo-app' },
            body: JSON.stringify({ is_hidden: hidden })
          });
          photo.is_hidden = hidden;
          this.notice = hidden ? 'Photo masquée : elle n’apparaît plus dans le diaporama. L’original reste conservé.' : 'Photo publiée : elle est à nouveau visible dans le diaporama.';
          await this.loadPhotos(false);
        } catch (error) { this.actionError = 'La visibilité n’a pas pu être modifiée. ' + error.message; }
        finally { this.busyIds = this.busyIds.filter(id => id !== photo.id); }
      },
      openDelete(photo, event) {
        this.returnFocus = event.currentTarget;
        this.confirmPhoto = photo;
        this.$nextTick(() => { this.$refs.deleteDialog.showModal(); this.$refs.cancelDelete.focus(); });
      },
      closeDelete() {
        if (this.deleting) return;
        this.$refs.deleteDialog.close();
        this.confirmPhoto = null;
        if (this.returnFocus && this.returnFocus.isConnected) this.returnFocus.focus();
        else this.$refs.galleryHeading.focus();
      },
      cancelDialog(event) { event.preventDefault(); this.closeDelete(); },
      async deletePhoto() {
        if (!this.confirmPhoto || this.deleting) return;
        this.deleting = true; this.actionError = ''; this.notice = '';
        try {
          const result = await W.api(`/api/admin/photos/${encodeURIComponent(this.confirmPhoto.id)}`, {
            method: 'DELETE', headers: { 'X-Requested-With': 'wedding-photo-app' }
          });
          this.photos = this.photos.filter(photo => photo.id !== this.confirmPhoto.id);
          this.notice = result.pending ? 'Photo retirée de l’album. La suppression des fichiers est en attente (export en cours ou stockage temporairement indisponible).' : 'La photo et son original ont été supprimés définitivement.';
          this.deleting = false;
          this.closeDelete();
          await this.loadPhotos(false);
        } catch (error) {
          this.actionError = 'La suppression n’a pas abouti. ' + error.message;
          this.deleting = false;
          this.closeDelete();
        } finally { this.deleting = false; }
      },
      printQr() { window.print(); },
      formatDate(value) { return W.date(value); },
      formatBytes(value) { return W.bytes(value); }
    }));
  });
})();
