# Feature Specification: Clipper-style capture and media download

**Feature Branch**: `002-clipper-capture-media` (stacked on `001-merge-duplicate-bookmarks`)

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "Bookmark capture URL and update from source interfaces should take design inspiration from Obsidian Web Clipper, with a field below the template dropdown showing the pasted URL. Update from source should populate only after the user selects capture, pulling whatever quick information the template allows instead of waiting for all media (TikTok captures currently download everything first, which is slow and risks rate limits). Move media capture to a separate command that works like Obsidian's native Download attachments command but also covers TikTok videos and photos and YouTube videos. Update from source becomes the more comprehensive command for updating a note's fields or changing its template. Follow Obsidian's design philosophy: less opinionated, Obsidian-style."

## Background

Today **Capture URL** asks only for a URL and a template, then shows a "Capturing…"
notice until the server has finished everything (page load, scrolling,
screenshots, page images, and for TikTok every photo and the video). Only then is
a note written. The user never sees or edits what the template produced.

**Update note from source** opens straight away but starts fetching immediately
with an auto-matched template, always asks for the TikTok video and all carousel
photos whatever the template uses, and won't apply until all of them have
downloaded. That is the slow path, and the burst of media downloads is what risks
TikTok rate limits.

Obsidian Web Clipper shows the template's properties and rendered body as
editable text as soon as the page has been read, and keeps slow optional work
(its interpreter) as a separate step. Obsidian's native **Download attachments
for current file** turns remote images in a note into vault files, with a
checklist of what to download. This feature brings both patterns in:

- capturing becomes "see the note, edit it, add it", fast because nothing waits
  on files;
- downloading media becomes its own step and its own command, which can run
  later, from any note, and covers what the native command can't (TikTok, YouTube
  and other video sites);
- the plugin defers to the user's Obsidian settings (attachment folder, link
  format, property types, link updating on rename) instead of keeping its own
  versions, and adds as few settings of its own as possible.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Capture a page by seeing and editing its note first (Priority: P1)

The user copies a link and runs **Capture URL**. The modal shows the URL, picks
the matching template, and within seconds fills in the note name, properties and
body as the template renders them. The user tweaks a tag, fixes the title, and
selects **Add**. The note appears in the vault at once and opens.

**Why this priority**: This is the main way bookmarks are made, and today it is
both slow and blind. On its own it delivers the faster, editable capture.

**Independent Test**: With an article URL on the clipboard, run Capture URL,
change one property and one line of the body, select Add, and check the written
note has both edits and appeared without waiting for screenshots.

**Acceptance Scenarios**:

1. **Given** the clipboard holds a web address, **When** the user runs Capture
   URL, **Then** the modal shows, top to bottom: the template dropdown, the URL
   field (prefilled), the note name, a collapsible Properties section, the note
   body, and a footer with the folder and an Add button.
2. **Given** the clipboard holds no web address, **Then** the URL field is empty
   and focused, and nothing is fetched until a valid address is typed or pasted.
3. **Given** a valid URL, **Then** the template is chosen by the templates' URL
   rules (first match, else the default), before anything is fetched.
4. **Given** a template is chosen, **Then** its property rows show at once (name
   and type icon, empty value), and the page is fetched without the user doing
   anything else.
5. **Given** the page has been read, **Then** every property, the note name and
   the body fill in with the template's output, and each can be edited.
6. **Given** each property row, **Then** its icon and input match the type the
   vault already uses for that property (text, list, number, checkbox, date, date
   and time), the same as Obsidian's own Properties view shows.
7. **Given** the user edits any field, **Then** the template dropdown still names
   the template, with a mark showing the note was changed from it.
8. **Given** the user picks another template after the page was read, **Then**
   the fields refill from the other template within a couple of seconds, without
   the page being loaded again, and the user is warned before edits are lost.
9. **Given** the user selects Add, **Then** the note is written with exactly what
   the modal shows (edits included) to the folder in the footer, and opened,
   without waiting for any screenshot or media file.
