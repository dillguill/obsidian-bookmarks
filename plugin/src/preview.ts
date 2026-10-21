import type { Job, RenderedNote } from "./api";
import type { ServerClient } from "./client";

const POLL_MS = 500;
/** How long to wait for a page to be read before giving up. */
const READ_TIMEOUT_MS = 45_000;

/** A preview the modal is showing. */
export interface Preview {
  job: Job;
  /** Its note has been read, so its page is held on the server. */
  read: boolean;
}

/**
 * Starts a preview of a page and waits for its note. `started` gets the job as
 * soon as the server has it, so it can be let go if the user moves on.
 * `template` null lets the server match one (schema rules too).
 */
export async function readPreview(client: ServerClient, url: string, template: string | null, started: (job: Job) => void): Promise<{ job: Job; note: RenderedNote }> {
  let job = await client.capture(url, "plugin", false, template, [], "preview");
  started(job);
  const until = Date.now() + READ_TIMEOUT_MS;
  // Done once the note is out, or the page is held without one (the template couldn't render).
  while (!job.assets.includes("note") && !job.heldUntil && (job.status === "pending" || job.status === "running")) {
    if (Date.now() > until) throw new Error("the server is taking too long to read the page");
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
    job = await client.job(job.id);
  }
  if (job.status === "failed") throw new Error(job.error ?? "unknown error");
  if (!job.assets.includes("note")) throw new Error("the template couldn't be rendered on this page");
  const note = JSON.parse(await client.assetText(job.id, "note")) as RenderedNote;
  return { job, note };
}

/** Lets go of a preview nobody saved: cancelled while it's still reading, released once its page is held. */
export async function letGo(client: ServerClient, preview: Preview): Promise<void> {
  await (preview.read ? client.release(preview.job.id, false) : client.cancel(preview.job.id)).catch(() => {});
}
