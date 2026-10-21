import { Notice, TFile, getFrontMatterInfo, parseLinktext, stringifyYaml, type App } from "obsidian";
import { errorText } from "./errors";
import { imageLink, redirectFrontmatter, redirectedLink, spliceSpans, type Span } from "./links";
import { appendBodies, applyMergedProperties, countsAsDuplicate, keptFrom, mergeChoices, mergePlan, rankNotes, unusedFiles, type MergeNote } from "./merge";
import { duplicatePicker, MergeModal, type DuplicateEntry, type MergePreview, type MergeSelection } from "./merge-modal";
import type BookmarksPlugin from "./main";
import { captureIdPropertyName } from "./template";

/** Finding duplicate bookmarks and merging, deleting or keeping them apart. */
export class MergeController {
  constructor(private readonly plugin: BookmarksPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  // ---- duplicates ----

  /** A group still worth offering: two or more notes not marked separate. */
  isDuplicate(key: string): boolean {
    return countsAsDuplicate(this.plugin.index.paths(key), this.plugin.settings.separateNotes?.[key] ?? []);
  }

  /** Lists every duplicate group in the vault and resolves the picked one, then the ones after it. */
  findDuplicates(): void {
    const entries: DuplicateEntry[] = this.plugin.index
      .groups()
      .filter(({ key }) => this.isDuplicate(key))
      .map(({ key, paths }) => {
        const separate = this.plugin.settings.separateNotes?.[key] ?? [];
        const first = this.app.vault.getAbstractFileByPath(paths[0]!);
        const url = (first instanceof TFile && this.plugin.noteUrl(first)) || key;
        const names = paths.map((p) => p.replace(/^.*\//, "").replace(/\.md$/, ""));
        return { key, url, names, active: paths.filter((p) => !separate.includes(p)).length };
      })
      .sort((a, b) => b.active - a.active || a.url.localeCompare(b.url));
    if (!entries.length) {
      new Notice("No duplicate bookmarks.");
      return;
    }
    duplicatePicker(this.app, entries, (entry) => {
      const after = entries.slice(entries.indexOf(entry) + 1).map((e) => e.key);
      this.open(entry.key, after);
    }).open();
  }

  /** Opens the merge view for a group; with a queue, the next group still worth offering opens after it. */
  open(key: string, queue?: string[]): void {
    const notes = this.mergeNotes(key);
    if (notes.length < 2) return;
    const first = this.app.vault.getAbstractFileByPath(notes[0]!.path);
    const sources = this.linkSources();
    const next = () => {
      if (!queue) return;
      const i = queue.findIndex((k) => this.isDuplicate(k));
      if (i >= 0) this.open(queue[i]!, queue.slice(i + 1));
    };
    new MergeModal(
      this.app,
      { url: (first instanceof TFile && this.plugin.noteUrl(first)) || key, notes, separate: this.plugin.settings.separateNotes?.[key] ?? [] },
      {
        skip: this.mergeSkip(),
        propertyNames: () => this.plugin.vaultProperties(),
        imageSrc: (value, from) => this.imageSrc(value, from),
        preview: (selection) => this.previewMerge(notes, selection, sources),
        spelling: this.propertySpelling(),
        unusedCount: (selection) => this.unusedFor(notes, selection, sources).length,
        onApply: (selection) =>
          void this.applyMerge(key, selection).then(next, (err: unknown) => {
            console.error("bookmarks: merge failed", err);
            new Notice(`Couldn't merge: ${errorText(err)}`, 0);
          }),
        onSkip: queue ? next : undefined,
      },
    ).open();
  }

  /**
   * What a merge would do, for the preview: the kept note's text before and
   * after (frontmatter written the way processFrontMatter writes it, so only
   * real changes show), the deleted notes' text, and how many links elsewhere
   * get pointed at the kept note.
   */
  private async previewMerge(notes: readonly MergeNote[], selection: MergeSelection, sources: Map<string, string[]>): Promise<MergePreview> {
    const file = (path: string) => this.app.vault.getAbstractFileByPath(path) as TFile;
    const read = async (path: string) => this.app.vault.cachedRead(file(path));
    const bodyOf = (text: string) => text.slice(getFrontMatterInfo(text).contentStart);
    const kept = notes.find((n) => selection.state.get(n.path) === "keep");
    const having = (d: string) => notes.filter((n) => selection.state.get(n.path) === d);
    const merged = kept ? having("merge") : [];
    const deleted = kept ? having("delete") : [];
    const removed = new Set([...merged, ...deleted].map((n) => n.path));
    const redirects = [...removed].reduce((count, path) => count + (sources.get(path) ?? []).filter((source) => !removed.has(source)).length, 0);
    const deletedText = await Promise.all(deleted.map(async (n) => ({ name: n.basename, text: await read(n.path) })));
    if (!kept) return { kept: null, merged: [], deleted: deletedText, redirects: 0 };

    const bodies: Record<string, string> = {};
    for (const n of merged) bodies[n.path] = bodyOf(await read(n.path));
    const plan = mergePlan({ notes, state: selection.state, choices: selection.choices, picks: selection.picks, bodies });
    const text = await read(kept.path);
    const before = this.plugin.frontmatterOf(file(kept.path));
    const after = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
    applyMergedProperties(after, plan);
    const withFrontmatter = (frontmatter: Record<string, unknown>) => (Object.keys(frontmatter).length ? `---\n${stringifyYaml(frontmatter)}---\n` : "");
    const head = withFrontmatter(after);
    return {
      kept: { name: kept.basename, before: withFrontmatter(before) + bodyOf(text), after: appendBodies(head + bodyOf(text), plan, head.length) },
      merged: merged.map((n) => n.basename),
      deleted: deletedText,
      redirects,
    };
  }

  /** Where a property value's image loads from, for previews: a vault file's resource path or a web address. */
  private imageSrc(value: unknown, from: string): string | null {
    const image = imageLink(value);
    if (!image) return null;
    if ("url" in image) return image.url;
    const file = this.app.metadataCache.getFirstLinkpathDest(image.vault, from);
    return file ? this.app.vault.getResourcePath(file) : null;
  }

  /** URL and capture id property names, which a merge never offers or changes. */
  private mergeSkip(): string[] {
    return [...this.plugin.urlNames(), ...this.plugin.templates.map(captureIdPropertyName)];
  }

  /** Target path -> notes linking to it, from the resolved link index. */
  private linkSources(): Map<string, string[]> {
    const sources = new Map<string, string[]>();
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      for (const target of Object.keys(targets)) sources.set(target, [...(sources.get(target) ?? []), source]);
    }
    return sources;
  }

  /** A group's notes, as the merge works with them, in the order they're offered as the one to keep. */
  private mergeNotes(key: string): MergeNote[] {
    const sources = this.linkSources();
    const captureIds = this.plugin.templates.map(captureIdPropertyName);
    const notes: MergeNote[] = [];
    for (const path of this.plugin.index.paths(key)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const frontmatter = this.plugin.frontmatterOf(file);
      const dated = ["created", "date", "captured"].map((name) => Date.parse(String(frontmatter[name] ?? ""))).find(Number.isFinite);
      notes.push({
        path,
        basename: file.basename,
        folder: file.parent && file.parent.path !== "/" ? file.parent.path : "",
        frontmatter,
        backlinks: (sources.get(path) ?? []).filter((source) => source !== path).length,
        hasCaptureId: captureIds.some((name) => typeof frontmatter[name] === "string" && frontmatter[name]),
        date: dated ?? null,
        ctime: file.stat.ctime,
      });
    }
    return rankNotes(notes);
  }

  /** The vault's most used spelling of each property name, by its lowercase form. */
  private propertySpelling(): (lower: string) => string | undefined {
    const counts = new Map<string, Map<string, number>>();
    for (const note of this.app.vault.getMarkdownFiles()) {
      for (const name of Object.keys(this.plugin.frontmatterOf(note))) {
        const byName = counts.get(name.toLowerCase()) ?? new Map<string, number>();
        byName.set(name, (byName.get(name) ?? 0) + 1);
        counts.set(name.toLowerCase(), byName);
      }
    }
    return (lower) => [...(counts.get(lower) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  /** Where a note's link points, resolved the way Obsidian resolves it. */
  private linkTarget(link: string, source: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path, source);
  }

  /** Files only the notes this selection removes use, which the merge can trash. */
  private unusedFor(notes: readonly MergeNote[], selection: MergeSelection, sources = this.linkSources()): string[] {
    const removed = notes.filter((n) => ["merge", "delete"].includes(selection.state.get(n.path) ?? "")).map((n) => n.path);
    if (!selection.state.size || ![...selection.state.values()].includes("keep") || !removed.length) return [];
    const { resolvedLinks } = this.app.metadataCache;
    // What the kept note takes over: links in merged bodies, and in properties whose value comes along.
    const carried: string[] = [];
    for (const path of removed.filter((p) => selection.state.get(p) === "merge")) {
      const cache = this.app.metadataCache.getCache(path);
      for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
        const target = this.linkTarget(ref.link, path);
        if (target) carried.push(target.path);
      }
      for (const ref of cache?.frontmatterLinks ?? []) {
        const choice = selection.choices.find((c) => c.name.toLowerCase() === ref.key.replace(/\.\d+$/, "").toLowerCase());
        const kept = choice && (choice.kind !== "conflict" || keptFrom(choice, selection.picks[choice.name]).includes(path));
        const target = kept ? this.linkTarget(ref.link, path) : null;
        if (target) carried.push(target.path);
      }
    }
    return unusedFiles({
      removed,
      linksFrom: (path) => Object.keys(resolvedLinks[path] ?? {}),
      linkedBy: (target) => sources.get(target) ?? [],
      carried,
      isNote: (path) => path.endsWith(".md"),
    });
  }

  /**
   * Applies a merge: links to the removed notes are pointed at the kept note,
   * the kept note gets the chosen properties and the merged bodies, separate
   * marks are saved, and only then are the removed notes and their unused files
   * trashed. Stops at the first step that fails and says what's left undone.
   */
  private async applyMerge(key: string, selection: MergeSelection): Promise<void> {
    const notes = this.mergeNotes(key);
    if ([...selection.state.keys()].some((path) => !notes.some((n) => n.path === path))) {
      new Notice("The notes changed while the merge view was open. Nothing was merged; open it again.");
      return;
    }
    const kept = notes.find((n) => selection.state.get(n.path) === "keep");
    const merging = notes.filter((n) => selection.state.get(n.path) === "merge");
    // Values come from the notes as they are now, in case one changed while the view was open.
    const choices = kept ? mergeChoices([kept, ...merging], this.mergeSkip(), this.propertySpelling()) : [];
    let files: string[] = [];
    try {
      if (selection.removeFiles) files = this.unusedFor(notes, { ...selection, choices });
    } catch (err) {
      // Leaving files in place is safe; the merge itself can go ahead.
      console.error("bookmarks: couldn't work out unused files", err);
    }
    const draft = mergePlan({ notes, state: selection.state, choices, picks: selection.picks, bodies: {} });
    if (!draft.kept) {
      await this.saveSeparate(key, draft.separate);
      new Notice("Saved.");
      return;
    }
    const keptFile = this.app.vault.getAbstractFileByPath(draft.kept) as TFile;
    const removed = [...draft.merge, ...draft.delete];
    let step = "redirect links";
    let redirected = 0;
    let trashed = 0;
    try {
      redirected = await this.redirectLinks(removed, keptFile);

      step = `update “${keptFile.basename}”`;
      const bodies: Record<string, string> = {};
      for (const path of draft.merge) {
        const text = await this.app.vault.read(this.app.vault.getAbstractFileByPath(path) as TFile);
        bodies[path] = text.slice(getFrontMatterInfo(text).contentStart);
      }
      const plan = mergePlan({ notes, state: selection.state, choices, picks: selection.picks, bodies });
      await this.app.fileManager.processFrontMatter(keptFile, (frontmatter: Record<string, unknown>) => applyMergedProperties(frontmatter, plan));
      if (plan.bodies.length) await this.app.vault.process(keptFile, (text) => appendBodies(text, plan, getFrontMatterInfo(text).contentStart));

      step = "save the separate notes";
      await this.saveSeparate(key, plan.separate);

      for (const path of removed) {
        step = `trash “${path}”`;
        await this.app.fileManager.trashFile(this.app.vault.getAbstractFileByPath(path)!);
      }
      for (const path of files) {
        step = `trash “${path}”`;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) await this.app.fileManager.trashFile(file);
        trashed++;
      }
    } catch (err) {
      console.error("bookmarks: merge failed", err);
      new Notice(`Merging into “${keptFile.basename}” stopped: couldn't ${step}: ${errorText(err)}. Nothing after that step was done.`, 0);
      return;
    }
    const parts = [
      draft.delete.length ? `${draft.delete.length} deleted` : "",
      `${redirected} link${redirected === 1 ? "" : "s"} redirected`,
      trashed ? `${trashed} file${trashed === 1 ? "" : "s"} removed` : "",
    ].filter(Boolean);
    const done = draft.merge.length ? `Merged ${draft.merge.length + 1} notes into “${keptFile.basename}”` : `Kept “${keptFile.basename}”`;
    new Notice(`${done}: ${parts.join(", ")}.`);
    this.plugin.openNote(keptFile.path);
  }

  /** Points every link and embed resolving to one of `removed` at `kept`, keeping headings, blocks and visible text. Returns how many. */
  private async redirectLinks(removed: readonly string[], kept: TFile): Promise<number> {
    const { metadataCache, fileManager, vault } = this.app;
    const removedSet = new Set(removed);
    const sources = Object.entries(metadataCache.resolvedLinks)
      .filter(([, targets]) => removed.some((path) => targets[path]))
      .map(([source]) => source);
    let count = 0;
    for (const source of sources) {
      const file = vault.getAbstractFileByPath(source);
      const cache = file instanceof TFile ? metadataCache.getFileCache(file) : null;
      if (!(file instanceof TFile) || !cache) continue;
      const generate = (subpath: string, alias: string) => fileManager.generateMarkdownLink(kept, source, subpath, alias);
      const spans: (Span & { original: string })[] = [];
      for (const [refs, embed] of [[cache.links ?? [], false], [cache.embeds ?? [], true]] as const) {
        for (const ref of refs) {
          const target = this.linkTarget(ref.link, source);
          if (!target || !removedSet.has(target.path)) continue;
          spans.push({
            start: ref.position.start.offset,
            end: ref.position.end.offset,
            original: ref.original,
            replacement: redirectedLink({ original: ref.original, link: ref.link, displayText: ref.displayText, embed }, target.basename, generate),
          });
        }
      }
      if (spans.length) {
        await vault.process(file, (text) => {
          // Skip any link the text no longer holds where the cache says (an edit since it was read).
          const current = spans.filter((span) => text.slice(span.start, span.end) === span.original);
          count += current.length;
          return spliceSpans(text, current);
        });
      }
      const frontmatterRefs = (cache.frontmatterLinks ?? []).filter((ref) => removedSet.has(this.linkTarget(ref.link, source)?.path ?? ""));
      if (frontmatterRefs.length) {
        await fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          for (const ref of frontmatterRefs) {
            const target = this.linkTarget(ref.link, source)!;
            const replacement = redirectedLink({ original: ref.original, link: ref.link, displayText: ref.displayText, embed: false }, target.basename, generate);
            if (redirectFrontmatter(frontmatter, ref.key, ref.original, replacement) || redirectFrontmatter(frontmatter, ref.key.replace(/\.\d+$/, ""), ref.original, replacement)) count++;
          }
        });
      }
    }
    return count;
  }

  /** Saves which notes of a group are separate on purpose, dropping marks for notes that no longer exist. */
  private async saveSeparate(key: string, paths: string[]): Promise<void> {
    const marks = { ...(this.plugin.settings.separateNotes ?? {}), [key]: paths };
    for (const [k, list] of Object.entries(marks)) {
      const existing = list.filter((p) => this.app.vault.getAbstractFileByPath(p));
      if (existing.length) marks[k] = existing;
      else delete marks[k];
    }
    this.plugin.settings.separateNotes = marks;
    await this.plugin.persist();
  }

  /** Keeps a separate mark on a note when it's renamed or moved. */
  async renameSeparate(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    for (const list of Object.values(this.plugin.settings.separateNotes ?? {})) {
      const i = list.indexOf(oldPath);
      if (i >= 0) {
        list[i] = newPath;
        changed = true;
      }
    }
    if (changed) await this.plugin.persist();
  }}
