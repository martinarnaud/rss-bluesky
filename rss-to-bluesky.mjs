#!/usr/bin/env node
// Surveille un flux RSS (Seenthis) et publie les nouveaux items sur Bluesky.
// Conçu pour tourner dans GitHub Actions (voir .github/workflows/rss-to-bluesky.yml).
//
// Variables d'environnement (à définir comme Secrets du dépôt) :
//   SEENTHIS_FEED_URL   adresse du flux RSS
//   BSKY_IDENTIFIER     votre handle, ex. arno-spip.bsky.social
//   BSKY_APP_PASSWORD   mot de passe d'APPLICATION Bluesky (pas le mot de passe du compte)
//
// Options :
//   DRY_RUN=1           affiche ce qui serait publié, sans rien publier ni enregistrer
//   STATE_FILE=...      chemin du fichier d'état (défaut : ./state.json)
//
// Le dépôt étant public, rien de sensible ne doit être écrit dans state.json
// ni dans les logs : l'adresse du flux n'y apparaît jamais.

import Parser from "rss-parser";
import { AtpAgent, RichText } from "@atproto/api";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fetchWithAnubis } from "./anubis.mjs";
import { buildImageEmbed, buildLinkCard, decodeEntities, fetchLinkMeta, findExternalUrl, isImageUrl } from "./og-card.mjs";


// ---------- Configuration ----------
const FEED_URL = process.env.SEENTHIS_FEED_URL;
const STATE_FILE = process.env.STATE_FILE ?? "state.json";
const DRY_RUN = process.env.DRY_RUN === "1";

// Au tout premier lancement, seuls les items des dernières 24 h sont publiés
// (comme "Published After" dans Pipedream). Les plus anciens sont ignorés.
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const DELAY_BETWEEN_POSTS_MS = 2000;
const MAX_STATE_ENTRIES = 1000;

const BSKY_MAX_GRAPHEMES = 300;
const ELLIPSIS = "…";
const SEPARATOR = "\n\n";

// ---------- Texte du post (votre logique Pipedream) ----------
function smartTruncate(text, maxLength) {
  if (maxLength <= 0) return "";
  const graphemes = [...text];
  if (graphemes.length <= maxLength) return text;

  const truncated = graphemes.slice(0, maxLength - ELLIPSIS.length).join("");
  const lastNewline = truncated.lastIndexOf("\n");
  const lastSpace = truncated.lastIndexOf(" ");

  let cutPoint;
  if (lastNewline > truncated.length * 0.7) cutPoint = lastNewline;
  else if (lastSpace > 0) cutPoint = lastSpace;
  else cutPoint = truncated.length;

  return truncated.substring(0, cutPoint).replace(/\s+$/, "") + ELLIPSIS;
}

function buildPostText(summary, link) {
  const reserved = [...link].length + [...SEPARATOR].length;
  const available = BSKY_MAX_GRAPHEMES - reserved;
  if (available <= 0) throw new Error(`Lien trop long pour un post Bluesky : ${link}`);
  const clean = smartTruncate(summary, available).replace(/\s+$/, "");
  return `${clean}${SEPARATOR}${link}`;
}

// Quand une carte (ou une image) est attachée, l'adresse affichée dans le texte devient
// redondante : on la retire pour gagner des caractères.
function stripUrl(text, url) {
  if (!url) return text;
  const same = (candidate) => {
    const cleaned = decodeEntities(candidate).replace(/[.,;:!?)\]»]+$/, "");
    if (cleaned === url) return true;
    try {
      return new URL(cleaned).href === url;
    } catch {
      return false;
    }
  };
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, (m) => (same(m) ? "" : m))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function postToBluesky(agent, summary, link, embed) {
  const rt = new RichText({ text: buildPostText(summary, link) });
  await rt.detectFacets(agent);
  return agent.post({
    text: rt.text,
    facets: rt.facets,
    ...(embed ? { embed } : {}),
    createdAt: new Date().toISOString(),
  });
}

