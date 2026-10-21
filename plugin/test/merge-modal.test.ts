import { describe, expect, it, vi } from "vitest";

// The modal classes only need to exist; this test looks at member names, not behaviour.
vi.mock("obsidian", () => ({ Modal: class {}, SuggestModal: class {}, AbstractInputSuggest: class {}, setIcon: () => {} }));

const { MergeModal } = await import("../src/merge-modal");
const { Picker } = await import("../src/source-picker");

/**
 * Properties Obsidian sets on every Modal / SuggestModal instance (read from Obsidian 1.14). A method
 * with one of these names is shadowed and stops working: `selection()` did, and the merge button
 * never got its label or ran.
 */
const OBSIDIAN_MODAL_PROPERTIES = [
  "app", "bgEl", "bgOpacity", "chooser", "containerEl", "contentEl", "ctaEl", "dimBackground", "emptyStateText",
  "hasInitialInputFocus", "headerEl", "inputEl", "instructionsEl", "isOpen", "limit", "modalEl", "onWindowClose",
  "popout", "popoutStorageKey", "quitRef", "resultContainerEl", "scope", "selection", "shouldAnimateOpen",
  "shouldRestoreSelection", "titleEl", "unloadHandler", "win", "windowTitle",
];

describe("merge modals", () => {
  it.each([MergeModal, Picker])("%o doesn't reuse a name Obsidian's Modal sets", (Modal) => {
    const members = Object.getOwnPropertyNames(Modal.prototype);
    expect(members.filter((name) => OBSIDIAN_MODAL_PROPERTIES.includes(name))).toEqual([]);
  });
});
