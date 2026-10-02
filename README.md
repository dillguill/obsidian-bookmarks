# obsidian-bookmarks

Save clippings similar to [Karakeep](https://karakeep.app) with rich metadata to Obsidian.

A self-hosted capture server takes full-page screenshots and readable markdown of
links you save from anywhere; an Obsidian plugin drains finished captures into
your vault as deduplicated bookmark notes. See the
[design doc](docs/superpowers/specs/2026-09-18-obsidian-bookmarks-design.md).

## Layout

| Path       | What                                                             |
|------------|------------------------------------------------------------------|
| `plugin/`  | Obsidian plugin (TypeScript + esbuild), the sole vault writer    |
| `harness/` | Capture backend `bookmarks-server` (Node + Playwright), Docker   |
| `specs/`   | Spec Kit feature specs                                           |
| `docs/`    | Design and phase docs                                            |
| `spikes/`  | Feasibility probes                                               |

## Development

Requires Node 22.12+.

```sh
npm install
npm run typecheck
npm test
npm run build        # plugin/main.js + harness/dist
```

Plugin: `npm run dev -w plugin` rebuilds `plugin/main.js` on change. Symlink or
copy `plugin/` (`main.js`, `manifest.json`) into `<vault>/.obsidian/plugins/bookmarks/`.

Server:

```sh
cd harness
cp .env.example .env    # set BOOKMARKS_TOKENS
docker compose up --build
```