10. **Given** the URL is already saved in the vault, **Then** the modal says so
    with the existing note's name, and offers to open it; adding anyway is still
    possible (see User Story 2).
11. **Given** the page can't be read (blocked, unreachable, server down), **Then**
    the modal shows why with a Retry, and the user can still add a note holding
    just the link.

---

### User Story 2 - Choose what Add does, with the template's preset (Priority: P1)

The footer's Add is a split button. Its main action and the folder come from the
template; the user can change either for this capture.

*(Revised with the user: "Add and download media" is gone. What a note keeps as
local files is said by the `|local` filter in the template, and can be changed
per capture in the modal; see User Story 8.)*

**Why this priority**: It replaces fixed behaviour with the template's own
preset.

**Independent Test**: Give a template the preset "Copy markdown", capture a page,
and check the main button reads "Copy markdown"; switch to Add for one capture
and check the note is written.

**Acceptance Scenarios**:

1. **Given** a template with no preset, **Then** the main button is **Add**.
2. **Given** a template with a preset, **Then** the main button is that action:
   **Add** or **Copy markdown**.
3. **Given** the button's menu, **Then** it lists the other action, plus **Save
   as new** when the URL is already saved.
4. **Given** Add, **Then** the note is written at once, and any media marked
   `|local` downloads afterwards (User Story 8) without the modal waiting.
5. **Given** "Copy markdown", **Then** the full note (properties and body) is
   copied with media as web addresses, and nothing is written or downloaded.
6. **Given** the folder field, **Then** it starts as the template's folder, can be
   changed for this capture, and suggests existing vault folders.

---

### User Story 3 - Screenshots arrive without slowing capture (Priority: P1)

The user's template embeds a screenshot of the page. They add the note right
away; the screenshot shows up in it a little later.

**Why this priority**: Screenshots must not bring back the wait this feature
removes, and a note must never contain a link to a file that doesn't exist.

**Independent Test**: Capture a long article with a template that embeds a
full-page screenshot, select Add immediately, and check the note opens without
the embed, then gains it once the file is in the vault.

**Acceptance Scenarios**:

1. **Given** the template uses a screenshot, **When** the user adds the note
   before the screenshot is ready, **Then** the note is written without that
   embed or link.
2. **Given** the screenshot then finishes, **Then** the file is saved in the
   vault and its embed or link is added where the template puts it.
3. **Given** a screenshot fails, **Then** the note simply never gets it, and no
   broken link is left behind.
4. **Given** the user has edited the note since adding it, **Then** adding the
   screenshot doesn't undo their edits; if the place it belongs no longer
   exists, it goes at the end of the note.
5. **Given** a full-page screenshot, **Then** it shows content that loads only on
   scrolling, even though the note's text was read before scrolling.

---

### User Story 4 - Update a note from its source, on demand (Priority: P1)

The user opens an older or thin bookmark and runs **Update note from source**.
The modal shows the note's current values under the note's template. Nothing is
fetched until they select **Fetch**. Then each property shows its current and
new value, and the user decides, per property, to keep, replace or merge, and
whether to keep, append or replace the body.

**Why this priority**: It fixes the slow, eager update and makes it a
deliberate, reviewable change to an existing note.

**Independent Test**: On a TikTok bookmark with an empty `author`, run the
command, check nothing is fetched until Fetch, then apply a replaced `author` and
a kept body, and check no video or photo was downloaded.

**Acceptance Scenarios**:

1. **Given** the active note has a bookmark URL, **When** the user runs Update
   note from source, **Then** the same modal layout opens showing the note's
   current name, properties and body, under the template that matches the note,
   and nothing is fetched.
2. **Given** the user selects Fetch, **Then** the page is read quickly (no media
   files) and each property row shows its current and new value.
3. **Given** the new values, **Then** each property is preset to what the
   template sets up: replace an empty value, merge lists, keep values that are
   the same; and the user can change any row to keep, replace or merge.
4. **Given** the user wants a property the template doesn't have, **Then** they
   can add one, choosing its name from properties used in the vault, and remove
   any row.
