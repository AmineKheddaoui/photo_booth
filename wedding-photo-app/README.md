# Album photo de mariage

Application Express sous Node.js 24 : dépôt de photos par les invités, galerie, diaporama, administration et export. Tailwind CSS 3 est compilé localement ; Alpine.js est servi localement depuis `node_modules/alpinejs/dist/cdn.min.js`, sans CDN externe. Le QR code de partage peut être téléchargé en SVG pour impression.

## Structure du projet

Le code applicatif, les interfaces et les tests sont inclus :

```text
wedding-photo-app/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── README.md
├── package.json
├── package-lock.json
├── server.js
├── public/                 # HTML, JavaScript et CSS compilé
├── tailwind.config.js
├── test/                   # tests backend et interfaces
├── uploads/                # originaux ; emplacement local par défaut
├── thumbnails/             # miniatures ; emplacement local par défaut
└── data.db                 # créé à l'exécution ; jamais versionné
```

`npm start` lance le serveur ; `npm run build:css` compile Tailwind 3 depuis les sources `public/**/*.html` et `public/js/**/*.js`. `server.js` expose `createApp` et `startServer` et fournit `GET /healthz`. L’application initialise SQLite automatiquement. Dans Docker, `DATA_DIR=/app/storage` déplace ensemble `uploads/`, `thumbnails/` et `data.db` dans le volume persistant ; le développement documenté ci-dessous utilise `./storage`.

## Démarrage avec Docker Compose

Prérequis : Docker et Docker Compose (plugin `docker compose` ou commande compatible `docker-compose`). Toutes les commandes ci-dessous se lancent **depuis `wedding-photo-app`**.

1. Copiez le modèle de configuration :

   ```sh
   cp .env.example .env
   ```

   Sous Windows PowerShell :

   ```powershell
   Copy-Item .env.example .env
   ```

2. Générez un secret administrateur unique :

   ```sh
   openssl rand -hex 24
   ```

   Si OpenSSL n'est pas installé, Node.js permet aussi de générer 48 caractères hexadécimaux :

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
   ```

   Collez le résultat dans `ADMIN_PASSWORD` du fichier `.env`. Conservez-le dans un gestionnaire de mots de passe. `CHANGE_ME` n'est pas un mot de passe utilisable : le serveur le rejette. Ne partagez et ne versionnez jamais `.env`.

3. Pour un essai sur cette machine, conservez `PUBLIC_URL=http://localhost:3000`, `HOST_BIND=127.0.0.1` et `TRUST_PROXY=0`.

4. Construisez et démarrez :

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

   Équivalent avec la commande à trait d'union :

   ```sh
   docker-compose up -d --build
   ```

5. Ouvrez <http://localhost:3000>. Le contrôle de santé appelle `/healthz` avec `fetch` de Node.js et un délai de 3 secondes ; aucune installation de `curl` n'est nécessaire.

Le fichier `.env` sert à **l'interpolation Compose**. Les variables applicatives sont transmises explicitement par `environment` ; aucun `env_file` n'est nécessaire. Des variables déjà exportées dans votre terminal peuvent prendre priorité sur `.env`. `docker compose config` permet d'inspecter la configuration, mais affiche aussi le secret : ne publiez pas sa sortie.

### Configuration

| Variable | Valeur / rôle |
| --- | --- |
| `ADMIN_USER` | Identifiant administrateur, `admin` par défaut. |
| `ADMIN_PASSWORD` | Secret obligatoire d'au moins 16 caractères ; utilisez le générateur ci-dessus. |
| `PUBLIC_URL` | URL publique canonique, obligatoire en production ; exemple réel : `https://photos.example.com`. |
| `EVENT_NAME` | Nom facultatif de l'événement. |
| `SLIDESHOW_INTERVAL_MS` | Intervalle du diaporama en millisecondes, `7000` par défaut. |
| `TRUST_PROXY` | Confiance dans le proxy désactivée par défaut (`0`) ; `1` seulement derrière exactement un proxy de confiance. |
| `HOST_BIND` | Adresse de publication Docker, `127.0.0.1` par défaut ; ce n'est pas l'adresse d'écoute interne Express. |
| `PORT` | Port applicatif, `3000` par défaut ; fixé à `3000` dans Compose pour correspondre au mapping et au contrôle de santé. |
| `DATA_DIR` | Racine persistante : `/app/storage` dans Docker ; sans configuration, le serveur utilise son chemin local au projet. |

