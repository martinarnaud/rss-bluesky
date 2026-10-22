// Thread de calcul pour le défi Anubis (algorithme "fast").
// Cherche un nonce tel que SHA-256(randomData + nonce) commence par
// `difficulty` chiffres hexadécimaux égaux à zéro.
//
// Deux méthodes :
//  - rapide : SHA-256 spécialisé (sha256-pow.mjs), plusieurs fois plus rapide ;
//  - de repli : bibliothèque de chiffrement de Node, utilisée si la méthode rapide
//    échoue à son auto-contrôle ou si la difficulté sort de la plage prévue.
// Dans les deux cas, toute solution est vérifiée avec la bibliothèque de Node avant d'être renvoyée.
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { makeHasher, zeroMask } from "./sha256-pow.mjs";

const { randomData, difficulty, start, step, flag } = workerData;
const stop = new Int32Array(flag); // drapeau partagé : un autre thread a trouvé, ou délai dépassé
const ZEROS = "0".repeat(difficulty);

const reference = (nonce) => createHash("sha256").update(randomData).update(String(nonce)).digest("hex");

// Auto-contrôle : la méthode rapide doit donner exactement le même résultat que Node.
function fastMethodIsReliable(hasher) {
  const samples = [0, 1, 9, 10, 99, 100, 4242, 99999, 100000, 123456789, 999999999, 1000000000, 3000000000];
  for (let i = 0; i < 50; i++) samples.push(Math.floor(Math.random() * 2e9));
  return samples.every((n) => hasher.word0(n) === Buffer.from(reference(n).slice(0, 8), "hex").readInt32BE(0));
}

function found(nonce) {
  const hash = reference(nonce);
  if (!hash.startsWith(ZEROS)) return false; // ne devrait jamais arriver
  parentPort.postMessage({ nonce, hash });
  return true;
}

function searchFast(hasher) {
  const mask = zeroMask(difficulty);
  for (let nonce = start, iter = 0; ; nonce += step, iter++) {
    if ((iter & 0xffff) === 0 && Atomics.load(stop, 0) !== 0) return;
    if ((hasher.word0(nonce) & mask) === 0 && found(nonce)) return;
  }
}

function searchFallback() {
  const base = createHash("sha256").update(randomData);
  for (let nonce = start, iter = 0; ; nonce += step, iter++) {
    if ((iter & 0x3fff) === 0 && Atomics.load(stop, 0) !== 0) return;
    const hex = base.copy().update(String(nonce)).digest("hex");
    if (hex.startsWith(ZEROS)) {
      parentPort.postMessage({ nonce, hash: hex });
      return;
    }
  }
}

let hasher = null;
if (difficulty >= 1 && difficulty <= 8) {
  try {
    const h = makeHasher(randomData);
    if (fastMethodIsReliable(h)) hasher = h;
  } catch {
    hasher = null;
  }
}

if (hasher) searchFast(hasher);
else searchFallback();
