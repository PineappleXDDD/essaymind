/**
 * EssayMind — Frontend JavaScript
 * OOP: Abstraction (BaseComponent), Inheritance, Encapsulation, Polymorphism
 */
"use strict";

// ── ABSTRACTION ───────────────────────────────────────────────
class BaseComponent {
  constructor(root) {
    if (!root) throw new Error(`${this.constructor.name}: root element required`);
    this._root = root; this._listeners = [];
  }
  render() { throw new Error("render() must be implemented"); }
  _on(el, ev, fn) { el.addEventListener(ev, fn); this._listeners.push({el,ev,fn}); }
  destroy() { this._listeners.forEach(({el,ev,fn}) => el.removeEventListener(ev,fn)); this._listeners=[]; }
}

// ── ENCAPSULATION: API ────────────────────────────────────────
class ApiClient {
  #base;
  constructor(base = "") { this.#base = base; }
  async getStatus()       { return this.#get("/api/status"); }
  async getSessions()     { return this.#get("/api/sessions"); }
  async createSession()   { return this.#post("/api/sessions", {}); }
  async getSession(id)    { return this.#get(`/api/sessions/${id}`); }
  async setModel(model)   { return this.#post("/api/model", { model }); }
  async chat(sid, msg)    { return this.#post("/api/chat", { session_id: sid, message: msg }); }
  async deleteSession(id) {
    return (await fetch(`${this.#base}/api/sessions/${id}`, { method:"DELETE" })).json();
  }
  async updateTitle(id, title) {
    return (await fetch(`${this.#base}/api/sessions/${id}/title`, {
      method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({title})
    })).json();
  }
  async evaluate(formData, signal) {
    return (await fetch(`${this.#base}/api/evaluate`, { method:"POST", body:formData, signal })).json();
  }
  async #get(path) { return (await fetch(`${this.#base}${path}`)).json(); }
  async #post(path, body) {
    return (await fetch(`${this.#base}${path}`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
    })).json();
  }
}

// ── ENCAPSULATION: Rubric ─────────────────────────────────────
class RubricManager {
  #criteria;
  static #VERSION = "v3"; // bump this to force-reset cached rubrics
  static #DEFAULTS = [
    { id:"focus",       label:"Focus",       weight:20, description:"Clarity and strength of the central argument or thesis" },
    { id:"structure",   label:"Structure",   weight:20, description:"Logical flow, introduction, body, and conclusion" },
    { id:"credibility", label:"Credibility", weight:20, description:"Use of evidence, citations, and supporting details" },
    { id:"style",       label:"Style",       weight:20, description:"Word choice, tone, voice, and overall expression" },
    { id:"clarity",     label:"Clarity",     weight:20, description:"Grammar, spelling, punctuation, and readability" },
  ];
  constructor() { this.#criteria = this.#load(); }
  #load() {
    try {
      const ver = localStorage.getItem("essaymind_rubric_ver");
      if (ver !== RubricManager.#VERSION) {
        // Force reset on version mismatch — clears old criteria names
        localStorage.removeItem("essaymind_rubric");
        localStorage.setItem("essaymind_rubric_ver", RubricManager.#VERSION);
      }
      const s = localStorage.getItem("essaymind_rubric");
      if (s) return JSON.parse(s);
    } catch {}
    return RubricManager.#DEFAULTS.map(c => ({...c}));
  }
  #save() { localStorage.setItem("essaymind_rubric", JSON.stringify(this.#criteria)); }
  get criteria() { return this.#criteria; }
  update(c) { this.#criteria = c; this.#save(); }
  reset()   { this.#criteria = RubricManager.#DEFAULTS.map(c => ({...c})); this.#save(); }
  toApiPayload() { return { criteria: this.#criteria }; }
}

// ── INHERITANCE: StatusBar ────────────────────────────────────
class StatusBar extends BaseComponent {
  #dot; #text; #select; #api; #models = [];
  constructor(root, api) {
    super(root); this.#api = api;
    this.#dot = document.getElementById("statusDot");
    this.#text = document.getElementById("statusText");
    this.#select = document.getElementById("modelSelect");
    this._on(this.#select, "change", () => this.#onModelChange());
  }
  render() { this.check(); }
  async check() {
    try {
      const d = await this.#api.getStatus();
      if (d.status === "connected") {
        this.#dot.className = "status-dot connected";
        this.#text.textContent = "Ollama connected";
        this.#models = d.models || [];
        this.#populate(d.current_model);
      } else this.#disconnected(d.error);
    } catch { this.#disconnected("Cannot reach Ollama"); }
  }
  #disconnected(msg) {
    this.#dot.className = "status-dot disconnected";
    this.#text.textContent = "Ollama offline";
    this.#select.innerHTML = `<option>${msg || "Not connected"}</option>`;
  }
  #populate(current) {
    this.#select.innerHTML = this.#models.length
      ? this.#models.map(m => `<option value="${m}" ${m===current?"selected":""}>${m}</option>`).join("")
      : `<option value="${current}">${current}</option>`;
  }
  async #onModelChange() { const m = this.#select.value; if (m) await this.#api.setModel(m); }
}

// ── INHERITANCE: RubricModal ──────────────────────────────────
class RubricModal extends BaseComponent {
  #rubric; #fieldsEl; #totalEl;
  constructor(root, rubric) {
    super(root); this.#rubric = rubric;
    this.#fieldsEl = document.getElementById("rubricFields");
    this.#totalEl  = document.getElementById("rubricTotal");
    this._on(document.getElementById("rubricBtn"),   "click", () => this.open());
    this._on(document.getElementById("rubricClose"), "click", () => this.close());
    this._on(document.getElementById("rubricSave"),  "click", () => this.#save());
    this._on(document.getElementById("rubricReset"), "click", () => this.#reset());
    this._on(this._root, "click", e => { if (e.target === this._root) this.close(); });
  }
  render() { this.#build(); }
  open()   { this.#build(); this._root.style.display = "flex"; }
  close()  { this._root.style.display = "none"; }
  #build() {
    this.#fieldsEl.innerHTML = "";
    this.#rubric.criteria.forEach((c, i) => {
      const div = document.createElement("div");
      div.className = "rubric-field";
      div.innerHTML = `
        <div class="rubric-field-head">
          <span class="rubric-field-label">${c.label}</span>
          <span class="rubric-weight-val" id="wval_${i}">${c.weight}%</span>
        </div>
        <div class="rubric-field-desc">${c.description}</div>
        <div class="rubric-weight-row">
          <input type="range" class="rubric-slider" min="0" max="60" value="${c.weight}" id="wslider_${i}" />
        </div>`;
      div.querySelector(".rubric-slider").addEventListener("input", () => this.#onSlide());
      this.#fieldsEl.appendChild(div);
    });
    this.#updateTotal();
  }
  #onSlide() {
    document.querySelectorAll(".rubric-slider").forEach((sl, i) => {
      const el = document.getElementById(`wval_${i}`); if (el) el.textContent = sl.value + "%";
    });
    this.#updateTotal();
  }
  #updateTotal() {
    const total = Array.from(document.querySelectorAll(".rubric-slider")).reduce((s,sl)=>s+parseInt(sl.value),0);
    this.#totalEl.textContent = total + "%";
    this.#totalEl.className = "rubric-total-val" + (Math.abs(total-100)>1?" over":"");
  }
  #save() {
    const sliders = document.querySelectorAll(".rubric-slider");
    this.#rubric.update(this.#rubric.criteria.map((c,i)=>({...c,weight:parseInt(sliders[i]?.value??c.weight)})));
    this.close(); showToast("Rubric saved ✓");
  }
  #reset() { this.#rubric.reset(); this.#build(); showToast("Rubric reset to defaults"); }
}

// ── INHERITANCE: HistorySidebar ───────────────────────────────
class HistorySidebar extends BaseComponent {
  #api; #listEl; #emptyEl; #sessions=[]; #activeId=null;
  onSelect; onDelete; onRename;

  constructor(root, api) {
    super(root); this.#api=api;
    this.#listEl  = document.getElementById("historyList");
    this.#emptyEl = document.getElementById("historyEmpty");
  }
  render() { this.load(); }
  async load() {
    try { this.#sessions = await this.#api.getSessions(); this.#draw(); }
    catch(e) { console.error("History:", e); }
  }
  setActive(id) { this.#activeId=id; this.#draw(); }
  addOrUpdate(s) {
    const i = this.#sessions.findIndex(x=>x.id===s.id);
    if (i>=0) this.#sessions[i]=s; else this.#sessions.unshift(s);
    this.#activeId=s.id; this.#draw();
  }
  remove(id) {
    this.#sessions=this.#sessions.filter(s=>s.id!==id);
    if (this.#activeId===id) this.#activeId=null; this.#draw();
  }
  updateLocalTitle(id, title) {
    const s = this.#sessions.find(x=>x.id===id);
    if (s) { s.title=title; this.#draw(); }
  }

  #draw() {
    this.#listEl.querySelectorAll(".history-item").forEach(i=>i.remove());
    if (!this.#sessions.length) { this.#emptyEl.style.display=""; return; }
    this.#emptyEl.style.display="none";
    this.#sessions.forEach(s => {
      const div = document.createElement("div");
      div.className = "history-item"+(s.id===this.#activeId?" active":"");
      div.dataset.sid = s.id;
      const dateStr = this.#fmtDate(new Date(s.updated||s.created));
      div.innerHTML = `
        <span class="history-item-title" title="Double-click to rename">${escHtml(s.title)}</span>
        <span class="history-item-date">${dateStr}</span>
        <div class="history-item-actions">
          <button class="history-item-rename" title="Rename">✎</button>
          <button class="history-item-del"    title="Delete">×</button>
        </div>`;
      div.addEventListener("click", e => {
        if (e.target.classList.contains("history-item-del")) { e.stopPropagation(); this.onDelete?.(s.id); }
        else if (e.target.classList.contains("history-item-rename")) { e.stopPropagation(); this.onRename?.(s.id, s.title); }
        else this.onSelect?.(s.id);
      });
      // Double-click title to rename
      div.querySelector(".history-item-title").addEventListener("dblclick", e => {
        e.stopPropagation(); this.onRename?.(s.id, s.title);
      });
      this.#listEl.appendChild(div);
    });
  }
  #fmtDate(d) {
    const now = new Date();
    return d.toDateString()===now.toDateString()
      ? d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})
      : d.toLocaleDateString([],{month:"short",day:"numeric"});
  }
}

// ── INHERITANCE: LoadingIndicator ─────────────────────────────
class LoadingIndicator extends BaseComponent {
  #el=null; #timer=null; #barTimer=null; #progress=0;
  static #STEPS = [
    {pct:8,  msg:"Reading your essay…"},
    {pct:20, msg:"Analysing focus & argument…"},
    {pct:35, msg:"Checking structure & flow…"},
    {pct:50, msg:"Scanning for weaknesses…"},
    {pct:63, msg:"Evaluating style & credibility…"},
    {pct:75, msg:"Scoring each criterion…"},
    {pct:84, msg:"Writing recommendations…"},
    {pct:92, msg:"Compiling your report…"},
    {pct:97, msg:"Almost done…"},
  ];
  constructor(root) { super(root); }
  render() {}

  show(container) {
    this.#el = document.createElement("div");
    this.#el.id = "loadingMsg"; this.#el.className = "msg msg-ai";
    this.#el.innerHTML = `
      <div class="msg-avatar lc-avatar">◈</div>
      <div class="msg-body" style="max-width:100%;">
        <div class="loading-card">
          <div class="lc-top">
            <span class="lc-status" id="lcStatus">Preparing evaluation…</span>
            <span class="lc-pct" id="lcPct">0%</span>
          </div>
          <div class="lc-track"><div class="lc-bar" id="lcBar"></div></div>
          <div class="lc-steps">
            <span class="lc-step ls-done">Received</span>
            <span class="lc-step ls-active" id="lcS1">Analysing</span>
            <span class="lc-step" id="lcS2">Scoring</span>
            <span class="lc-step" id="lcS3">Complete</span>
          </div>
        </div>
      </div>`;
    container.appendChild(this.#el);
    container.scrollTop = container.scrollHeight;
    this.#animate();
  }
  hide() {
    clearInterval(this.#timer); clearInterval(this.#barTimer);
    this.#el?.remove(); this.#el=null; this.#progress=0;
  }
  complete() {
    this.#progress=100; this.#setText("Evaluation complete! ✓");
    const b=document.getElementById("lcBar"); if(b) b.style.width="100%";
    const p=document.getElementById("lcPct"); if(p) p.textContent="100%";
    document.getElementById("lcS1")?.classList.replace("ls-active","ls-done");
    document.getElementById("lcS2")?.classList.add("ls-done");
    document.getElementById("lcS3")?.classList.add("ls-active");
    clearInterval(this.#timer);
  }
  #animate() {
    let stepIdx=0;
    this.#timer = setInterval(() => {
      if (stepIdx>=LoadingIndicator.#STEPS.length) return;
      const step = LoadingIndicator.#STEPS[stepIdx++];
      this.#progress = step.pct; this.#setText(step.msg);
      if (step.pct>=55) {
        document.getElementById("lcS1")?.classList.replace("ls-active","ls-done");
        document.getElementById("lcS2")?.classList.add("ls-active");
      }
    }, 3000);
    this.#barTimer = setInterval(() => {
      const bar=document.getElementById("lcBar"), pct=document.getElementById("lcPct");
      if (!bar) return;
      const cur=parseFloat(bar.style.width||"0"), next=cur+(this.#progress-cur)*0.1;
      bar.style.width=next+"%"; if(pct) pct.textContent=Math.round(next)+"%";
    }, 100);
  }
  #setText(msg) {
    const el=document.getElementById("lcStatus"); if(!el) return;
    el.style.opacity="0"; setTimeout(()=>{el.textContent=msg;el.style.opacity="1";},160);
  }
}

// ── INHERITANCE + POLYMORPHISM: MessageRenderer ───────────────
class MessageRenderer extends BaseComponent {
  #container; #loader;
  constructor(root) {
    super(root);
    this.#container = document.getElementById("messages");
    this.#loader    = new LoadingIndicator(root);
  }
  render()          { this.clear(); }
  clear()           { this.#container.innerHTML = ""; }
  showLoading()     { this.#loader.show(this.#container); this.#scroll(); }
  completeLoading() { this.#loader.complete(); }
  removeLoading()   { this.#loader.hide(); }

  appendUser(text, filename) {
    const display = filename ? `📎 ${filename}\n\n${text.slice(0,200)}${text.length>200?"…":""}` : text;
    const el = this.#bubble("user", escHtml(display).replace(/\n/g,"<br>"));
    this.#container.appendChild(el); this.#scroll();
  }
  appendError(text) {
    const el = this.#bubble("ai", `<span style="color:var(--red)">⚠ ${escHtml(text)}</span>`);
    this.#container.appendChild(el); this.#scroll();
  }
  appendChat(text) {
    const el = this.#bubble("ai", escHtml(text).replace(/\n/g,"<br>"));
    this.#container.appendChild(el); this.#scroll();
  }

  // POLYMORPHISM — evaluation renders collapsible card
  appendEvaluation(ev) {
    const scores    = this.#normalise(ev.scores||{}, ev.rubric_used);
    const errors    = ev.errors||[];
    const recs      = ev.recommendations||[];
    const strengths = ev.strengths||[];
    const score     = ev.overall_score??"—";
    const grade     = ev.grade??"—";
    const sNum      = parseFloat(score)||0;
    const col       = sNum>=80?"var(--green)":sNum>=60?"var(--yellow)":"var(--red)";

    const msg = document.createElement("div");
    msg.className = "msg msg-ai";
    // Tab order: Scores, Recommendations, Strengths, Weaknesses
    msg.innerHTML = `
      <div class="msg-avatar">◈</div>
      <div class="msg-body" style="max-width:100%;">
        <div class="eval-card">

          <!-- Header (no collapse button here anymore) -->
          <div class="eval-header">
            <div class="eval-title-block">
              <div class="eval-title">Essay Evaluation Report</div>
              <div class="eval-summary">${escHtml(ev.summary||"Evaluation complete.")}</div>
            </div>
            <div class="eval-score-circle" style="border-color:${col};box-shadow:0 0 28px ${col}44;background:${col}14;">
              <span class="eval-score-num" style="color:${col};">${score}</span>
              <span class="eval-grade" style="color:${col};">${grade}</span>
            </div>
          </div>

          <!-- Collapsible body -->
          <div class="eval-body">
            <div class="eval-tabs">
              <button class="eval-tab active" data-panel="scores">Scores</button>
              <button class="eval-tab" data-panel="recs">Recommendations</button>
              <button class="eval-tab" data-panel="strengths">Strengths</button>
              <button class="eval-tab" data-panel="errors">Weaknesses${errors.length?`<span class="err-badge">${errors.length}</span>`:""}</button>
              <button class="eval-tab" data-panel="aidetect">AI Detection</button>
            </div>
            <div class="eval-panels">
              <div class="eval-panel active" data-panel-id="scores">
                <div class="criteria-list">${this.#renderScores(scores)}</div>
              </div>
              <div class="eval-panel" data-panel-id="recs">
                <div class="recs-list">
                  ${recs.map((r,i)=>`<div class="rec-item"><div class="rec-num">${i+1}</div><div>${escHtml(r)}</div></div>`).join("")||'<p class="empty-msg">No recommendations.</p>'}
                </div>
              </div>
              <div class="eval-panel" data-panel-id="strengths">
                <div class="strengths-list">
                  ${strengths.map(s=>`<div class="strength-item">${escHtml(s)}</div>`).join("")||'<p class="empty-msg">No strengths listed.</p>'}
                </div>
              </div>
              <div class="eval-panel" data-panel-id="errors">${this.#renderErrors(errors)}</div>
              <div class="eval-panel" data-panel-id="aidetect">${this.#renderAiDetection(ev.ai_detection)}</div>

            </div>
            <div class="eval-meta">
              <span class="eval-meta-item">Words: <strong>${ev.word_count??"—"}</strong></span>
              <span class="eval-meta-item">Chars: <strong>${ev.char_count??"—"}</strong></span>
              <span class="eval-meta-item">Weaknesses: <strong>${errors.length}</strong></span>
              ${ev._cached?'<span class="eval-meta-item" style="color:var(--ac);">⚡ Cached result</span>':''}
            </div>
          </div>
          <!-- Collapse button — bottom center -->
          <div class="eval-collapse-footer">
            <button class="collapse-btn" title="Collapse response">
              <svg class="collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
              <span class="collapse-label">Hide</span>
            </button>
          </div>
        </div>
        <div class="msg-time">${fmtTime(new Date())}</div>
      </div>`;

    // Tab switching
    msg.querySelectorAll(".eval-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        const p = tab.dataset.panel;
        msg.querySelectorAll(".eval-tab").forEach(t=>t.classList.remove("active"));
        msg.querySelectorAll(".eval-panel").forEach(x=>x.classList.remove("active"));
        tab.classList.add("active");
        msg.querySelector(`[data-panel-id="${p}"]`)?.classList.add("active");
      });
    });

    // Collapse / expand — button is at the bottom center
    const collapseBtn  = msg.querySelector(".collapse-btn");
    const evalBody     = msg.querySelector(".eval-body");
    const collapseIcon = msg.querySelector(".collapse-icon");
    const collapseLabel= msg.querySelector(".collapse-label");
    collapseBtn.addEventListener("click", e => {
      e.stopPropagation();
      const collapsed = evalBody.classList.toggle("collapsed");
      collapseIcon.style.transform = collapsed ? "rotate(180deg)" : "rotate(0deg)";
      collapseLabel.textContent    = collapsed ? "Show" : "Hide";
      collapseBtn.title            = collapsed ? "Expand response" : "Collapse response";
    });

    this.#container.appendChild(msg);
    this.#scroll();
    this.#animateBars(msg);
  }

  // Bulletproof bar animation — pill style with glow
  #animateBars(container) {
    const bars = container.querySelectorAll(".score-fill");
    // Snap to 0% with no transition first
    bars.forEach(b => { b.style.transition = "none"; b.style.width = "0%"; });
    // Double rAF: browser paints 0% state, then we animate to real value
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bars.forEach(b => {
        const pct = parseFloat(b.dataset.width) || 0;
        const sc  = pct; // same as score

        // Pick color to match reference: green / orange / pink-red
        let bg, shadow;
        if (sc >= 80) {
          bg     = "linear-gradient(90deg, #3ecf70, #52e88a)";
          shadow = "0 0 14px rgba(62,207,112,0.55)";
        } else if (sc >= 60) {
          bg     = "linear-gradient(90deg, #f0975a, #ffb07a)";
          shadow = "0 0 14px rgba(240,151,90,0.55)";
        } else {
          bg     = "linear-gradient(90deg, #e8717e, #f5959f)";
          shadow = "0 0 14px rgba(232,113,126,0.5)";
        }

        b.style.transition  = "width 1s cubic-bezier(.4,0,.2,1)";
        b.style.width       = pct + "%";
        b.style.background  = bg;
        b.style.boxShadow   = shadow;
      });
    }));
  }

  // ── Score helpers ─────────────────────────────────────────
  #normalise(raw, rubricLabels) {
    const lmap = {};
    // Build lookup: normalised-label-string -> display label
    if (Array.isArray(rubricLabels))
      rubricLabels.forEach(l => { lmap[l.toLowerCase().replace(/[^a-z]/g,"")] = l; });

    // Build a set of known criterion IDs from rubricLabels so we can filter garbage keys
    // Also accept common aliases
    const knownKeys = new Set([
      ...Object.keys(lmap),
      "focus","structure","credibility","style","clarity",
      "thesis","evidence","language","conventions","argument","organization"
    ]);

    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      const normKey = key.toLowerCase().replace(/[^a-z]/g,"");

      // Skip keys that are clearly not criterion IDs:
      // - pure metadata like "feedback", "score", "overall", "grade", "summary"
      // - non-object / non-numeric values at the top level (means it's a string field)
      const skipKeys = new Set(["feedback","score","overall","grade","summary","text","type","issue","suggestion","explanation"]);
      if (skipKeys.has(normKey)) continue;

      // If value is not an object or number, skip (it's a string field, not a criterion)
      if (typeof val === "string") continue;
      if (Array.isArray(val)) continue;

      const entry = typeof val === "object" && val !== null ? {...val} : {score: val};

      // Attach display label
      if (!entry.label) {
        const ck = normKey;
        entry.label = lmap[ck] || key.replace(/_/g," ").replace(/\b\w/g, l => l.toUpperCase());
      }

      // Extract numeric score from any common field name
      const rs = entry.score ?? entry.value ?? entry.points ?? entry.mark ?? entry.rating ?? 0;
      entry.score = Math.min(100, Math.max(0, Math.round(parseFloat(rs) || 0)));
      out[key] = entry;
    }
    return out;
  }

  #renderScores(scores) {
    const entries = Object.entries(scores);
    if (!entries.length) return `<p class="empty-msg">No scores available.</p>`;
    return entries.map(([id, d]) => {
      const sc  = Math.min(100, Math.max(0, d.score ?? 0));
      // Color thresholds — purple accent default, green excellent, yellow good, red poor
      // Match text color to bar color thresholds
      const col = sc >= 80 ? "#3ecf70"
                : sc >= 60 ? "#f0975a"
                :            "#e8717e";
      return `
        <div class="criterion-item">
          <div class="criterion-head">
            <span class="criterion-label">${escHtml(d.label || id)}</span>
            <span class="criterion-score" style="color:${col};">${sc}<span class="score-denom">/100</span></span>
          </div>
          <div class="score-bar">
            <div class="score-fill" data-width="${sc}" data-color="${col}" style="width:0%;"></div>
          </div>
          <div class="criterion-feedback">${escHtml(d.feedback || "")}</div>
        </div>`;
    }).join("");
  }

  #renderErrors(errors) {
    if (!errors.length) return `<div class="no-errors">✓ No weaknesses detected — great writing!</div>`;
    return `<div class="errors-list">`+errors.map(e => {
      const tc = `error-type-${(e.type||"Grammar").split(" ")[0]}`;
      return `<div class="error-item">
        <span class="error-type-badge ${tc}">${escHtml(e.type||"Issue")}</span>
        ${e.text?`<div class="error-found">${escHtml(e.text)}</div>`:""}
        <div class="error-issue">${escHtml(e.issue||"")}</div>
        ${e.suggestion?`<div class="error-fix">${escHtml(e.suggestion)}</div>`:""}
      </div>`;
    }).join("")+`</div>`;
  }

  #renderAiDetection(data) {
    if (!data) return `<div class="ai-detect-wrap"><p class="empty-msg" style="text-align:center;padding:20px;">🔄 AI Detection running — resubmit the essay to see results.</p></div>`;
    if (data.error) return `<div class="ai-detect-wrap"><p class="empty-msg">Detection error: ${escHtml(String(data.error))}</p></div>`;

    const prob    = Math.min(100, Math.max(0, parseInt(data.probability_ai) || 0));
    const verdict = data.verdict || "Unknown";
    const conf    = parseInt(data.confidence) || 0;
    const indicators  = Array.isArray(data.indicators)   ? data.indicators   : [];
    const humanSigs   = Array.isArray(data.human_signals) ? data.human_signals : [];
    const explanation = data.explanation || "";

    const col = prob >= 70 ? "#e8717e" : prob >= 40 ? "#f0975a" : "#3ecf70";
    const icon = prob >= 70 ? "🤖" : prob >= 40 ? "🔍" : "✍️";

    return `<div class="ai-detect-wrap">
      <div class="ai-detect-header">
        <div class="ai-detect-verdict">
          <span class="ai-verdict-icon">${icon}</span>
          <div>
            <div class="ai-verdict-label" style="color:${col};">${escHtml(verdict)}</div>
            <div class="ai-verdict-sub">AI Probability: <strong style="color:${col};">${prob}%</strong> &nbsp;·&nbsp; Confidence: ${conf}%</div>
          </div>
        </div>
        <div class="ai-prob-circle" style="border:3px solid ${col};background:${col}18;width:68px;height:68px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
          <span style="font-family:'Syne',sans-serif;font-weight:800;font-size:18px;color:${col};line-height:1;">${prob}%</span>
          <span style="font-size:9px;color:${col};font-family:'JetBrains Mono',monospace;letter-spacing:1px;">AI</span>
        </div>
      </div>

      <div style="margin:14px 0 6px;">
        <div style="width:100%;height:22px;background:var(--bg-h);border-radius:99px;overflow:hidden;position:relative;">
          <div style="height:100%;width:${prob}%;background:linear-gradient(90deg,#3ecf70 0%,#f0975a 50%,#e8717e 100%);background-size:${(100/Math.max(prob,1))*100}% 100%;border-radius:99px;transition:width 1s cubic-bezier(.4,0,.2,1);position:relative;">
            <div style="position:absolute;top:4px;left:8px;right:8px;height:5px;border-radius:99px;background:rgba(255,255,255,.2);"></div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--tx-3);margin-top:4px;padding:0 2px;">
          <span>Human</span><span>Uncertain</span><span>AI</span>
        </div>
      </div>

      ${explanation ? `<div style="font-size:13px;color:var(--tx-2);line-height:1.6;background:var(--bg-e);border:1px solid var(--br);border-radius:10px;padding:12px 14px;margin-bottom:12px;">${escHtml(explanation)}</div>` : ""}

      ${indicators.length ? `
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px;color:var(--tx-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">🤖 AI Signals Found</div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px;">
          ${indicators.map(i=>`<div style="font-size:13px;padding:7px 12px;background:rgba(232,113,126,.08);border:1px solid rgba(232,113,126,.2);border-radius:8px;color:var(--tx-2);">⚠ ${escHtml(String(i))}</div>`).join("")}
        </div>` : ""}

      ${humanSigs.length ? `
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px;color:var(--tx-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">✍️ Human Signals</div>
        <div style="display:flex;flex-direction:column;gap:5px;">
          ${humanSigs.map(s=>`<div style="font-size:13px;padding:7px 12px;background:rgba(62,207,112,.08);border:1px solid rgba(62,207,112,.2);border-radius:8px;color:var(--tx-2);">✓ ${escHtml(String(s))}</div>`).join("")}
        </div>` : ""}
    </div>`;
  }

  #bubble(role, html) {
    const msg = document.createElement("div");
    msg.className = `msg msg-${role}`;
    const isUser = role==="user";
    msg.innerHTML = `
      <div class="msg-avatar">${isUser?"✎":"◈"}</div>
      <div class="msg-body">
        <div class="msg-bubble">${html}</div>
        <div class="msg-time">${fmtTime(new Date())}</div>
      </div>`;
    return msg;
  }
  #scroll() { requestAnimationFrame(() => { this._root.scrollTop = this._root.scrollHeight; }); }

  loadMessages(msgs) {
    this.clear();
    msgs.forEach(m => {
      if (m.role==="user")   this.appendUser(m.content);
      else if (m.evaluation) this.appendEvaluation(m.evaluation);
      else                   this.appendChat(m.content);
    });
  }
}

// ── ENCAPSULATION: App ────────────────────────────────────────
class App {
  #api; #rubric; #history; #renderer; #status; #rubricModal;
  #currentSessionId    = null;
  #pendingFile         = null;
  #isEvaluating        = false;
  #renamingSessionId   = null;
  #abortController     = null;
  #evalToken           = 0;
  // Track which session ID an in-flight evaluation belongs to.
  // When the response arrives we save it to the right session even if the user
  // has navigated away and back.
  #evalSessionId       = null;

  constructor() {
    this.#api         = new ApiClient("");
    this.#rubric      = new RubricManager();
    this.#history     = new HistorySidebar(document.getElementById("sidebar"), this.#api);
    this.#renderer    = new MessageRenderer(document.getElementById("chatArea"));
    this.#status      = new StatusBar(document.getElementById("sidebar"), this.#api);
    this.#rubricModal = new RubricModal(document.getElementById("rubricModal"), this.#rubric);
    this.#wireEvents();
    this.#init();
  }

  #wireEvents() {
    // Input
    document.getElementById("sendBtn").addEventListener("click", ()=>this.#send());
    document.getElementById("chatInput").addEventListener("keydown", e=>{
      if (e.key==="Enter"&&!e.shiftKey){e.preventDefault();this.#send();}
    });
    // Also allow Enter on the whole input box area when a file is attached
    // so user doesn't HAVE to type anything — just attach and press Enter
    document.getElementById("inputBox").addEventListener("keydown", e=>{
      if (e.key==="Enter"&&!e.shiftKey&&this.#pendingFile&&!e.target.matches("textarea")){
        e.preventDefault(); this.#send();
      }
    });
    document.getElementById("chatInput").addEventListener("input", ()=>this.#resizeTa());
    document.getElementById("fileInput").addEventListener("change", e=>{
      const f=e.target.files?.[0]; if(f) this.#attachFile(f);
    });

    // Drag & Drop
    const overlay = document.getElementById("dropOverlay");
    ["dragenter","dragover"].forEach(ev=>document.addEventListener(ev,e=>{
      e.preventDefault(); overlay.classList.add("visible");
    }));
    ["dragleave","dragend"].forEach(ev=>document.addEventListener(ev,e=>{
      if (!e.relatedTarget||!document.body.contains(e.relatedTarget))
        overlay.classList.remove("visible");
    }));
    document.addEventListener("drop",e=>{
      e.preventDefault(); overlay.classList.remove("visible");
      const f=e.dataTransfer?.files?.[0]; if(f) this.#attachFile(f);
    });

    // Paste image
    document.addEventListener("paste",e=>{
      for (const item of e.clipboardData?.items||[]) {
        if (item.type.startsWith("image/")) {
          const f=item.getAsFile(); if(f){this.#attachFile(f);e.preventDefault();break;}
        }
      }
    });

    // Session controls
    document.getElementById("newSessionBtn").addEventListener("click",    ()=>this.#newSession());
    document.getElementById("deleteSessionBtn").addEventListener("click", ()=>this.#deleteCurrentSession());
    document.getElementById("sidebarToggle").addEventListener("click",    ()=>this.#toggleSidebar(false));
    document.getElementById("openSidebar").addEventListener("click",      ()=>this.#toggleSidebar(true));
    document.getElementById("mobOverlay").addEventListener("click",       ()=>this.#closeMobileSidebar());
    document.getElementById("themeToggle").addEventListener("click",      ()=>this.#toggleTheme());

    // Rename modal
    document.getElementById("renameClose").addEventListener("click",   ()=>this.#closeRename());
    document.getElementById("renameCancel").addEventListener("click",  ()=>this.#closeRename());
    document.getElementById("renameConfirm").addEventListener("click", ()=>this.#confirmRename());
    document.getElementById("renameModal").addEventListener("click", e=>{
      if (e.target===document.getElementById("renameModal")) this.#closeRename();
    });
    document.getElementById("renameInput").addEventListener("keydown", e=>{
      if (e.key==="Enter") this.#confirmRename();
      if (e.key==="Escape") this.#closeRename();
    });

    // History callbacks
    this.#history.onSelect = id=>this.#loadSession(id);
    this.#history.onDelete = id=>this.#deleteSession(id);
    this.#history.onRename = (id,title)=>this.#openRename(id,title);
  }

  async #init() {
    const theme = localStorage.getItem("essaymind_theme")||"dark";
    document.documentElement.dataset.theme = theme;
    this.#status.render();
    this.#history.render();
    this.#rubricModal.render();
  }

  // ── Rename ─────────────────────────────────────────────────
  #openRename(id, currentTitle) {
    this.#renamingSessionId = id;
    const inp = document.getElementById("renameInput");
    inp.value = currentTitle||"";
    document.getElementById("renameModal").style.display = "flex";
    setTimeout(()=>{ inp.focus(); inp.select(); }, 80);
  }
  #closeRename() {
    this.#renamingSessionId = null;
    document.getElementById("renameModal").style.display = "none";
  }
  async #confirmRename() {
    const id    = this.#renamingSessionId;
    const title = document.getElementById("renameInput").value.trim();
    if (!id||!title) { this.#closeRename(); return; }
    await this.#api.updateTitle(id, title);
    this.#history.updateLocalTitle(id, title);
    if (this.#currentSessionId===id)
      document.getElementById("topbarTitle").textContent = title;
    this.#closeRename();
    showToast("Session renamed ✓");
  }

  // ── File ────────────────────────────────────────────────────
  #attachFile(file) {
    const ok = /\.(pdf|docx|txt|png|jpg|jpeg|webp|bmp)$/i.test(file.name)||file.type.startsWith("image/");
    if (!ok) { showToast("⚠ Unsupported file type"); return; }
    this.#pendingFile = file;
    const name = file.name||`image.${file.type.split("/")[1]||"png"}`;
    const chips = document.getElementById("fileChips");
    chips.style.display="flex";
    chips.innerHTML = `<div class="file-chip">${file.type.startsWith("image/")?"🖼":"📎"} ${escHtml(name)}<button class="file-chip-remove" id="removeFile">×</button></div>`;
    document.getElementById("removeFile").addEventListener("click",()=>{
      this.#pendingFile=null; chips.style.display="none"; chips.innerHTML="";
      document.getElementById("fileInput").value="";
    });
    showToast(`📎 Attached: ${name}`);
  }

  // ── Session management ──────────────────────────────────────
  async #newSession() {
    // Don't cancel the in-flight eval — it keeps running in the background
    // and saves its result to the server for the session it started on.
    // Just create a new session and switch the UI.
    const session = await this.#api.createSession();
    this.#currentSessionId = session.id;

    this.#pendingFile = null;
    document.getElementById("topbarTitle").textContent = "New Evaluation";
    document.getElementById("chatInput").value = "";
    document.getElementById("fileChips").style.display = "none";
    document.getElementById("fileChips").innerHTML = "";
    document.getElementById("welcomeScreen").classList.remove("hidden");
    this.#renderer.render();
    this.#history.addOrUpdate(session);
    this.#history.setActive(session.id);
    this.#closeMobileSidebar();
    document.getElementById("chatInput").focus();
  }
  async #loadSession(id) {
    // Don't cancel the in-flight evaluation — just let it finish in the background.
    // It will save to its own session on the server.
    // Just switch the visible UI to show the selected session.
    this.#currentSessionId = id;
    this.#history.setActive(id);
    this.#closeMobileSidebar();

    // Clear the chat area and show the selected session's messages
    this.#renderer.render();
    document.getElementById("welcomeScreen").classList.add("hidden");
    document.getElementById("topbarTitle").textContent = "Loading...";

    try {
      const s = await this.#api.getSession(id);
      if (!s || s.error) {
        document.getElementById("welcomeScreen").classList.remove("hidden");
        return;
      }
      // Only update UI if the user hasn't switched away again while we were loading
      if (this.#currentSessionId !== id) return;
      document.getElementById("topbarTitle").textContent = s.title || "Evaluation";
      const msgs = s.messages || [];
      if (msgs.length > 0) {
        document.getElementById("welcomeScreen").classList.add("hidden");
        this.#renderer.loadMessages(msgs);
      } else {
        document.getElementById("welcomeScreen").classList.remove("hidden");
      }
    } catch(e) { console.error(e); }
  }
  async #deleteCurrentSession() {
    if (!this.#currentSessionId) return;
    if (!confirm("Delete this session?")) return;
    await this.#deleteSession(this.#currentSessionId); this.#newSession();
  }
  async #deleteSession(id) {
    await this.#api.deleteSession(id); this.#history.remove(id);
    if (this.#currentSessionId===id) this.#newSession();
  }

  // ── Send ────────────────────────────────────────────────────
  async #send() {
    if (this.#isEvaluating) return;
    const text=document.getElementById("chatInput").value.trim();
    if (!text&&!this.#pendingFile) return;
    const isFirst=!this.#currentSessionId||
      (await this.#api.getSession(this.#currentSessionId))?.messages?.length===0;
    if (this.#pendingFile||isFirst) await this.#runEvaluation(text);
    else await this.#runChat(text);
  }

  async #runEvaluation(text) {
    const file = this.#pendingFile;
    if (!text && !file) return;

    this.#isEvaluating = true;
    this.#abortController = new AbortController();
    const signal        = this.#abortController.signal;
    const mySessionId   = this.#currentSessionId; // session this eval belongs to

    document.getElementById("chatInput").value = ""; this.#resizeTa();
    document.getElementById("sendBtn").disabled = true;
    document.getElementById("welcomeScreen").classList.add("hidden");
    this.#renderer.appendUser(text || `Evaluating: ${file?.name}`, file?.name);
    this.#renderer.showLoading();

    const form = new FormData();
    if (this.#currentSessionId) form.append("session_id", this.#currentSessionId);
    if (text) form.append("text", text);
    if (file) form.append("file", file);
    form.append("rubric", JSON.stringify(this.#rubric.toApiPayload()));

    this.#pendingFile = null;
    document.getElementById("fileChips").style.display = "none";
    document.getElementById("fileChips").innerHTML = "";

    try {
      const data = await this.#api.evaluate(form, signal);

      // Update the history sidebar regardless of which session is active now
      if (!data.error && data.session_id) {
        const s = await this.#api.getSession(data.session_id);
        if (s) this.#history.addOrUpdate(s);
      }

      // If user is still on the session this eval belongs to — show the result
      if (this.#currentSessionId === mySessionId) {
        this.#renderer.completeLoading();
        await sleep(400);
        this.#renderer.removeLoading();

        if (data.error) {
          this.#renderer.appendError(data.error);
        } else {
          this.#currentSessionId = data.session_id;
          this.#renderer.appendEvaluation(data.evaluation);
          const s = await this.#api.getSession(this.#currentSessionId);
          if (s) {
            this.#history.addOrUpdate(s);
            document.getElementById("topbarTitle").textContent = s.title || "Evaluation";
          }
        }
      } else {
        // User has navigated away — quietly remove the loading indicator
        // from whatever session we're now on (it may not even be visible)
        this.#renderer.removeLoading();
        // Show a toast so user knows their other session finished
        showToast("✓ Evaluation complete in previous session");
      }

    } catch(err) {
      if (err.name === "AbortError") return;
      if (this.#currentSessionId === mySessionId) {
        this.#renderer.removeLoading();
        this.#renderer.appendError("Network error. Is Ollama running?");
      }
    } finally {
      this.#isEvaluating = false;
      this.#abortController = null;
      document.getElementById("sendBtn").disabled = false;
      }
    }
  }

  async #runChat(text) {
    document.getElementById("chatInput").value=""; this.#resizeTa();
    document.getElementById("sendBtn").disabled=true;
    this.#renderer.appendUser(text); this.#renderer.showLoading();
    try {
      const data=await this.#api.chat(this.#currentSessionId,text);
      this.#renderer.completeLoading(); await sleep(300); this.#renderer.removeLoading();
      if (data.error) this.#renderer.appendError(data.error);
      else {
        this.#renderer.appendChat(data.response);
        this.#currentSessionId=data.session_id;
        const s=await this.#api.getSession(this.#currentSessionId);
        if(s) this.#history.addOrUpdate(s);
      }
    } catch {
      this.#renderer.removeLoading();
      this.#renderer.appendError("Network error. Is Ollama running?");
    } finally { document.getElementById("sendBtn").disabled=false; }
  }

  // ── UI helpers ──────────────────────────────────────────────
  #resizeTa() {
    const el=document.getElementById("chatInput");
    el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,180)+"px";
  }
  #toggleTheme() {
    const next=document.documentElement.dataset.theme==="dark"?"light":"dark";
    document.documentElement.dataset.theme=next;
    localStorage.setItem("essaymind_theme",next);
  }
  #toggleSidebar(open) {
    const sb=document.getElementById("sidebar");
    if (open) {
      sb.classList.remove("hidden");
      if (window.innerWidth<=700){sb.classList.add("mobile-open");document.getElementById("mobOverlay").classList.add("visible");}
      document.getElementById("openSidebar").style.display="none";
    } else {
      if (window.innerWidth<=700) this.#closeMobileSidebar();
      else {
        sb.classList.toggle("hidden");
        document.getElementById("openSidebar").style.display=sb.classList.contains("hidden")?"flex":"none";
      }
    }
  }
  #closeMobileSidebar() {
    document.getElementById("sidebar").classList.remove("mobile-open");
    document.getElementById("mobOverlay").classList.remove("visible");
  }
}

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function fmtTime(d) { return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
function sleep(ms)  { return new Promise(r=>setTimeout(r,ms)); }
function showToast(msg) {
  const t=document.createElement("div");
  t.style.cssText="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ac);color:var(--tx-inv);padding:9px 20px;border-radius:99px;font-family:var(--font-display);font-size:13px;font-weight:600;box-shadow:var(--shadow);z-index:9999;animation:msgIn .2s var(--ease);white-space:nowrap;pointer-events:none;";
  t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2500);
}

document.addEventListener("DOMContentLoaded", ()=>new App());
