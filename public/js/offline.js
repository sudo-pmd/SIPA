// Coffre-fort hors-ligne : instantané chiffré dans IndexedDB, clé dérivée
// du PIN par PBKDF2 (WebCrypto). Rien n'est stocké en clair.
const DB_NAME = 'sipa-offline';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const randomHex = (bytes = 16) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

async function deriveKey(pin, saltB64, iterations = 150_000) {
  const material = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function saveSnapshot(user, results, pin) {
  if (!crypto?.subtle) return false;
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(pin, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = enc.encode(JSON.stringify({ user, results, savedAt: new Date().toISOString() }));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
  await idbSet('vault', { salt, iv: b64(iv), data: b64(cipher), version: 1 });
  return true;
}

export async function loadSnapshot(pin) {
  const record = await idbGet('vault');
  if (!record) throw new Error('Aucun coffre hors-ligne sur cet appareil.');
  const key = await deriveKey(pin, record.salt);
  const iv = unb64(record.iv);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, unb64(record.data));
  } catch {
    throw new Error('Code PIN incorrect ou coffre hors-ligne endommagé.');
  }
  return JSON.parse(dec.decode(plain));
}

export async function hasSnapshot() {
  try {
    return Boolean(await idbGet('vault'));
  } catch {
    return false;
  }
}

export async function clearSnapshot() {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete('vault');
    tx.oncomplete = resolve;
  });
}

export async function cacheFacilities(facilities) {
  try {
    await idbSet('facilities', { at: Date.now(), facilities });
    localStorage.setItem('sipa.facilitiesAt', String(Date.now()));
  } catch {
    /* quota */
  }
}

export async function readFacilitiesCache() {
  try {
    const record = await idbGet('facilities');
    return record?.facilities ?? [];
  } catch {
    return [];
  }
}

export { randomHex };
