const LANGS = [
  { code: "zh", name: "中文" },
  { code: "en", name: "英语" },
  { code: "ja", name: "日语" },
  { code: "ko", name: "韩语" },
  { code: "ru", name: "俄语" }
];

const STORE = "lt.workbench.v2";

const DEFAULT_PROMPT = [
  "你是专业翻译引擎，把下面的文本从 {sourceLang} 翻译成 {targetLang}。",
  "只输出译文，不解释、不加引号、不重复原文。",
  "保留原有标点；人名、模型名、lora 名、标签保持原样。",
  "出现 ⟦P0⟧ 这类占位符时原样保留在原位置。"
].join("\n");

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8081/v1",
  apiKey: "",
  model: "qwen3.6-27b",
  temperature: 0.2,
  topP: 0.9,
  maxTokens: 1024,
  concurrency: 2,
  src: "en",
  tgt: "zh",
  segmentMode: "original",
  protect: false,
  systemPrompt: DEFAULT_PROMPT
};

const $ = (id) => document.getElementById(id);
const state = {
  settings: { ...DEFAULTS },
  profiles: [],
  activeProfile: "",
  theme: "auto",
  view: "text",
  textSegments: [],
  exportStyle: "block",
  exportCols: { source: false, target: true, back: false },
  glossary: [],
  glossaryOn: true,
  files: [],
  activeFileId: "",
  closedFolders: [],
  gapReport: {},
  warnMode: "all",
  scope: { translate: "current", back: "current" },
  controller: null,
  aborted: false,
  busy: false,
  apiOk: false
};

function normalize(t) { return String(t || "").replace(/\s+/g, " ").trim().toLowerCase(); }

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.max(52, el.scrollHeight) + "px";
}

function fitRow(row) {
  const areas = row.querySelectorAll("textarea");
  if (!areas.length) return;
  areas.forEach((a) => { a.style.height = "auto"; });
  let max = 52;
  let border = 0;
  areas.forEach((a) => {
    max = Math.max(max, a.scrollHeight);
    border = Math.max(border, a.offsetHeight - a.clientHeight);
  });
  areas.forEach((a) => { a.style.height = max + border + "px"; });
}

function saveState() {
  const data = {
    settings: state.settings,
    profiles: state.profiles,
    activeProfile: state.activeProfile,
    theme: state.theme,
    view: state.view,
    glossary: state.glossary,
    glossaryOn: state.glossaryOn,
    exportStyle: state.exportStyle,
    exportCols: state.exportCols,
    textSegments: state.textSegments,
    files: state.files,
    activeFileId: state.activeFileId,
    closedFolders: state.closedFolders,
    scope: state.scope
  };
  try {
    localStorage.setItem(STORE, JSON.stringify(data));
    storageWarned = false;
  } catch {
    if (!storageWarned) {
      storageWarned = true;
      setStatus("浏览器存储已满，请删除部分文件后再导入", true);
    }
  }
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
    state.settings = { ...DEFAULTS, ...(raw.settings || {}) };
    if (!state.settings.segmentMode && raw.settings?.lineMode) state.settings.segmentMode = "line";
    state.profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
    state.activeProfile = raw.activeProfile || "";
    state.theme = raw.theme || "auto";
    state.view = raw.view === "files" ? "files" : "text";
    state.exportStyle = raw.exportStyle === "sentence" ? "sentence" : "block";
    state.exportCols = { source: false, target: true, back: false, ...(raw.exportCols || {}) };
    state.glossary = Array.isArray(raw.glossary) ? raw.glossary : [];
    state.glossaryOn = raw.glossaryOn !== false;
    state.textSegments = Array.isArray(raw.textSegments) ? raw.textSegments : [];
    state.files = Array.isArray(raw.files) ? raw.files : [];
    state.activeFileId = raw.activeFileId || (state.files[0] && state.files[0].id) || "";
    state.closedFolders = Array.isArray(raw.closedFolders) ? raw.closedFolders : [];
    state.scope = { translate: "current", back: "current", ...(raw.scope || {}) };
  } catch {}
}

let storageWarned = false;

const saveSoon = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(saveState, 300); }; })();

function currentSegments() {
  if (state.view === "files") {
    const file = state.files.find((f) => f.id === state.activeFileId);
    return file ? file.segments : [];
  }
  return state.textSegments;
}

function setStatus(text, error) {
  const el = $("status");
  el.textContent = text || "";
  el.style.color = error ? "var(--danger)" : "";
}

/* ---------- 语言 ---------- */
function fillLangs() {
  for (const id of ["srcLang", "tgtLang"]) {
    const sel = $(id);
    sel.innerHTML = "";
    for (const l of LANGS) {
      const o = document.createElement("option");
      o.value = l.code; o.textContent = l.name;
      sel.appendChild(o);
    }
  }
  $("srcLang").value = state.settings.src;
  $("tgtLang").value = state.settings.tgt;
}

/* ---------- 分段 ---------- */
// 称谓、头衔：后面几乎总是接名字，无条件合并
const ABBREV_ALWAYS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "hon", "gen", "col", "capt", "lt", "sgt",
  "cmdr", "adm", "gov", "sen", "rep", "pres", "supt", "insp", "fr", "sr", "jr", "st", "mt"
]);

// 月份、星期、州名、拉丁缩写、学位、公司、度量衡：只在下一句是小写/数字开头时才合并
const ABBREV_CONDITIONAL = new Set([
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "ala", "ariz", "ark", "calif", "colo", "conn", "del", "fla", "ga", "ill", "ind",
  "kan", "kans", "ky", "la", "md", "mass", "mich", "minn", "miss", "mo", "mont",
  "neb", "nebr", "nev", "okla", "ore", "pa", "penn", "tenn", "tex", "va", "vt",
  "wash", "wisc", "wis", "wyo", "dc",
  "etc", "vs", "al", "am", "pm", "no", "cf", "viz", "ibid",
  "phd", "ba", "ma", "bs", "dds", "md",
  "co", "inc", "ltd", "corp", "bros", "plc", "llc",
  "in", "ft", "lb", "oz", "pp", "p", "approx", "min", "max", "sec", "hr", "mi", "km", "kg", "cm", "mm",
  "vol", "fig", "ch", "art", "para", "ed", "eds", "trans", "dept", "univ", "est", "misc", "esp", "incl"
]);

