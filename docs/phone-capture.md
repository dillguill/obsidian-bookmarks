# Saving bookmarks from your phone

The phone never captures anything itself. It sends the URL to bookmarks-server,
the server captures it, and the next Obsidian that opens (desktop or mobile)
writes the note. Obsidian can be closed when you share.

## 1. Let the phone reach the server

The compose file binds the server to `127.0.0.1` on the machine running Docker,
so nothing outside that machine can reach it by default. The simplest safe way
in is [Tailscale Serve](https://tailscale.com/kb/1312/serve), which gives the
server an HTTPS address that only devices on your tailnet can open:

1. Install Tailscale on the server machine and on the phone, signed in to the
   same tailnet.
2. In the Tailscale admin console, turn on MagicDNS and HTTPS certificates
   (Serve needs both).
3. On the server machine:

   ```sh
   tailscale serve --bg 8787
   ```

   It prints the address, like `https://mac-mini.your-tailnet.ts.net`. `--bg`
   keeps it running across reboots; `tailscale serve --https=443 off` stops it.

4. Check it from the phone's browser or another tailnet device:

   ```sh
   curl -H "Authorization: Bearer phone-token" https://mac-mini.your-tailnet.ts.net/health
   ```

Give each device its own token in `BOOKMARKS_TOKENS` (for example
`desktop-token,phone-token`) so you can revoke one without touching the others.

## 2. iOS: a share-sheet Shortcut

In the Shortcuts app, create a new shortcut:

1. Open the shortcut's settings (the **i** button), turn on **Show in Share
   Sheet**, and set it to receive **URLs** and **Safari web pages**.
2. Add **Get Contents of URL**:
   - URL: `https://mac-mini.your-tailnet.ts.net/capture`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer phone-token`
   - Request Body: **JSON**, with two text fields:
     `url` = **Shortcut Input**, and `origin` = `shortcut`
3. Add **Get Dictionary Value** for key `error` from **Contents of URL**, then
   **If** *Dictionary Value* **has any value**: **Show Notification**
   `Not saved: ` + *Dictionary Value*; **Otherwise**: **Show Notification**
   `Saved to bookmarks`.
4. Name it **Save Bookmark**.

Now **Share → Save Bookmark** from Safari or any app that shares a link. The
server replies straight away (HTTP 202) and captures in the background.
Shortcuts doesn't treat an HTTP error as a failure, which is why step 3 checks
the reply for an `error` field (a bad token, or a rejected URL such as a
private-network address).

## 3. Android

Any app that can send an HTTP request from the share menu works, for example
[HTTP Shortcuts](https://http-shortcuts.rmy.ch/). Use the same request as the iOS
Shortcut: `POST /capture`, the `Authorization: Bearer <token>` header, and a
JSON body `{"url": "<shared URL>", "origin": "share"}`.

## 4. Getting the notes

Open Obsidian on any device with the Bookmarks plugin set up. It writes finished
captures on startup and then every poll interval (60 seconds by default), or
straight away with **Bookmarks: Fetch finished captures now**. On Obsidian mobile,
set the plugin's server URL to the Tailscale address and add the phone's own token.

A capture is written once even when several devices are open: the plugin skips
any capture whose `capture_id` is already in the vault. If the same page is
already saved, the new capture is skipped and acknowledged without a second note.
