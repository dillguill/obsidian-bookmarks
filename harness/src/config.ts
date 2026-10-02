export interface Config {
  host: string;
  port: number;
  /** Per-device bearer tokens; remove one to revoke that device (design §8). */
  tokens: ReadonlySet<string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokens = new Set(
    (env.BOOKMARKS_TOKENS ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
  return {
    // Safe default bind; the compose file publishes it explicitly.
    host: env.BOOKMARKS_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.BOOKMARKS_PORT ?? "8787", 10),
    tokens,
  };
}
