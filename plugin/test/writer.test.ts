import { beforeEach, describe, expect, it } from "vitest";
import { fileMarker, type Job, type RenderedNote } from "../src/api";
import { DedupIndex } from "../src/dedup";
import { DEFAULT_TEMPLATE } from "../src/template";
import { writeBookmark, type VaultPort } from "../src/writer";

class MemoryVault implements VaultPort {
  files = new Map<string, string | ArrayBuffer>();
  folders = new Set<string>();
  async exists(path: string) {
    return this.files.has(path);
  }
  async ensureFolder(path: string) {
    this.folders.add(path);
  }
  async writeBinary(path: string, data: ArrayBuffer) {
    this.files.set(path, data);
  }
  async createNote(path: string, content: string) {
    if (this.files.has(path)) throw new Error("exists");
    this.files.set(path, content);
  }
  async replaceNote(path: string, content: string) {
    if (!this.files.has(path)) throw new Error("missing");
    this.files.set(path, content);
  }
}

const job = (over: Partial<Job> = {}): Job => ({
  id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
  url: "https://www.example.com/post?utm_source=x",
  origin: "shortcut",
  status: "done",
  error: null,
  createdAt: "2026-10-02T19:00:00.000Z",
  updatedAt: "2026-10-02T19:00:05.000Z",
  meta: {
    finalUrl: "https://www.example.com/post?utm_source=x",
    canonical: "https://example.com/post",
    title: "A Post",
    description: "About things",
    author: "Ann",
    site: "Example",
    domain: "example.com",
    published: "",
    image: "",
    favicon: "",
    wordCount: 100,
    httpStatus: 200,
    truncated: false,
  },
  assets: ["screenshot_page", "markdown"],
  screenshotExt: "jpg",
  ...over,
});