Compose refuse un `ADMIN_PASSWORD` ou un `PUBLIC_URL` vide/manquant. Le serveur arrête également son démarrage en production si le mot de passe n'est pas suffisamment fort ou si l'URL publique est absente/invalide. Le HTTP sur `localhost` est accepté pour l'exemple local ; ce n'est pas un déploiement Internet sécurisé.

Pour un accès temporaire sur le réseau local, choisissez l'IP locale du serveur pour `HOST_BIND` (ou `0.0.0.0` pour toutes les interfaces) et une `PUBLIC_URL` accessible aux téléphones. Autorisez le port dans le pare-feu uniquement sur le réseau voulu. Ne définissez pas `TRUST_PROXY=1` pour un accès direct. Sur un réseau non fiable, utilisez HTTPS ; HTTP expose notamment les identifiants administrateur en transit.

## HTTPS et reverse proxy

Pour un déploiement réel, utilisez un reverse proxy externe, par exemple Caddy ou Nginx. Aucun proxy n'est inclus comme service Compose. Configurez DNS, certificats et pare-feu, puis définissez :

```dotenv
PUBLIC_URL=https://photos.example.com
HOST_BIND=127.0.0.1
TRUST_PROXY=1
```

Exemple de Caddyfile pour **Caddy installé sur le même hôte**, avec DNS pointant vers ce serveur et ports 80/443 disponibles :

