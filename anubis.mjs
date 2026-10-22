// Client HTTP capable de relever le défi de calcul d'Anubis (algorithme "fast").
//
// Principe (le même que celui d'un lecteur de flux comme Reeder) :
//   1. on demande le flux ; si le site répond par la page de défi, on lit le défi dedans ;
//   2. on effectue le calcul demandé (preuve de travail SHA-256) ;
//   3. on envoie la solution à l'adresse prévue par Anubis, qui répond par un cookie ;
//   4. on redemande le flux avec ce cookie.
//
// Ce que ce module ne fait PAS : il s'identifie toujours sous son vrai nom
// (jamais comme un navigateur), il ne tente qu'un seul défi par exécution, et
// il abandonne sans insister si le défi n'est pas d'un type qu'il connaît.

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const WORKER_FILE = new URL("./anubis-worker.mjs", import.meta.url);
const PASS_CHALLENGE_PATH = "/.within.website/x/cmd/anubis/api/pass-challenge";

// Garde-fous : au-delà, le calcul serait déraisonnable pour une exécution automatique.
const MAX_DIFFICULTY = 8;            // 16^8 ≈ 4,3 milliards d'essais en moyenne
const SOLVE_TIMEOUT_MS = 8 * 60 * 1000;

// ---------- Cookies ----------
class CookieJar {
  constructor(file) {
    this.file = file;
    this.map = new Map(); // nom -> { value, expiresAt | null }
  }

  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      for (const [name, c] of Object.entries(data)) this.map.set(name, c);
    } catch {
      // pas de fichier : jarre vide
    }
    this.#purge();
  }

  async save() {
    if (!this.file) return;
    this.#purge();
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
  }

  #purge() {
    const now = Date.now();
    for (const [name, c] of this.map) if (c.expiresAt && c.expiresAt <= now) this.map.delete(name);
  }

  header() {
    this.#purge();
    return [...this.map].map(([n, c]) => `${n}=${c.value}`).join("; ");
  }

  store(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let expiresAt = null;
      for (const a of attrs) {
        const [k, v = ""] = a.split("=");
        if (/^max-age$/i.test(k)) expiresAt = Date.now() + Number(v) * 1000;
        else if (/^expires$/i.test(k) && expiresAt === null) expiresAt = +new Date(v) || null;
      }
      if (value === "" || (expiresAt !== null && expiresAt <= Date.now())) this.map.delete(name);
      else this.map.set(name, { value, expiresAt });
    }
  }
}

// ---------- Calcul ----------
export function solveProofOfWork({ randomData, difficulty, threads = availableParallelism(), timeoutMs = SOLVE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const flag = new SharedArrayBuffer(4);
    const stop = new Int32Array(flag);
    const workers = [];
    let finished = false;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      Atomics.store(stop, 0, 1);
      for (const w of workers) w.terminate();
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`le calcul n'a pas abouti en ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );

    for (let i = 0; i < threads; i++) {
      const w = new Worker(WORKER_FILE, {
        workerData: { randomData, difficulty, start: i, step: threads, flag },
      });
      w.on("message", (m) => finish(resolve, m));
      w.on("error", (e) => finish(reject, e));
      workers.push(w);
    }
  });
}

// ---------- Détection et lecture du défi ----------
function scriptJson(html, id) {
  const m = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

export function parseChallengePage(html) {
  const data = scriptJson(html, "anubis_challenge");
  if (!data) return null;
  return {
    algorithm: data.rules?.algorithm ?? data.challenge?.method,
    difficulty: data.rules?.difficulty ?? data.challenge?.difficulty,
    id: data.challenge?.id,
    randomData: data.challenge?.randomData,
    basePrefix: scriptJson(html, "anubis_base_prefix") ?? "",
  };
}

// ---------- Requête complète ----------
/**
 * Télécharge `url`. Si le site répond par un défi Anubis de type "fast", le résout puis
 * redemande la page. Renvoie { res, body } de la dernière réponse.
 *
 * options : userAgent, accept, cookieFile, log (fonction), threads
 */
export async function fetchWithAnubis(url, options = {}) {
  const {
    userAgent,
    accept = "*/*",
    cookieFile,
    log = () => {},
    threads,
  } = options;

  const jar = new CookieJar(cookieFile);
  await jar.load();

  const request = async (target, init = {}) => {
    const headers = { "User-Agent": userAgent, Accept: accept };
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(target, { ...init, headers, signal: AbortSignal.timeout(30000) });
    jar.store(res);
    return { res, body: await res.text() };
  };

  let result = await request(url);
  const challenge = parseChallengePage(result.body);
  if (!challenge) {
    await jar.save();
    return result; // pas de défi : réponse normale
  }

  // ----- Défi Anubis -----
  if (challenge.algorithm !== "fast") {
    throw new Error(`défi Anubis non pris en charge (algorithme « ${challenge.algorithm} »)`);
  }
  if (!challenge.id || !challenge.randomData || !Number.isInteger(challenge.difficulty)) {
    throw new Error("défi Anubis illisible (champs manquants)");
  }
  if (challenge.difficulty > MAX_DIFFICULTY) {
    throw new Error(`difficulté Anubis trop élevée (${challenge.difficulty} > ${MAX_DIFFICULTY}) : abandon`);
  }

  const nThreads = threads ?? availableParallelism();
  log(`Défi Anubis détecté (algorithme fast, difficulté ${challenge.difficulty}). Calcul sur ${nThreads} thread(s)...`);
  const t0 = Date.now();
  const { nonce, hash } = await solveProofOfWork({
    randomData: challenge.randomData,
    difficulty: challenge.difficulty,
    threads: nThreads,
  });
  const elapsed = Date.now() - t0;
  log(`Défi résolu en ${(elapsed / 1000).toFixed(1)} s.`);

  const origin = new URL(url).origin;
  const pass = new URL(`${challenge.basePrefix}${PASS_CHALLENGE_PATH}`, origin);
  pass.searchParams.set("id", challenge.id);
  pass.searchParams.set("response", hash);
  pass.searchParams.set("nonce", String(nonce));
  pass.searchParams.set("redir", url);
  pass.searchParams.set("elapsedTime", String(elapsed));

  // On ne suit pas la redirection : on récupère le cookie, puis on redemande le flux nous-mêmes.
  const passed = await request(pass, { redirect: "manual" });
  if (passed.res.status >= 400) {
    return passed; // refus : la réponse sera affichée par l'appelant
  }

  result = await request(url);
  await jar.save();
  return result;
}
