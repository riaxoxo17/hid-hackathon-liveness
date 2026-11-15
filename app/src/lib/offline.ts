// Offline mode on the kiosk. Used only when the central service cannot be reached.
//
// Safe by design:
//   - never opens on a face alone: badge + live person + cached schedule ALLOW + correct PIN
//   - anything the schedule would allow only after a step-up is denied offline
//   - the cache is one door's schedule for a few hours (letters per 15-minute slot), names and salted
//     PIN hashes; no face data, no photos; it is deleted when it expires
//   - each decision is logged without images and uploaded when the connection returns, then deleted
import { api, NetworkError } from './api';

const BKEY = 'hid.offline.bundle';
const QKEY = 'hid.offline.queue';
const FKEY = 'hid.offline.fails';
const KKEY = 'hid.kiosk.id';
const QUEUE_MAX_AGE = 24 * 3600 * 1000;

export type Bundle = {
  version: string; zone: string; zoneName: string; kind: string; issuedAt: string; start: string;
  expiresAt: string; hours: number; slotMin: number; thresholds: Record<string, number>;
  users: Record<string, { name: string; slots: string; pinSalt: string; pinHash: string; pinIter: number }>;
};
export type OfflineRecord = {
  id: string; at: number; localTime: string; badgeId: string; zone: string; zoneName: string;
  decision: 'ALLOW' | 'DENY'; reasons: string[]; schedule: string; spoofScore: number; gazePassed: boolean;
  light: string; pin: string; bundleVersion: string; test?: any;
};

// browser storage can throw (private mode, quota); offline mode then simply has no cache
const read = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: any) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((f) => f());

export const offline = {
  online: true,
  forced: false, // demo switch: behave exactly as if the network were down
  lastError: '',

  subscribe(f: Listener) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  isOffline() {
    return this.forced || !this.online;
  },
  setForced(v: boolean) {
    this.forced = v;
    emit();
    if (!v) this.ping();
  },
  kioskId(): string {
    let id = read<string>(KKEY, '');
    if (!id) {
      id = 'kiosk-' + Math.random().toString(36).slice(2, 8);
      write(KKEY, id);
    }
    return id;
  },

  // ---- connection ----
  markDown(e: any) {
    if (e instanceof NetworkError || e?.name === 'NetworkError') {
      this.online = false;
      this.lastError = String(e.message || e);
      emit();
      return true;
    }
    return false;
  },
  async ping() {
    if (this.forced) return;
    const was = this.online;
    try {
      await api.health();
      this.online = true;
    } catch (e) {
      this.online = !(e instanceof NetworkError);
    }
    if (was !== this.online) emit();
    if (!was && this.online) await this.sync().catch(() => {});
  },

  // ---- cached schedule ----
  bundle(): Bundle | null {
    const b = read<Bundle | null>(BKEY, null);
    if (b && Date.parse(b.expiresAt) < Date.now()) {
      write(BKEY, null); // expired: delete, never use
      emit();
      return null;
    }
    return b;
  },
  async refresh(zone: string, clock?: string | null) {
    if (this.isOffline()) return this.bundle();
    const b = await api.bundle(zone, clock);
    write(BKEY, b);
    emit();
    return b as Bundle;
  },
  scheduleLetter(b: Bundle, badge: string, local: string): 'A' | 'S' | 'D' {
    const u = b.users[badge];
    if (!u) return 'D';
    const mins = (Date.parse(local + ':00Z') - Date.parse(b.start + ':00Z')) / 60000;
    const i = Math.floor(mins / b.slotMin);
    if (!(i >= 0 && i < u.slots.length)) return 'D';
    return u.slots[i] as 'A' | 'S' | 'D';
  },

  // ---- PIN (PBKDF2-SHA256 with WebCrypto, same as the server) ----
  async pinOk(b: Bundle, badge: string, pin: string) {
    const u = b.users[badge];
    if (!u || !/^\d{4,8}$/.test(pin)) return false;
    const salt = new Uint8Array(u.pinSalt.match(/../g)!.map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: u.pinIter }, key, 256);
    const hex = Array.from(new Uint8Array(bits)).map((x) => x.toString(16).padStart(2, '0')).join('');
    return hex === u.pinHash;
  },
  fails(badge: string) {
    return read<Record<string, number>>(FKEY, {})[badge] || 0;
  },
  addFail(badge: string) {
    const f = read<Record<string, number>>(FKEY, {});
    f[badge] = (f[badge] || 0) + 1;
    write(FKEY, f);
  },

  // ---- decision log and sync ----
  queue(): OfflineRecord[] {
    return read<OfflineRecord[]>(QKEY, []).filter((r) => Date.now() - r.at < QUEUE_MAX_AGE);
  },
  log(r: Omit<OfflineRecord, 'id' | 'at'>) {
    const rec: OfflineRecord = { ...r, id: crypto.randomUUID().replace(/-/g, '').slice(0, 20), at: Date.now() };
    write(QKEY, [...this.queue(), rec]);
    emit();
    return rec;
  },
  async sync(): Promise<{ sent: number; conflicts: any[] } | null> {
    const q = this.queue();
    if (this.isOffline() || !q.length) return null;
    const r = await api.offlineSync(this.kioskId(), q);
    const done = new Set<string>(r.accepted);
    write(QKEY, this.queue().filter((x) => !done.has(x.id)));
    write(FKEY, null); // lockouts reset once the central service has the record
    emit();
    return { sent: done.size, conflicts: r.conflicts };
  },
};
