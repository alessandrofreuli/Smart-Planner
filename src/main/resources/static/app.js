"use strict";

const $ = selector => document.querySelector(selector);
const ui = {
  scheduled: $("#scheduled"), todo: $("#todo"), status: $("#status"),
  composer: $("#composer"), input: $("#composer-input"), send: $("#send"),
  editor: $("#editor"), form: $("#edit-form"), editorStatus: $("#editor-status"),
  save: $("#save"), remove: $("#delete"), cancel: $("#cancel")
};
const fields = ui.form.elements;

const state = { items: [], today: null, editingId: null, busy: false };

const TYPE = { ACTIVITY: "Activity", GOAL: "Goal", COMMITMENT: "Commitment" };
const PRIORITY = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/* ---------- helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let statusTimer;
function setStatus(message = "", error = false, target = ui.status) {
  clearTimeout(statusTimer);
  target.textContent = message;
  target.classList.toggle("error", error);
  if (message && !error && target === ui.status) {
    statusTimer = setTimeout(() => setStatus(""), 4000);
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { Accept: "application/json", "Content-Type": "application/json" }
    });
  } catch {
    throw new Error("Cannot reach the server. Is the app running?");
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = {
      400: "Check the required fields, date, time and duration.",
      404: "Item not found. Reload the page.",
      502: "The model returned an invalid response. Try rephrasing.",
      503: "Service unavailable. Check that the local model is running.",
      504: "The local model took too long to answer."
    }[response.status];
    throw new Error(body?.detail || body?.message || fallback || `Request failed (HTTP ${response.status}).`);
  }
  return body;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", timeZone: "UTC"
});
const dayYearFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
});

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayLabel(iso) {
  if (iso === state.today) return "Today";
  if (iso === addDays(state.today, 1)) return "Tomorrow";
  const format = iso.slice(0, 4) === state.today.slice(0, 4) ? dayFormat : dayYearFormat;
  return format.format(new Date(`${iso}T12:00:00Z`));
}

/* ---------- rendering ---------- */

function byDate(a, b) {
  return a.date.localeCompare(b.date)
    || (a.time || "99:99").localeCompare(b.time || "99:99")
    || a.id - b.id;
}

function byPriority(a, b) {
  return RANK[a.priority] - RANK[b.priority] || b.id - a.id;
}

function card(item) {
  const li = el("li", item.date && item.date < state.today ? "card past" : "card");
  const button = el("button", "card-btn");
  button.type = "button";
  button.addEventListener("click", () => openEditor(item));

  const head = el("span", "card-head");
  head.append(
    el("span", `badge ${item.priority.toLowerCase()}`, PRIORITY[item.priority]),
    el("span", "card-title", item.title)
  );
  if (item.date) head.append(el("span", "card-date", dayLabel(item.date)));
  button.append(head);

  const meta = [item.time, item.duration ? `${item.duration} min` : null, TYPE[item.type]]
    .filter(Boolean).join(" · ");
  if (meta) button.append(el("span", "card-meta", meta));
  if (item.notes) button.append(el("span", "card-notes", item.notes));

  li.append(button);
  return li;
}

function render() {
  if (!state.today) return;

  const dated = state.items.filter(item => item.date).sort(byDate);
  ui.scheduled.replaceChildren();
  if (dated.length === 0) {
    ui.scheduled.append(el("p", "empty", "Nothing scheduled."));
  } else {
    const list = el("ul", "list");
    for (const item of dated) list.append(card(item));
    ui.scheduled.append(list);
  }

  const undated = state.items.filter(item => !item.date).sort(byPriority);
  ui.todo.replaceChildren();
  if (undated.length === 0) {
    ui.todo.append(el("p", "empty", "Nothing to do."));
  } else {
    const list = el("ul", "list");
    for (const item of undated) list.append(card(item));
    ui.todo.append(list);
  }
}

function upsert(saved) {
  state.items = state.items.filter(item => item.id !== saved.id);
  state.items.push(saved);
  render();
}

/* ---------- loading ---------- */

async function load() {
  try {
    const [context, items] = await Promise.all([api("/api/agenda/context"), api("/api/events")]);
    state.today = context.today;
    state.items = items;
    render();
  } catch (error) {
    setStatus(error.message, true);
  }
}

/* ---------- composer ---------- */

function setBusy(busy) {
  state.busy = busy;
  ui.input.disabled = busy;
  ui.send.disabled = busy;
  ui.send.textContent = busy ? "Adding…" : "Add";
}

ui.composer.addEventListener("submit", async event => {
  event.preventDefault();
  const text = ui.input.value.trim();
  if (!text || state.busy || !state.today) return;
  setBusy(true);
  setStatus("Interpreting your request…");
  try {
    const draft = await api("/api/agenda/interpret", { method: "POST", body: JSON.stringify({ text }) });
    const saved = await api("/api/events", { method: "POST", body: JSON.stringify(draft) });
    upsert(saved);
    ui.input.value = "";
    setStatus(`Added “${saved.title}”.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
    ui.input.focus();
  }
});

/* ---------- editor ---------- */

function readForm() {
  return {
    title: fields.title.value.trim(),
    type: fields.type.value,
    date: fields.date.value || null,
    time: fields.time.value || null,
    duration: fields.duration.value === "" ? null : Number(fields.duration.value),
    notes: fields.notes.value.trim() || null,
    priority: fields.priority.value
  };
}

function setEditorBusy(busy) {
  state.busy = busy;
  for (const control of ui.form.querySelectorAll("input, select, textarea, button")) control.disabled = busy;
  ui.save.textContent = busy ? "Saving…" : "Save";
}

function openEditor(item) {
  if (state.busy) return;
  state.editingId = item.id;
  fields.title.value = item.title;
  fields.type.value = item.type;
  fields.priority.value = item.priority;
  fields.date.value = item.date || "";
  fields.time.value = item.time || "";
  fields.duration.value = item.duration ?? "";
  fields.notes.value = item.notes || "";
  setStatus("", false, ui.editorStatus);
  ui.editor.showModal();
  fields.title.focus();
}

function closeEditor() {
  if (!state.busy) ui.editor.close();
}

ui.form.addEventListener("submit", async event => {
  event.preventDefault();
  if (state.busy || !ui.form.reportValidity()) return;
  const draft = readForm();
  if (!draft.title) {
    setStatus("Enter a title.", true, ui.editorStatus);
    return;
  }
  setEditorBusy(true);
  try {
    const saved = await api(`/api/events/${state.editingId}`, { method: "PUT", body: JSON.stringify(draft) });
    ui.editor.close();
    upsert(saved);
    setStatus("Item updated.");
  } catch (error) {
    setStatus(error.message, true, ui.editorStatus);
  } finally {
    setEditorBusy(false);
  }
});

ui.remove.addEventListener("click", async () => {
  if (state.busy || state.editingId === null) return;
  setEditorBusy(true);
  try {
    await api(`/api/events/${state.editingId}`, { method: "DELETE" });
    state.items = state.items.filter(item => item.id !== state.editingId);
    ui.editor.close();
    render();
    setStatus("Item deleted.");
  } catch (error) {
    setStatus(error.message, true, ui.editorStatus);
  } finally {
    setEditorBusy(false);
  }
});

ui.cancel.addEventListener("click", closeEditor);
ui.editor.addEventListener("cancel", event => { if (state.busy) event.preventDefault(); });

load();