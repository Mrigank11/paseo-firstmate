// Web push: the deck tells subscribed browsers when a task enters Needs you, with no window open anywhere. A browser opts
// in once on the deck's own page (notify.ts); from then on its push service (Firefox: Mozilla's) wakes the deck's service
// worker. Standards: RFC 8030 (delivery), RFC 8291 (the message is readable by that browser only), RFC 8292 (VAPID).
//
// In the folder `dir` (the deck's settings folder), owner-readable only:
//   keys.json           the deck's VAPID key pair and the key its "Notify me" link carries; made once
//   subscriptions.json  the browsers that opted in
//   seen.json           what each project was waiting for, so every wait is pushed once, restarts included
//   push.log            what the deck sent, what the push service replied, what the page and the worker reported
import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notifyPageHtml, serviceWorkerScript, track, type Needs, type NeedsItem, type Seen } from "./notify.ts";

type Keys = { publicKey: string; privateKey: string; key: string };
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushReply = { code: number; type: string; body: string };
export type PushOpts = { fetch?: typeof fetch; now?: () => number; retryMs?: number[]; log?: (m: string) => void };

/** The services browsers hand out addresses of (Firefox, Chrome, Edge, Safari). The deck sends nowhere else. */
const PUSH_HOSTS = /(^|\.)(push\.services\.mozilla\.com|notify\.windows\.com|web\.push\.apple\.com)$|^fcm\.googleapis\.com$/;
/** The standard wants a contact address for the sender. Deliberately nobody's. */
const CONTACT = "mailto:deck@localhost.invalid";
const TTL_SECONDS = 86_400; // how long the push service holds a message for a browser that is not running
const RETRY_MS = [30_000, 300_000];
const MAX_SUBSCRIPTIONS = 10, TITLE_MAX = 120, LINE_MAX = 220, LOG_MAX = 128 * 1024;

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One message in the aes128gcm form of RFC 8291. `fixed` sets what is otherwise random (the published test vector). */
export function encryptPush(payload: Buffer, to: Subscription["keys"], fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  const ours = createECDH("prime256v1");
  if (fixed) ours.setPrivateKey(fixed.privateKey); else ours.generateKeys();
  const mine = ours.getPublicKey(), theirs = unb64(to.p256dh), salt = fixed?.salt ?? randomBytes(16);
  const ikm = hkdf(ours.computeSecret(theirs), unb64(to.auth), Buffer.concat([Buffer.from("WebPush: info\0"), theirs, mine]), 32);
  const cipher = createCipheriv("aes-128-gcm", hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(4096, 0);
  head[4] = mine.length;
  return Buffer.concat([salt, head, mine, data]);
}

/** The Authorization header that tells the push service this sender is the one the browser subscribed to. */
function vapid(endpoint: string, keys: Keys): string {
  const part = (v: unknown) => b64(Buffer.from(JSON.stringify(v)));
  const text = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT })}`;
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)) } });
  return `vapid t=${text}.${b64(sign("sha256", Buffer.from(text), { key, dsaEncoding: "ieee-p1363" }))}, k=${keys.publicKey}`;
}

function validSubscription(v: any): Subscription | null {
  try {
    const { endpoint, keys: { p256dh, auth } } = v;
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port || !PUSH_HOSTS.test(url.hostname)) return null;
    if (unb64(p256dh).length !== 65 || unb64(auth).length !== 16) return null;
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(unb64(p256dh)); // throws unless it is a point on the curve
    return { endpoint: url.href, keys: { p256dh, auth } };
  } catch { return null; }
}

/** Short name of a browser in the log; the address itself is a secret. */
const nameOf = (s: Subscription) => createHash("sha1").update(s.endpoint).digest("hex").slice(0, 6);

const PAGE_REPORTS: Record<string, (d: string) => string> = {
  open: (d) => `page: open, ${d}`,
  allow: (d) => `page: Allow pressed, the browser answered ${d}`,
  error: (d) => `page: failed: ${d}`,
};
const WORKER_REPORTS: Record<string, (who: string, task: string, d: string) => string> = {
  received: (w, t) => `worker ${w}: received ${t}`,
  shown: (w, t) => `worker ${w}: the browser says it showed ${t}`,
  error: (w, t, d) => `worker ${w}: could not show ${t}: ${d}`,
  click: (w, t) => `worker ${w}: clicked ${t}`,
};

export class WebPush {
  private dir: string;
  private keys: Keys;
  private seen: Record<string, Seen>;
  private fetch: typeof fetch;
  private now: () => number;
  private retryMs: number[];
  private warn: (m: string) => void;
  private sending = new Set<Promise<void>>();
  private retries = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  /** Messages the worker may still report on: id -> browser and task. */
  private messages = new Map<string, { who: string; task: string }>();

  constructor(dir: string, o: PushOpts = {}) {
    this.dir = dir;
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? RETRY_MS;
    this.warn = o.log ?? (() => {});
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // never replaced once written: new keys would cut off every browser that opted in
    if (!existsSync(this.file("keys.json"))) {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      this.write("keys.json", { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()), key: randomBytes(16).toString("hex") });
    }
    this.keys = JSON.parse(readFileSync(this.file("keys.json"), "utf8"));
    this.seen = this.read("seen.json", {});
  }

  /** What the "Notify me" link carries: only its holder may subscribe a browser. */
  get linkKey(): string { return this.keys.key; }

  /** The waiting tasks of one project as the deck sees them now. Sends what is newly waiting to every browser. */
  see(project: string, id: string, needs: Needs, pageUrl: string | null): void {
    const before = this.seen[id];
    const { seen, fresh } = track(before, needs, this.now());
    if (JSON.stringify(seen) !== JSON.stringify(before)) {
      this.seen[id] = seen;
      this.write("seen.json", this.seen); // before sending: a crash must not send twice
    }
    for (const item of fresh) for (const sub of this.subscriptions()) this.send(sub, { project, id, item, pageUrl }, 0);
  }

  /** Resolves when nothing is on its way to a push service (retries still waiting their turn are not). */
  async idle(): Promise<void> {
    while (this.sending.size) await Promise.all(this.sending);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.retries) clearTimeout(t);
    this.retries.clear();
  }

  private send(sub: Subscription, what: { project: string; id: string; item: NeedsItem; pageUrl: string | null }, tried: number): void {
    const { project, id, item, pageUrl } = what;
    const task = `${project}/${item.id}`, who = nameOf(sub), m = randomBytes(12).toString("hex");
    this.messages.set(m, { who, task });
    if (this.messages.size > 500) this.messages.delete(this.messages.keys().next().value!);
    const said = (reply: string) => this.note(`deck: sent ${task} "${cut(item.title, 60)}" to browser ${who}; ${reply}`);
    // `why` can be long (the service's own words): it goes last, where a cut costs nothing
    const again = (outcome: string, why: string) => {
      const wait = this.retryMs[tried];
      if (wait === undefined) return said(`${outcome}, giving up: ${why}`);
      said(`${outcome}, trying again in ${Math.round(wait / 1000)} s: ${why}`);
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        const held = this.seen[id]?.held[item.id];
        if (held && !held.left && held.wait === item.wait && this.subscriptions().some((s) => s.endpoint === sub.endpoint)) this.send(sub, what, tried + 1);
      }, wait);
      timer.unref?.();
      this.retries.add(timer);
    };
    const job = (async () => {
      const body = encryptPush(Buffer.from(JSON.stringify({ m, title: cut(item.title, TITLE_MAX), body: item.reason, tag: `fm:${project}:${item.id}`, url: pageUrl })), sub.keys);
      let res: Response;
      try {
        res = await this.fetch(sub.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body: new Uint8Array(body),
          headers: { Authorization: vapid(sub.endpoint, this.keys), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(TTL_SECONDS), Urgency: "high" } });
      } catch (e) {
        if (!this.stopped) again("could not reach the push service", (e as Error).message);
        return;
      }
      if (this.stopped) return;
      const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 100);
      const replied = `push service replied ${res.status}`;
      if (res.status === 404 || res.status === 410) {
        this.write("subscriptions.json", this.subscriptions().filter((s) => s.endpoint !== sub.endpoint));
        said(`${replied}, this browser's subscription is gone and forgotten: ${text}`);
      } else if (res.status === 429 || res.status >= 500) again(replied, text);
      else said(text ? `${replied}: ${text}` : replied);
    })().catch((e) => this.warn(`push to ${who} failed: ${(e as Error).message}`));
    this.sending.add(job);
    void job.finally(() => this.sending.delete(job));
  }

  /**
   * The deck's web server, under /_push/: `GET ` the opt-in page, `GET sw.js` the worker, `POST subscribe {k, sub}`,
   * `POST report {k | m, e, d}` (the page proves itself with the link's key, the worker with the id of a message it got).
   */
  route(path: string, method: string, body: string, from: { ip: string; agent: string }): PushReply {
    const done = (code: number, text = "", type = "text/plain"): PushReply => ({ code, type, body: text });
    if (method === "GET" && path === "/_push/") {
      this.note(`deck: opt-in page requested from ${from.ip} (${from.agent})`);
      return done(200, notifyPageHtml(this.keys.publicKey), "text/html; charset=utf-8");
    }
    if (method === "GET" && path === "/_push/sw.js") return done(200, serviceWorkerScript(), "text/javascript; charset=utf-8");
    if (method !== "POST" || (path !== "/_push/subscribe" && path !== "/_push/report")) return done(404);
    let v: any;
    try { v = JSON.parse(body); } catch { return done(400); }
    const given = Buffer.from(String(v?.k ?? "")), key = Buffer.from(this.keys.key);
    const keyed = given.length === key.length && timingSafeEqual(given, key);
    const message = this.messages.get(String(v?.m ?? ""));
    if (!keyed && !(message && path === "/_push/report")) {
      if (v?.k) this.note("deck: refused an out-of-date key");
      return done(403);
    }
    if (path === "/_push/report") {
      const e = String(v.e), d = String(v.d ?? "");
      const table: object = keyed ? PAGE_REPORTS : WORKER_REPORTS;
      if (!Object.hasOwn(table, e)) return done(400);
      this.note(keyed ? PAGE_REPORTS[e](d) : WORKER_REPORTS[e](message!.who, message!.task, d));
      return done(204);
    }
    const sub = validSubscription(v.sub);
    if (!sub) { this.note("deck: refused a subscription that is not a push service address with valid keys"); return done(400); }
    this.write("subscriptions.json", [...this.subscriptions().filter((s) => s.endpoint !== sub.endpoint), sub].slice(-MAX_SUBSCRIPTIONS));
    this.note(`deck: browser ${nameOf(sub)} subscribed (from ${from.ip}, ${from.agent})`);
    return done(204);
  }

  private subscriptions(): Subscription[] { return this.read("subscriptions.json", []); }

  private file(name: string): string { return join(this.dir, name); }

  private read<T>(name: string, otherwise: T): T {
    try { return JSON.parse(readFileSync(this.file(name), "utf8")); } catch { return otherwise; }
  }

  private write(name: string, value: unknown): void {
    const tmp = this.file(`.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file(name));
  }

  /** Add one line to push.log, keeping the newer half when it grows large. Never throws: it is only a diary. */
  private note(line: string): void {
    try {
      const file = this.file("push.log");
      const text = line.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim().slice(0, LINE_MAX);
      appendFileSync(file, `${new Date().toLocaleString("sv-SE")} ${text}\n`, { mode: 0o600 });
      if (statSync(file).size <= LOG_MAX) return;
      const tail = readFileSync(file, "utf8").slice(-LOG_MAX / 2);
      writeFileSync(file, tail.slice(tail.indexOf("\n") + 1));
    } catch {}
  }
}