5. **Given** the body, **Then** the choices are keep (default), append the new
   body, or replace; replacing shows a line-by-line preview of what would change
   before applying.
6. **Given** the user applies, **Then** only the chosen changes are made, at once,
   without waiting on any files.
7. **Given** the old "Capture current bookmark again" behaviour, **Then** it is
   available here as **Replace whole note** (every property and the body
   replaced), and no longer a separate command.
8. **Given** a failed capture's "Retry capture" link in a note, **Then** it opens
   this modal for that note with Replace whole note chosen.

---

### User Story 5 - Download a note's media as its own command (Priority: P1)

The user runs **Download media for current note** on a TikTok bookmark. A list
shows the video (or the photos), the cover and any remote images, each ticked.
They untick one and select Download. Each item is saved to the vault and replaces
what it came from in the note; one that fails is reported and left as it was.

**Why this priority**: It's the second half of the user's request, and it is
where the slow, rate-limited work now lives.

**Independent Test**: On a note with a TikTok player, a YouTube embed and a
remote `![](https://…)` image, run the command, untick the image, download, and
check the player and embed were replaced by vault files and the image link was
left alone.

**Acceptance Scenarios**:

1. **Given** the active note is a Markdown file, **Then** the command is offered.
   **Given** the note has nothing to download, **When** it runs, **Then** a notice
   says so.
