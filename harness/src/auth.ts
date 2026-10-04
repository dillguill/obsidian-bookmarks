import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** Sessions last this long after the last request that used them. */
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const KEY_PREFIX = "bm_";

export interface ApiKey {
  id: string;
  name: string;
  /** First characters of the key, so it can be told apart in the list. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeyRow {
  id: string;
  name: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const random = (bytes: number) => randomBytes(bytes).toString("base64url");

async function hashPassword(password: string, salt = randomBytes(16)): Promise<string> {
  const hash = await scryptAsync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): string | null {
  return password.length < 8 ? "Use at least 8 characters for the password." : null;
}

/**
 * The settings page's sign-in account, its sessions, and the API keys made on
 * the page. Secrets are stored only as hashes; a key is shown once, when made.
 */
export class AuthStore {
  private readonly db: DatabaseSync;
  private code: string | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        hint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
  }

  /**
   * One-time code, written to the server's log, that whoever creates the
   * account must enter: proof they run the server. Null once an account exists.
   */
  setupCode(): string | null {
    if (this.username()) return (this.code = null);
    if (!this.code) {
      this.code = random(9);
      console.log(`No sign-in account yet. Open the settings page and create one with setup code: ${this.code}`);
    }
    return this.code;
  }

  username(): string | null {
    const row = this.db.prepare("SELECT username FROM account WHERE id = 1").get() as { username: string } | undefined;
    return row?.username ?? null;
  }

  /** Creates the one account; false when one already exists. */
  async createAccount(username: string, password: string): Promise<boolean> {
    if (this.username()) return false;
    this.db.prepare("INSERT INTO account (id, username, password) VALUES (1, ?, ?)").run(username, await hashPassword(password));
    this.code = null;
    return true;
  }

  async verify(username: string, password: string): Promise<boolean> {
    const row = this.db.prepare("SELECT username, password FROM account WHERE id = 1").get() as
      | { username: string; password: string }
      | undefined;
    // Hash anyway when there's no match, so timing doesn't reveal the username.
    const ok = await checkPassword(password, row?.password ?? (await hashPassword("")));
    return Boolean(row) && row!.username === username && ok;
  }

  /** Sets a new password and signs out every session. */
  async setPassword(password: string): Promise<void> {
    this.db.prepare("UPDATE account SET password = ? WHERE id = 1").run(await hashPassword(password));
    this.db.prepare("DELETE FROM sessions").run();
  }

  /** Removes the account and its sessions, so the page asks to create one again (password reset). */
  resetAccount(): void {
    this.db.prepare("DELETE FROM account").run();
    this.db.prepare("DELETE FROM sessions").run();
    this.code = null;
  }

  createSession(): string {
    const id = random(32);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    this.db.prepare("INSERT INTO sessions (hash, expires_at) VALUES (?, ?)").run(sha256(id), Date.now() + SESSION_MS);
    return id;
  }

  /** True for a live session; extends it. */
  touchSession(id: string): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET expires_at = ? WHERE hash = ? AND expires_at >= ?")
      .run(Date.now() + SESSION_MS, sha256(id), Date.now());
    return result.changes > 0;
  }

  endSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(sha256(id));
  }

  /** Makes a key; the returned secret is never stored and can't be shown again. */
  createKey(name: string): { key: ApiKey; secret: string } {
    const secret = KEY_PREFIX + random(32);
    const id = random(9);
    const now = new Date().toISOString();
    const hint = secret.slice(0, KEY_PREFIX.length + 4);
    this.db.prepare("INSERT INTO api_keys (id, name, hash, hint, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, sha256(secret), hint, now);
    return { key: { id, name, hint, createdAt: now, lastUsedAt: null }, secret };
  }

  listKeys(): ApiKey[] {
    const rows = this.db.prepare("SELECT id, name, hint, created_at, last_used_at FROM api_keys ORDER BY created_at").all() as unknown as KeyRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, hint: row.hint, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
  }

  revokeKey(id: string): boolean {
    return this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
  }

  /** True for a key made on the settings page; records when it was last used (to the minute). */
  useKey(secret: string): boolean {
    if (!secret.startsWith(KEY_PREFIX)) return false;
    const hash = sha256(secret);
    const row = this.db.prepare("SELECT last_used_at FROM api_keys WHERE hash = ?").get(hash) as { last_used_at: string | null } | undefined;
    if (!row) return false;
    const now = new Date().toISOString();
    if (row.last_used_at?.slice(0, 16) !== now.slice(0, 16)) this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE hash = ?").run(now, hash);
    return true;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Counts failed sign-ins per client address; after `limit` failures within
 * the window, that address is turned away until the window passes.
 */
export class Throttle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(client: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.failures.get(client) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(client, list);
    else this.failures.delete(client);
    return list;
  }

  blocked(client: string): boolean {
    return this.recent(client).length >= this.limit;
  }

  fail(client: string): void {
    this.failures.set(client, [...this.recent(client), Date.now()]);
  }

  clear(client: string): void {
    this.failures.delete(client);
  }
}
