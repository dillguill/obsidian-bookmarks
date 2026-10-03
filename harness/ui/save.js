// Popup opened by the bookmarklet on the settings page (General). It sends the
// page to POST /capture with the token this browser signed in with. It saves
// straight away only when the link carries this browser's bookmarklet key, so
// another site opening this page can't save bookmarks without a click.
"use strict";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const url = params.get("url") || "";
const pick = params.get("pick") === "1";

function stored(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

const token = stored("bookmarks-token");
const trusted = Boolean(params.get("k")) && params.get("k") === stored("bookmarks-bookmarklet-key");

function status(text, isError = false) {
  $("save-status").textContent = text;
  $("save-status").classList.toggle("error", isError);
}

async function save() {
  $("save-button").disabled = true;
  status("Saving…");
  try {
    const template = $("save-template").value || undefined;
    const res = await fetch("/capture", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url, origin: "bookmarklet", template }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("The saved token wasn't accepted. Sign in again on the settings page.");
    if (!res.ok) throw new Error(body.message || body.error || `Server returned HTTP ${res.status}`);
    status("Saved. It appears in Obsidian the next time it fetches captures.");
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    status(`Not saved: ${err.message}`, true);
    $("save-button").disabled = false;
  }
}

async function start() {
  $("save-url").textContent = url;
  if (!/^https?:\/\//i.test(url)) return status("This page can't be saved: it isn't a web address.", true);
  if (!token) {
    status("Sign in on the settings page in this browser first.", true);
    const link = document.createElement("a");
    link.href = "/ui/";
    link.target = "_blank";
    link.textContent = " Open settings";
    $("save-status").append(link);
    return;
  }
  $("save-form").hidden = false;
  $("save-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void save();
  });
  if (pick) {
    try {
      const res = await fetch("/templates", { headers: { Authorization: `Bearer ${token}` } });
      const { templates } = await res.json();
      for (const name of templates) $("save-template").append(new Option(name, name));
      $("template-row").hidden = templates.length < 2;
    } catch {
      // keep Automatic only
    }
  }
  if (trusted && !pick) return save();
  $("save-button").focus();
}

void start();