// ---------- Carte YouTube ----------
// Bluesky affiche une « carte » (titre, vignette, lecteur intégré dans l'application)
// quand le post contient un lien externe attaché sous forme d'embed. Il faut la construire
// nous-mêmes : Bluesky ne la génère pas à partir du texte.
const YOUTUBE_RE = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>]*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{6,}[^\s"'<>]*/i;
const YOUTUBE_OEMBED = process.env.YOUTUBE_OEMBED_URL ?? "https://www.youtube.com/oembed";
const MAX_THUMB_BYTES = 950000; // Bluesky refuse les vignettes de plus d'environ 1 Mo

function findYouTubeUrl(item) {
  const haystack = [item.content, item["content:encoded"], item.contentSnippet, item.summary]
    .filter(Boolean)
    .join(" ")
    .replaceAll("&amp;", "&");
  const m = haystack.match(YOUTUBE_RE);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, "") : null;
}

async function buildYouTubeEmbed(agent, url) {
  const headers = { "User-Agent": "rss-to-bluesky/1.0" };
  const res = await fetch(`${YOUTUBE_OEMBED}?${new URLSearchParams({ url, format: "json" })}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`oEmbed HTTP ${res.status}`);
  const meta = await res.json();

  let thumb;
  if (meta.thumbnail_url) {
    const img = await fetch(meta.thumbnail_url, { headers, signal: AbortSignal.timeout(15000) });
    if (img.ok) {
      const bytes = Buffer.from(await img.arrayBuffer());
      if (bytes.length > 0 && bytes.length <= MAX_THUMB_BYTES) {
        const mime = (img.headers.get("content-type") ?? "image/jpeg").split(";")[0];
        const uploaded = await agent.uploadBlob(bytes, { encoding: mime });
        thumb = uploaded.data.blob;
      }
    }
  }

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: url,
      title: meta.title ?? url,
      description: meta.author_name ? `YouTube · ${meta.author_name}` : "YouTube",
      ...(thumb ? { thumb } : {}),
    },
  };
}

// ---------- Logique RSS (équivalent de itemKey / itemTs) ----------
function itemKey(item) {
  const id = item.guid ?? item.id ?? item.link ?? item.title;
  const base = id
    ? (id.length > 64 ? id.slice(-64) : id)
    : JSON.stringify(item);
  // On stocke un hash court plutôt que l'identifiant brut.
  return createHash("sha1").update(base).digest("hex").slice(0, 20);
}

function itemTs(item) {
  const d = item.isoDate ?? item.pubDate;
  return d ? +new Date(d) : Date.now();
}

// Texte à publier : à ajuster selon ce que contient votre flux Seenthis.
function itemSummary(item) {
  const text = (item.contentSnippet ?? item.summary ?? item.title ?? "")
    // Seenthis place une flèche « ▻ » devant les liens : on la supprime pour que
    // l'adresse qui suit soit reconnue comme un lien par Bluesky.
    .replaceAll("▻", "");
  return text.trim();
}

// ---------- État (state.json, versionné dans le dépôt) ----------
async function loadState() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return { seen: s.seen ?? {}, keepalive: s.keepalive };
  } catch {
    return { seen: {} };
  }
}

async function saveState(state) {
  // Marqueur mensuel : garantit au moins un commit par mois, pour que GitHub
  // ne désactive pas le workflow planifié d'un dépôt public inactif.
  state.keepalive = new Date().toISOString().slice(0, 7);

  // Limite la taille du fichier : on garde les entrées les plus récentes.
  const entries = Object.entries(state.seen);
  if (entries.length > MAX_STATE_ENTRIES) {
    entries.sort((a, b) => b[1] - a[1]);
    state.seen = Object.fromEntries(entries.slice(0, MAX_STATE_ENTRIES));
  }
  // Clés triées : diffs stables, pas de commit inutile.
  const sorted = Object.fromEntries(Object.entries(state.seen).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(
    STATE_FILE,
    JSON.stringify({ keepalive: state.keepalive, seen: sorted }, null, 2) + "\n",
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

// L'adresse du flux ne doit jamais apparaître dans les logs (dépôt public).
const maskUrl = (s) => String(s).replaceAll(FEED_URL, "[URL du flux]");

// Taille maximale du contenu affiché en cas d'échec (évite des logs démesurés).
const MAX_DUMP_CHARS = 50000;

// Télécharge le flux une seule fois : le texte reçu sert à la fois à l'analyse
// et, en cas d'échec, à l'affichage du contenu brut.
// Si le site est protégé par Anubis, le défi de calcul est relevé (voir anubis.mjs).
async function fetchFeedText(url) {
  return fetchWithAnubis(url, {
    userAgent: "rss-to-bluesky/1.0",
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    cookieFile: process.env.ANUBIS_COOKIE_FILE, // optionnel : réutilise le cookie d'un passage à l'autre
    log: (msg) => console.log(maskUrl(msg)),
  });
}

// Affiche dans les logs ce que le serveur a réellement renvoyé.
function dumpResponse(res, body) {
  const hints = [];
  if (/anubis/i.test(body)) hints.push("la page mentionne Anubis");
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(body)) hints.push("ressemble à un flux");
  else if (/<html/i.test(body)) hints.push("c'est une page HTML, pas un flux");

  console.error(`Réponse reçue : HTTP ${res.status}, type "${res.headers.get("content-type")}", ${body.length} caractères.`);
  if (hints.length) console.error(`Indices : ${hints.join(" ; ")}.`);
  console.error("----- DÉBUT DU CONTENU REÇU -----");
  console.error(maskUrl(body.length > MAX_DUMP_CHARS ? body.slice(0, MAX_DUMP_CHARS) : body));
  if (body.length > MAX_DUMP_CHARS) {
    console.error(`[... tronqué : ${body.length - MAX_DUMP_CHARS} caractères supplémentaires ...]`);
  }
  console.error("----- FIN DU CONTENU REÇU -----");
}

async function main() {
  if (!FEED_URL) {
    throw new Error("SEENTHIS_FEED_URL n'est pas défini (Secret du dépôt ou variable d'environnement).");
  }

  const state = await loadState();
  const isFirstRun = Object.keys(state.seen).length === 0;
  const cutoff = Date.now() - FIRST_RUN_LOOKBACK_MS;
  const parser = new Parser({
    timeout: 20000,
    headers: { "User-Agent": "rss-to-bluesky/1.0" },
  });

  // 1. Récupérer les nouveaux items
  let res;
  let body;
  try {
    ({ res, body } = await fetchFeedText(normalizeUrl(FEED_URL)));
  } catch (err) {
    throw new Error(`Impossible de télécharger le flux : ${maskUrl(err.message)}`);
  }

  let feed;
  try {
    if (!res.ok) throw new Error(`le serveur a répondu HTTP ${res.status}`);
    feed = await parser.parseString(body);
  } catch (err) {
    dumpResponse(res, body); // affiche le contenu brut reçu, avant le message d'erreur
    throw new Error(`Impossible de lire le flux : ${maskUrl(err.message)}`);
  }

  const toPost = [];
  const items = [...feed.items].sort((a, b) => itemTs(a) - itemTs(b)); // du plus ancien au plus récent
  for (const item of items) {
    const key = itemKey(item);
    if (state.seen[key]) continue;
    if (isFirstRun && itemTs(item) < cutoff) {
      state.seen[key] = Date.now(); // marqué comme vu, jamais publié
      continue;
    }
    toPost.push({ key, item });
  }

  if (toPost.length === 0) {
    if (!DRY_RUN) await saveState(state);
    console.log("Rien de nouveau.");
    return;
  }

  // 2. Publier sur Bluesky
  let agent = null;
  if (!DRY_RUN) {
    const { BSKY_IDENTIFIER, BSKY_APP_PASSWORD } = process.env;
    if (!BSKY_IDENTIFIER || !BSKY_APP_PASSWORD) {
      throw new Error("BSKY_IDENTIFIER et BSKY_APP_PASSWORD doivent être définis.");
    }
    agent = new AtpAgent({ service: process.env.BSKY_SERVICE ?? "https://bsky.social" });
    await agent.login({ identifier: BSKY_IDENTIFIER, password: BSKY_APP_PASSWORD });
  }

  let failed = false;
  for (const { key, item } of toPost) {
    let summary = itemSummary(item);
    const link = item.link;
    if (!summary || !link) {
      console.warn(`Item ignoré (résumé ou lien manquant) : ${item.title ?? key}`);
      state.seen[key] = Date.now();
      continue;
    }

    // Un seul embed par post : YouTube en priorité (lecteur intégré), sinon le premier lien
    // externe du message : l'image elle-même si c'est un lien direct vers une image, sinon
    // une carte avec ses métadonnées Open Graph.
    const youtubeUrl = findYouTubeUrl(item);
    const cardUrl = youtubeUrl ? null : findExternalUrl(item, link);

    // Le texte n'est dépouillé de l'adresse que si la carte est effectivement attachée.
    const withoutUrl = (u) => stripUrl(summary, u) || summary;

    if (DRY_RUN) {
      console.log(`[DRY_RUN] Publierait :\n${buildPostText(withoutUrl(youtubeUrl ?? cardUrl), link)}`);
      console.log("[DRY_RUN] (adresse retirée du texte seulement si la carte est construite)");
      if (youtubeUrl) console.log(`[DRY_RUN] + carte YouTube : ${youtubeUrl}`);
      if (cardUrl && isImageUrl(cardUrl)) {
        console.log(`[DRY_RUN] + image intégrée : ${cardUrl}`);
      } else if (cardUrl) {
        try {
          const m = await fetchLinkMeta(cardUrl);
          console.log(`[DRY_RUN] + carte de lien : ${cardUrl}`);
          console.log(`            titre       : ${m.title}`);
          console.log(`            description : ${m.description || "(aucune)"}`);
          console.log(`            vignette    : ${m.image ? `oui (${m.image.mime}, ${m.image.bytes.length} octets)` : m.hasImageTag ? `non (${m.imageProblem})` : "non (pas d'image dans la page)"}`);
        } catch (err) {
          console.log(`[DRY_RUN] carte de lien impossible pour ${cardUrl} : ${err.message}`);
        }
      }
      console.log("---");
      continue;
    }

    try {
      // Carte : si elle ne peut pas être construite, on publie quand même, sans carte.
      let embed;
      if (youtubeUrl) {
        try {
          embed = await buildYouTubeEmbed(agent, youtubeUrl);
        } catch (err) {
          console.warn(`Carte YouTube impossible (${err.message}) : publication sans carte.`);
        }
      } else if (cardUrl && isImageUrl(cardUrl)) {
        try {
          embed = await buildImageEmbed(agent, cardUrl, item.title ?? summary);
        } catch (err) {
          console.warn(`Image impossible pour ${cardUrl} (${err.message}) : publication sans image.`);
        }
      } else if (cardUrl) {
        try {
          embed = await buildLinkCard(agent, cardUrl);
        } catch (err) {
          console.warn(`Carte de lien impossible pour ${cardUrl} (${err.message}) : publication sans carte.`);
        }
      }
      if (embed) summary = withoutUrl(youtubeUrl ?? cardUrl);
      await postToBluesky(agent, summary, link, embed);
      state.seen[key] = Date.now();
      console.log(`Publié : ${item.title ?? link}`);
      await sleep(DELAY_BETWEEN_POSTS_MS);
    } catch (err) {
      // Pas marqué comme vu : sera retenté au prochain passage.
      // On s'arrête là pour conserver l'ordre chronologique des publications.
      console.error(`Échec de publication (${link}) : ${err.message}`);
      failed = true;
      break;
    }
  }

  if (!DRY_RUN) await saveState(state);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
