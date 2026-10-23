#!/usr/bin/env bash
# Enregistre state.json dans le dépôt, sans conflit.
#
# Si le dépôt a reçu une autre version de state.json entre le début de l'exécution et maintenant
# (autre exécution, envoi manuel...), on repart de la version du dépôt, on y fusionne nos entrées
# (merge-state.mjs), puis on réessaie l'envoi. On ne perd donc jamais un item déjà publié.
set -euo pipefail

FILE=state.json
BRANCH="${GITHUB_REF_NAME:-main}"

[ -f "$FILE" ] || { echo "Pas de $FILE : rien à enregistrer."; exit 0; }

# Rien de modifié : rien à faire.
if git ls-files --error-unmatch "$FILE" >/dev/null 2>&1 && git diff --quiet -- "$FILE"; then
  echo "$FILE inchangé."
  exit 0
fi

# Copies hors du dépôt : elles survivent aux remises à zéro ci-dessous.
cp "$FILE" /tmp/state-ours.json
cp merge-state.mjs /tmp/merge-state.mjs

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  git fetch --quiet origin "$BRANCH"
  git reset --quiet --hard "origin/$BRANCH"

  if [ -f "$FILE" ]; then
    node /tmp/merge-state.mjs /tmp/state-ours.json "$FILE"
  else
    cp /tmp/state-ours.json "$FILE"
  fi

  git add "$FILE"
  if git diff --cached --quiet; then
    echo "Le dépôt contient déjà toutes les entrées : rien à enregistrer."
    exit 0
  fi

  git commit --quiet -m "Mise à jour de l'état"
  if git push --quiet origin "HEAD:$BRANCH"; then
    echo "État enregistré (tentative $attempt)."
    exit 0
  fi

  echo "Envoi refusé (tentative $attempt/5), nouvel essai..."
  sleep $((attempt * 3))
done

echo "Impossible d'enregistrer $FILE après 5 tentatives." >&2
exit 1