```caddyfile
photos.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

La limite de taille du proxy doit permettre les envois de 15 MiB, plus l'enveloppe multipart. Sous Nginx, configurez notamment `client_max_body_size 16m;` et transmettez correctement `Host`, `X-Forwarded-For` et `X-Forwarded-Proto`. Adaptez aussi les délais à la connexion des invités.

**`TRUST_PROXY=1` n'est sûr que si chaque requête traverse exactement un proxy de confiance.** L'accès direct au backend doit rester bloqué et le proxy doit normaliser les en-têtes transmis. Sinon un client peut falsifier `X-Forwarded-Host`, `X-Forwarded-Proto` ou l'adresse d'origine. Avec plusieurs relais, ne supposez pas que cette configuration convient. `PUBLIC_URL` est prioritaire pour les liens publics et le QR code : fournissez une URL canonique fiable plutôt que de dépendre des en-têtes de requête.

Si Caddy tourne lui-même dans un conteneur externe, son `127.0.0.1` ne désigne pas le conteneur applicatif : configurez explicitement leur connectivité, sans exposer directement le backend à Internet.

## Image, droits et stockage

La construction multi-stage utilise `node:24-bookworm-slim` :

- étape de compilation : `npm ci`, puis `npm run build:css` ;
- étape des dépendances d'exécution : `npm ci --omit=dev` ;
- image finale : dépendances de production (dont Alpine.js), `public/` compilé, `server.js` et `package*.json` ; lancement avec `npm start`.

Le processus s'exécute comme utilisateur non-root `node` (UID 1000). Le système de fichiers du conteneur est en lecture seule, avec un `/tmp` temporaire de 128 MiB. Toutes les écritures persistantes restent sous `DATA_DIR` ; `/tmp` n'est pas un emplacement de sauvegarde.

Le volume nommé `wedding_data` est monté sur `/app/storage`. Compose préfixe normalement son nom réel par celui du projet. À sa première création, Docker initialise le volume depuis le répertoire de l'image, dont le propriétaire est UID 1000 ; les photos, miniatures et `data.db` sont donc accessibles en écriture à `node`. Un volume existant ou un bind mount conserve ses propres permissions : assurez-vous alors que l'UID 1000 peut y écrire. Ne contournez pas un problème de droits en lançant le serveur comme root.

Compose active `init`, `restart: unless-stopped`, supprime toutes les capabilities et impose `no-new-privileges`. Le délai d’arrêt Docker est de 30 secondes, supérieur à la limite applicative de 25 secondes. La mémoire est limitée à **1 GiB**, plutôt qu'à 512 MiB, pour laisser une marge aux quatre traitements Sharp concurrents. Ce n'est pas une garantie contre un dépassement avec de grandes images décodées : surveillez la mémoire et adaptez `mem_limit` au serveur et à la charge. Un état `unhealthy` n'entraîne pas à lui seul un redémarrage Docker ; surveillez aussi la santé du service.

### Sauvegarde cohérente

SQLite utilise WAL : copier uniquement `data.db` pendant que le serveur écrit n'est pas une sauvegarde fiable. Pour sauvegarder **ensemble** base, originaux et miniatures, arrêtez l'application et copiez tout le stockage dans un dossier neuf :

```sh
docker compose stop app
docker compose cp app:/app/storage ./backup-storage
docker compose start app
```

`docker compose cp` peut copier depuis un conteneur arrêté. Choisissez un nouveau nom de destination pour chaque sauvegarde, vérifiez son contenu et testez une restauration. Ne réutilisez pas silencieusement un ancien dossier de sauvegarde. Protégez ces copies : elles contiennent des photos privées et des métadonnées.

Pour une sauvegarde SQLite à chaud, utilisez l'API de sauvegarde SQLite ou la commande `.backup` d'un outil SQLite adapté, pas une simple copie du fichier. Cela rend la **base** cohérente, mais ne fige pas les fichiers photo : il faut également coordonner les dépôts/suppressions pour obtenir un ensemble cohérent. Le client SQLite n'est pas installé dans l'image minimale.

Pour restaurer, arrêtez l'application, remplacez le contenu du volume par la sauvegarde complète avec les droits UID 1000, puis redémarrez et vérifiez galerie et administration. Une copie des fichiers de déploiement seule ne sauvegarde pas les photos.

```sh
docker compose down
```

Cette commande conserve normalement le volume. **`docker compose down -v` détruit le volume et donc les photos, miniatures et la base de données.** Ne l'utilisez pas pour une mise à jour. Pour reconstruire après modification du code, utilisez `docker compose up -d --build` en conservant le même projet Compose.

## Utilisation et limites

- Un dépôt accepte **une seule image**, au maximum **15 MiB** et **40 mégapixels**. Sharp valide et décode le contenu, indépendamment du nom de fichier. JPEG, PNG, WebP, GIF, AVIF et TIFF sont acceptés ; HEIC et SVG ne le sont pas. Pour les images animées/multipages, la miniature reprend la première image ; l’original reste intact.
- Les miniatures WebP sont limitées à 1200 × 1200 pixels, avec correction de l’orientation et sans métadonnées. Les interfaces n’utilisent aucun CDN, aucune police externe ni bundler.
- La page `/` propose appareil photo et galerie ; `/admin` utilise une authentification HTTP Basic ; `/slideshow` est public. Le diaporama suit l’intégralité des photos visibles via pagination, SSE et polling de secours toutes les 15 secondes.
- Les requêtes de dépôt utilisent les en-têtes `X-Device-Token` et `X-Upload-Id`. Le client conserve son jeton d'appareil et réutilise le même identifiant de dépôt pour les nouvelles tentatives de la **même** soumission : les retries sont idempotents. Une autre photo doit recevoir un autre identifiant de dépôt.
- Le quota est de **50 dépôts par jeton d'appareil**. Le compteur est monotone : supprimer une photo ne restitue pas de quota. Un retry idempotent ne crée pas de seconde photo ni ne consomme un second dépôt. Les reçus restent en base après suppression : une réponse perdue puis rejouée n’annule pas la modération.
- Un jeton n'est **pas une identité**. Un invité peut effacer son `localStorage` ou changer de navigateur et recommencer avec un nouveau jeton. Ce mécanisme limite l'usage courant, sans fournir d'antifraude forte.
- Les photos masquées par l’administration ne sont plus servies publiquement ; les originaux sont **toujours réservés à l’administration**. L’export inclut les photos masquées. Une miniature déjà vue peut toutefois avoir été enregistrée par un visiteur : masquer ne permet pas de révoquer une copie existante.
- L’export ZIP est produit à la volée, sans archive temporaire, avec un seul fichier source ouvert par export. Il fige la liste des originaux existants ; une suppression concurrente retire immédiatement la photo de l’album, mais attend la fin des exports utilisant ce fichier pour l’effacer physiquement. Les échecs de suppression sont enregistrés en base et réessayés toutes les 30 secondes et au démarrage. L’interface signale les suppressions en attente. Une archive photo ne remplace pas la sauvegarde complète du stockage et de la base.
- Un seul processus applicatif doit utiliser le volume : pas de réplication de conteneurs sur la même base. Le nettoyage de récupération au démarrage suppose cet usage exclusif.
- Les envois sont limités à quatre traitements simultanés et 3000 requêtes par réseau sur 15 minutes ; deux exports peuvent fonctionner simultanément. Les réponses `BUSY` demandent une reprise avec délai. La protection des formulaires admin exige un en-tête dédié et vérifie l’origine ; les connexions admin échouées sont limitées à 30 sur 15 minutes.
- Il n’y a pas de plafond global de stockage : surveillez l’espace disque, la mémoire et la disponibilité. L’application n’est pas un service public anonyme anti-abus ; limitez la diffusion du QR code et la durée d’ouverture de la collecte.
- Les originaux conservent leurs métadonnées, notamment EXIF (date, appareil, localisation éventuelle). Les miniatures sont générées sans ces métadonnées. Informez les invités de ce risque de confidentialité et retirez les métadonnées avant dépôt si nécessaire.
- Utilisez le QR code **SVG** fourni par l'interface pour une impression nette. Vérifiez `PUBLIC_URL` et testez le QR avec un téléphone avant de l'imprimer ; `localhost` sur le téléphone ne désigne pas le serveur.

## Exécution locale sans Docker

Prérequis : Node.js **24** et npm. Depuis `wedding-photo-app`, installez aussi les dépendances de développement pour compiler Tailwind :

```sh
npm ci
npm run build:css
```

Générez un secret avec `openssl rand -hex 24` (ou la commande Node.js donnée plus haut), puis configurez l'environnement. Le fichier `.env` de Compose **n'est pas automatiquement chargé par ces commandes npm**.

### Shell POSIX

```sh
export NODE_ENV=development
export PORT=3000
export DATA_DIR=./storage
export ADMIN_USER=admin
export PUBLIC_URL=http://localhost:3000
export TRUST_PROXY=0
export SLIDESHOW_INTERVAL_MS=7000
printf 'Collez le secret généré (au moins 16 caractères) : '
read -r ADMIN_PASSWORD
export ADMIN_PASSWORD
npm start
```

La saisie ci-dessus est visible à l'écran ; faites-la dans un terminal privé. `DATA_DIR=./storage` garde toutes les données locales dans le dossier ignoré par Git ; sans cette variable, le serveur utilise son emplacement par défaut dans le projet.

### Windows PowerShell

```powershell
$env:NODE_ENV = 'development'
$env:PORT = '3000'
$env:DATA_DIR = './storage'
$env:ADMIN_USER = 'admin'
$env:PUBLIC_URL = 'http://localhost:3000'
$env:TRUST_PROXY = '0'
$env:SLIDESHOW_INTERVAL_MS = '7000'
$env:ADMIN_PASSWORD = Read-Host 'Collez le secret généré (au moins 16 caractères, saisie visible)'
npm start
```

Ouvrez <http://localhost:3000>. Arrêtez le processus avec Ctrl+C. Après modification des classes HTML/JavaScript, relancez `npm run build:css`. Pour lancer localement en mode production, remplacez `NODE_ENV` par `production` et fournissez impérativement le secret fort et `PUBLIC_URL` ; les contrôles de démarrage restent applicables.

## Tests et validation

```sh
npm ci
npm run build:css
npm run check
npm test
npm audit
```

Les tests utilisent des bases SQLite et répertoires temporaires isolés. Ils couvrent les uploads et leur validation, les quotas atomiques, les reprises idempotentes, la modération, les originaux/ZIP, les ressources protégées, le proxy, la persistance, les événements SSE et les comportements des interfaces simulés dans une VM JavaScript. Le verrou `package-lock.json` fixe les versions installées. Une surcharge ciblée met à jour `minimatch` dans `readdir-glob` pour corriger son avis de sécurité, sans modifier les dépendances de Tailwind.

Un test complémentaire utilise un vrai navigateur Chromium headless :

```sh
npx playwright install chromium
npm run test:browser
```

Il démarre automatiquement un serveur isolé et vérifie les uploads mobiles, la persistance du nom/quota, l’administration, le QR, les styles d’impression, le téléchargement ZIP, la rotation du diaporama, les mises à jour SSE de modération/suppression, les largeurs mobiles et l’absence d’erreurs JavaScript/CSP. Playwright est une dépendance de développement uniquement et ses navigateurs ne sont pas inclus dans l’image Docker.

Docker n’étant pas installé dans l’environnement de développement, la construction de l’image et l’exécution Compose n’y ont pas été testées. Le test Chromium a réussi, mais ne remplace pas une vérification sur de vrais téléphones. Avant le mariage, vérifiez le build Docker, un upload depuis iOS/Android, le QR imprimé, le diaporama, les droits du volume et une sauvegarde/restauration. Configurez impérativement HTTPS avant une exposition sur Internet.