const ABBREV_DOTTED_ALWAYS = new Set(["us", "uk", "un", "eu", "usa", "ussr"]);

function abbreviationKind(text) {
  const t = String(text || "").trim();
  if (!t.endsWith(".")) return "";
  if (/^\d+\.$/.test(t)) return "always";                 // 列表编号 1. 2.
  const m = /([A-Za-z][A-Za-z.]*)\.$/.exec(t);
  if (!m) return "";
  const word = m[1].replace(/\./g, "").toLowerCase();
  if (ABBREV_ALWAYS.has(word)) return "always";
  if (ABBREV_CONDITIONAL.has(word)) return "conditional";
  if (/(?:[A-Za-z]\.){2,}$/.test(t)) {                     // e.g. / U.S. / Ph.D. / a.m.
    return ABBREV_DOTTED_ALWAYS.has(word) ? "always" : "conditional";
  }
  if (/^[A-Z]$/.test(m[1])) return "initial";               // J. K. Rowling
  return "";
}

function mergeAbbreviations(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const last = out[out.length - 1];
    if (last) {
      const kind = abbreviationKind(last.text);
      const nextLower = /^[a-z0-9(\[]/.test(chunk.text);
      const nextUpper = /^[A-Z]/.test(chunk.text);
      const shouldMerge =
        kind === "always" ||
        (kind === "strong" && (nextUpper || nextLower)) ||
        (kind === "conditional" && nextLower) ||
        (kind === "initial" && nextUpper);
      if (shouldMerge) {
        last.text = last.text + (chunk.gap || " ") + chunk.text;
        continue;
      }
    }
    out.push({ ...chunk });
  }
  return out;
}

function splitText(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const seg = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    if (state.settings.segmentMode === "original") {
      out.push({ text: line.trim(), line: lineIndex, gap: "" });
      return;
    }
    const chunks = [];
    let prevEnd = 0;
    const trailing = (raw) => (raw.match(/\s+$/) || [""])[0];
    let tail = "";
    if (seg) {
      for (const part of seg.segment(line)) {
        const raw = part.segment;
        if (!raw.trim()) { tail += raw; prevEnd = part.index + raw.length; continue; }
        chunks.push({ text: raw.trim(), gap: tail + line.slice(prevEnd, part.index) });
        prevEnd = part.index + raw.length;
        tail = trailing(raw);
      }
    } else {
      const parts = line.split(/(?<=[.!?。！？])\s*/);
      let cursor = 0;
      for (const t of parts) {
        const idx = line.indexOf(t, cursor);
        if (!t.trim()) { tail += t; cursor = idx + t.length; continue; }
        chunks.push({ text: t.trim(), gap: tail + line.slice(cursor, idx) });
        cursor = idx + t.length;
        tail = trailing(t);
      }
    }
    if (!chunks.length) out.push({ text: line.trim(), line: lineIndex, gap: "" });
    mergeAbbreviations(chunks).forEach((c) => out.push({ text: c.text, line: lineIndex, gap: c.gap }));
  });
  return out;
}

function toSegments(parts) {
  return parts.map((part) => ({
    source: typeof part === "string" ? part : part.text,
    line: typeof part === "string" ? 0 : part.line,
    gap: typeof part === "string" ? " " : part.gap,
    target: "", back: "", status: "", error: false
  }));
}

/* ---------- ComfyUI 保护 ---------- */
function protectComfy(text) {
  const tokens = [];
  const patterns = [
    /<lora:[^>]*>/gi, /<lyco:[^>]*>/gi, /<hypernetwork:[^>]*>/gi, /<[a-zA-Z][\w:-]*:[^>]*>/g,
    /\([^()]*:\s*-?\d+(?:\.\d+)?\)/g, /\[[^\[\]|]*\|[^\[\]]*\]/g,
    /\bBREAK\b/g, /\b(?:AND|ADDROW|ADDCOL|ADDBASE)\b/g
  ];
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => { const i = tokens.length; tokens.push(m); return "⟦P" + i + "⟧"; });
  }
  return { text: out, tokens };
}
function restoreComfy(text, tokens) {
  return tokens.length ? text.replace(/⟦\s*P(\d+)\s*⟧/g, (m, i) => tokens[Number(i)] ?? m) : text;
}
function missingTokens(text, tokens) { return tokens.filter((t) => !String(text || "").includes(t)); }

/* ---------- API ---------- */
function baseUrl() { return state.settings.baseUrl.replace(/\/+$/, ""); }
function authHeaders() {
  const h = { "content-type": "application/json" };
  if (state.settings.apiKey) h.authorization = "Bearer " + state.settings.apiKey;
  return h;
}

