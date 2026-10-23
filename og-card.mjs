// Carte de lien (« link card ») pour Bluesky, à partir des métadonnées Open Graph de la page cible.
//
// Bluesky ne génère pas de carte à partir du texte d'un post : il faut joindre un embed
// « app.bsky.embed.external » avec titre, description et vignette. On les lit ici dans
// les balises <meta property="og:..."> de la page liée (avec repli sur twitter:* et <title>).
//
// Précautions :
//  - uniquement des sites publics en http(s) : pas de localhost ni d'adresses privées,
//    y compris après redirection (les redirections sont suivies à la main, une par une) ;
//  - taille de page et d'image limitées, délais courts ;
//  - une page qui répond par un défi anti-robots (Anubis, Cloudflare...) n'est PAS contournée :
//    on renonce simplement à la carte.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const USER_AGENT = "rss-to-bluesky/1.0 (link-card)";
const TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 500000;
export const MAX_THUMB_BYTES = 950000; // Bluesky refuse les vignettes de plus d'environ 1 Mo
const MAX_REDIRECTS = 5;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 300;

// Réservé aux tests locaux : autorise localhost / adresses privées.
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_URLS === "1";

// ---------- Sécurité des adresses ----------
function isPrivateIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIP(ip) {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true; // adresse non reconnue : par prudence, on refuse
}

async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`protocole refusé (${u.protocol})`);
  if (ALLOW_PRIVATE) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) throw new Error("adresse locale refusée");
  if (isIP(host)) {
    if (isPrivateIP(host)) throw new Error("adresse privée refusée");
    return u;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIP(a.address))) throw new Error("le nom pointe vers une adresse privée");
  return u;
}

// ---------- Téléchargement borné ----------
async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return { buf: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true };
    }
  }
  return { buf: Buffer.concat(chunks), truncated: false };
}

async function safeFetch(startUrl, { accept, maxBytes }) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "fr,en;q=0.8" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = new URL(res.headers.get("location"), url).href;
      continue;
    }
    const { buf, truncated } = await readLimited(res, maxBytes);
    return { res, finalUrl: url, buf, truncated };
  }
  throw new Error("trop de redirections");
}

// ---------- Lecture du HTML ----------
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", laquo: "«", raquo: "»",
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const clean = (s) => decodeEntities(s ?? "").replace(/\s+/g, " ").trim();

function decodeBody(buf, contentType) {
  let label = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!label) label = buf.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export function parseMetadata(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  const meta = new Map();
  for (const tag of stripped.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const a of tag[0].matchAll(/([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
  }
  const first = (...keys) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  const titleTag = stripped.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: clean(first("og:title", "twitter:title") ?? titleTag),
    description: clean(first("og:description", "twitter:description", "description")),
    image: first("og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src")?.trim(),
    hasChallenge: /id=["']anubis_challenge["']/i.test(html) ||
      /^(just a moment|attention required|making sure you.?re not a bot|access denied|are you a robot|verifying you are human|vérification)/i.test(clean(titleTag ?? "")),
  };
}

// ---------- Image ----------
function sniffImageType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 4 && b.subarray(0, 4).toString("latin1") === "\x89PNG") return "image/png";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length > 4 && b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return null;
}

async function fetchImage(imageUrl, pageUrl) {
  const abs = new URL(imageUrl, pageUrl).href;
  const { res, buf, truncated } = await safeFetch(abs, { accept: "image/*,*/*;q=0.5", maxBytes: MAX_THUMB_BYTES });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  if (truncated) throw new Error("image trop lourde");
  const mime = sniffImageType(buf);
  if (!mime) throw new Error("format d'image non pris en charge");
  return { bytes: buf, mime };
}

// ---------- Interface publique ----------

/** Lit titre, description et image de la page. Lève une erreur si aucune carte n'est possible. */
export async function fetchLinkMeta(url) {
  const { res, finalUrl, buf } = await safeFetch(url, {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.3",
    maxBytes: MAX_HTML_BYTES,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/html|xml/i.test(type)) throw new Error(`pas une page web (${type || "type inconnu"})`);

  const m = parseMetadata(decodeBody(buf, type));
  if (m.hasChallenge) throw new Error("page protégée par un défi anti-robots : pas de carte");
  if (!m.title) throw new Error("aucun titre trouvé (ni og:title, ni <title>)");

  let image = null;
  let imageProblem = null;
  if (m.image) {
    try {
      image = await fetchImage(m.image, finalUrl);
    } catch (err) {
      imageProblem = err.message;
    }
  }
  return {
    title: m.title.slice(0, MAX_TITLE),
    description: m.description.slice(0, MAX_DESCRIPTION),
    image,
    imageProblem,
    hasImageTag: Boolean(m.image),
  };
}

/** Construit l'embed Bluesky (envoie la vignette si elle existe). */
export async function buildLinkCard(agent, url, meta) {
  const m = meta ?? (await fetchLinkMeta(url));
  let thumb;
  if (m.image) {
    const uploaded = await agent.uploadBlob(m.image.bytes, { encoding: m.image.mime });
    thumb = uploaded.data.blob;
  }
  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: url,
      title: m.title,
      description: m.description,
      ...(thumb ? { thumb } : {}),
    },
  };
}

/**
 * Premier lien « externe » du message : ni Seenthis, ni le site du lien du message lui-même.
 * Cherche d'abord dans les attributs href, puis dans les adresses écrites en clair.
 */
export function findExternalUrl(item, ownLink) {
  const html = [item.content, item["content:encoded"]].filter(Boolean).join(" ");
  const candidates = [];
  for (const m of html.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) candidates.push(m[1] ?? m[2]);
  const text = [html, item.contentSnippet, item.summary].filter(Boolean).join(" ");
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) candidates.push(m[0]);

  const bare = (h) => h.toLowerCase().replace(/^www\./, "");
  let ownHost = "";
  try {
    ownHost = bare(new URL(ownLink).hostname);
  } catch {
    // lien du message illisible : on ne filtre que Seenthis
  }

  for (const raw of candidates) {
    const cleaned = decodeEntities(raw).replace(/[.,;:!?)\]»]+$/, "");
    let u;
    try {
      u = new URL(cleaned);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = bare(u.hostname);
    if (host === "seenthis.net" || host.endsWith(".seenthis.net") || host === ownHost) continue;
    return u.href;
  }
  return null;
}
