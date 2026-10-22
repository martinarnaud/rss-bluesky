// SHA-256 spécialisé pour la preuve de travail d'Anubis.
//
// On cherche un nonce tel que SHA-256(randomData + nonce) commence par des zéros.
// randomData est identique à chaque essai : on calcule une fois l'état interne après
// ses blocs complets de 64 octets ("midstate"), puis on ne refait, à chaque essai,
// que le dernier bloc (qui contient les chiffres du nonce). Cela évite de re-hacher
// la chaîne du serveur à chaque tentative et d'appeler la bibliothèque de chiffrement.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * Compression SHA-256 d'un bloc de 64 octets.
 * S : état d'entrée (8 mots), W : tableau de 64 mots dont les 16 premiers contiennent le bloc.
 * Renvoie le premier mot du nouvel état si `out` est absent, sinon écrit les 8 mots dans `out`.
 */
function compress(S, W, out) {
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15];
    const w2 = W[i - 2];
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = S[0], b = S[1], c = S[2], d = S[3], e = S[4], f = S[5], g = S[6], h = S[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  if (!out) return (S[0] + a) | 0;
  out[0] = (S[0] + a) | 0; out[1] = (S[1] + b) | 0; out[2] = (S[2] + c) | 0; out[3] = (S[3] + d) | 0;
  out[4] = (S[4] + e) | 0; out[5] = (S[5] + f) | 0; out[6] = (S[6] + g) | 0; out[7] = (S[7] + h) | 0;
  return out[0];
}

const digitCount = (n) => (n < 10 ? 1 : Math.floor(Math.log10(n)) + 1);

/**
 * Prépare le calcul pour un préfixe donné (randomData).
 * Renvoie { word0(nonce) } : premier mot (entier 32 bits signé) de SHA-256(prefix + String(nonce)).
 */
export function makeHasher(prefix) {
  const P = Buffer.from(prefix, "utf8");
  const L = P.length;
  const fullBlocks = Math.floor(L / 64);
  const rem = P.subarray(fullBlocks * 64);
  const r = rem.length;

  // Midstate : état après les blocs complets du préfixe.
  const mid = Int32Array.from(IV);
  const W = new Int32Array(64);
  const tmp = new Int32Array(8);
  for (let blk = 0; blk < fullBlocks; blk++) {
    for (let i = 0; i < 16; i++) W[i] = P.readInt32BE(blk * 64 + i * 4);
    compress(mid, W, tmp);
    mid.set(tmp);
  }

  // Modèle du ou des derniers blocs pour un nonce de D chiffres.
  let curD = 0;
  let lo = 0;
  let hi = -1; // nonces représentables avec curD chiffres : [lo, hi]
  let tail = new Int32Array(16);
  let template = tail;
  let blocks = 1;
  let firstWord = 0;
  let lastWord = 0;

  function configure(D) {
    curD = D;
    lo = D === 1 ? 0 : 10 ** (D - 1);
    hi = 10 ** D - 1;
    const bytesLen = r + D + 1 + 8;
    blocks = bytesLen <= 64 ? 1 : 2;
    const T = blocks * 64;
    const bytes = Buffer.alloc(T);
    rem.copy(bytes, 0);
    bytes[r + D] = 0x80;
    bytes.writeBigUInt64BE(BigInt(L + D) * 8n, T - 8);
    template = new Int32Array(T / 4);
    for (let i = 0; i < T / 4; i++) template[i] = bytes.readInt32BE(i * 4);
    tail = Int32Array.from(template);
    firstWord = r >> 2;
    lastWord = (r + D - 1) >> 2;
  }

  function word0(nonce) {
    if (nonce < lo || nonce > hi) configure(digitCount(nonce));

    // Écrit les chiffres du nonce dans le(s) dernier(s) bloc(s).
    for (let i = firstWord; i <= lastWord; i++) tail[i] = template[i];
    let n = nonce;
    for (let p = r + curD - 1; p >= r; p--) {
      const q = Math.floor(n / 10);
      tail[p >> 2] |= (48 + (n - q * 10)) << (24 - 8 * (p & 3));
      n = q;
    }

    if (blocks === 1) {
      for (let i = 0; i < 16; i++) W[i] = tail[i];
      return compress(mid, W);
    }
    // Cas rare : le dernier bloc déborde sur un second bloc.
    for (let i = 0; i < 16; i++) W[i] = tail[i];
    compress(mid, W, tmp);
    const S2 = Int32Array.from(tmp);
    for (let i = 0; i < 16; i++) W[i] = tail[16 + i];
    return compress(S2, W);
  }

  return { word0 };
}

/** Masque à appliquer au premier mot pour exiger `difficulty` chiffres hexadécimaux nuls (1 à 8). */
export function zeroMask(difficulty) {
  if (difficulty < 1 || difficulty > 8) throw new RangeError("difficulté hors de 1..8");
  return difficulty === 8 ? -1 : (0xffffffff << (32 - 4 * difficulty)) | 0;
}
