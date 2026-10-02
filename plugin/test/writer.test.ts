import { beforeEach, describe, expect, it } from "vitest";
import { SCREENSHOT_MARKER, type Job, type RenderedNote } from "../src/api";
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
  assets: ["screenshot", "markdown"],
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
    const result = await writeBookmark({ job: job(), markdown: "Hello **world**", screenshot: new ArrayBuffer(3) }, options());
    expect(result).toEqual({ kind: "written", path: "Bookmarks/notes/example-com-a-post-2026-10-02.md" });
    expect(vault.files.has("Bookmarks/assets/example-com-a-post-2026-10-02.jpg")).toBe(true);
    const note = vault.files.get(result.path) as string;
    expect(note).toContain('source: "https://example.com/post"');
    expect(note).toContain('screenshot: "[[Bookmarks/assets/example-com-a-post-2026-10-02.jpg]]"');
    expect(note).toContain("---\n\n![[Bookmarks/assets/example-com-a-post-2026-10-02.jpg]]\n\nHello **world**\n");
  });

  it("is idempotent by capture_id and dedups by URL", async () => {
    await writeBookmark({ job: job(), markdown: "", screenshot: null }, options());
    expect((await writeBookmark({ job: job(), markdown: "", screenshot: null }, options())).kind).toBe("already-written");
    const again = await writeBookmark({ job: job({ id: "01JABCDEFGHJKMNPQRSTVWXYZ1", url: "http://example.com/post/" }), markdown: "", screenshot: null }, options());
    expect(again.kind).toBe("duplicate");
    expect(vault.files.size).toBe(1);
  });

  it("suffixes the filename when the name is taken", async () => {
    vault.files.set("Bookmarks/notes/example-com-a-post-2026-10-02.md", "someone else's note");
    const result = await writeBookmark({ job: job(), markdown: "", screenshot: null }, options());
    expect(result.path).toBe("Bookmarks/notes/example-com-a-post-2026-10-02-2.md");
  });

  it("writes the server-rendered note, filling in the screenshot path", async () => {
    const note: RenderedNote = {
      template: "Clips",
      noteName: "A Post: notes",
      path: "Clips/example.com/",
      frontmatter: `---\nsource: "https://example.com/post"\ncover: "[[${SCREENSHOT_MARKER}]]"\ncapture_id: "${job().id}"\n---\n`,
      content: `![[${SCREENSHOT_MARKER}]]\n\n# Body`,
    };
    const result = await writeBookmark({ job: job(), markdown: "ignored", screenshot: new ArrayBuffer(3), note }, options());
    expect(result).toEqual({ kind: "written", path: "Clips/example.com/A Post notes.md" });
    expect(vault.files.has("Bookmarks/assets/A Post notes.jpg")).toBe(true);
    expect(vault.files.get(result.path)).toBe(
      `---\nsource: "https://example.com/post"\ncover: "[[Bookmarks/assets/A Post notes.jpg]]"\ncapture_id: "${job().id}"\n---\n![[Bookmarks/assets/A Post notes.jpg]]\n\n# Body\n`,
    );
    expect(index.findByUrl("https://example.com/post")).toBe(result.path);

    // Without a screenshot the marker disappears.
    const second = await writeBookmark({ job: job({ id: "01JABCDEFGHJKMNPQRSTVWXYZ1", url: "https://example.com/other", meta: null, screenshotExt: null }), markdown: "", screenshot: null, note }, options());
    expect(vault.files.get(second.path)).toBe(`---\nsource: "https://example.com/post"\ncover: ""\ncapture_id: "${job().id}"\n---\n# Body\n`);
  });

  it("leaves capture_id out when hidden and still skips a capture it already wrote", async () => {
    const written = new Map<string, string>();
    const opts = { ...options(), hideCaptureId: true, writtenCapture: (id: string) => written.get(id) ?? null };
    const first = await writeBookmark({ job: job(), markdown: "", screenshot: null }, opts);
    expect(vault.files.get(first.path)).not.toContain("capture_id");
    written.set(job().id, first.path);
    // A fresh index (Obsidian restarted) has no capture ids, since the frontmatter has none.
    index = new DedupIndex();
    expect(await writeBookmark({ job: job(), markdown: "", screenshot: null }, { ...opts, index })).toEqual({ kind: "already-written", path: first.path });
  });

  it("keeps the link when capture failed", async () => {
    const url = "https://www.nytimes.com/2026/10/01/technology/rogue-agents.html";
    const blockPage = { ...job().meta!, title: "Just a moment...", finalUrl: url, canonical: null };
    const failed = job({ status: "failed", error: "Blocked by site: bot wall", assets: [], screenshotExt: null, meta: blockPage, url });
    const result = await writeBookmark({ job: failed, markdown: "", screenshot: null }, options());
    const note = vault.files.get(result.path) as string;
    expect(result.path).toBe("Bookmarks/notes/nytimes-com-rogue-agents-2026-10-02.md");
    expect(note).toContain(`source: "${url}"`);
    expect(note).toContain('title: "rogue agents"');
    expect(note).toContain("> [!warning] Capture failed\n> Blocked by site: bot wall");
  });

  it("ignores a canonical link that points at another site", async () => {
    const shared = job({ meta: { ...job().meta!, canonical: "https://syndicator.example.net/post" } });
    await writeBookmark({ job: shared, markdown: "", screenshot: null }, options());
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
