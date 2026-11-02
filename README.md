# photo_booth

Application auto-hébergée de collecte de photos de mariage : dépôt mobile sans compte, administration protégée, QR code imprimable, diaporama live et export ZIP.

Le code complet et les instructions de lancement sont dans [`wedding-photo-app/README.md`](wedding-photo-app/README.md).

Depuis `wedding-photo-app`, configurez `.env` à partir de `.env.example`, puis lancez :

```sh
docker-compose up -d --build
```

Le mot de passe administrateur et l’URL publique doivent être configurés avant le démarrage.