async function fetchModels() {
  const res = await fetch(baseUrl() + "/models", { headers: authHeaders() });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

async function checkApi() {
  try {
    const ids = await fetchModels();
    state.apiOk = true;
    $("apiDot").className = "dot ok";
    updateBubble();
    $("apiHint").textContent = ids.length + " 个模型";
    $("apiHint").className = "hint";
    fillModels(ids);
    return true;
  } catch (e) {
    state.apiOk = false;
    $("apiDot").className = "dot on";
    updateBubble();
    $("apiHint").textContent = "连接失败";
    $("apiHint").className = "hint err";
    return false;
  }
}

function fillModels(ids) {
  const sel = $("model");
  sel.innerHTML = "";
  for (const id of ids) {
    const o = document.createElement("option");
    o.value = id; o.textContent = id;
    sel.appendChild(o);
  }
  if (!ids.includes(state.settings.model) && ids.length) state.settings.model = ids[0];
  if (state.settings.model && !ids.includes(state.settings.model)) {
    const o = document.createElement("option");
    o.value = state.settings.model; o.textContent = state.settings.model;
    sel.appendChild(o);
  }
  sel.value = state.settings.model;
}

async function chat(text, direction, nudge, signal) {
  const src = LANGS.find((l) => l.code === state.settings.src)?.name || state.settings.src;
  const tgt = LANGS.find((l) => l.code === state.settings.tgt)?.name || state.settings.tgt;
  const from = direction === "back" ? tgt : src;
  const to = direction === "back" ? src : tgt;
  const system = state.settings.systemPrompt
    .replaceAll("{sourceLang}", from).replaceAll("{targetLang}", to)
    .replaceAll("{src}", from).replaceAll("{tgt}", to);
  const gloss = glossaryBlock(direction);
  const messages = [{ role: "system", content: gloss ? system + "\n\n" + gloss : system }, { role: "user", content: text }];
  if (nudge) messages.push({ role: "user", content: nudge });
  const res = await fetch(baseUrl() + "/chat/completions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: state.settings.model,
      messages,
      temperature: Number(state.settings.temperature),
      top_p: Number(state.settings.topP),
      max_tokens: Number(state.settings.maxTokens),
      stream: false
    }),
    signal
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

const ECHO_NUDGE = "上面是待翻译文本，必须输出目标语言译文，禁止原样返回。";

function glossaryBlock(direction) {
  if (!state.glossaryOn) return "";
  const pairs = state.glossary.filter((g) => g.src && g.tgt);
  if (!pairs.length) return "";
  const lines = pairs
    .map((g) => (direction === "back" ? g.tgt + " => " + g.src : g.src + " => " + g.tgt))
    .join("\n");
  return "术语对照，遇到左侧词必须使用右侧译法：\n" + lines;
}

async function translateSegment(seg, direction, signal) {
  const input = direction === "back" ? seg.target : seg.source;
  const bundle = state.settings.protect ? protectComfy(input) : { text: input, tokens: [] };
  let out = await chat(bundle.text, direction, "", signal);
  if (normalize(out) === normalize(bundle.text)) out = await chat(bundle.text, direction, ECHO_NUDGE, signal);
  let restored = restoreComfy(out, bundle.tokens);
  const lost = missingTokens(restored, bundle.tokens);
  if (lost.length) {
    const retry = await chat(bundle.text, direction, "必须原样保留这些片段：" + lost.join(" "), signal);
    const retried = restoreComfy(retry, bundle.tokens);
    if (missingTokens(retried, bundle.tokens).length < lost.length) restored = retried;
  }
  return { text: restored, lost: missingTokens(restored, bundle.tokens).length };
}

function activeFile() {
  return state.files.find((f) => f.id === state.activeFileId) || null;
}

/* 断点接续：同一段落 + 同一参数 + 同一方向，做过就不再请求 */
function paramSignature() {
  return [
    state.settings.model, state.settings.src, state.settings.tgt,
    state.settings.temperature, state.settings.topP,
    state.settings.protect ? "p1" : "p0",
    state.settings.glossaryOn ? "g1" : "g0",
    state.settings.systemPrompt
  ].join("¦");
}

function memoKey(seg, direction) {
  const input = direction === "back" ? seg.target : seg.source;
  return [paramSignature(), direction, String(input || "")].join("¦");
}

function isMemoHit(seg, direction) {
  const entry = seg.memo && seg.memo[direction];
  if (!entry || typeof entry !== "object") return false;
  if (entry.key !== memoKey(seg, direction)) return false;
  const current = direction === "back" ? seg.back : seg.target;
  return String(current ?? "") === String(entry.value ?? "");
}

async function translateOne(seg, direction, signal) {
  if (isMemoHit(seg, direction)) return;
  seg.status = "…"; seg.error = false; renderAll();
  try {
    const r = await translateSegment(seg, direction, signal);
    if (direction === "back") seg.back = r.text; else seg.target = r.text;
    const same = direction === "forward"
      ? normalize(seg.target) === normalize(seg.source)
      : normalize(seg.back) === normalize(seg.target);
    seg.status = r.lost ? "占位符丢失" : same ? "原样返回" : "";
    seg.error = Boolean(r.lost || same);
    seg.memo = {
      ...(seg.memo || {}),
      [direction]: { key: memoKey(seg, direction), value: direction === "back" ? seg.back : seg.target }
    };
  } catch (e) {
    if (e && e.name === "AbortError") { seg.status = "已中断"; return; }
    seg.status = "失败"; seg.error = true;
  }
  renderAll(); saveSoon();
}

async function runTasks(tasks, direction) {
  if (state.busy || !tasks.length) return;
  state.busy = true; state.aborted = false;
  const controller = new AbortController();
  state.controller = controller;
  $("abortBtn").classList.remove("hidden");
  let done = 0;
  let cursor = 0;
  const limit = Math.max(1, Number(state.settings.concurrency) || 1);
  const label = direction === "back" ? "回译" : "翻译";
  const worker = async () => {
    while (cursor < tasks.length && !state.aborted) {
      const task = tasks[cursor++];
      await translateOne(task.seg, direction, controller.signal);
      done += 1;
      setStatus(label + " " + done + "/" + tasks.length + (state.aborted ? "（中断中）" : ""));
      if (state.aborted) break;
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  state.busy = false;
  state.controller = null;
  $("abortBtn").classList.add("hidden");
  renderAll(); saveSoon();
  const failed = tasks.filter((t) => t.seg.error).length;
  if (state.aborted) setStatus("已中断  点击 翻译/回译 即可续接");
  else setStatus(failed ? "完成，失败 " + failed : "完成", failed > 0);
}

function runOn(list, indexes, direction) {
  const tasks = indexes.map((i) => list[i]).filter(Boolean).map((seg) => ({ seg }));
  return runTasks(tasks, direction);
}

async function runScope(direction, scope) {
  const files = scope === "all" ? state.files.slice() : [activeFile()].filter(Boolean);
  const tasks = [];
  for (const file of files) {
    for (const seg of file.segments) {
      const input = direction === "back" ? seg.target : seg.source;
      if (!String(input || "").trim()) continue;
      if (isMemoHit(seg, direction)) continue;
      tasks.push({ seg });
    }
  }
  if (!tasks.length) { setStatus("没有需要处理的段落"); return; }
  await runTasks(tasks, direction);
}

function fillBackByScope(scope) {
  const files = scope === "all" ? state.files.slice() : [activeFile()].filter(Boolean);
  let count = 0;
  for (const file of files) {
    for (const seg of file.segments) {
      if (!String(seg.back || "").trim() && String(seg.source || "").trim()) {
        seg.back = seg.source;
        count += 1;
      }
    }
  }
  renderAll(); saveSoon();
  setStatus("填充 " + count + " 条回译");
}

/* ---------- 渲染 ---------- */

/* ---------- 渲染 ---------- */
function renderRows() {
  const rows = $("rows");
  rows.innerHTML = "";
  const list = currentSegments();
  $("empty").hidden = list.length > 0;
  list.forEach((seg, index) => {
    const row = document.createElement("div");
    row.className = "row";

    const no = document.createElement("div");
    no.className = "no"; no.textContent = String(index + 1);

    const makeArea = (value, cls, onChange) => {
      const ta = document.createElement("textarea");
      ta.value = value || "";
      ta.spellcheck = false;
      if (cls) ta.className = cls;
      ta.addEventListener("input", () => { onChange(ta.value); fitRow(row); saveSoon(); });
      return ta;
    };

    const source = makeArea(seg.source, "", (v) => { seg.source = v; });
    const target = makeArea(seg.target, "", (v) => { seg.target = v; });
    const back = makeArea(seg.back, "back", (v) => { seg.back = v; });
    back.placeholder = "回译";

    const actions = document.createElement("div");
    actions.className = "cell-actions";
    const t = document.createElement("button");
    t.textContent = "译";
    t.onclick = () => runOn(currentSegments(), [index], "forward");
    const b = document.createElement("button");
    b.textContent = "回译";
    b.onclick = () => runOn(currentSegments(), [index], "back");
    const badge = document.createElement("span");
    badge.className = "badge" + (seg.error ? " err" : "");
    badge.textContent = seg.status || "";
    actions.append(t, b, badge);

    row.append(no, source, target, back, actions);
    rows.appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => fitRow(row)));
    setTimeout(() => fitRow(row), 60);
  });
}

function renderGlossary() {
  const box = $("glossList");
  box.innerHTML = "";
  if (!state.glossary.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "还没有术语";
    box.appendChild(p);
  }
  state.glossary.forEach((g, index) => {
    const row = document.createElement("div");
    row.className = "gloss-row";
    const a = document.createElement("input");
    a.type = "text"; a.value = g.src || ""; a.placeholder = "原文";
    a.addEventListener("input", () => { g.src = a.value; saveSoon(); });
    const b = document.createElement("input");
    b.type = "text"; b.value = g.tgt || ""; b.placeholder = "译法";
    b.addEventListener("input", () => { g.tgt = b.value; saveSoon(); });
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "删除";
    del.onclick = () => { state.glossary.splice(index, 1); renderGlossary(); saveSoon(); };
    row.append(a, b, del);
    box.appendChild(row);
  });
  $("glossOn").checked = state.glossaryOn;
  document.querySelectorAll("#styleToggle button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.style === state.exportStyle);
  });
  $("expSrc").checked = state.exportCols.source;
  $("expTgt").checked = state.exportCols.target;
  $("expBack").checked = state.exportCols.back;
}

