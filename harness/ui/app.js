// Settings page for bookmarks-server. Plain DOM, no dependencies; every
// user-provided string goes through textContent or .value, never innerHTML.
"use strict";

const TOKEN_KEY = "bookmarks-token";
const PROPERTY_TYPES = ["text", "multitext", "number", "checkbox", "date", "datetime"];
const $ = (id) => document.getElementById(id);

let token = readToken();
let settings = null;
let view = { section: "capture", template: 0 };
let saveTimer = null;

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function writeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the token lasts for this page load only
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showSignIn("That token wasn't accepted.");
    throw new Error("unauthorized");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}

let statusTimer = null;
function status(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => el.classList.remove("show"), 1500);
}

// ---- saving ----

function scheduleSave() {
  clearTimeout(saveTimer);
  status("Saving…");
  saveTimer = setTimeout(save, 600);
}

async function save() {
  saveTimer = null;
  try {
    // Properties still being typed (no name yet) stay on screen but aren't sent.
    const payload = {
      ...settings,
      templates: settings.templates.map((t) => ({ ...t, properties: t.properties.filter((p) => p.name.trim()) })),
    };
    const { settings: saved } = await api("PUT", "/settings", payload);
    // Keep what's on screen (the server only cleans values), but adopt cleaned site lists.
    settings.bannerSites = saved.bannerSites;
    settings.noScreenshotSites = saved.noScreenshotSites;
    status("Saved");
  } catch (err) {
    if (err.message !== "unauthorized") status(`Not saved: ${err.message}`, true);
  }
}

