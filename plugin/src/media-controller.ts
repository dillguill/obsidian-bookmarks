import { Notice, TFile, getFrontMatterInfo, requestUrl, type App } from "obsidian";
import type { Job, MediaAsset, MediaWant } from "./api";
import { errorText } from "./errors";
import type BookmarksPlugin from "./main";
import { findMedia, imageName, isMarked, replaceSource, type MediaItem, type MediaKind } from "./media";
import { MediaModal, type ItemState } from "./media-modal";
import { normalizeUrl } from "./url";
import { attachmentPath } from "./writer";

const POLL_MS = 2000;
/** Longest a download is waited on: a long video can take a while, and the queue may be busy. */
const WAIT_MS = 30 * 60_000;

/** Which download a server item comes from: a TikTok post's video, photos and cover come together. */
const WANTS: Record<Exclude<MediaKind, "image">, MediaWant> = { tiktok_video: "video", tiktok_photos: "photos", tiktok_cover: "cover", site_video: "video" };

/** What each item's saved files are called, after the note: <note>-video.mp4, <note>-cover.jpg, <note>-photo-2.jpg. */
const SUFFIX: Record<Exclude<MediaKind, "image">, string> = { tiktok_video: "video", tiktok_photos: "photo", tiktok_cover: "cover", site_video: "video" };

/**
 * Download media for current note: finds the note's media, lets the user pick
 * (or takes what a capture marked `|local`), downloads it one item at a time,
 * and swaps each item's player, embed or address for the saved files.
 */