function importGlossary(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const rows = String(fr.result || "").split(/\r?\n/).map((l) => l.split(/\t|,/)).filter((r) => r.length >= 2 && r[0].trim());
    for (const r of rows) state.glossary.push({ src: r[0].trim(), tgt: r[1].trim() });
    renderGlossary(); saveSoon();
    setStatus("导入 " + rows.length + " 条术语");
  };
  fr.readAsText(file, "utf-8");
}

function exportGlossary() {
  const body = state.glossary.map((g) => g.src + "," + g.tgt).join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "glossary.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderFiles() {
  const box = $("fileList");
  box.innerHTML = "";
  if (!state.files.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "还没有导入文件";
    box.appendChild(p);
  } else {
    const list = document.createElement("ul");
    list.className = "tree";
    renderTree(buildFileTree(state.files), list, "");
    box.appendChild(list);
  }
  const active = state.files.find((f) => f.id === state.activeFileId);
  $("fileName").textContent = state.view === "files" && active ? (active.path || active.name) : "";
  updateEdge();
}

function updateEdge() {
  const visible = state.view === "files" && state.files.length > 1 && $("drawerFiles").hidden;
  $("fileDrawerToggle").classList.toggle("hidden", !visible);
}

function renderAll() {
  renderRows();
  renderFiles();
}

/* ---------- 模式 ---------- */
function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  $("textActions").classList.toggle("hidden", view !== "text");
  $("fileActions").classList.toggle("hidden", view !== "files");
  $("sourceInput").classList.toggle("hidden", view !== "text");
  closeDrawers();
  renderAll();
  saveSoon();
}

/* ---------- 抽屉 ---------- */
function updateBubble() {
  const anyOpen = !$("drawerApi").hidden || !$("drawerMisc").hidden || !$("drawerFiles").hidden || !$("drawerGloss").hidden;
  $("apiBubble").hidden = anyOpen || state.apiOk;
}

function closeDrawers() {
  $("drawerApi").hidden = true;
  $("drawerMisc").hidden = true;
  $("drawerFiles").hidden = true;
  $("drawerGloss").hidden = true;
  updateBubble();
  updateEdge();
}
function toggleDrawer(name) {
  const el = $("drawer" + name[0].toUpperCase() + name.slice(1));
  const willOpen = el.hidden;
  closeDrawers();
  el.hidden = !willOpen;
  updateBubble();
  updateEdge();
}

function syncScopes() {
  const t = $("scopeTranslate");
  t.textContent = state.scope.translate === "all" ? "全" : "此";
  t.classList.toggle("is-all", state.scope.translate === "all");
  const b = $("scopeBack");
  b.textContent = state.scope.back === "all" ? "全" : "此";
  b.classList.toggle("is-all", state.scope.back === "all");
  saveSoon();
}

function markThemeOption() {
  document.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.themeOpt === state.theme);
  });
}

/* ---------- 配置档案 ---------- */
function renderProfiles() {
  const sel = $("profileSelect");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "未命名";
  sel.appendChild(none);
  for (const p of state.profiles) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = state.activeProfile || "";
}

