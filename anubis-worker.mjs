// Thread de calcul pour le défi Anubis (algorithme "fast").
// Cherche un nonce tel que SHA-256(randomData + nonce) commence par
// `difficulty` chiffres hexadécimaux égaux à zéro.
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";

const { randomData, difficulty, start, step, flag } = workerData;
const stop = new Int32Array(flag); // drapeau partagé : un autre thread a trouvé, ou délai dépassé

const base = createHash("sha256").update(randomData);
const fullBytes = difficulty >> 1;
const halfNibble = difficulty & 1;

function ok(d) {
  for (let i = 0; i < fullBytes; i++) if (d[i] !== 0) return false;
  return !halfNibble || (d[fullBytes] >> 4) === 0;
}

for (let nonce = start, iter = 0; ; nonce += step, iter++) {
  if ((iter & 0x3fff) === 0 && Atomics.load(stop, 0) !== 0) break;
  const d = base.copy().update(String(nonce)).digest();
  if (ok(d)) {
    parentPort.postMessage({ nonce, hash: d.toString("hex") });
    break;
  }
}