export class MediaController {
  constructor(private readonly plugin: BookmarksPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  /** What in a note can be downloaded; `local` are values a template marked `|local` (see findMedia). */
  async find(file: TFile, local: readonly string[] = []): Promise<MediaItem[]> {
    const text = await this.app.vault.read(file);
    return findMedia(text.slice(getFrontMatterInfo(text).contentStart), this.plugin.frontmatterOf(file), this.plugin.noteUrl(file), local);
  }

  /** Downloads, without asking, the media a note was just added with that its template marked `|local`; values edited since don't match, so aren't saved. */
  async saveLocal(file: TFile, local: readonly string[]): Promise<void> {
    const items = (await this.find(file, local)).filter((item) => isMarked(item, local));
    if (items.length) await this.run(file, items, null);
  }

  /** Opens the picker for a note's media. */
  async download(file: TFile): Promise<void> {
    const items = await this.find(file);
    if (!items.length) {
      new Notice("There's no media to download in this note.");
      return;
    }
    const modal = new MediaModal(this.app, items, (chosen) => void this.run(file, chosen, modal));
    modal.open();
    // TikTok posts' thumbnails come from TikTok's oEmbed, so they arrive a moment later.
    for (const item of items) {
      if (item.preview || !item.kind.startsWith("tiktok_")) continue;
      void this.tiktokThumbnail(item.url).then((url) => url && modal.setPreview(item.key, url));
    }
  }

  private async tiktokThumbnail(url: string): Promise<string | null> {
    try {
      const reply = await requestUrl({ url: `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, throw: false });
      return reply.status < 400 ? ((reply.json as { thumbnail_url?: string }).thumbnail_url ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * Puts a finished follow-up download (queued by the server after a phone
   * capture) into the capture's note, with the note's other media marked
   * `|local`: images, which the plugin fetches itself.
   */
  async applyFollowUp(file: TFile, job: Job): Promise<void> {
    const local = job.media?.local ?? [];
    const items = (await this.find(file, local)).filter((item) => isMarked(item, local));
    const url = job.media?.url ?? job.url;
    const same = (a: string, b: string) => (normalizeUrl(a) ?? a) === (normalizeUrl(b) ?? b) || tiktokId(a) !== null && tiktokId(a) === tiktokId(b);
    const prefetched = new Map<string, Job>();
    for (const item of items) if (item.via === "server" && same(item.url, url)) prefetched.set(item.url, job);
    // Nothing the server fetched has a place in the note any more (edited, or already saved): just collect it.
    if (!prefetched.size) await this.plugin.client().delivered(job.id).catch(() => {});
    if (items.length) await this.run(file, items, null, prefetched);
  }

  /** Downloads the items one at a time: images here, posts and videos on the server, which spaces them out per site. `prefetched` are downloads the server already made. */
  private async run(file: TFile, items: readonly MediaItem[], modal: MediaModal | null, prefetched: ReadonlyMap<string, Job> = new Map()): Promise<void> {
    const states = new Map<string, ItemState>();
    const set = (item: MediaItem, state: ItemState) => {
      states.set(item.key, state);
      modal?.setState(item.key, state);
      modal?.progress([...states.values()].filter((s) => s.state === "done" || s.state === "failed").length, items.length);
    };
    modal?.progress(0, items.length);
    const notice = modal ? null : new Notice(`Downloading ${items.length === 1 ? items[0]!.label : `${items.length} media files`}…`, 0);

    for (const item of items.filter((i) => i.via === "plugin")) {
      set(item, { state: "working" });
      try {
        await this.saveImage(file, item);
        set(item, { state: "done" });
      } catch (err) {
        set(item, { state: "failed", reason: errorText(err) });
      }
    }

    // A TikTok cover is fetched from the address in the note while it still
    // works (its links last days), and from the post on the server after.
    const fresh: MediaItem[] = [];
    for (const item of items.filter((i) => i.kind === "tiktok_cover" && i.preview && !prefetched.has(i.url))) {
      set(item, { state: "working" });
      try {
        await this.saveImage(file, { ...item, url: item.preview! }, `${file.basename}-cover`);
        set(item, { state: "done" });
      } catch {
        fresh.push(item);
      }
    }

    // One server download per post or video page, for everything wanted from it.
    const groups = new Map<string, MediaItem[]>();
    const onServer = items.filter((i) => i.via === "server" && (i.kind !== "tiktok_cover" || !i.preview || prefetched.has(i.url) || fresh.includes(i)));
    for (const item of onServer) groups.set(item.url, [...(groups.get(item.url) ?? []), item]);
    if (groups.size) {
      try {
        await this.plugin.ready();
      } catch (err) {
        for (const group of groups.values()) for (const item of group) set(item, { state: "failed", reason: errorText(err) });
        groups.clear();
      }
    }
    for (const [url, group] of groups) {
      for (const item of group) set(item, { state: "working" });
      try {
        const job = prefetched.get(url) ?? (await this.fetchOnServer(url, [...new Set(group.map((i) => WANTS[i.kind as keyof typeof WANTS]))]));
        for (const item of group) {
          try {
            const reason = await this.saveFromJob(file, item, job);
            set(item, reason ? { state: "failed", reason } : { state: "done" });
          } catch (err) {
            set(item, { state: "failed", reason: errorText(err) });
          }
        }
        await this.plugin.client().delivered(job.id).catch(() => {});
      } catch (err) {
        for (const item of group) set(item, { state: "failed", reason: errorText(err) });
      }
    }

    notice?.hide();
    const failed = items.filter((i) => states.get(i.key)?.state === "failed");
    const done = items.length - failed.length;
    const reasons = failed.map((i) => `${i.label} (${(states.get(i.key) as { reason: string }).reason})`).join("; ");
    new Notice(failed.length ? `Downloaded ${done} of ${items.length}. ${failed.length} failed: ${reasons}.` : `Downloaded ${done === 1 ? items[0]!.label : `${done} media files`}.`, failed.length ? 10_000 : 4000);
  }

  /** Queues a download on the server and waits for it to finish. */
  private async fetchOnServer(url: string, want: MediaWant[]): Promise<Job> {
    const client = this.plugin.client();
    let job = await client.requestMedia(url, want);
    const until = Date.now() + WAIT_MS;
    while (job.status === "pending" || job.status === "running") {
      if (Date.now() > until) throw new Error("the server is still downloading it; try again later");
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      job = await client.job(job.id);
    }
    return job;
  }

  /** Saves what a finished server download made for one item and puts it in the note; the reason it didn't, or null. */
  private async saveFromJob(file: TFile, item: MediaItem, job: Job): Promise<string | null> {
    const want = WANTS[item.kind as keyof typeof WANTS];
    // A post whose URL said video can turn out to be photos, and the other way round.
    const post = item.kind === "tiktok_video" || item.kind === "tiktok_photos";
    const fits = (m: MediaWant) => m === want || (post && (m === "video" || m === "photos"));
    const made = (job.media?.made ?? []).filter((m) => fits(m.want)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (!made.length) return job.media?.errors.find((e) => fits(e.want))?.message ?? job.error ?? "nothing was downloaded";
    const client = this.plugin.client();
    const saved: TFile[] = [];
    for (const m of made) {
      const ext = m.asset === "media_video" ? "mp4" : (job.screenshotExt ?? "jpg");
      const suffix = post ? (m.want === "video" ? "video" : "photo") : SUFFIX[item.kind as keyof typeof SUFFIX];
      const name = `${file.basename}-${suffix}${m.index ? `-${m.index}` : ""}.${ext}`;
      saved.push(await this.write(file, name, await client.assetBinary(job.id, m.asset as MediaAsset)));
    }
    return (await this.place(file, item, saved)) ? null : "saved, but its place in the note was edited meanwhile";
  }

  /** Downloads a web or data: image and puts it in the note; `base` names the file, else the image's own name does. */
  private async saveImage(file: TFile, item: MediaItem, base?: string): Promise<void> {
    let data: ArrayBuffer;
    let type: string | null = null;
    let disposition: string | null = null;
    if (item.url.startsWith("data:")) {
      const comma = item.url.indexOf(",");
      const meta = item.url.slice(5, comma);
      const payload = item.url.slice(comma + 1);
      const bytes = meta.endsWith(";base64") ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(payload));
      data = bytes.buffer as ArrayBuffer;
    } else {
      const reply = await requestUrl({ url: item.url, throw: false });
      if (reply.status >= 400) throw new Error(`the site answered HTTP ${reply.status}`);
      data = reply.arrayBuffer;
      type = reply.headers["content-type"] ?? null;
      disposition = reply.headers["content-disposition"] ?? null;
    }
    if (!data.byteLength) throw new Error("the image was empty");
    const named = imageName(item.url, type, disposition);
    const saved = await this.write(file, `${base ?? named.base}.${named.ext}`, data);
    if (!(await this.place(file, item, [saved]))) throw new Error("saved, but its place in the note was edited meanwhile");
  }

  /** Writes a file where the note's attachments go and returns it. */
  private async write(file: TFile, name: string, data: ArrayBuffer): Promise<TFile> {
    const path = await attachmentPath(this.plugin.vaultPort(), this.plugin.settings.attachmentFolder, name, file.path);
    return this.app.vault.createBinary(path, data);
  }

  /** Swaps the item's place in the note for links to the saved files; false when that place is gone. */
  private async place(file: TFile, item: MediaItem, saved: readonly TFile[]): Promise<boolean> {
    const { source } = item;
    if (source.in === "property") {
      let replaced = false;
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        if (frontmatter[source.name] !== source.value) return;
        frontmatter[source.name] = `[[${this.app.metadataCache.fileToLinktext(saved[0]!, file.path, false)}]]`;
        replaced = true;
      });
      return replaced;
    }
    const embeds = saved.map((f) => `!${this.app.fileManager.generateMarkdownLink(f, file.path)}`);
    let replaced = false;
    await this.app.vault.process(file, (text) => {
      const out = replaceSource(text, source, embeds);
      replaced = out.replaced;
      return out.text;
    });
    return replaced;
  }
}

/** A TikTok post's id from its URL, so links to one post in different forms match. */
function tiktokId(url: string): string | null {
  return /tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i.exec(url)?.[1] ?? null;
}

