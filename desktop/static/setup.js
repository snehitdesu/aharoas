// First-run wizard (runs in a sandboxed renderer; talks only to window.aharosSetup).
"use strict";

const $ = (id) => document.getElementById(id);
const form = $("form");
const errorBox = $("error");

function showStep(n) {
  for (const i of [0, 1, 2, 3]) {
    const el = $(`step-${i}`);
    if (el) el.hidden = i !== n;
  }
  form.hidden = !(n === 1 || n === 2);
  document.querySelectorAll(".steps li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === Math.max(1, n));
    li.classList.toggle("done", s < n);
  });
  const first = document.querySelector(`#step-${n} input, #step-${n} button:not([disabled])`);
  if (first) first.focus();
}

function setError(msg) {
  errorBox.textContent = msg || "";
  errorBox.hidden = !msg;
}

function clearFieldErrors() {
  form.querySelectorAll(".field-error").forEach((e) => e.remove());
  form.querySelectorAll("[aria-invalid]").forEach((e) => {
    e.removeAttribute("aria-invalid");
    e.removeAttribute("aria-describedby");
  });
}

function fieldError(name, messages) {
  const input = form.elements.namedItem(name);
  if (!input) return false;
  input.setAttribute("aria-invalid", "true");
  // Outside the <label> so the message does not become part of the field's name.
  const p = document.createElement("span");
  p.className = "field-error";
  p.id = `${name}-error`;
  p.textContent = messages.join(" · ");
  input.setAttribute("aria-describedby", p.id);
  (input.closest("label") || input).insertAdjacentElement("afterend", p);
  return true;
}

function requireFields(names) {
  clearFieldErrors();
  let ok = true;
  for (const n of names) {
    const el = form.elements.namedItem(n);
    if (!el.value.trim()) {
      fieldError(n, ["Required"]);
      ok = false;
    }
  }
  return ok;
}

const STEP1 = ["organizationName", "outletName", "outletCode", "timezone", "currency"];
const STEP2 = ["ownerName", "ownerEmail", "ownerPassword", "confirmPassword"];

$("choose-new").addEventListener("click", () => showStep(1));
$("back-1").addEventListener("click", () => showStep(0));
$("back-2").addEventListener("click", () => showStep(1));
$("next-1").addEventListener("click", () => {
  setError("");
  if (requireFields(STEP1)) showStep(2);
});
form.querySelectorAll("input.upper").forEach((el) => el.addEventListener("input", () => (el.value = el.value.toUpperCase())));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  if (!requireFields(STEP2)) return;
  const data = Object.fromEntries(new FormData(form).entries());
  if (data.ownerPassword !== data.confirmPassword) {
    fieldError("confirmPassword", ["Passwords do not match"]);
    return;
  }
  delete data.confirmPassword;
  const button = $("create");
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const res = await window.aharosSetup.submit(data);
    if (res && res.ok) {
      form.reset();
      $("owner-email").textContent = res.ownerEmail;
      showStep(3);
      return;
    }
    clearFieldErrors();
    const fe = (res && res.fieldErrors) || {};
    let firstStep = 0;
    for (const [k, msgs] of Object.entries(fe)) {
      const key = k === "password" ? "ownerPassword" : k;
      if (fieldError(key, msgs)) firstStep = firstStep || (STEP1.includes(key) ? 1 : 2);
    }
    if (firstStep) showStep(firstStep);
    setError((res && res.message) || "Setup failed");
  } catch (err) {
    setError(String((err && err.message) || err));
  } finally {
    button.disabled = false;
    button.textContent = "Create restaurant";
  }
});

$("finish").addEventListener("click", () => window.aharosSetup.finish());

window.aharosSetup.defaults().then((d) => {
  form.elements.namedItem("timezone").value = d.timezone;
  form.elements.namedItem("currency").value = d.currency;
  $("version").textContent = `Aharos ${d.version}`;
});
showStep(0);