function newProfile() {
  const name = prompt("配置名称", "配置 " + (state.profiles.length + 1));
  if (!name) return;
  const p = { id: String(Date.now()), name, baseUrl: state.settings.baseUrl, apiKey: state.settings.apiKey, model: state.settings.model };
  state.profiles.push(p);
  state.activeProfile = p.id;
  renderProfiles(); saveSoon();
}

function deleteProfile() {
  if (!state.activeProfile) return;
  state.profiles = state.profiles.filter((p) => p.id !== state.activeProfile);
  state.activeProfile = "";
  renderProfiles(); saveSoon();
}

function saveProfile() {
  let p = state.profiles.find((x) => x.id === state.activeProfile);
  if (!p) {
    p = { id: String(Date.now()), name: "配置 " + (state.profiles.length + 1) };
    state.profiles.push(p);
    state.activeProfile = p.id;
  }
  p.baseUrl = state.settings.baseUrl;
  p.apiKey = state.settings.apiKey;
  p.model = state.settings.model;
  renderProfiles(); saveSoon();
  setStatus("配置已保存");
}

function applyProfile(id) {
  const p = state.profiles.find((x) => x.id === id);
  state.activeProfile = id;
  if (p) {
    state.settings.baseUrl = p.baseUrl;
    state.settings.apiKey = p.apiKey || "";
    state.settings.model = p.model || state.settings.model;
    syncSettingsForm();
    saveSoon();
    checkApi();
  }
}

/* ---------- 设置同步 ---------- */
function syncSettingsForm() {
  $("baseUrl").value = state.settings.baseUrl;
  $("apiKey").value = state.settings.apiKey || "";
  $("temperature").value = state.settings.temperature;
  $("tempOut").textContent = state.settings.temperature;
  $("topP").value = state.settings.topP;
  $("topPOut").textContent = state.settings.topP;
  $("maxTokens").value = state.settings.maxTokens;
  $("concurrency").value = state.settings.concurrency;
  $("systemPrompt").value = state.settings.systemPrompt;
  document.querySelectorAll("#segmentToggle button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.seg === state.settings.segmentMode);
  });
  $("protect").checked = state.settings.protect;
  $("srcLang").value = state.settings.src;
  $("tgtLang").value = state.settings.tgt;
  fillModels([...$("model").options].map((o) => o.value).filter(Boolean));
}

/* ---------- 文件 ---------- */
function splitFileContent(name, text) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "srt" || ext === "vtt") {
    const lines = text.split(/\r?\n/);
    const out = [];
    let buf = [];
    let cue = 0;
    const flush = () => { const t = buf.join(" ").trim(); if (t) { out.push({ text: t, line: cue, gap: "" }); cue += 1; } buf = []; };
    for (const line of lines) {
      const l = line.trim();
      if (!l) { flush(); continue; }
      if (/^\d+$/.test(l)) continue;
      if (/-->/.test(l)) continue;
      if (/^WEBVTT/i.test(l)) continue;
      buf.push(l);
    }
    flush();
    return out;
  }
  return splitText(text);
}

const FILE_LIMIT = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "srt", "vtt"]);
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function isSupportedFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return TEXT_EXTENSIONS.has(ext) && file.size <= MAX_FILE_BYTES;
}

function addFiles(batch) {
  const entries = Array.isArray(batch) ? batch : batch.entries;
  let skipped = Array.isArray(batch) ? 0 : (batch.skipped || 0);
  if (!entries.length) {
    setStatus(skipped ? "跳过 " + skipped + " 个非文本或超大文件" : "没有可导入的文件", true);
    return;
  }
  const supported = entries.filter((item) => isSupportedFile(item.file));
  skipped += entries.length - supported.length;
  if (!supported.length) {
    setStatus("跳过 " + skipped + " 个非文本或超大文件", true);
    return;
  }
  const room = FILE_LIMIT - state.files.length;
  if (room <= 0) { setStatus("文件已达上限 " + FILE_LIMIT + " 个", true); return; }
  const list = supported.slice(0, room);
  const slots = new Array(list.length);
  const readers = list.map((item, index) => new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const text = String(fr.result || "");
      slots[index] = {
        id: String(Date.now()) + "-" + index + "-" + Math.random().toString(36).slice(2, 7),
        name: item.file.name,
        path: item.path || item.file.name,
        segments: toSegments(splitFileContent(item.file.name, text))
      };
      resolve();
    };
    fr.onerror = () => resolve();
    fr.readAsText(item.file, "utf-8");
  }));
  Promise.all(readers).then(() => {
    const added = slots.filter(Boolean);
    state.files.push(...added);
    if (added.length) state.activeFileId = added[0].id;
    renderAll(); saveSoon();
    const notes = [];
    if (skipped) notes.push("跳过 " + skipped + " 个非文本/超大文件");
    if (supported.length > list.length) notes.push("超出上限已截断");
    setStatus("已导入 " + added.length + " 个文件" + (notes.length ? "（" + notes.join("，") + "）" : ""));
  });
}

function filesFromInput(fileList) {
  const entries = [];
  let skipped = 0;
  for (const file of fileList) {
    if (!isSupportedFile(file)) { skipped += 1; continue; }
    entries.push({ file, path: (file.webkitRelativePath || file.name).replace(/\\/g, "/") });
  }
  return { entries, skipped };
}

async function filesFromDataTransfer(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === "file" && i.webkitGetAsEntry);
  if (!items.length) return filesFromInput(dt.files || []);
  const out = [];
  let skipped = 0;
  const readEntry = (entry, prefix) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        if (!isSupportedFile(file)) { skipped += 1; resolve(); return; }
        out.push({ file, path: prefix + entry.name });
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const batch = [];
      const readMore = () => reader.readEntries(async (part) => {
        if (!part.length) {
          for (const child of batch) await readEntry(child, prefix + entry.name + "/");
          resolve();
          return;
        }
        batch.push(...part);
        readMore();
      }, () => resolve());
      readMore();
    } else resolve();
  });
  for (const item of items) await readEntry(item.webkitGetAsEntry(), "");
  return { entries: out, skipped };
}

