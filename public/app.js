// ============================================================
// TOJ Campaign Builder — Frontend Logic
// ============================================================

const state = {
  rows: [],           // contacts/campaign rows
  columns: ["campaign_name", "name", "email", "phone", "utm_source", "utm_medium", "utm_campaign", "full_tracked_url", "qr_code_url"],
  lastBuiltUrl: null,
  lastQrDataUrl: null,
  lastUtmParts: null, // snapshot of builder at time of build
};

// ---------- TOAST ----------
function toast(msg, kind = "ok") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2500);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.errors?.join(", ") || `Error ${res.status}`);
  }
  return data;
}

// ============================================================
// AUTH
// ============================================================
async function checkAuth() {
  try {
    const me = await api("/api/me");
    if (me.authenticated) {
      document.getElementById("userEmail").textContent = me.email;
      showApp();
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

function showAuth() {
  document.getElementById("authView").classList.remove("hidden");
  document.getElementById("appView").classList.add("hidden");
}

// If we arrived with ?return=/some/admin/path, bounce there once authenticated
// (e.g. the Intake CRM sends users here to sign in, then wants them back).
// Same-origin paths only — must start with a single "/" (no "//host" open-redirect).
function returnTarget() {
  try {
    var r = new URLSearchParams(location.search).get("return");
    if (r && r.charAt(0) === "/" && r.charAt(1) !== "/") return r;
  } catch (e) {}
  return null;
}

function showApp() {
  var back = returnTarget();
  if (back) { location.href = back; return; }
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  loadTemplates();
}

// Tab toggle between login/register
document.querySelectorAll("#authView .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#authView .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    document.getElementById("loginForm").classList.toggle("hidden", which !== "login");
    document.getElementById("registerForm").classList.toggle("hidden", which !== "register");
  });
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginErr");
  errEl.textContent = "";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("loginEmail").value,
        password: document.getElementById("loginPassword").value,
      }),
    });
    document.getElementById("userEmail").textContent = data.email;
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("regErr");
  errEl.textContent = "";
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("regEmail").value,
        password: document.getElementById("regPassword").value,
      }),
    });
    document.getElementById("userEmail").textContent = data.email;
    showApp();
    toast("Account created");
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  state.rows = [];
  renderTable();
  showAuth();
});

// ============================================================
// MAIN VIEW TABS
// ============================================================
document.querySelectorAll(".tabs.main .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tabs.main .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    document.getElementById(view + "View").classList.remove("hidden");
    if (view === "templates") loadTemplates();
  });
});

