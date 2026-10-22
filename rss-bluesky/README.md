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

## À savoir

- Au tout premier passage réel, seuls les items des dernières 24 h sont publiés.
- `state.json` (créé automatiquement) mémorise les items déjà traités. Ne le supprimez pas, sinon ils seraient republiés.
- Le dépôt étant public, ne mettez jamais d'identifiants dans le code : uniquement dans les Secrets.
- Les exécutions planifiées peuvent être retardées de quelques minutes par GitHub.
- Test en local : `SEENTHIS_FEED_URL=... DRY_RUN=1 node rss-to-bluesky.mjs`
