// Couche d'accès à l'API SIPA : session, coffre-fort, hors-ligne.
export class ApiError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const read = (store, key) => {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
};
const write = (store, key, value) => {
  try {
    if (value == null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
};

export const state = {
  meta: null,
  token: read(localStorage, 'sipa.token'),
  user: null,
  vault: { token: read(sessionStorage, 'sipa.vault'), expiresAt: Number(read(sessionStorage, 'sipa.vaultUntil') ?? 0) },
  credentialId: read(localStorage, 'sipa.cred'),
  staffToken: read(localStorage, 'sipa.staff'),
  staff: null,
  locked: true,
  onboarded: Boolean(read(localStorage, 'sipa.onboarded')),
  lastLocation: null,
  pendingChat: null,
};

export function setSession({ token, user }) {
  state.token = token;
  state.user = user;
  write(localStorage, 'sipa.token', token);
  if (user) write(localStorage, 'sipa.onboarded', '1');
}

export function clearSession() {
  state.token = null;
  state.user = null;
  state.vault = { token: null, expiresAt: 0 };
  write(localStorage, 'sipa.token', null);
  write(sessionStorage, 'sipa.vault', null);
  write(sessionStorage, 'sipa.vaultUntil', null);
}

export function setVault({ token, expiresIn }) {
  state.vault = { token, expiresAt: Date.now() + (expiresIn ?? 600) * 1000 };
  write(sessionStorage, 'sipa.vault', token);
  write(sessionStorage, 'sipa.vaultUntil', String(state.vault.expiresAt));
}

export function vaultToken() {
  if (!state.vault.token || state.vault.expiresAt < Date.now() + 5_000) return null;
  return state.vault.token;
}

export function setStaff({ token, staff }) {
  state.staffToken = token;
  state.staff = staff;
  write(localStorage, 'sipa.staff', token);
}

export function clearStaff() {
  state.staffToken = null;
  state.staff = null;
  write(localStorage, 'sipa.staff', null);
}

export function setCredential(id) {
  state.credentialId = id;
  write(localStorage, 'sipa.cred', id);
}

const BASE = '';

export async function api(path, { method = 'GET', body, useVault = false, useStaff = false, token, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const bearer = token ?? (useStaff ? state.staffToken : state.token);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (useVault) {
    const vt = vaultToken();
    if (vt) headers['x-vault-unlock-token'] = vt;
  }
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError(0, 'Connexion indisponible. Vérifiez votre réseau.', { offline: true });
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    if (res.status === 401 && useVault) {
      state.vault = { token: null, expiresAt: 0 };
      write(sessionStorage, 'sipa.vault', null);
    }
    throw new ApiError(res.status, data.error ?? 'Une erreur est survenue.', data);
  }
  return data;
}

export function openEventStream(handlers = {}) {
  if (!state.token || typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`/api/v1/stream?token=${encodeURIComponent(state.token)}`);
  source.onmessage = (event) => {
    try {
      handlers.onEvent?.(JSON.parse(event.data));
    } catch {
      /* ignoré */
    }
  };
  source.onerror = () => {};
  return () => source.close();
}

export function openProStream(handlers = {}) {
  if (!state.staffToken || typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`/api/v1/pro/stream?token=${encodeURIComponent(state.staffToken)}`);
  source.onmessage = (event) => {
    try {
      handlers.onEvent?.(JSON.parse(event.data));
    } catch {
      /* ignoré */
    }
  };
  return () => source.close();
}

export const money = (value) => new Intl.NumberFormat('fr-FR').format(value);
