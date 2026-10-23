#!/usr/bin/env node
// Fusionne deux versions de state.json : toutes les entrées « seen » des deux fichiers sont conservées.
//
// Usage : node merge-state.mjs <notre-version.json> <version-du-dépôt.json>
// Le résultat est écrit dans le second fichier.
//
// Sert à enregistrer l'état sans conflit quand deux exécutions (ou un envoi manuel)
// ont modifié state.json en même temps : on ne perd jamais un item déjà publié.

import { readFileSync, writeFileSync } from "node:fs";

const MAX_STATE_ENTRIES = 1000; // même limite que rss-to-bluesky.mjs

const [oursPath, theirsPath] = process.argv.slice(2);
if (!oursPath || !theirsPath) {
  console.error("Usage : node merge-state.mjs <notre-version.json> <version-du-dépôt.json>");
  process.exit(2);
}

function read(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { seen: data.seen ?? {}, keepalive: data.keepalive ?? "" };
  } catch {
    return { seen: {}, keepalive: "" };
  }
}

const ours = read(oursPath);
const theirs = read(theirsPath);

const seen = { ...theirs.seen };
for (const [key, ts] of Object.entries(ours.seen)) seen[key] = Math.max(seen[key] ?? 0, ts);

// Limite la taille : on garde les entrées les plus récentes.
let entries = Object.entries(seen);
if (entries.length > MAX_STATE_ENTRIES) {
  entries.sort((a, b) => b[1] - a[1]);
  entries = entries.slice(0, MAX_STATE_ENTRIES);
}
// Clés triées : diffs stables.
entries.sort(([a], [b]) => a.localeCompare(b));

const keepalive = [ours.keepalive, theirs.keepalive].sort().at(-1);
writeFileSync(theirsPath, JSON.stringify({ keepalive, seen: Object.fromEntries(entries) }, null, 2) + "\n");
