/** An error's message, for notices and status lines. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
