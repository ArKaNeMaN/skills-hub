const $ = (id) => document.getElementById(id)

const state = {
  csrf: null,
  bucket: null,
  skill: null,
  buckets: [],
}

function showLogin(message = "") {
  $("login").hidden = false
  $("app").hidden = true
  $("nav").hidden = true
  $("login-error").textContent = message
}

function showApp() {
  $("login").hidden = true
  $("app").hidden = false
  $("nav").hidden = false
}

function el(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

const ALL_SCOPES = [
  "skills:read",
  "skills:write",
  "skills:delete",
  "buckets:read",
  "buckets:write",
  "tokens:admin",
  "audit:read",
  "admin",
]
const DEFAULT_TOKEN_SCOPES = ["skills:read", "buckets:read"]

function renderScopes(container, selected = []) {
  const checked = new Set(selected)
  container.replaceChildren()
  for (const scope of ALL_SCOPES) {
    const label = el("label")
    const input = document.createElement("input")
    input.type = "checkbox"
    input.value = scope
    input.checked = checked.has(scope)
    label.append(input, document.createTextNode(` ${scope}`))
    container.append(label)
  }
}

function selectedScopes(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.value)
}

async function api(path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase()
  const headers = { Accept: "application/json", ...(options.headers ?? {}) }
  if (options.body !== undefined) headers["Content-Type"] = "application/json"
  if (method !== "GET" && method !== "HEAD" && state.csrf) headers["X-CSRF-Token"] = state.csrf
  const response = await fetch(path, {
    ...options,
    method,
    credentials: "same-origin",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  if (response.status === 401) {
    state.csrf = null
    showLogin("Session expired")
    throw new Error("unauthorized")
  }
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail ?? data.title ?? data.code ?? `HTTP ${response.status}`)
  return data
}

function setTab(name) {
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = true
  $(`tab-${name}`).hidden = false
  for (const button of document.querySelectorAll("#nav [data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === name)
  }
  if (name === "buckets") loadBuckets()
  if (name === "tokens") loadTokens()
  if (name === "audit") loadAudit()
}

async function loadSession() {
  try {
    const session = await api("/api/v1/admin/session")
    state.csrf = session.csrfToken
    showApp()
    setTab("buckets")
  } catch {
    showLogin("")
  }
}

async function loadBuckets() {
  const data = await api("/api/v1/admin/buckets")
  state.buckets = data.buckets ?? []
  const list = $("bucket-list")
  list.replaceChildren()
  for (const bucket of state.buckets) {
    const item = el("li")
    const button = el("button", bucket.slug, "link")
    button.addEventListener("click", () => openBucket(bucket.slug))
    item.append(button, el("span", ` ${bucket.name}`, "muted"))
    if (bucket.last_index_error) item.append(el("div", bucket.last_index_error, "error small"))
    list.append(item)
  }
}

async function openBucket(slug) {
  state.bucket = slug
  state.skill = null
  $("bucket-view").hidden = false
  $("skill-editor").hidden = true
  $("bucket-title").textContent = slug
  await loadSkills()
}

async function loadSkills() {
  const data = await api(`/api/v1/admin/skills?bucket=${encodeURIComponent(state.bucket)}`)
  const group = (data.buckets ?? []).find((entry) => entry.bucket === state.bucket)
  const list = $("skill-list")
  list.replaceChildren()
  for (const skill of group?.skills ?? []) {
    const item = el("li")
    const button = el("button", skill.name, "link")
    button.addEventListener("click", () => openSkill(skill.name))
    item.append(button, el("span", ` ${skill.description}`, "muted"))
    list.append(item)
  }
}

function renderFile(path, content) {
  const box = el("div", undefined, "file")
  const head = el("div", undefined, "row")
  head.append(el("strong", path))
  const save = el("button", "Save")
  const remove = el("button", "Delete", "danger")
  head.append(save, remove)
  const textarea = el("textarea")
  textarea.value = content
  box.append(head, textarea)
  save.addEventListener("click", async () => {
    try {
      await api(`/api/v1/admin/skills/${encodeURIComponent(state.bucket)}/${encodeURIComponent(state.skill)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        body: { content: textarea.value },
      })
      $("editor-status").textContent = `Saved ${path}`
    } catch (error) {
      $("editor-status").textContent = error.message
    }
  })
  remove.addEventListener("click", async () => {
    if (path === "SKILL.md") {
      $("editor-status").textContent = "Use Delete skill to remove SKILL.md"
      return
    }
    if (!confirm(`Delete ${path}?`)) return
    try {
      await api(`/api/v1/admin/skills/${encodeURIComponent(state.bucket)}/${encodeURIComponent(state.skill)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "DELETE",
      })
      await openSkill(state.skill)
    } catch (error) {
      $("editor-status").textContent = error.message
    }
  })
  return box
}

async function openSkill(name) {
  state.skill = name
  $("skill-editor").hidden = false
  $("skill-title").textContent = `${state.bucket}/${name}`
  const data = await api(`/api/v1/admin/skills/${encodeURIComponent(state.bucket)}/${encodeURIComponent(name)}`)
  const files = $("files")
  files.replaceChildren()
  for (const file of data.files ?? []) files.append(renderFile(file.path, file.content))
  $("editor-status").textContent = ""
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  try {
    const response = await fetch("/api/v1/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ adminToken: $("login-token").value }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.detail ?? data.code ?? "login failed")
    state.csrf = data.csrfToken
    $("login-token").value = ""
    showApp()
    setTab("buckets")
  } catch (error) {
    $("login-error").textContent = error.message
  }
})

$("logout").addEventListener("click", async () => {
  try {
    await api("/api/v1/admin/logout", { method: "POST" })
  } catch {
    // ignore
  }
  state.csrf = null
  showLogin("")
})

for (const button of document.querySelectorAll("#nav [data-tab]")) {
  button.addEventListener("click", () => setTab(button.dataset.tab))
}

$("bucket-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  try {
    await api("/api/v1/admin/buckets", {
      method: "POST",
      body: { slug: $("bucket-slug").value, name: $("bucket-name").value },
    })
    $("bucket-slug").value = ""
    $("bucket-name").value = ""
    await loadBuckets()
  } catch (error) {
    alert(error.message)
  }
})