describe("writeBookmark", () => {
  let vault: MemoryVault;
  let index: DedupIndex;
  const now = new Date("2026-10-02T12:00:00");
  const options = () => ({ vault, index, template: DEFAULT_TEMPLATE, notesFolder: "Bookmarks/notes", assetsFolder: "Bookmarks/assets", now });

  beforeEach(() => {
    vault = new MemoryVault();
    index = new DedupIndex();
  });

  it("writes the screenshot and a note with frontmatter and body", async () => {
    const result = await writeBookmark({ job: job(), markdown: "Hello **world**", files: { screenshot_page: new ArrayBuffer(3) } }, options());
    expect(result).toEqual({ kind: "written", path: "Bookmarks/notes/example-com-a-post-2026-10-02.md" });
    expect(vault.files.has("Bookmarks/assets/example-com-a-post-2026-10-02.jpg")).toBe(true);
    const note = vault.files.get(result.path) as string;
    expect(note).toContain('source: "https://example.com/post"');
    expect(note).toContain('screenshot: "[[Bookmarks/assets/example-com-a-post-2026-10-02.jpg]]"');
    expect(note).toContain("---\n\n![[Bookmarks/assets/example-com-a-post-2026-10-02.jpg]]\n\nHello **world**\n");
  });

  it("drops ![[{{screenshot_page}}]] when the fallback note has no screenshot", async () => {
    const result = await writeBookmark({ job: job({ screenshotExt: null }), markdown: "Hello", files: {} }, options());
    const note = vault.files.get(result.path) as string;
    expect(note).toContain('screenshot: ""');
    expect(note).not.toContain("[[");
    expect(note).not.toContain("bookmarks-");
  });

  it("saves every capture file under the note's name", async () => {
    const note: RenderedNote = {
      template: "Clips",
      noteName: "All",
      path: "Clips",
      frontmatter: "---\n---\n",
      content: ["screenshot_mobile", "screenshot_page_dark", "screenshot_banner_dark", "pdf_page", "tiktok_video"].map((k) => `![[${fileMarker(k as "pdf_page")}]]`).join("\n"),
    };
    const files = { screenshot_mobile: new ArrayBuffer(1), screenshot_page_dark: new ArrayBuffer(1), screenshot_banner_dark: new ArrayBuffer(1), pdf_page: new ArrayBuffer(1), tiktok_video: new ArrayBuffer(1) };
    const result = await writeBookmark({ job: job(), markdown: "", files, note }, options());
    expect(vault.files.get(result.path)).toBe(
      "---\n---\n![[Bookmarks/assets/All-mobile.jpg]]\n![[Bookmarks/assets/All-dark.jpg]]\n![[Bookmarks/assets/All-banner-dark.jpg]]\n![[Bookmarks/assets/All.pdf]]\n![[Bookmarks/assets/All-tiktok-video.mp4]]\n",
    );
  });

  it("is idempotent by capture_id and dedups by URL", async () => {
    await writeBookmark({ job: job(), markdown: "", files: {} }, options());
    expect((await writeBookmark({ job: job(), markdown: "", files: {} }, options())).kind).toBe("already-written");
    const again = await writeBookmark({ job: job({ id: "01JABCDEFGHJKMNPQRSTVWXYZ1", url: "http://example.com/post/" }), markdown: "", files: {} }, options());
    expect(again.kind).toBe("duplicate");
    expect(vault.files.size).toBe(1);
  });

  it("suffixes the filename when the name is taken", async () => {
    vault.files.set("Bookmarks/notes/example-com-a-post-2026-10-02.md", "someone else's note");
    const result = await writeBookmark({ job: job(), markdown: "", files: {} }, options());
    expect(result.path).toBe("Bookmarks/notes/example-com-a-post-2026-10-02-2.md");
  });

  it("writes the server-rendered note, filling in the screenshot path", async () => {
    const note: RenderedNote = {
      template: "Clips",
      noteName: "A Post: notes",
      path: "Clips/example.com/",
      frontmatter: `---\nsource: "https://example.com/post"\ncover: "[[${fileMarker("screenshot_page")}]]"\ncapture_id: "${job().id}"\n---\n`,
      content: `![[${fileMarker("screenshot_page")}]]\n\n# Body`,
    };
    const result = await writeBookmark({ job: job(), markdown: "ignored", files: { screenshot_page: new ArrayBuffer(3) }, note }, options());
    expect(result).toEqual({ kind: "written", path: "Clips/example.com/A Post notes.md" });
    expect(vault.files.has("Bookmarks/assets/A Post notes.jpg")).toBe(true);
    expect(vault.files.get(result.path)).toBe(
      `---\nsource: "https://example.com/post"\ncover: "[[Bookmarks/assets/A Post notes.jpg]]"\ncapture_id: "${job().id}"\n---\n![[Bookmarks/assets/A Post notes.jpg]]\n\n# Body\n`,
    );
    expect(index.findByUrl("https://example.com/post")).toBe(result.path);

    // Without a screenshot the marker disappears.
    const second = await writeBookmark({ job: job({ id: "01JABCDEFGHJKMNPQRSTVWXYZ1", url: "https://example.com/other", meta: null, screenshotExt: null }), markdown: "", files: {}, note }, options());
    expect(vault.files.get(second.path)).toBe(`---\nsource: "https://example.com/post"\ncover: ""\ncapture_id: "${job().id}"\n---\n# Body\n`);
  });

  it("saves the banner shot next to the note and fills {{screenshot_banner}}", async () => {
    const note: RenderedNote = {
      template: "Clips",
      noteName: "Banner",
      path: "Clips",
      frontmatter: `---\nbanner: "[[${fileMarker("screenshot_banner")}]]"\npage: "${fileMarker("screenshot_page")}"\n---\n`,
      content: `![[${fileMarker("screenshot_banner")}]]`,
    };
    const result = await writeBookmark({ job: job(), markdown: "", files: { screenshot_banner: new ArrayBuffer(3) }, note }, options());
    expect(vault.files.has("Bookmarks/assets/Banner-banner.jpg")).toBe(true);
    expect(vault.files.get(result.path)).toBe(`---\nbanner: "[[Bookmarks/assets/Banner-banner.jpg]]"\npage: ""\n---\n![[Bookmarks/assets/Banner-banner.jpg]]\n`);
  });

  it("leaves capture_id out when hidden and still skips a capture it already wrote", async () => {
    const written = new Map<string, string>();
    const opts = { ...options(), hideCaptureId: true, writtenCapture: (id: string) => written.get(id) ?? null };
    const first = await writeBookmark({ job: job(), markdown: "", files: {} }, opts);
    expect(vault.files.get(first.path)).not.toContain("capture_id");
    written.set(job().id, first.path);
    // A fresh index (Obsidian restarted) has no capture ids, since the frontmatter has none.
    index = new DedupIndex();
    expect(await writeBookmark({ job: job(), markdown: "", files: {} }, { ...opts, index })).toEqual({ kind: "already-written", path: first.path });
  });

  it("keeps the link when capture failed", async () => {
    const url = "https://www.nytimes.com/2026/10/01/technology/rogue-agents.html";
    const blockPage = { ...job().meta!, title: "Just a moment...", finalUrl: url, canonical: null };
    const failed = job({ status: "failed", error: "Blocked by site: bot wall", assets: [], screenshotExt: null, meta: blockPage, url });
    const result = await writeBookmark({ job: failed, markdown: "", files: {} }, options());
    const note = vault.files.get(result.path) as string;
    expect(result.path).toBe("Bookmarks/notes/nytimes-com-rogue-agents-2026-10-02.md");
    expect(note).toContain(`source: "${url}"`);
    expect(note).toContain('title: "rogue agents"');
    expect(note).toContain("> [!warning] Capture failed\n> Blocked by site: bot wall");
    expect(note).toContain("> [Retry capture](obsidian://bookmarks?action=retry&path=Bookmarks%2Fnotes%2Fnytimes-com-rogue-agents-2026-10-02.md)");

    // Retrying overwrites the same note instead of tripping URL dedup.
    const retried = await writeBookmark(
      { job: job({ id: "01JABCDEFGHJKMNPQRSTVWXYZ2", url, meta: { ...job().meta!, finalUrl: url, canonical: null } }), markdown: "Full text", files: {} },
      { ...options(), mode: { kind: "replace", path: result.path } },
    );
    expect(retried).toEqual({ kind: "written", path: result.path });
    expect(vault.files.get(result.path)).not.toContain("Capture failed");
    expect(vault.files.get(result.path)).toContain("Full text");
  });

  it("saves a second note for the same page when asked", async () => {
    const first = await writeBookmark({ job: job(), markdown: "", files: {} }, options());
    const again = job({ id: "01JABCDEFGHJKMNPQRSTVWXYZ3" });
    expect((await writeBookmark({ job: again, markdown: "", files: {} }, options())).kind).toBe("duplicate");
    const second = await writeBookmark({ job: again, markdown: "", files: {} }, { ...options(), mode: { kind: "new" } });
    expect(second.kind).toBe("written");
    expect(second.path).not.toBe(first.path);
  });

  it("ignores a canonical link that points at another site", async () => {
    const shared = job({ meta: { ...job().meta!, canonical: "https://syndicator.example.net/post" } });
    await writeBookmark({ job: shared, markdown: "", files: {} }, options());
    expect(index.findByUrl("https://example.com/post")).not.toBeNull();
  });
});

describe("DedupIndex", () => {
  it("tracks renames and deletes", () => {
    const index = new DedupIndex();
    index.set("a.md", "https://example.com/x", "id1");
    index.rename("a.md", "b.md");
    expect(index.findByUrl("https://www.example.com/x/")).toBe("b.md");
    expect(index.findByCaptureId("id1")).toBe("b.md");
    index.remove("b.md");
    expect(index.findByUrl("https://example.com/x")).toBeNull();
    expect(index.size).toBe(0);
  });
});