2. **Given** the note, **Then** the list includes: a TikTok post's video, or its
   photos, and its cover (from the note's TikTok player or its bookmark URL); a
   video from YouTube, X or Vimeo (from an embed in the note, or the bookmark
   URL; plain links aren't offered); remote images embedded in the body; and
   remote image URLs held in properties.
3. **Given** the list, **Then** each item shows a preview where one is available,
   and all are ticked by default.
4. **Given** the user downloads, **Then** items are fetched one at a time and the
   note is updated as each one succeeds: a TikTok player or video embed is
   replaced by an embed of the saved file; an image embed is replaced by an embed
   of the saved image; a property's URL is replaced by a link to the saved file.
   The bookmark's URL property is never changed.
5. **Given** an item fails, **Then** the others still complete, the failed one is
   left as it was in the note, and a summary lists what failed and why.
6. **Given** a video is larger than the size cap, **Then** it is reported as too
   large and skipped.
7. **Given** the note is closed or edited while downloads run, **Then** updates
   still land in the right places and don't overwrite the user's edits.
8. **Given** the same item was already downloaded into the vault for this note,
   **Then** running the command again doesn't offer or save a second copy.

---

### User Story 6 - Change a note's template (Priority: P2)

The user switches a bookmark to a different template in Update note from source,
to restructure it or bring it in line with newer notes.

**Why this priority**: Requested as part of making Update the comprehensive
command, but less common than updating fields.

**Independent Test**: Switch a note from the default template to the TikTok
template, keep a property the TikTok template doesn't have, tick rename/move,
and check the result and that links to the note still work.

**Acceptance Scenarios**:

1. **Given** the user picks another template, **Then** after Fetch, properties
   both templates share show current and new values as in User Story 4.
2. **Given** properties the new template doesn't have, **Then** they are listed
   as kept, each with a remove switch that starts off.
3. **Given** "Rename and move to match the template" (off by default), **Then** the
   note gets the new template's name and folder, and links to it update according
   to the user's Obsidian setting.
4. **Given** the note's TikTok player was already replaced by a saved video,
   **Then** changing template doesn't bring the player back.
5. **Given** the note was switched, **Then** the next Update opens on the template
   it was switched to, provided the template records its name in the note (see
   Assumptions); otherwise the template is matched by URL again.

---

### User Story 7 - Captures from the phone keep the template's local media (Priority: P2)

A TikTok post shared from the phone with a template using
`{{tiktok_thumbnail|local}}` lands in the vault as a note, and its cover follows
shortly, without the user opening the modal.

**Why this priority**: Keeps phone and background captures, made while Obsidian
is closed, from losing media when a post is deleted.

**Independent Test**: Share a TikTok post through the phone shortcut, delete
nothing, open Obsidian later, and check the note was written and its cover
property links to a vault file.

**Acceptance Scenarios**:

1. **Given** a background capture whose template marks media `|local`, **Then**
   the server starts downloading exactly that media straight after the capture,
   and the note is written when Obsidian next opens.
2. **Given** the media is still downloading when the note is written, **Then** the
   note shows the web address or TikTok player in its place until the file
   arrives, and it is replaced then.
3. **Given** a template with no `|local` media, **Then** background captures
   download no media.

---

### User Story 8 - Say which media is kept locally, in the template (Priority: P1)

TikTok posts and their media links disappear. The user writes
`[[{{tiktok_thumbnail|local}}]]` in the TikTok template's `cover` property, so
every capture keeps a copy of the cover in the vault, while the video stays the
TikTok player. For one post they want the video too, so in the capture modal they
switch on the video under "Save in the vault" before selecting Add.

**Why this priority**: It's the reason for the change: keeping ephemeral media
without downloading everything on every capture, with one rule instead of a
preset, guessed defaults and variables that each save something.

**Independent Test**: With the cover marked `|local` and the video not, capture a
TikTok post and check only the cover is downloaded and linked; capture another
with the body's player switched to local in the modal and check the video is
downloaded too.

**Acceptance Scenarios**:

1. **Given** a media variable without `|local`, **Then** it renders as the web
   address (or, for a TikTok video, the player), as Web Clipper would.
2. **Given** a media variable with `|local`, **Then** the note is written showing
   the web address, and that media alone is downloaded afterwards and replaces the
   address with a link or embed of the vault file, in the user's link format.
3. **Given** the capture modal, **Then** a "Save in the vault" list under the
   body shows the note's media, each with a switch that's on when the template
   used `|local`; changing it applies to this capture only.
4. **Given** a download fails, **Then** the web address stays in the note and the
   failure is reported as in User Story 5.
5. **Given** an existing template using a removed variable (`{{image_local}}`,
   `{{tiktok_save}}`, `{{tiktok_image_N}}`), **Then** it is rewritten to the
   `|local` form that saves the same media (FR-050).

---

### Edge Cases

- **Mobile**: both modals and the download list work at phone width (no
  sideways scrolling; the split button and folder field fit).
- **Typing a URL**: fetching starts once the address is valid and the user stops
  typing or pastes; changing the URL discards the previous fetch.
- **Template URL rules that depend on page data** (e.g. schema type) can only
  match once the page is read; if they then pick a different template, the
  modal switches to it before the user has edited anything, and only suggests it
  afterwards.
- **Closing the modal** cancels any fetch in progress and frees the page on the
  server; closing after Add doesn't stop screenshots or media already started.
- **Re-rendering after the page expired** (the user waited a long time before
  switching template): the page is fetched again, with a short notice.
- **Lazy-loaded articles**: text that only appears on scrolling may be missing
  from the quick read; Update note from source can pull it in later.
- **Rate limits**: several captures with `|local` media in a row queue their
  downloads one at a time with a pause between downloads from the same site.
- **`|local` on something that isn't media** (plain text, a page link): the value
  is left as it is.
- **Templates pasted into the official Web Clipper**: `{{image|local}}` should
  fall back to the plain address there; the `tiktok_*` variables only exist in
  this plugin and render empty in Web Clipper either way.
- **Expired TikTok media links**: the download command loads the post again
  rather than using links saved earlier; a deleted or private post is reported
  as unavailable.
- **Instagram** often needs a login; failures there are reported, not retried.
- **Duplicate file names**: saved files never overwrite existing ones.
- **Attachment folder setting** says "same folder as current file": files go next
  to the note.
- **No server configured**: Capture URL can still add a link-only note; Update
  and Download media explain the server is needed.
- **Existing templates using `{{tiktok_video}}` / `{{tiktok_images}}`** keep
  rendering, as the player and web addresses; removed media variables are
  rewritten to their `|local` form (FR-050).

## Requirements *(mandatory)*

### Functional Requirements

**Modal layout (Capture URL and Update note from source)**

- **FR-001**: Both commands MUST use one modal layout, top to bottom: template
  dropdown; URL field (Capture URL only); note name; collapsible Properties; note
  body; footer with folder field and a split action button.
- **FR-002**: Property rows MUST look and behave like Obsidian's own Properties
  view: type icon, name, value, each value editable.
- **FR-003**: Each property's type (and so its icon and input) MUST be the type
  the vault already uses for that property; the plugin MUST NOT keep a separate
  list of property types where the vault's can be read.
- **FR-004**: Whether Properties is collapsed MUST be remembered between uses on
  the device.
- **FR-005**: The modals MUST work at phone width.

**Capture URL**

- **FR-006**: The URL field MUST be prefilled from the clipboard when it holds a
  web address.
- **FR-007**: The template MUST be chosen by the templates' URL rules before
  fetching, and changeable by the user at any time.
- **FR-008**: A valid URL MUST start a quick read of the page with no further
  action; the quick read MUST NOT wait for scrolling, images, screenshots or
  media.
- **FR-009**: Property names and types MUST show before the page is read; values,
  note name and body MUST fill in once it is read, and stay editable.
- **FR-010**: Switching template after the page was read MUST re-render from the
  same page without loading it again, while the page is still held (FR-011).
- **FR-011**: The server MUST hold a quickly-read page until the modal closes or a
  short time passes (about two minutes), then free it.
- **FR-012**: Editing a field MUST keep the template named in the dropdown with a
  visible "changed" mark; switching template with edits present MUST ask first.
- **FR-013**: Add MUST write the note exactly as shown, with the user's edits, to
  the folder in the footer, and open it, without waiting for any file.
- **FR-014**: The split button MUST offer Add and Copy markdown, plus Save as new
  when the URL is already saved; its main action MUST be the template's preset
  (FR-031) or Add when it has none.
- **FR-015**: When the URL is already in the vault, the modal MUST name the
  existing note and offer to open it.
- **FR-016**: When the page can't be read, the modal MUST say why, offer Retry,
  and still allow adding a note with just the link.

**Screenshots**

- **FR-017**: Screenshots the template uses MUST be taken after the note's text is
  ready and MUST NOT delay Add.
- **FR-018**: A note MUST never contain a link or embed to a screenshot that isn't
  in the vault; each screenshot's link MUST be added where the template places it
  once its file is saved, and never added if it fails.
- **FR-019**: Adding a screenshot later MUST NOT overwrite the user's edits; when
  its place can't be found, it MUST go at the end of the note.
- **FR-020**: Full-page screenshots MUST include content that loads on scrolling.

**Update note from source**

- **FR-021**: The modal MUST open on the note's current values and template
  without fetching; fetching MUST start only when the user selects Fetch.
- **FR-022**: Fetching for an update MUST use the quick read and MUST NOT download
  media; screenshots MUST be taken only when the user picks one.
- **FR-023**: Each property MUST show current and new values, preset as the
  template sets up, and be changeable to keep, replace or merge (merge only for
  lists).
- **FR-024**: The user MUST be able to add properties (named from those used in
  the vault) and remove rows.
- **FR-025**: The body MUST offer keep (default), append and replace; replace MUST
  show a line-by-line preview of the change before applying.
- **FR-026**: Applying MUST change only what was chosen, at once, without waiting
  on files.
- **FR-027**: Replace whole note MUST be offered in this modal, and the separate
  "Capture current bookmark again" command MUST be removed; the Retry capture
  link MUST open this modal with Replace whole note chosen.
- **FR-028**: When the template changes, properties not in the new template MUST
  be kept unless the user turns on their remove switch.
- **FR-029**: "Rename and move to match the template" MUST be off by default and,
  when on, MUST rename and move the note so that links to it update per the
  user's Obsidian settings.
- **FR-030**: Changing template MUST NOT restore a TikTok player or remote link
  that was already replaced by a saved file.

**Templates**

- **FR-031**: A template MAY set one preset, "On capture": Add or Copy markdown.
  It is the only new template setting. A stored "Add and download media" MUST be
  read as Add.
- **FR-032**: A template's folder MUST be the footer's starting folder.
- **FR-033**: Whether media is saved locally MUST be decided only by the `|local`
  filter (FR-047), never by the preset, by which variables a template uses, or by
  the URL. *(Changed with the user twice: first a migration stored "Add and download
  media" on templates using media variables, then it was worked out from those
  variables; both are replaced by `|local`.)*

**Local media (`|local`)**

- **FR-047**: Media variables MUST render as web addresses (a TikTok post as the
  player); the `|local` filter, written last in a tag, MUST mark the value to be
  kept as a vault file. It MUST work on any value holding a web address (an image,
  a video page, a TikTok player) and MUST leave other values unchanged. In a
  property, where the result can only be a link to one file, a marked value that
  isn't a single web address (a player, a list) MUST render blank, with its
  brackets, and not be downloaded.
- **FR-048**: The TikTok media variables MUST be: `{{tiktok_embed}}` (the player,
  for any post), `{{tiktok_video}}` and `{{tiktok_images}}` (the same player, only
  for a video or a photo post) and `{{tiktok_thumbnail}}` (the cover's address);
  with `|local` the player saves the video or the photos. Web Clipper's own
  `{{image}}` is the page image. `{{image_local}}`, `{{tiktok_save}}` and
  `{{tiktok_image_N}}` MUST be removed. *(Simplified while building: no separate
  `{{tiktok_media}}`, since `{{tiktok_embed}}` already is that, and no list
  filters on the photos, since their addresses expire and only the player is
  shown.)*
- **FR-049**: Media marked `|local` MUST be downloaded through the same queue as
  Download media (FR-037), using the address read at capture when it is still
  valid and reading the post again only when it isn't, and MUST replace its
  address as in FR-038. The note MUST never contain a link to a file that isn't
  in the vault (SC-004).
- **FR-050**: Saved and imported templates MUST be rewritten: `{{image_local}}`
  → `{{image|local}}`, `{{tiktok_save}}` → `{{tiktok_embed|local}}` and
  `{{tiktok_image_N}}` → `{{tiktok_images|local}}` whenever they're loaded, and a
  stored "Add and download media" preset MUST be dropped. Nothing else is
  rewritten: `|local` on `{{tiktok_thumbnail}}` and the like is the user's choice.
  *(Changed with the user: a one-time migration adding `|local` to the TikTok
  variables was dropped, and the user's templates were edited by hand.)*
- **FR-051**: A post's or video's saved files MUST be named after the note and
  what they are (`<note>-cover`, `<note>-video`, `<note>-photo-N`), the same
  whether they came from a capture or from Download media; other images keep
  their own file names, as Obsidian's download does.

**Download media for current note**

- **FR-034**: The command MUST be offered for any active Markdown note, and say
  when there is nothing to download.
- **FR-035**: It MUST find: TikTok video or photos and cover (from a TikTok player
  in the note or the bookmark URL); YouTube, X and Vimeo videos (from embeds or
  the bookmark URL; plain links in the text are not media); remote image embeds
  in the body; and remote image URLs in properties. Instagram videos MUST be
  attempted, with failures reported.
- **FR-036**: It MUST show what it found as a list with previews where available,
  all ticked, before downloading anything.
- **FR-037**: Downloads MUST run one at a time, with a pause between downloads from
  the same site.
- **FR-038**: Each successful item MUST replace its source in the note (player,
  embed, image or property URL) with a link or embed of the saved file, in the
  user's Obsidian link format; the bookmark's URL property MUST NOT change.
- **FR-039**: A failed item MUST NOT stop the others or leave the note
  half-changed; the note MUST be updated for every success, and a summary MUST
  list each failure with its reason.
- **FR-040**: Videos over the size cap (300 MB) MUST be skipped and reported.
- **FR-041**: Running the command again MUST NOT save a second copy of something
  already downloaded for the note.
- **FR-042**: Captures from the modal and background captures with `|local`
  media MUST start those downloads after the note is written, without user
  interaction, and replace sources as in FR-038 when they finish.

**Where files go**

- **FR-043**: Screenshots and media MUST be saved where the user's Obsidian
  attachment setting puts attachments for the note, unless the plugin's attachment
  folder setting overrides it.
- **FR-044**: On upgrade, an existing attachment folder setting MUST be kept as
  the override, so files keep going where they went; on a new install the
  override MUST be empty.
- **FR-045**: Saved files MUST never overwrite existing files.

**Compatibility**

- **FR-046**: Plugin and server MUST refuse to work with a mismatched version of
  each other, with a message saying which to update.

### Key Entities

- **Template**: name, URL rules, folder, note name format, properties, body, and
  the new optional "On capture" preset (Add or Copy markdown).
- **Local media mark**: a media value a template or the modal marked `|local`:
  what it is (cover, video, photo, image), the address read at capture, and where
  it sits in the note.
- **Quick read**: a page read by the server without media, held for a short time
  so the note can be re-rendered with another template; gives property values,
  note name, body, and the variables a template can use.
- **Pending screenshot**: a screenshot a written note is waiting on, with where
  its link goes in the note.
- **Media item**: something in a note that can become a vault file (TikTok video,
  TikTok photo, TikTok cover, video from a video site, remote image, property
  image URL), with its source in the note and, once downloaded, its vault file.
- **Media download**: a queued, one-at-a-time download of a note's media items,
  started by the command, or by a capture with local media marks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a typical article or TikTok post, the Capture URL modal shows
  filled-in fields within 5 seconds of a valid URL, and the note is in the vault
  within 1 second of selecting Add.
- **SC-002**: No capture or update downloads any media that wasn't marked
  `|local` (in the template or the modal), unless the user ran Download media.
- **SC-003**: Switching template after the page was read refills the fields within
  2 seconds without loading the page again.
- **SC-004**: In testing, no written note ever contains a link to a screenshot or
  media file that isn't in the vault.
- **SC-005**: Download media replaces every successful item and reports every
  failure; one failure never leaves the note unchanged for items that succeeded.
- **SC-006**: Ten TikTok captures in a row with `{{tiktok_embed|local}}` complete
  their downloads without a rate-limit failure.
- **SC-007**: Both modals and the download list are fully usable on a phone with
  no sideways scrolling.
- **SC-008**: The plugin adds no more than two new settings in total (the
  template's "On capture" preset and the attachment folder override).

## Assumptions

- **Open question 5a (rate limits)**: a fixed pause between downloads from the
  same site, with no daily cap and no user setting. A cap is added later only if
  rate limits still occur.
- **`|local` in the official Web Clipper**: the server takes `|local` out of a
  template before Web Clipper's engine sees it, so the bundled engine needs no
  change. In the Web Clipper extension itself its template editor flags `local`
  as an unknown filter; rendering is assumed to pass the value through
  unchanged, which hasn't been tried in the extension.
- **Open question 5b (background media)**: background captures with `|local`
  media download it on the server straight away rather than
  waiting for Obsidian to open, favouring posts that may be deleted over
  rate-limit risk (which FR-037 already limits).
- **Open question 7b (Replace whole note)**: it is a preset of the update modal
  with every property and the body set to replace, not a separate command.
- **The note's template** is matched by URL rules on each update unless the
  template opts in to recording its name as a visible property in the note. It is
  never stored as hidden plugin data.
- Screenshots are not media: they stay part of capture and need the page as it
  was captured, while media can be fetched again later from the post's URL.
- The quick read happens before scrolling, so lazily loaded text on long pages
  may be missing from a captured note; this is accepted for speed.
- Video downloads from YouTube, X and Vimeo rely on a downloader added to the
  capture server; their availability depends on those sites.
- The URL and capture-ID behaviour of notes, the duplicate index and the merge
  feature (001) are unchanged.
- Internal cleanup that supports this work (shared modal code, moving inline
  styles to a stylesheet, splitting the main plugin file, removing dead code) is
  planned in `plan.md`. Removing the code duplicated between plugin and server
  is a separate change, not part of this feature.
