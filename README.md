[![RSS vers Bluesky](https://github.com/martinarnaud/rss-bluesky/actions/workflows/rss-to-bluesky.yml/badge.svg?branch=main)](https://github.com/martinarnaud/rss-bluesky/actions/workflows/rss-to-bluesky.yml)

# RSS vers Bluesky

Publie sur Bluesky les nouveaux items d'un flux RSS (Seenthis), toutes les 30 minutes, via GitHub Actions.

## Mise en place

1. Créez un dépôt **public** sur GitHub et envoyez-y le contenu de ce dossier
   (y compris le dossier caché `.github/workflows/`).
2. Sur Bluesky, créez un **mot de passe d'application** (Réglages → Mots de passe d'application).
3. Dans le dépôt : *Settings → Secrets and variables → Actions → New repository secret*.
   Créez trois secrets :
   - `SEENTHIS_FEED_URL` : l'adresse de votre flux RSS
   - `BSKY_IDENTIFIER` : votre handle Bluesky (ex. `arno-spip.bsky.social`)
   - `BSKY_APP_PASSWORD` : le mot de passe d'application
4. *Settings → Actions → General → Workflow permissions* : choisissez **Read and write permissions**.
5. Onglet **Actions** → « RSS vers Bluesky » → *Run workflow* (la case « dry_run » est cochée par défaut).
   Lisez les logs : le texte des posts qui seraient publiés doit vous convenir.
6. Relancez avec « dry_run » décochée, ou attendez le prochain passage planifié : la publication est alors réelle.

## Sites protégés par Anubis

Si le flux est protégé par [Anubis](https://github.com/TecharoHQ/anubis), `anubis.mjs` relève le défi de calcul
demandé (preuve de travail SHA-256, algorithme « fast »), comme le ferait un lecteur de flux, puis lit le flux.

- Le client s'identifie toujours sous son vrai nom (`rss-to-bluesky/1.0`), jamais comme un navigateur.
- Le calcul n'est fait qu'une fois par exécution, et abandonné si la difficulté dépasse 8 ou si l'algorithme n'est pas « fast ».
- Le calcul peut prendre de quelques dizaines de secondes à quelques minutes selon la difficulté configurée par le site.
- Le cookie obtenu est conservé dans le cache GitHub Actions (jamais dans le dépôt) pour éviter de refaire le calcul
  à chaque passage, s'il reste valable.
- Il suppose que l'administrateur du site accepte ce type d'accès pour votre usage. Si ce n'est pas le cas, ne l'utilisez pas.

## À savoir

- Au tout premier passage réel, seuls les items des dernières 24 h sont publiés.
- `state.json` (créé automatiquement) mémorise les items déjà traités. Ne le supprimez pas, sinon ils seraient republiés.
- Le dépôt étant public, ne mettez jamais d'identifiants dans le code : uniquement dans les Secrets.
- Les exécutions planifiées peuvent être retardées de quelques minutes par GitHub.
- En cas d'échec de lecture du flux, les logs affichent le contenu brut reçu (utile pour comprendre ce que renvoie le site).
- Test en local : `SEENTHIS_FEED_URL=... DRY_RUN=1 node rss-to-bluesky.mjs` (Node 20 ou plus récent).