window.addEventListener("beforeunload", (event) => {
  if (saveTimer) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// ---- sections ----

function show(section) {
  for (const id of ["signin", "general", "capture", "template"]) $(id).hidden = id !== section;
}

function showSignIn(message) {
  show("signin");
  for (const el of document.querySelectorAll(".sidebar button, .sidebar label")) el.toggleAttribute("disabled", true);
  if (message) status(message, true);
  $("token").focus();
}

function render() {
  for (const el of document.querySelectorAll(".sidebar button, .sidebar label")) el.removeAttribute("disabled");
  for (const el of document.querySelectorAll(".nav-item[data-section]")) {
    el.classList.toggle("active", el.dataset.section === view.section);
  }
  renderTemplateList();
  if (view.section === "template") renderTemplate();
  else if (view.section === "capture") renderCapture();
  show(view.section);
}

function renderTemplateList() {
  const list = $("template-list");
  list.replaceChildren(
    ...settings.templates.map((t, i) => {
      const button = document.createElement("button");
      button.className = "nav-item";
      button.textContent = i === 0 ? `${t.name || "Untitled"} (default)` : t.name || "Untitled";
      button.classList.toggle("active", view.section === "template" && view.template === i);
      button.addEventListener("click", () => {
        view = { section: "template", template: i };
        render();
      });
      return button;
    }),
  );
}

function renderCapture() {
  $("screenshot-style").value = settings.screenshotStyle;
  $("banner-sites").value = settings.bannerSites.join("\n");
  $("no-screenshot-sites").value = settings.noScreenshotSites.join("\n");
}

const lines = (value) => value.split("\n").map((s) => s.trim()).filter(Boolean);

$("screenshot-style").addEventListener("change", (e) => {
  settings.screenshotStyle = e.target.value;
  scheduleSave();
});
$("banner-sites").addEventListener("input", (e) => {
  settings.bannerSites = lines(e.target.value);
  scheduleSave();
});
$("no-screenshot-sites").addEventListener("input", (e) => {
  settings.noScreenshotSites = lines(e.target.value);
  scheduleSave();
});

// ---- template editor ----

const current = () => settings.templates[view.template];

function renderTemplate() {
  const t = current();
  $("template-title").textContent = t.name || "Untitled";
  $("template-default-note").textContent =
    view.template === 0 ? "Default template: used when no other template's trigger matches." : "";
  $("t-name").value = t.name;
  $("t-triggers").value = (t.triggers || []).join("\n");
  $("t-note-name").value = t.noteNameFormat;
  $("t-path").value = t.path;
  $("t-content").value = t.noteContentFormat;
  $("template-delete").disabled = settings.templates.length === 1;
  $("template-duplicate").textContent = "Duplicate";
  const makeDefault = $("template-make-default");
  if (makeDefault) makeDefault.hidden = view.template === 0;
  renderProperties();
}

function renderProperties() {
  const t = current();
  $("t-properties").replaceChildren(
    ...t.properties.map((prop, i) => {
      const row = document.createElement("div");
      row.className = "property";

      const type = document.createElement("select");
      type.setAttribute("aria-label", "Property type");
      for (const name of PROPERTY_TYPES) type.add(new Option(name, name));
      type.value = prop.type;
      type.addEventListener("change", () => {
        prop.type = type.value;
        scheduleSave();
      });

      const name = document.createElement("input");
      name.type = "text";
      name.placeholder = "name";
      name.value = prop.name;
      name.setAttribute("aria-label", "Property name");
      name.addEventListener("input", () => {
        prop.name = name.value;
        if (prop.name.trim()) scheduleSave();
      });

      const value = document.createElement("input");
      value.type = "text";
      value.placeholder = "{{variable}}";
      value.value = prop.value;
      value.spellcheck = false;
      value.setAttribute("aria-label", "Property value");
      value.addEventListener("input", () => {
        prop.value = value.value;
        scheduleSave();
      });

      const remove = document.createElement("button");
      remove.className = "icon-button";
      remove.textContent = "×";
      remove.title = "Remove property";
      remove.setAttribute("aria-label", `Remove ${prop.name || "property"}`);
      remove.addEventListener("click", () => {
        t.properties.splice(i, 1);
        renderProperties();
        scheduleSave();
      });

      row.append(type, name, value, remove);
      return row;
    }),
  );
}

function bindText(id, apply) {
  $(id).addEventListener("input", (e) => {
    apply(current(), e.target.value);
    if (id === "t-name") {
      $("template-title").textContent = e.target.value || "Untitled";
      renderTemplateList();
      if (!e.target.value.trim()) return; // the server requires a name
    }
    scheduleSave();
  });
}
bindText("t-name", (t, v) => (t.name = v));
bindText("t-triggers", (t, v) => (t.triggers = lines(v)));
bindText("t-note-name", (t, v) => (t.noteNameFormat = v));
bindText("t-path", (t, v) => (t.path = v));
bindText("t-content", (t, v) => (t.noteContentFormat = v));

$("t-add-property").addEventListener("click", () => {
  current().properties.push({ name: "", value: "", type: "text" });
  renderProperties();
  const inputs = $("t-properties").querySelectorAll("input");
  inputs[inputs.length - 2]?.focus();
});

function uniqueName(base) {
  const names = new Set(settings.templates.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

function addTemplate(template) {
  settings.templates.push(template);
  view = { section: "template", template: settings.templates.length - 1 };
  render();
  scheduleSave();
}

$("new-template").addEventListener("click", () => {
  const base = structuredClone(settings.templates[0]);
  addTemplate({ ...base, name: uniqueName("New template"), triggers: [] });
  $("t-name").select();
});

$("template-duplicate").addEventListener("click", () => {
  const copy = structuredClone(current());
  addTemplate({ ...copy, name: uniqueName(`${copy.name} copy`) });
});

$("template-delete").addEventListener("click", () => {
  if (settings.templates.length === 1) return;
  if (!confirm(`Delete the template "${current().name}"?`)) return;
  settings.templates.splice(view.template, 1);
  view = { section: "template", template: Math.min(view.template, settings.templates.length - 1) };
  render();
  scheduleSave();
});

// "Make default" moves a template to the top of the list.
const makeDefault = document.createElement("button");
makeDefault.id = "template-make-default";
makeDefault.textContent = "Make default";
makeDefault.addEventListener("click", () => {
  const [t] = settings.templates.splice(view.template, 1);
  settings.templates.unshift(t);
  view = { section: "template", template: 0 };
  render();
  scheduleSave();
});
$("template-duplicate").before(makeDefault);

$("template-export").addEventListener("click", () => {
  const t = current();
  const blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${(t.name || "template").replace(/[^\w.-]+/g, "-").toLowerCase()}-clipper.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

/**
 * Accepts a Web Clipper template export, Web Clipper's full settings export
 * (templates under "template_<id>", ordered by template_list), a list of
 * templates, or {templates: [...]}. Only templates are read; the rest of a
 * settings export (including any API keys in it) is ignored.
 */
function templatesFrom(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.templates)) return json.templates;
  if (json && typeof json === "object" && Object.keys(json).some((key) => key.startsWith("template_"))) {
    const order = Array.isArray(json.template_list) ? json.template_list.map((id) => `template_${id}`) : [];
    const keys = Object.keys(json).filter((key) => key.startsWith("template_") && key !== "template_list");
    const ordered = [...order.filter((key) => keys.includes(key)), ...keys.filter((key) => !order.includes(key))];
    const templates = ordered.map((key) => json[key]).filter((t) => t && typeof t === "object" && !Array.isArray(t));
    if (templates.length) return Object.assign(templates, { fullExport: true });
  }
  if (json && typeof json === "object" && ("noteContentFormat" in json || "properties" in json)) return [json];
  throw new Error("This file doesn't look like a Web Clipper template.");
}

// Variables the server can't fill yet; they come out empty in notes.
const UNSUPPORTED_VARIABLE = /\{\{\s*(schema:|meta:|selector:|selectorHtml:|")/;

function importTemplate(raw, fallbackName) {
  return {
    schemaVersion: raw.schemaVersion || "0.1.0",
    name: uniqueName(String(raw.name || fallbackName)),
    behavior: "create",
    noteNameFormat: String(raw.noteNameFormat ?? settings.templates[0].noteNameFormat),
    path: String(raw.path ?? settings.templates[0].path),
    noteContentFormat: String(raw.noteContentFormat ?? "{{content}}"),
    properties: (Array.isArray(raw.properties) ? raw.properties : [])
      .filter((p) => p && p.name)
      .map((p) => ({
        name: String(p.name),
        value: String(p.value ?? ""),
        type: PROPERTY_TYPES.includes(p.type) ? p.type : "text",
      })),
    triggers: Array.isArray(raw.triggers) ? raw.triggers.map(String) : [],
  };
}

$("import-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const imported = [];
  let fullExport = false;
  for (const file of files) {
    try {
      const raws = templatesFrom(JSON.parse(await file.text()));
      fullExport ||= Boolean(raws.fullExport);
      for (const raw of raws) imported.push(importTemplate(raw, file.name.replace(/\.json$/i, "")));
    } catch (err) {
      status(`${file.name}: ${err.message}`, true);
      return;
    }
  }
  if (!imported.length) return;
  // A full Web Clipper export brings its own default (its first template), so it goes on top.
  if (fullExport) settings.templates.unshift(...imported);
  else settings.templates.push(...imported);
  view = { section: "template", template: fullExport ? 0 : settings.templates.length - 1 };
  render();
  scheduleSave();
  const partial = imported
    .filter((t) => [t.noteNameFormat, t.noteContentFormat, ...t.properties.map((p) => p.value)].some((v) => UNSUPPORTED_VARIABLE.test(v))).map((t) => t.name);
  const summary = `Imported ${imported.length} template${imported.length === 1 ? "" : "s"}.`;
  showImportNote(
    partial.length
      ? `${summary} ${partial.join(", ")} use${partial.length === 1 ? "s" : ""} schema, meta, selector or prompt variables, which the server can't fill yet; they come out empty.`
      : summary,
  );
});

function showImportNote(text) {
  const note = $("template-default-note");
  note.textContent = text;
  setTimeout(() => {
    if (view.section === "template") renderTemplate();
  }, 12000);
}

// ---- navigation and sign-in ----

for (const el of document.querySelectorAll(".nav-item[data-section]")) {
  el.addEventListener("click", () => {
    view = { section: el.dataset.section, template: view.template };
    render();
  });
}

$("signout").addEventListener("click", () => {
  token = "";
  writeToken("");
  settings = null;
  showSignIn();
});

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  if (await load()) {
    writeToken(token);
    $("token").value = "";
  }
});

async function load() {
  try {
    const [health, current] = await Promise.all([api("GET", "/health"), api("GET", "/settings")]);
    $("server-version").textContent = `bookmarks-server ${health.version}, API version ${health.apiVersion}`;
    settings = current.settings;
    render();
    return true;
  } catch (err) {
    if (err.message !== "unauthorized") status(`Couldn't load settings: ${err.message}`, true);
    return false;
  }
}

if (token) void load();
else showSignIn();