$("skill-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const name = $("skill-name").value.trim()
  if (!name) return
  try {
    await api(`/api/v1/admin/skills/${encodeURIComponent(state.bucket)}/${encodeURIComponent(name)}/files/SKILL.md`, {
      method: "PUT",
      body: { content: `---\nname: ${name}\ndescription: TODO describe ${name}\n---\n\n` },
    })
    $("skill-name").value = ""
    await loadSkills()
    await openSkill(name)
  } catch (error) {
    alert(error.message)
  }
})

$("add-file-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const path = $("add-file-path").value.trim()
  if (!path) return
  try {
    await api(`/api/v1/admin/skills/${encodeURIComponent(state.bucket)}/${encodeURIComponent(state.skill)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      body: { content: "" },
    })
    $("add-file-path").value = ""
    await openSkill(state.skill)
  } catch (error) {
    $("editor-status").textContent = error.message
  }
})

$("delete-skill").addEventListener("click", async () => {
  if (!confirm(`Delete skill ${state.skill}?`)) return
  try {
    await api(`/api/v1/admin/skills/${encodeURIComponent(state.bucket)}/${encodeURIComponent(state.skill)}`, { method: "DELETE" })
    $("skill-editor").hidden = true
    await loadSkills()
  } catch (error) {
    $("editor-status").textContent = error.message
  }
})

async function loadTokens() {
  const data = await api("/api/v1/admin/tokens")
  const list = $("token-list")
  list.replaceChildren()
  for (const token of data.tokens ?? []) {
    const item = el("li")
    const head = el("div", undefined, "row")
    const summary = el("div")
    summary.append(el("strong", token.label), el("span", ` ${token.id}`, "muted"))
    summary.append(el("div", `scopes: ${(token.scopes ?? []).join(", ") || "none"}`, "muted small"))
    const bucketText = token.allBuckets ? "all buckets" : (token.buckets ?? []).join(", ") || "none"
    summary.append(el("div", `buckets: ${bucketText}`, "muted small"))
    if (token.revokedAt) summary.append(el("span", " revoked", "error"))
    head.append(summary)
    item.append(head)

    if (!token.revokedAt) {
      const editor = el("div", undefined, "token-editor")
      editor.hidden = true

      const scopeGroup = el("div", undefined, "scopes")
      const bucketsInput = document.createElement("input")
      bucketsInput.placeholder = "buckets, comma separated"
      const allLabel = el("label")
      const allCheckbox = document.createElement("input")
      allCheckbox.type = "checkbox"
      allLabel.append(allCheckbox, document.createTextNode(" All buckets"))
      const error = el("p", undefined, "error small")
      error.hidden = true
      const buttons = el("div", undefined, "inline")
      const save = el("button", "Save")
      const cancel = el("button", "Cancel", "secondary")
      buttons.append(save, cancel)
      editor.append(scopeGroup, bucketsInput, allLabel, error, buttons)

      const setError = (message) => {
        error.textContent = message
        error.hidden = !message
      }
      const resetEditor = () => {
        renderScopes(scopeGroup, token.scopes ?? [])
        bucketsInput.value = (token.buckets ?? []).join(", ")
        allCheckbox.checked = Boolean(token.allBuckets)
        bucketsInput.disabled = allCheckbox.checked
        setError("")
      }
      allCheckbox.addEventListener("change", () => {
        bucketsInput.disabled = allCheckbox.checked
      })
      save.addEventListener("click", async () => {
        setError("")
        const allBuckets = allCheckbox.checked
        const scopes = selectedScopes(scopeGroup)
        const buckets = allBuckets
          ? []
          : bucketsInput.value.split(",").map((entry) => entry.trim()).filter(Boolean)
        if (!allBuckets && buckets.length === 0) {
          setError("At least one bucket is required")
          return
        }
        try {
          await api(`/api/v1/admin/tokens/${encodeURIComponent(token.id)}`, {
            method: "PATCH",
            body: { scopes, buckets, allBuckets },
          })
          await loadTokens()
        } catch (err) {
          setError(err.message)
        }
      })
      cancel.addEventListener("click", () => {
        editor.hidden = true
        resetEditor()
      })
      resetEditor()

      const actions = el("div", undefined, "inline")
      const edit = el("button", "Edit", "secondary")
      const revoke = el("button", "Revoke", "danger")
      edit.addEventListener("click", () => {
        editor.hidden = !editor.hidden
      })
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke ${token.label}?`)) return
        await api(`/api/v1/admin/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" })
        await loadTokens()
      })
      actions.append(edit, revoke)
      head.append(actions)
      item.append(editor)
    }
    list.append(item)
  }
}

$("token-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const scopes = selectedScopes($("token-scopes"))
  try {
    const data = await api("/api/v1/admin/tokens", {
      method: "POST",
      body: {
        label: $("token-label").value,
        scopes,
        buckets: $("token-buckets").value.split(",").map((item) => item.trim()).filter(Boolean),
      },
    })
    $("new-token").textContent = data.token
    $("token-label").value = ""
    await loadTokens()
  } catch (error) {
    alert(error.message)
  }
})

async function loadAudit() {
  const data = await api("/api/v1/admin/audit?limit=100")
  const body = $("audit-body")
  body.replaceChildren()
  for (const entry of data.entries ?? []) {
    const row = el("tr")
    for (const value of [entry.ts, entry.actor_type, entry.action, entry.bucket_slug, entry.skill_name, entry.result]) {
      row.append(el("td", value ?? ""))
    }
    body.append(row)
  }
}

$("refresh-audit").addEventListener("click", () => loadAudit())

renderScopes($("token-scopes"), DEFAULT_TOKEN_SCOPES)

loadSession()
