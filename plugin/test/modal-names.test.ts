import { describe, expect, it, vi } from "vitest";

// The modal classes only need to exist; this test looks at member names, not behaviour.
vi.mock("obsidian", () => ({ Modal: class {}, PluginSettingTab: class {}, SuggestModal: class {}, AbstractInputSuggest: class {}, Menu: class {}, Setting: class {}, setIcon: () => {} }));

const { ClipModal } = await import("../src/clip-modal");
const { CaptureModal } = await import("../src/capture-modal");
const { UpdateModal } = await import("../src/update-modal");
const { MediaModal } = await import("../src/media-modal");

/** Properties Obsidian sets on every Modal instance (read from Obsidian 1.14); a member with one of these names is shadowed. */
const OBSIDIAN_MODAL_PROPERTIES = [
  "app", "bgEl", "bgOpacity", "containerEl", "contentEl", "ctaEl", "dimBackground", "headerEl", "isOpen", "modalEl", "onWindowClose",
  "popout", "popoutStorageKey", "quitRef", "scope", "selection", "shouldAnimateOpen", "shouldRestoreSelection", "titleEl", "unloadHandler", "win", "windowTitle",
];

describe("capture modals", () => {
  it.each([ClipModal, CaptureModal, UpdateModal, MediaModal])("%o doesn't reuse a name Obsidian's Modal sets", (Modal) => {
    const members = Object.getOwnPropertyNames(Modal.prototype);
    expect(members.filter((name) => OBSIDIAN_MODAL_PROPERTIES.includes(name))).toEqual([]);
  });
});