function buildFileTree(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path || file.name).split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.folders.has(parts[i])) node.folders.set(parts[i], { folders: new Map(), files: [] });
      node = node.folders.get(parts[i]);
    }
    node.files.push(file);
  }
  return root;
}

function countTreeFiles(node) {
  let total = node.files.length;
  for (const child of node.folders.values()) total += countTreeFiles(child);
  return total;
}

function renderTree(node, container, prefix) {
  const folders = [...node.folders.keys()].sort((a, b) => nameCollator.compare(a, b));
  const files = [...node.files].sort((a, b) => nameCollator.compare(a.name, b.name));

  for (const name of folders) {
    const full = prefix + name;
    const child = node.folders.get(name);
    const item = document.createElement("li");
    const open = !state.closedFolders.includes(full);
    item.className = "tree-folder" + (open ? " open" : "");

    const head = document.createElement("div");
    head.className = "tree-folder-head";
    const arrow = document.createElement("span");
    arrow.className = "tf-arrow";
    arrow.textContent = "▶";
    const label = document.createElement("span");
    label.className = "tf-name";
    label.textContent = name;
    const count = document.createElement("span");
    count.className = "tf-count";
    count.textContent = countTreeFiles(child);
    head.append(arrow, label, count);
    head.onclick = () => {
      const closing = item.classList.contains("open");
      item.classList.toggle("open", !closing);
      if (closing) { if (!state.closedFolders.includes(full)) state.closedFolders.push(full); }
      else state.closedFolders = state.closedFolders.filter((p) => p !== full);
      saveSoon();
    };

    const children = document.createElement("ul");
    children.className = "tree-children";
    renderTree(child, children, full + "/");
    item.append(head, children);
    container.appendChild(item);
  }

  for (const file of files) {
    const item = document.createElement("li");
    item.className = "tree-file" + (file.id === state.activeFileId ? " active" : "");
    const wrap = document.createElement("div");
    wrap.className = "f-wrap";
    const label = document.createElement("div");
    label.className = "f-name";
    label.textContent = file.name;
    label.title = file.path || file.name;
    wrap.appendChild(label);
    const reason = state.gapReport[file.id];
    if (reason && reason.length) {
      item.classList.add("f-bad");
      const note = document.createElement("div");
      note.className = "f-reason";
      note.textContent = reason.join("，");
      wrap.appendChild(note);
    }
    const meta = document.createElement("span");
    meta.className = "f-meta";
    const done = file.segments.filter((s) => s.target).length;
    meta.textContent = done + "/" + file.segments.length;
    const del = document.createElement("button");
    del.className = "file-del";
    del.textContent = "×";
    del.title = "删除";
    del.onclick = (e) => {
      e.stopPropagation();
      state.files = state.files.filter((x) => x.id !== file.id);
      if (state.activeFileId === file.id) state.activeFileId = state.files[0] ? state.files[0].id : "";
      renderAll(); saveSoon();
    };
    item.append(wrap, meta, del);
    item.onclick = () => { state.activeFileId = file.id; renderAll(); saveSoon(); };
    container.appendChild(item);
  }
}

function exportFields() {
  const { source, target, back } = state.exportCols;
  if (source && target && back) return ["source", "target", "back"];
  if (target && back) return ["back", "target"];
  if (source && back) return ["source", "back"];
  if (source && target) return ["source", "target"];
  if (source) return ["source"];
  if (target) return ["target"];
  if (back) return ["back"];
  return [];
}

function isDeletedSegment(seg) {
  return !String(seg.source || "").trim() && !String(seg.target || "").trim() && !String(seg.back || "").trim();
}