// ============================================================
// UTM + QR
// ============================================================
document.getElementById("buildUtmBtn").addEventListener("click", async () => {
  const errEl = document.getElementById("utmErr");
  errEl.textContent = "";
  const payload = {
    baseUrl: document.getElementById("baseUrl").value.trim(),
    source: document.getElementById("utmSource").value.trim(),
    medium: document.getElementById("utmMedium").value.trim(),
    campaign: document.getElementById("utmCampaign").value.trim(),
    content: document.getElementById("utmContent").value.trim(),
    term: document.getElementById("utmTerm").value.trim(),
  };

  try {
    const { url } = await api("/api/utm/build", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.lastBuiltUrl = url;
    state.lastUtmParts = payload;
    document.getElementById("fullUrl").textContent = url;
    document.getElementById("copyUrlBtn").disabled = false;

    // Auto-generate QR for the built URL
    const { qr } = await api("/api/qr/generate", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    state.lastQrDataUrl = qr;
    document.getElementById("qrWrap").innerHTML = `<img src="${qr}" alt="QR code" />`;
    document.getElementById("downloadQrBtn").disabled = false;
    document.getElementById("addRowBtn").disabled = false;
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById("copyUrlBtn").addEventListener("click", async () => {
  if (!state.lastBuiltUrl) return;
  try {
    await navigator.clipboard.writeText(state.lastBuiltUrl);
    toast("Copied");
  } catch {
    toast("Copy failed", "err");
  }
});

document.getElementById("downloadQrBtn").addEventListener("click", () => {
  if (!state.lastQrDataUrl) return;
  const a = document.createElement("a");
  a.href = state.lastQrDataUrl;
  const safe = (document.getElementById("utmCampaign").value || "qr")
    .replace(/[^a-z0-9_-]/gi, "_")
    .toLowerCase();
  a.download = `${safe}_qr.png`;
  a.click();
});

document.getElementById("addRowBtn").addEventListener("click", () => {
  if (!state.lastBuiltUrl) return;
  const p = state.lastUtmParts;
  const row = {
    campaign_name: document.getElementById("campaignName").value.trim() || p.campaign,
    name: "",
    email: "",
    phone: "",
    utm_source: p.source,
    utm_medium: p.medium,
    utm_campaign: p.campaign,
    full_tracked_url: state.lastBuiltUrl,
    qr_code_url: state.lastQrDataUrl ? "[embedded PNG]" : "",
  };
  state.rows.push(row);
  renderTable();
  toast("Row added to contacts");
});

// ============================================================
// CONTACTS / CSV
// ============================================================
document.getElementById("addContactBtn").addEventListener("click", () => {
  const name = document.getElementById("cName").value.trim();
  const email = document.getElementById("cEmail").value.trim();
  const phone = document.getElementById("cPhone").value.trim();
  if (!name && !email && !phone) return;

  state.rows.push({
    campaign_name: "",
    name,
    email,
    phone,
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    full_tracked_url: "",
    qr_code_url: "",
  });
  document.getElementById("cName").value = "";
  document.getElementById("cEmail").value = "";
  document.getElementById("cPhone").value = "";
  renderTable();
});

document.getElementById("clearRowsBtn").addEventListener("click", () => {
  if (!state.rows.length) return;
  if (!confirm("Clear all rows?")) return;
  state.rows = [];
  renderTable();
});

document.getElementById("downloadCsvBtn").addEventListener("click", () => {
  if (!state.rows.length) {
    toast("No rows to download", "err");
    return;
  }
  const csv = buildCsvClient(state.rows, state.columns);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `toj_campaign_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Upload CSV
document.getElementById("uploadCsvBtn").addEventListener("click", () => {
  document.getElementById("csvFileInput").click();
});
document.getElementById("csvFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const { rows } = await api("/api/csv/parse", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    mergeParsedRows(rows);
    toast(`Imported ${rows.length} rows`);
  } catch (err) {
    toast(err.message, "err");
  }
  e.target.value = "";
});

// Paste CSV modal
const pasteModal = document.getElementById("pasteModal");
document.getElementById("pasteCsvBtn").addEventListener("click", () => {
  document.getElementById("pasteArea").value = "";
  pasteModal.classList.remove("hidden");
});
document.getElementById("pasteCancelBtn").addEventListener("click", () =>
  pasteModal.classList.add("hidden")
);
document.getElementById("pasteImportBtn").addEventListener("click", async () => {
  const text = document.getElementById("pasteArea").value.trim();
  if (!text) return;
  try {
    const { rows } = await api("/api/csv/parse", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    mergeParsedRows(rows);
    pasteModal.classList.add("hidden");
    toast(`Imported ${rows.length} rows`);
  } catch (err) {
    toast(err.message, "err");
  }
});

function mergeParsedRows(parsed) {
  // Make sure columns include every field we just imported
  parsed.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (!state.columns.includes(k)) state.columns.push(k);
    });
  });
  state.rows.push(...parsed);
  renderTable();
}

// ============================================================
// RENDER TABLE
// ============================================================
function renderTable() {
  const table = document.getElementById("rowsTable");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  if (!state.rows.length) {
    thead.innerHTML = "<tr><th>(empty — add a row to start)</th></tr>";
    tbody.innerHTML = "";
    document.getElementById("rowCount").textContent = "0 rows";
    return;
  }

  // Compute the active column order from state.columns but only keep those that appear
  const activeCols = state.columns.filter((c) =>
    state.rows.some((r) => r[c] !== undefined && r[c] !== "")
  );
  // Also add any row keys not in state.columns
  state.rows.forEach((r) =>
    Object.keys(r).forEach((k) => {
      if (!activeCols.includes(k)) activeCols.push(k);
    })
  );

  thead.innerHTML =
    "<tr>" +
    activeCols.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
    "<th></th></tr>";

  tbody.innerHTML = state.rows
    .map((r, i) => {
      const cells = activeCols
        .map((c) => {
          const v = r[c] ?? "";
          const invalid =
            (c === "email" && v && !isEmailClient(v)) ||
            (c.includes("url") && v && v !== "[embedded PNG]" && !isUrlClient(v));
          return `<td class="${invalid ? "invalid" : ""}">${escapeHtml(
            truncate(v, 60)
          )}</td>`;
        })
        .join("");
      return `<tr>${cells}<td class="remove-cell"><button class="row-x" data-i="${i}" title="Remove">×</button></td></tr>`;
    })
    .join("");

  tbody.querySelectorAll(".row-x").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const i = parseInt(e.target.dataset.i, 10);
      state.rows.splice(i, 1);
      renderTable();
    })
  );

  document.getElementById("rowCount").textContent = `${state.rows.length} rows`;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isEmailClient(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
}
function isUrlClient(v) {
  try {
    new URL(String(v).trim());
    return true;
  } catch {
    return false;
  }
}

// Client-side CSV builder (mirror of server util, for instant download)
function buildCsvClient(rows, preferredOrder) {
  const headers = [];
  preferredOrder.forEach((c) => headers.push(c));
  rows.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (!headers.includes(k)) headers.push(k);
    });
  });

  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(",")];
  rows.forEach((r) =>
    lines.push(headers.map((h) => esc(r[h])).join(","))
  );
  return lines.join("\n");
}

// ============================================================
// TEMPLATES
// ============================================================
document.getElementById("saveTemplateBtn").addEventListener("click", async () => {
  const name = document.getElementById("tplName").value.trim();
  const colsRaw = document.getElementById("tplColumns").value.trim();
  if (!name || !colsRaw) return toast("Name and columns required", "err");
  const columns = colsRaw.split(",").map((c) => c.trim()).filter(Boolean);
  try {
    await api("/api/templates", {
      method: "POST",
      body: JSON.stringify({ name, columns }),
    });
    toast("Template saved");
    document.getElementById("tplName").value = "";
    document.getElementById("tplColumns").value = "";
    loadTemplates();
  } catch (err) {
    toast(err.message, "err");
  }
});

async function loadTemplates() {
  try {
    const { templates } = await api("/api/templates");
    const list = document.getElementById("templateList");
    const entries = Object.entries(templates || {});
    if (!entries.length) {
      list.innerHTML = `<span class="muted">No templates yet.</span>`;
      return;
    }
    list.innerHTML = entries
      .map(
        ([name, t]) => `
      <div class="tpl-row">
        <div>
          <div class="name">${escapeHtml(name)}</div>
          <div class="cols">${escapeHtml(t.columns.join(", "))}</div>
        </div>
        <div class="tpl-actions">
          <button class="ghost small" data-apply="${escapeHtml(name)}">Apply</button>
          <button class="ghost small danger" data-del="${escapeHtml(name)}">Delete</button>
        </div>
      </div>`
      )
      .join("");

    list.querySelectorAll("[data-apply]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const name = btn.dataset.apply;
        state.columns = [...templates[name].columns];
        renderTable();
        toast(`Applied template: ${name}`);
        // Switch to contacts view
        document.querySelectorAll(".tabs.main .tab").forEach((t) => t.classList.remove("active"));
        document.querySelector('.tabs.main .tab[data-view="contacts"]').classList.add("active");
        document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
        document.getElementById("contactsView").classList.remove("hidden");
      })
    );
    list.querySelectorAll("[data-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const name = btn.dataset.del;
        if (!confirm(`Delete template "${name}"?`)) return;
        await api(`/api/templates/${encodeURIComponent(name)}`, { method: "DELETE" });
        loadTemplates();
      })
    );
  } catch {
    /* not logged in yet */
  }
}

document.getElementById("loadTemplateBtn").addEventListener("click", async () => {
  // quick picker via prompt for now — switches to Templates tab
  document.querySelectorAll(".tabs.main .tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tabs.main .tab[data-view="templates"]').classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById("templatesView").classList.remove("hidden");
  loadTemplates();
});

// ============================================================
// CONTACT SETS (save/load whole row collections)
// ============================================================
const setModal = document.getElementById("setModal");
let setMode = "save";

document.getElementById("saveSetBtn").addEventListener("click", () => openSetModal("save"));
document.getElementById("loadSetBtn").addEventListener("click", () => openSetModal("load"));
document.getElementById("setCancelBtn").addEventListener("click", () => setModal.classList.add("hidden"));

function openSetModal(mode) {
  setMode = mode;
  document.getElementById("setModalTitle").textContent =
    mode === "save" ? "Save contact set" : "Load contact set";
  document.getElementById("setSaveBlock").classList.toggle("hidden", mode !== "save");
  document.getElementById("setLoadBlock").classList.toggle("hidden", mode !== "load");
  document.getElementById("setConfirmBtn").classList.toggle("hidden", mode !== "save");
  document.getElementById("setName").value = "";

  if (mode === "load") populateSetList();
  setModal.classList.remove("hidden");
}

async function populateSetList() {
  try {
    const { sets } = await api("/api/contacts");
    const entries = Object.entries(sets || {});
    const list = document.getElementById("setList");
    if (!entries.length) {
      list.innerHTML = `<span class="muted">No saved sets.</span>`;
      return;
    }
    list.innerHTML = entries
      .map(
        ([name, s]) => `
      <div class="tpl-row">
        <div>
          <div class="name">${escapeHtml(name)}</div>
          <div class="cols">${s.rows.length} rows · saved ${new Date(s.updatedAt).toLocaleString()}</div>
        </div>
        <div class="tpl-actions">
          <button class="ghost small" data-load="${escapeHtml(name)}">Load</button>
          <button class="ghost small danger" data-del="${escapeHtml(name)}">Delete</button>
        </div>
      </div>`
      )
      .join("");

    list.querySelectorAll("[data-load]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const name = btn.dataset.load;
        state.rows = [...sets[name].rows];
        renderTable();
        setModal.classList.add("hidden");
        toast(`Loaded "${name}"`);
      })
    );
    list.querySelectorAll("[data-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const name = btn.dataset.del;
        if (!confirm(`Delete set "${name}"?`)) return;
        await api(`/api/contacts/${encodeURIComponent(name)}`, { method: "DELETE" });
        populateSetList();
      })
    );
  } catch (err) {
    toast(err.message, "err");
  }
}

document.getElementById("setConfirmBtn").addEventListener("click", async () => {
  if (setMode !== "save") return;
  const name = document.getElementById("setName").value.trim();
  if (!name) return toast("Name required", "err");
  if (!state.rows.length) return toast("No rows to save", "err");
  try {
    await api("/api/contacts", {
      method: "POST",
      body: JSON.stringify({ name, rows: state.rows }),
    });
    toast("Set saved");
    setModal.classList.add("hidden");
  } catch (err) {
    toast(err.message, "err");
  }
});

// ============================================================
// BOOT
// ============================================================
checkAuth();