function buildExport(rawList) {
  const fields = exportFields();
  if (!fields.length) return "";
  const list = rawList.filter((s) => !isDeletedSegment(s));
  const out = [];

  if (state.exportStyle === "sentence") {
    list.forEach((s) => {
      const block = fields.map((f) => (s[f] || "").trim()).filter(Boolean);
      if (block.length) out.push(block.join("\n"), "");
    });
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  const groups = new Map();
  list.forEach((s, i) => {
    const key = Number.isFinite(s.line) ? s.line : i;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  const keys = [...groups.keys()].sort((a, b) => a - b);
  let prev = null;
  for (const key of keys) {
    if (prev !== null && (key > prev + 1 || fields.length > 1)) out.push("");
    const segs = groups.get(key);
    for (const field of fields) {
      const text = segs
        .map((s, i) => (i === 0 ? "" : (s.gap ?? " ")) + (s[field] || ""))
        .join("")
        .trimEnd();
      if (text) out.push(text);
    }
    prev = key;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function openExportMenu(anchor) {
  hideWarn();
  const menu = $("exportMenu");
  const r = anchor.getBoundingClientRect();
  $("exportAll").hidden = !(state.view === "files" && state.files.length);
  menu.hidden = false;
  menu.style.left = Math.min(r.left, window.innerWidth - 170) + "px";
  menu.style.top = r.bottom + 6 + "px";
}

const FIELD_LABEL = { source: "原文", target: "译文", back: "回译" };

function computeGaps() {
  const fields = exportFields();
  const report = {};
  for (const file of state.files) {
    const live = file.segments.filter((s) => !isDeletedSegment(s));
    const reasons = [];
    for (const field of fields) {
      const empty = live.filter((s) => !String(s[field] || "").trim()).length;
      if (empty) reasons.push(FIELD_LABEL[field] + " " + empty + " 处为空");
    }
    if (reasons.length) report[file.id] = reasons;
  }
  return report;
}

function hideWarn() {
  $("exportWarn").hidden = true;
}

function makeZip(entries) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd], { type: "application/zip" });
}

function exportZip(files) {
  const usable = files.filter((f) => f.segments.some((s) => !isDeletedSegment(s)));
  if (!usable.length) { setStatus("没有可导出的文件", true); hideWarn(); return; }
  const encoder = new TextEncoder();
  const entries = usable.map((file) => ({
    name: String(file.path || file.name).replace(/^\/+/, ""),
    data: encoder.encode(buildExport(file.segments))
  }));
  const blob = makeZip(entries);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "transloop-export.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  setStatus("已导出 " + usable.length + " 个文件");
  state.gapReport = {};
  renderFiles();
  saveSoon();
}

function tryExportAll(rect) {
  if (!state.files.length) { setStatus("没有文件", true); return; }
  const report = computeGaps();
  state.gapReport = report;
  renderFiles();
  const badIds = Object.keys(report);
  if (!badIds.length) { hideWarn(); exportZip(state.files); return; }
  const rows = [];
  for (const id of badIds) {
    const file = state.files.find((x) => x.id === id);
    if (!file) continue;
    rows.push((file.path || file.name) + " · " + report[id].join("，"));
  }
  showWarn(rect, "all", rows, "仅导出已完成文件");
}

function doExportCurrent(list) {
  const file = activeFile();
  const base = state.view === "files" && file ? file.name.replace(/\.[^.]+$/, "") : "translation";
  downloadText(base + ".txt", buildExport(list));
  $("exportMenu").hidden = true;
  hideWarn();
  const count = list.filter((s) => !isDeletedSegment(s)).length;
  setStatus("已导出" + (count ? "（" + count + " 段）" : ""));
}

function showWarn(rect, mode, rows, label) {
  state.warnMode = mode;
  $("exportPartial").textContent = label;
  const list = $("warnList");
  list.innerHTML = "";
  for (const text of rows) {
    const row = document.createElement("div");
    row.textContent = text;
    list.appendChild(row);
  }
  const menu = $("exportWarn");
  menu.hidden = false;
  menu.style.left = Math.min(rect.left, window.innerWidth - 350) + "px";
  menu.style.top = rect.bottom + 6 + "px";
}

function exportCurrent() {
  const list = currentSegments();
  if (!list.length) { setStatus("没有内容", true); return; }
  const fields = exportFields();
  if (!fields.length) { setStatus("至少选一项", true); return; }
  const bad = [];
  list.forEach((seg, index) => {
    if (isDeletedSegment(seg)) return;
    const empty = fields.filter((f) => !String(seg[f] || "").trim());
    if (empty.length) bad.push({ index, empty });
  });
  if (!bad.length) { doExportCurrent(list); return; }
  const rows = bad.slice(0, 20).map(({ index, empty }) =>
    "第 " + (index + 1) + " 段：" + empty.map((f) => FIELD_LABEL[f]).join("、") + " 为空");
  if (bad.length > 20) rows.push("…共 " + bad.length + " 段有空位");
  showWarn($("exportMenu").getBoundingClientRect(), "current", rows, "仅导出已完成片段");
}

function fillBackFromSource(list) {
  let count = 0;
  for (const seg of list) {
    if (!String(seg.back || "").trim() && String(seg.source || "").trim()) {
      seg.back = seg.source;
      count += 1;
    }
  }
  renderAll(); saveSoon();
  setStatus("填充 " + count + " 条回译");
}

/* ---------- 绑定 ---------- */
function bind() {
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("[data-drawer]").forEach((b) => b.addEventListener("click", () => toggleDrawer(b.dataset.drawer)));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDrawers));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawers(); });

  $("themeBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("themeMenu");
    menu.hidden = !menu.hidden;
    markThemeOption();
  });
  document.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      state.theme = b.dataset.themeOpt;
      document.documentElement.dataset.theme = state.theme;
      $("themeMenu").hidden = true;
      markThemeOption();
      saveSoon();
    });
  });
  document.addEventListener("click", (e) => {
    $("themeMenu").hidden = true;
    if (!e.target.closest("#exportMenu") && !e.target.closest("#exportText") && !e.target.closest("#exportFile")) {
      $("exportMenu").hidden = true;
    }
    if (!e.target.closest("#exportWarn") && !e.target.closest("#exportMenu") && !e.target.closest("#exportText") && !e.target.closest("#exportFile")) hideWarn();
    const insideDrawer = e.target.closest(".drawer") || e.target.closest("#exportText") || e.target.closest("#exportFile") || e.target.closest("#exportMenu");
    const railTrigger = e.target.closest("[data-drawer]") || e.target.closest(".rail-edge") || e.target.closest("#themeBtn") || e.target.closest("#themeMenu");
    if (!insideDrawer && !railTrigger) closeDrawers();
  });

  $("srcLang").addEventListener("change", () => { state.settings.src = $("srcLang").value; saveSoon(); });
  $("tgtLang").addEventListener("change", () => { state.settings.tgt = $("tgtLang").value; saveSoon(); });
  $("swapLangs").addEventListener("click", () => {
    [state.settings.src, state.settings.tgt] = [state.settings.tgt, state.settings.src];
    $("srcLang").value = state.settings.src; $("tgtLang").value = state.settings.tgt; saveSoon();
  });

  $("splitBtn").addEventListener("click", () => {
    const parts = splitText($("sourceInput").value);
    state.textSegments = toSegments(parts);
    renderRows(); saveSoon();
    setStatus(parts.length + " 段");
  });
  $("translateAll").addEventListener("click", () => {
    if (!state.textSegments.length) { setStatus("先切分", true); return; }
    runOn(state.textSegments, state.textSegments.map((s, i) => i), "forward");
  });
  $("backAll").addEventListener("click", () => {
    const idx = state.textSegments.map((s, i) => s.target ? i : -1).filter((i) => i >= 0);
    if (!idx.length) { setStatus("没有译文", true); return; }
    runOn(state.textSegments, idx, "back");
  });
  $("clearAll").addEventListener("click", () => {
    state.textSegments = []; $("sourceInput").value = ""; renderRows(); saveSoon(); setStatus("");
  });
  $("sourceInput").value = localStorage.getItem(STORE + ".draft") || "";
  $("sourceInput").addEventListener("input", () => {
    localStorage.setItem(STORE + ".draft", $("sourceInput").value); saveSoon();
  });
  $("sourceInput").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("translateAll").click();
  });

  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("importFolder").addEventListener("click", () => $("folderInput").click());
  $("fileInput").addEventListener("change", (e) => { addFiles(filesFromInput(e.target.files)); e.target.value = ""; });
  $("folderInput").addEventListener("change", (e) => { addFiles(filesFromInput(e.target.files)); e.target.value = ""; });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => document.querySelectorAll(".row").forEach(fitRow), 120);
  });

  const tableEl = document.querySelector(".table");
  let lastWidth = 0;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      const w = tableEl.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      document.querySelectorAll(".row").forEach(fitRow);
    }).observe(tableEl);
  }
  $("scopeTranslate").addEventListener("click", () => {
    state.scope.translate = state.scope.translate === "all" ? "current" : "all";
    syncScopes();
  });
  $("scopeBack").addEventListener("click", () => {
    state.scope.back = state.scope.back === "all" ? "current" : "all";
    syncScopes();
  });
  $("translateRun").addEventListener("click", () => runScope("forward", state.scope.translate));
  $("backRun").addEventListener("click", () => runScope("back", state.scope.back));
  $("fillBackRun").addEventListener("click", () => fillBackByScope(state.scope.back));
  $("fillBackText").addEventListener("click", () => fillBackFromSource(state.textSegments));
  $("abortBtn").addEventListener("click", () => {
    if (!state.busy) return;
    state.aborted = true;
    if (state.controller) state.controller.abort();
    setStatus("已中断");
  });
  $("exportAll").addEventListener("click", (e) => {
    e.stopPropagation();
    tryExportAll($("exportMenu").getBoundingClientRect());
  });
  $("exportPartial").addEventListener("click", () => {
    if (state.warnMode === "current") {
      const file = activeFile();
      const fields = exportFields();
      const list = (file ? file.segments : [])
        .filter((s) => !isDeletedSegment(s))
        .filter((s) => fields.every((f) => String(s[f] || "").trim()));
      doExportCurrent(list);
    } else {
      exportZip(state.files.filter((f) => !state.gapReport[f.id]));
    }
    hideWarn();
  });
  $("clearFiles").addEventListener("click", () => {
    state.files = [];
    state.activeFileId = "";
    renderAll(); saveSoon();
    setStatus("文件已清空");
    closeDrawers();
  });

  $("exportFile").addEventListener("click", (e) => { e.stopPropagation(); openExportMenu(e.currentTarget); });
  $("exportText").addEventListener("click", (e) => { e.stopPropagation(); openExportMenu(e.currentTarget); });
  $("expDo").addEventListener("click", exportCurrent);
  ["expSrc", "expTgt", "expBack"].forEach((id) => {
    $(id).addEventListener("change", () => {
      state.exportCols = { source: $("expSrc").checked, target: $("expTgt").checked, back: $("expBack").checked };
      saveSoon();
    });
  });
  document.querySelectorAll("#styleToggle button").forEach((b) => {
    b.addEventListener("click", () => {
      state.exportStyle = b.dataset.style;
      document.querySelectorAll("#styleToggle button").forEach((x) => x.classList.toggle("is-active", x === b));
      saveSoon();
    });
  });
  $("fileDrawerToggle").addEventListener("click", (e) => { e.stopPropagation(); toggleDrawer("files"); });

  $("glossAdd").addEventListener("click", () => { state.glossary.push({ src: "", tgt: "" }); renderGlossary(); saveSoon(); });
  $("glossOn").addEventListener("change", () => { state.glossaryOn = $("glossOn").checked; saveSoon(); });
  $("glossImport").addEventListener("click", () => $("glossFile").click());
  $("glossFile").addEventListener("change", (e) => { if (e.target.files[0]) importGlossary(e.target.files[0]); e.target.value = ""; });
  $("glossExport").addEventListener("click", exportGlossary);

  const main = $("sourceInput");
  document.addEventListener("dragover", (e) => { if (state.view === "files") e.preventDefault(); });
  document.addEventListener("drop", async (e) => {
    if (state.view !== "files") return;
    e.preventDefault();
    if (!e.dataTransfer) return;
    const entries = await filesFromDataTransfer(e.dataTransfer);
    addFiles(entries);
  });

  $("baseUrl").addEventListener("change", () => { state.settings.baseUrl = $("baseUrl").value.trim(); saveSoon(); checkApi(); });
  $("apiKey").addEventListener("change", () => { state.settings.apiKey = $("apiKey").value; saveSoon(); checkApi(); });
  $("model").addEventListener("change", () => { state.settings.model = $("model").value; saveSoon(); });
  $("refreshModels").addEventListener("click", () => checkApi());
  $("testApi").addEventListener("click", () => checkApi());
  $("newProfile").addEventListener("click", newProfile);
  $("delProfile").addEventListener("click", deleteProfile);
  $("saveProfile").addEventListener("click", saveProfile);
  $("profileSelect").addEventListener("change", () => applyProfile($("profileSelect").value));

  $("temperature").addEventListener("input", () => { state.settings.temperature = Number($("temperature").value); $("tempOut").textContent = $("temperature").value; saveSoon(); });
  $("topP").addEventListener("input", () => { state.settings.topP = Number($("topP").value); $("topPOut").textContent = $("topP").value; saveSoon(); });
  $("maxTokens").addEventListener("change", () => { state.settings.maxTokens = Number($("maxTokens").value) || 1024; saveSoon(); });
  $("concurrency").addEventListener("change", () => { state.settings.concurrency = Number($("concurrency").value) || 1; saveSoon(); });
  $("systemPrompt").addEventListener("input", () => { state.settings.systemPrompt = $("systemPrompt").value; saveSoon(); });
  $("resetPrompt").addEventListener("click", () => { state.settings.systemPrompt = DEFAULT_PROMPT; $("systemPrompt").value = DEFAULT_PROMPT; saveSoon(); });
  document.querySelectorAll("#segmentToggle button").forEach((b) => {
    b.addEventListener("click", () => {
      state.settings.segmentMode = b.dataset.seg;
      document.querySelectorAll("#segmentToggle button").forEach((x) => x.classList.toggle("is-active", x === b));
      saveSoon();
    });
  });
  $("protect").addEventListener("change", () => { state.settings.protect = $("protect").checked; saveSoon(); });
}

loadState();
document.documentElement.dataset.theme = state.theme;
markThemeOption();
fillLangs();
renderProfiles();
bind();
syncSettingsForm();
renderGlossary();
syncScopes();
setView(state.view);
renderAll();
checkApi();
