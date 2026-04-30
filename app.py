"""
EssayMind — AI Essay Evaluator (Flask Backend)
OOP: Abstraction, Encapsulation, Inheritance, Polymorphism
Deterministic scoring: SHA-256 hash of essay content + rubric config
Powered by Groq API (replaces Ollama)
"""
import os, json, uuid, re, hashlib, logging, time
from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, render_template, make_response
from flask_cors import CORS
import requests

try:
    import pytesseract
    from PIL import Image
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False

try:
    import fitz
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False

try:
    from docx import Document as DocxDocument
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# ── User isolation via cookie ─────────────────────────────────
def get_user_id():
    """Return a stable anonymous user-id from a browser cookie."""
    uid = request.cookies.get("essaymind_uid")
    if not uid:
        uid = str(uuid.uuid4())
    return uid

def set_uid_cookie(response, uid):
    """Attach the uid cookie to a response (1-year expiry)."""
    response.set_cookie("essaymind_uid", uid, max_age=365*24*3600, samesite="Lax")
    return response

UPLOAD_FOLDER = Path("uploads")
DATA_FOLDER   = Path("data")

# ── Groq config ───────────────────────────────────────────────
GROQ_API_KEY   = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL     = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_API_URL   = "https://api.groq.com/openai/v1/chat/completions"

# Available Groq models (shown in sidebar dropdown)
GROQ_MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
]

ALLOWED_EXT = {".pdf", ".docx", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".bmp"}

UPLOAD_FOLDER.mkdir(exist_ok=True)
DATA_FOLDER.mkdir(exist_ok=True)

HISTORY_FILE = DATA_FOLDER / "chat_history.json"
CACHE_FILE   = DATA_FOLDER / "score_cache.json"

# ── ABSTRACTION ───────────────────────────────────────────────
class BaseEvaluator(ABC):
    @abstractmethod
    def evaluate(self, text: str, rubric) -> dict: pass
    @abstractmethod
    def build_prompt(self, text: str, rubric) -> str: pass
    @abstractmethod
    def parse_response(self, raw: str) -> dict: pass

class FileProcessor(ABC):
    @abstractmethod
    def can_process(self, ext: str) -> bool: pass
    @abstractmethod
    def extract_text(self, filepath: Path) -> str: pass
    def _clean(self, t: str) -> str: return re.sub(r'\s+', ' ', t).strip()

# ── POLYMORPHISM: File processors ────────────────────────────
class TextFileProcessor(FileProcessor):
    def can_process(self, ext): return ext == ".txt"
    def extract_text(self, fp):
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            return self._clean(f.read())

class PDFProcessor(FileProcessor):
    def can_process(self, ext): return ext == ".pdf"
    def extract_text(self, fp):
        if not PDF_AVAILABLE: raise ValueError("PyMuPDF not installed. pip install pymupdf")
        doc = fitz.open(str(fp))
        pages = [p.get_text() for p in doc]; doc.close()
        text = "\n".join(pages)
        return self._ocr_pdf(fp) if len(text.strip()) < 50 else self._clean(text)
    def _ocr_pdf(self, fp):
        if not OCR_AVAILABLE: raise ValueError("Tesseract not available for scanned PDFs.")
        doc = fitz.open(str(fp)); texts = []
        for page in doc:
            pix = page.get_pixmap(dpi=200)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            texts.append(pytesseract.image_to_string(img))
        doc.close(); return self._clean("\n".join(texts))

class DocxProcessor(FileProcessor):
    def can_process(self, ext): return ext == ".docx"
    def extract_text(self, fp):
        if not DOCX_AVAILABLE: raise ValueError("python-docx not installed.")
        doc = DocxDocument(str(fp))
        return self._clean("\n".join(p.text for p in doc.paragraphs if p.text.strip()))

class ImageProcessor(FileProcessor):
    _OK = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    def can_process(self, ext): return ext.lower() in self._OK
    def extract_text(self, fp):
        if not OCR_AVAILABLE: raise ValueError("Tesseract OCR not available.")
        img = Image.open(str(fp)).convert("L")
        text = pytesseract.image_to_string(img, config="--psm 3")
        if not text.strip(): raise ValueError("No text detected in image.")
        return self._clean(text)

# ── ENCAPSULATION: Registry, Rubric, Cache, History ──────────
class FileProcessorRegistry:
    def __init__(self):
        self._p = [TextFileProcessor(), PDFProcessor(), DocxProcessor(), ImageProcessor()]
    def extract_text(self, fp: Path) -> str:
        ext = fp.suffix.lower()
        for p in self._p:
            if p.can_process(ext): return p.extract_text(fp)
        raise ValueError(f"Unsupported file type: {ext}")

class Rubric:
    DEFAULT_CRITERIA = [
        {"id":"focus",       "label":"Focus",       "weight":20, "description":"Clarity and strength of the central argument or thesis"},
        {"id":"structure",   "label":"Structure",   "weight":20, "description":"Logical flow, introduction, body, and conclusion"},
        {"id":"credibility", "label":"Credibility", "weight":20, "description":"Use of evidence, citations, and supporting details"},
        {"id":"style",       "label":"Style",       "weight":20, "description":"Word choice, tone, voice, and overall expression"},
        {"id":"clarity",     "label":"Clarity",     "weight":20, "description":"Grammar, spelling, punctuation, and readability"},
    ]
    def __init__(self, criteria=None):
        self._criteria = criteria or [dict(c) for c in self.DEFAULT_CRITERIA]
    @property
    def criteria(self): return self._criteria
    def to_prompt_text(self):
        return "\n".join(f"- {c['label']} ({c['weight']}%): {c['description']}" for c in self._criteria)
    def cache_key(self):
        return json.dumps([{"id":c["id"],"weight":c["weight"]} for c in self._criteria], sort_keys=True)
    def strictness_level(self) -> str:
        weights = [c["weight"] for c in self._criteria]
        max_w = max(weights) if weights else 20
        if max_w >= 30:   return "strict"
        if max_w >= 22:   return "moderately_strict"
        return "standard"
    @classmethod
    def from_dict(cls, data):
        return cls(data.get("criteria", cls.DEFAULT_CRITERIA))

class ScoreCache:
    def __init__(self, fp: Path):
        self._path = fp; self._cache = self._load()
    def _load(self):
        if self._path.exists():
            try:
                with open(self._path) as f: return json.load(f)
            except: pass
        return {}
    def _save(self):
        with open(self._path, "w") as f: json.dump(self._cache, f, indent=2)
    def make_key(self, text: str, rubric: Rubric) -> str:
        normalised = re.sub(r'\s+', ' ', text.strip()).lower()
        raw = normalised + "||RUBRIC||" + rubric.cache_key()
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()
    def get(self, key): return self._cache.get(key)
    def set(self, key, result):
        result["_cached"] = True
        self._cache[key] = result; self._save()
    def clear(self): self._cache = {}; self._save()
    def size(self): return len(self._cache)

class ChatHistoryManager:
    def __init__(self, fp: Path):
        self._path = fp; self._sessions = self._load()
    def _load(self):
        if self._path.exists():
            try:
                with open(self._path) as f: return json.load(f)
            except: pass
        return {}
    def _save(self):
        with open(self._path, "w") as f: json.dump(self._sessions, f, indent=2)
    def create_session(self, title="New Evaluation", uid=None):
        sid = str(uuid.uuid4())
        s = {"id":sid,"title":title,"uid":uid,"created":datetime.now().isoformat(),"updated":datetime.now().isoformat(),"messages":[]}
        self._sessions[sid] = s; self._save(); return s
    def get_session(self, sid): return self._sessions.get(sid)
    def get_all_sessions(self, uid=None):
        sessions = self._sessions.values()
        if uid:
            sessions = [s for s in sessions if s.get("uid") == uid]
        s = sorted(sessions, key=lambda x: x.get("updated",""), reverse=True)
        return [{"id":x["id"],"title":x["title"],"created":x["created"],"updated":x["updated"],"message_count":len(x.get("messages",[]))} for x in s]
    def add_message(self, sid, role, content, evaluation=None, metadata=None):
        s = self._sessions.get(sid)
        if not s: s = self.create_session(); sid = s["id"]
        msg = {"id":str(uuid.uuid4()),"role":role,"content":content,"timestamp":datetime.now().isoformat(),"evaluation":evaluation,"metadata":metadata or {}}
        s["messages"].append(msg); s["updated"] = datetime.now().isoformat()
        if role == "user" and len(s["messages"]) == 1:
            s["title"] = content[:50].strip() + ("..." if len(content)>50 else "")
        self._save(); return msg
    def delete_session(self, sid):
        if sid in self._sessions: del self._sessions[sid]; self._save(); return True
        return False
    def update_title(self, sid, title):
        if sid in self._sessions: self._sessions[sid]["title"] = title; self._save()

# ── INHERITANCE: EssayEvaluator ───────────────────────────────
class EssayEvaluator(BaseEvaluator):
    def __init__(self, model=None):
        self._model = model or GROQ_MODEL

    def build_prompt(self, text: str, rubric: Rubric) -> str:
        strictness = rubric.strictness_level()
        score_ranges = {
            "strict":            {"excellent":88, "good":72, "average":55, "poor":38},
            "moderately_strict": {"excellent":90, "good":78, "average":62, "poor":45},
            "standard":          {"excellent":92, "good":82, "average":68, "poor":50},
        }[strictness]

        criteria_lines = []
        for c in rubric.criteria:
            w = c["weight"]
            if w >= 30:
                note = f"HIGH WEIGHT ({w}%) — be strict; small flaws cause significant score drops"
            elif w >= 25:
                note = f"ELEVATED WEIGHT ({w}%) — apply firm standards"
            else:
                note = f"Standard weight ({w}%)"
            criteria_lines.append(f"  - {c['label']} [{note}]: {c['description']}")

        criteria_text = "\n".join(criteria_lines)

        example_scores = []
        for c in rubric.criteria:
            example_scores.append(f'    "{c["id"]}": {{"score": 75, "feedback": "Replace this with specific feedback about this criterion."}}')
        example_scores_str = ",\n".join(example_scores)

        strictness_instruction = {
            "strict": (
                "STRICT MODE — weights are high. Score harshly:\n"
                f"- Excellent writing = {score_ranges['excellent']}\n"
                f"- Good writing = {score_ranges['good']}\n"
                f"- Average writing = {score_ranges['average']}\n"
                f"- Poor/weak writing = {score_ranges['poor']} or below\n"
                "- Deduct heavily for ANY weakness in high-weight criteria."
            ),
            "moderately_strict": (
                "MODERATELY STRICT MODE:\n"
                f"- Excellent = {score_ranges['excellent']}, Good = {score_ranges['good']}, "
                f"Average = {score_ranges['average']}, Poor = {score_ranges['poor']}\n"
                "- Be firm on high-weight criteria."
            ),
            "standard": (
                "STANDARD MODE — be fair and balanced:\n"
                f"- Excellent = {score_ranges['excellent']}, Good = {score_ranges['good']}, "
                f"Average = {score_ranges['average']}, Poor = {score_ranges['poor']}\n"
                "- Recognise effort and strengths."
            ),
        }[strictness]

        return f"""You are an expert academic essay evaluator. Read the essay below and evaluate it honestly.

SCORING MODE:
{strictness_instruction}

IMPORTANT RULES:
- Each criterion gets its OWN independent score — never give all criteria the same score.
- An error-filled or incoherent essay MUST score below 50.
- overall_score = weighted average of all criterion scores.
- Write SPECIFIC feedback quoting actual phrases from the essay — not generic comments.
- For weaknesses: quote the EXACT problematic text found in the essay.

RUBRIC CRITERIA:
{criteria_text}

ESSAY:
---
{text[:5000]}
---

Respond with ONLY this JSON (no markdown, no explanation, no text before or after):

{{
  "overall_score": 75,
  "grade": "B",
  "summary": "Write 2-3 specific sentences summarising this particular essay here.",
  "scores": {{
{example_scores_str}
  }},
  "errors": [
    {{
      "type": "Grammar",
      "text": "paste exact phrase from essay here",
      "issue": "describe what is wrong",
      "suggestion": "show corrected version"
    }}
  ],
  "recommendations": [
    "Write specific, actionable suggestion 1 for THIS essay.",
    "Write specific suggestion 2.",
    "Write specific suggestion 3 (add more if score is low — low scores need more guidance)."
  ],
  "strengths": [
    "Write genuine strength 1 of THIS essay.",
    "Write genuine strength 2 (add more if score is high — high scores deserve more praise)."
  ]
}}

STRICT LENGTH LIMITS — stay within these or the response will be cut off:
- summary: MAX 2 sentences
- feedback per criterion: MAX 1 sentence, MAX 20 words
- errors list: MAX 3 items total. Each field MAX 10 words.
- recommendations: MAX 3 items, each MAX 20 words
- strengths: MAX 3 items, each MAX 15 words
Keep ALL strings short. Truncated JSON cannot be parsed and wastes the evaluation."""

    def evaluate(self, text: str, rubric: Rubric) -> dict:
        raw = self._call_groq(self.build_prompt(text, rubric))
        try:
            result = self.parse_response(raw)
        except ValueError:
            # First attempt failed — retry with a stricter prompt asking only for JSON
            retry_prompt = (
                "You previously returned an incomplete or unparseable JSON response. "
                "Return ONLY a valid JSON object with these keys: "
                "overall_score (int), grade (str), summary (str), scores (object), "
                "errors (array), recommendations (array), strengths (array). "
                "No markdown, no explanation, no text outside the JSON braces.\n\n"
                "Original task:\n" + self.build_prompt(text, rubric)
            )
            raw2 = self._call_groq(retry_prompt)
            result = self.parse_response(raw2)
        result["word_count"]  = len(text.split())
        result["char_count"]  = len(text)
        result["rubric_used"] = [c["label"] for c in rubric.criteria]

        # ── Enforce honest scoring ──────────────────────────────────────────
        scores_data = result.get("scores", {})
        if scores_data and isinstance(scores_data, dict):
            total_weight = 0
            weighted_sum = 0
            for criterion in rubric.criteria:
                cid  = criterion["id"]
                wgt  = criterion["weight"]
                data = scores_data.get(cid, {})
                if isinstance(data, dict):
                    raw_score = data.get("score", data.get("value", 0))
                else:
                    raw_score = data
                sc = max(0, min(100, int(float(raw_score or 0))))
                if isinstance(scores_data.get(cid), dict):
                    scores_data[cid]["score"] = sc
                weighted_sum += sc * wgt
                total_weight += wgt

            if total_weight > 0:
                computed = round(weighted_sum / total_weight)
                result["overall_score"] = computed
                if computed >= 93:   result["grade"] = "A+"
                elif computed >= 90: result["grade"] = "A"
                elif computed >= 87: result["grade"] = "A-"
                elif computed >= 83: result["grade"] = "B+"
                elif computed >= 80: result["grade"] = "B"
                elif computed >= 77: result["grade"] = "B-"
                elif computed >= 73: result["grade"] = "C+"
                elif computed >= 70: result["grade"] = "C"
                elif computed >= 67: result["grade"] = "C-"
                elif computed >= 60: result["grade"] = "D"
                else:                result["grade"] = "F"

        # ── Run AI detection ────────────────────────────────────────────────
        try:
            result["ai_detection"] = self._detect_ai(text)
        except Exception as e:
            result["ai_detection"] = {
                "verdict": "Unknown", "confidence": 0, "probability_ai": 50,
                "indicators": [str(e)], "human_signals": [],
                "explanation": "Detection failed."
            }

        return result

    def parse_response(self, raw: str, default: dict = None) -> dict:
        def try_json(s):
            try: return json.loads(s)
            except: return None

        def repair(s):
            """Close open strings, arrays, objects from a truncated JSON."""
            buf = []; in_str = False; esc = False
            for ch in s:
                if esc: esc = False; buf.append(ch); continue
                if ch == "\\": esc = True; buf.append(ch); continue
                if ch == '"': in_str = not in_str
                buf.append(ch)
            if in_str: buf.append('"')          # close open string
            t = "".join(buf).rstrip(", \n\r\t")
            t += "]" * max(0, t.count("[") - t.count("]"))
            t += "}" * max(0, t.count("{") - t.count("}"))
            return t

        try:
            cleaned = re.sub(r"```(?:json)?\s*", "", raw)
            cleaned = re.sub(r"```\s*", "", cleaned).strip()
            start = cleaned.find("{")
            if start == -1:
                raise ValueError("No JSON object found")
            cleaned = cleaned[start:]

            r = try_json(cleaned); 
            if r: return r
            stripped = re.sub(r",\s*([}\]])", r"\1", cleaned)
            r = try_json(stripped)
            if r: return r
            repaired = repair(cleaned)
            repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
            r = try_json(repaired)
            if r: return r
            raise ValueError("All repair attempts failed")
        except Exception as e:
            if default is not None:
                return default
            raise ValueError(f"JSON parse failed: {e}. Raw: {raw[:300]}")

    def _detect_ai(self, text: str) -> dict:
        """
        AI Detection using ZeroGPT unofficial API — no key needed.
        Falls back to local rule engine if ZeroGPT is unreachable.
        """
        safe_default = {
            "verdict": "Unknown", "confidence": 0, "probability_ai": 50,
            "indicators": ["Detection unavailable — check your internet connection"],
            "human_signals": [],
            "explanation": "Could not reach ZeroGPT. Check internet connection."
        }

        try:
            headers = {
                "Content-Type": "application/json",
                "origin": "https://www.zerogpt.com",
                "referer": "https://www.zerogpt.com/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
            payload = {"input_text": text[:5000]}
            r = requests.post(
                "https://api.zerogpt.com/api/detect/detectText",
                json=payload, headers=headers, timeout=20
            )
            r.raise_for_status()
            data = r.json()
            inner = data.get("data", data)

            ai_pct = inner.get("aiPercentage", None)
            if ai_pct is None:
                is_human = inner.get("isHuman", 0.5)
                ai_pct   = round((1 - float(is_human)) * 100)
            else:
                ai_pct = round(float(ai_pct))
            ai_pct = max(0, min(100, ai_pct))

            flagged = inner.get("sentences", []) or inner.get("highlighted", []) or []
            if isinstance(flagged, list):
                indicators = []
                for s in flagged[:4]:
                    txt = s.get("text", s.get("sentence", "")) if isinstance(s, dict) else str(s)
                    if txt: indicators.append(f'"{txt[:90].strip()}..."')
            else:
                indicators = []

            if not indicators:
                if ai_pct >= 70:
                    indicators = ["Uniform structure and generic phrasing detected",
                                  "Low sentence variation typical of AI writing"]
                elif ai_pct >= 40:
                    indicators = ["Some AI-like patterns present"]
                else:
                    indicators = ["No strong AI indicators found"]

            human_sigs = []
            if ai_pct < 50:   human_sigs = ["Natural sentence variation", "Authentic writing voice"]
            elif ai_pct < 70: human_sigs = ["Some natural phrasing detected"]

            if ai_pct >= 80:   verdict = "AI Generated"
            elif ai_pct >= 62: verdict = "Likely AI"
            elif ai_pct >= 42: verdict = "Uncertain"
            elif ai_pct >= 22: verdict = "Likely Human"
            else:              verdict = "Human"

            confidence = min(95, 50 + abs(ai_pct - 50))
            return {
                "verdict": verdict, "confidence": round(confidence),
                "probability_ai": ai_pct, "indicators": indicators,
                "human_signals": human_sigs,
                "explanation": f"ZeroGPT analysed the essay and estimated {ai_pct}% probability of AI generation.",
                "_source": "ZeroGPT"
            }

        except requests.exceptions.Timeout:
            logger.warning("ZeroGPT timed out — falling back to rule engine")
            return self._rule_engine_detect(text)
        except requests.exceptions.ConnectionError:
            logger.warning("ZeroGPT unreachable — falling back to rule engine")
            return self._rule_engine_detect(text)
        except Exception as e:
            logger.warning(f"ZeroGPT failed ({e}) — falling back to rule engine")
            return self._rule_engine_detect(text)

    def _rule_engine_detect(self, text: str) -> dict:
        try:
            rule = self._rule_based_ai_score(text)
            prob = rule["score"]
            if prob >= 80:   verdict = "AI Generated"
            elif prob >= 62: verdict = "Likely AI"
            elif prob >= 42: verdict = "Uncertain"
            elif prob >= 22: verdict = "Likely Human"
            else:            verdict = "Human"
            return {
                "verdict": verdict, "confidence": min(90, 50 + abs(prob - 50)),
                "probability_ai": prob,
                "indicators": rule["indicators"] or ["No strong AI indicators found"],
                "human_signals": ["Natural writing style"] if prob < 50 else [],
                "explanation": f"Offline rule engine estimated {prob}% AI probability (ZeroGPT unavailable).",
                "_source": "Rule Engine (offline)"
            }
        except Exception:
            return {
                "verdict": "Unknown", "confidence": 0, "probability_ai": 50,
                "indicators": ["Detection unavailable"], "human_signals": [],
                "explanation": "Detection could not complete.", "_source": "None"
            }

    def _rule_based_ai_score(self, text: str) -> dict:
        sentences = re.split(r'[.!?]+', text)
        sentences = [s.strip() for s in sentences if len(s.strip()) > 10]
        score = 0; indicators = []

        # Check sentence length uniformity
        if sentences:
            lengths = [len(s.split()) for s in sentences]
            avg = sum(lengths) / len(lengths)
            variance = sum((l - avg) ** 2 for l in lengths) / len(lengths)
            if variance < 15:
                score += 25
                indicators.append("Very uniform sentence lengths (low variance)")

        # Check for AI filler phrases
        ai_phrases = [
            "it is important to note", "it is worth noting", "in conclusion",
            "furthermore", "moreover", "in summary", "to summarize",
            "this essay will", "the purpose of this essay", "as previously mentioned",
            "in today's society", "plays a crucial role", "it goes without saying"
        ]
        text_lower = text.lower()
        found = [p for p in ai_phrases if p in text_lower]
        if len(found) >= 3:
            score += 30
            indicators.append(f"Multiple AI filler phrases detected: {', '.join(found[:3])}")
        elif len(found) >= 1:
            score += 10

        # Check transition word density
        transitions = ["firstly", "secondly", "thirdly", "additionally", "consequently",
                       "therefore", "thus", "hence", "subsequently", "nevertheless"]
        trans_count = sum(1 for t in transitions if t in text_lower)
        if trans_count >= 4:
            score += 20
            indicators.append(f"High transition word density ({trans_count} found)")

        # Check for exclamation marks / personal anecdotes (human signals)
        if text.count("!") > 2 or "I remember" in text or "I felt" in text:
            score = max(0, score - 15)

        return {"score": min(95, score), "indicators": indicators}

    def _call_groq(self, prompt: str, retries: int = 3) -> str:
        """Call Groq API with automatic retry on rate limit (429)."""
        if not GROQ_API_KEY:
            raise ConnectionError("GROQ_API_KEY environment variable is not set.")

        headers = {
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": self._model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": 6000,
            "seed": 42
        }
        for attempt in range(retries):
            try:
                r = requests.post(GROQ_API_URL, json=payload, headers=headers, timeout=60)
                # Check status manually before raise_for_status so we always have `r`
                if r.status_code == 429:
                    if attempt < retries - 1:
                        wait = int(r.headers.get("Retry-After", 2 ** (attempt + 1)))
                        logger.warning(f"Groq rate limit — waiting {wait}s (attempt {attempt+1}/{retries})")
                        time.sleep(wait)
                        continue
                    raise ConnectionError("Groq rate limit reached. Too many requests — please wait a moment and try again.")
                if r.status_code == 401:
                    raise ConnectionError("Invalid GROQ_API_KEY. Check your API key.")
                if r.status_code != 200:
                    raise ConnectionError(f"Groq API error {r.status_code}: {r.text[:200]}")
                return r.json()["choices"][0]["message"]["content"]
            except ConnectionError:
                raise
            except requests.exceptions.ConnectionError:
                raise ConnectionError("Cannot connect to Groq API. Check your internet connection.")
            except requests.exceptions.Timeout:
                raise TimeoutError("Groq API timed out. Please try again.")
            except Exception as e:
                if attempt < retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                raise ConnectionError(f"Groq request failed: {e}")

# ── Singletons ────────────────────────────────────────────────
history_manager = ChatHistoryManager(HISTORY_FILE)
score_cache     = ScoreCache(CACHE_FILE)
file_registry   = FileProcessorRegistry()
evaluator       = EssayEvaluator()

# ── Routes ────────────────────────────────────────────────────
@app.route("/")
def index(): return render_template("index.html")

@app.route("/api/status")
def status():
    if not GROQ_API_KEY:
        return jsonify({"status": "disconnected", "error": "GROQ_API_KEY not set", "models": [], "current_model": GROQ_MODEL})
    return jsonify({"status": "connected", "models": GROQ_MODELS, "current_model": evaluator._model})

@app.route("/api/model", methods=["POST"])
def set_model():
    m = request.json.get("model", "").strip()
    if not m: return jsonify({"error": "No model"}), 400
    evaluator._model = m; return jsonify({"model": m})

@app.route("/api/sessions")
def get_sessions():
    uid = get_user_id()
    resp = make_response(jsonify(history_manager.get_all_sessions(uid=uid)))
    return set_uid_cookie(resp, uid)

@app.route("/api/sessions", methods=["POST"])
def create_session():
    uid = get_user_id()
    resp = make_response(jsonify(history_manager.create_session(uid=uid)))
    return set_uid_cookie(resp, uid)

@app.route("/api/sessions/<sid>")
def get_session(sid):
    s = history_manager.get_session(sid)
    return jsonify(s) if s else (jsonify({"error": "Not found"}), 404)

@app.route("/api/sessions/<sid>", methods=["DELETE"])
def delete_session(sid):
    return jsonify({"deleted": sid}) if history_manager.delete_session(sid) else (jsonify({"error": "Not found"}), 404)

@app.route("/api/sessions/<sid>/title", methods=["PATCH"])
def update_title(sid):
    history_manager.update_title(sid, request.json.get("title", "").strip() or "Untitled")
    return jsonify({"ok": True})

@app.route("/api/evaluate", methods=["POST"])
def evaluate_essay():
    try:
        sid        = request.form.get("session_id", "")
        user_text  = request.form.get("text", "").strip()
        rubric_raw = request.form.get("rubric", "")
        file_obj   = request.files.get("file")
        essay_text = ""; source_meta = {}

        if file_obj and file_obj.filename:
            fname = file_obj.filename; ext = Path(fname).suffix.lower()
            if ext not in ALLOWED_EXT:
                return jsonify({"error": f"File type {ext} not supported."}), 400
            tmp = UPLOAD_FOLDER / f"{uuid.uuid4()}{ext}"
            file_obj.save(str(tmp))
            try:
                essay_text  = file_registry.extract_text(tmp)
                source_meta = {"source": "file", "filename": fname}
            finally:
                tmp.unlink(missing_ok=True)
        elif user_text:
            essay_text  = user_text
            source_meta = {"source": "text"}
        else:
            return jsonify({"error": "Please provide essay text or upload a file."}), 400

        if len(essay_text.strip()) < 50:
            return jsonify({"error": "Essay too short (minimum 50 characters)."}), 400

        rubric    = Rubric.from_dict(json.loads(rubric_raw) if rubric_raw else {})
        cache_key = score_cache.make_key(essay_text, rubric)
        cached    = score_cache.get(cache_key)

        if cached:
            logger.info(f"Cache HIT {cache_key[:12]} — returning stored result")
            result = cached
            if "ai_detection" not in result or not result.get("ai_detection"):
                try:
                    result["ai_detection"] = evaluator._detect_ai(essay_text)
                    score_cache.set(cache_key, result)
                except Exception as e:
                    result["ai_detection"] = {
                        "verdict": "Unknown", "confidence": 0, "probability_ai": 50,
                        "indicators": ["Detection unavailable"], "human_signals": [],
                        "explanation": str(e)
                    }
        else:
            logger.info(f"Cache MISS {cache_key[:12]} — calling Groq")
            try:
                result = evaluator.evaluate(essay_text, rubric)
            except (ConnectionError, TimeoutError) as e:
                return jsonify({"error": str(e)}), 503
            except ValueError as e:
                return jsonify({"error": str(e)}), 422
            score_cache.set(cache_key, result)

        uid = get_user_id()
        if not sid:
            session = history_manager.create_session(uid=uid); sid = session["id"]
        else:
            session = history_manager.get_session(sid)
            if not session:
                session = history_manager.create_session(uid=uid); sid = session["id"]

        display = (
            f"[File: {source_meta.get('filename', 'uploaded')}]\n\n{essay_text[:300]}..."
            if source_meta.get("source") == "file" else essay_text
        )
        history_manager.add_message(sid, "user", display, metadata=source_meta)
        history_manager.add_message(sid, "assistant", result.get("summary", "Evaluation complete."), evaluation=result)

        resp = make_response(jsonify({"session_id": sid, "evaluation": result, "from_cache": bool(cached)}))
        return set_uid_cookie(resp, uid)

    except Exception as e:
        logger.exception("Evaluate error")
        return jsonify({"error": f"Server error: {e}"}), 500

@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        data    = request.json or {}
        sid     = data.get("session_id", "")
        message = data.get("message", "").strip()
        if not message: return jsonify({"error": "Empty message"}), 400
        session = history_manager.get_session(sid) if sid else None
        if not session: session = history_manager.create_session(); sid = session["id"]
        history_manager.add_message(sid, "user", message)
        ctx = "".join(
            f"{'User' if m['role']=='user' else 'Assistant'}: {m['content'][:400]}\n"
            for m in session["messages"][-6:]
        )
        prompt = f"You are EssayMind, an expert writing tutor. Be specific and helpful.\n\nConversation:\n{ctx}\nUser: {message}\nAssistant:"
        try:
            raw = evaluator._call_groq(prompt)
        except (ConnectionError, TimeoutError) as e:
            return jsonify({"error": str(e)}), 503
        history_manager.add_message(sid, "assistant", raw)
        return jsonify({"session_id": sid, "response": raw})
    except Exception as e:
        logger.exception("Chat error")
        return jsonify({"error": str(e)}), 500

@app.route("/api/cache/stats")
def cache_stats(): return jsonify({"cached_essays": score_cache.size()})

@app.route("/api/cache/clear", methods=["POST"])
def clear_cache(): score_cache.clear(); return jsonify({"ok": True})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print("\n  ◈ EssayMind is running!")
    print(f"  Local: http://localhost:{port}")
    print(f"\n  Make sure GROQ_API_KEY is set in your environment.\n")
    app.run(debug=False, port=port, host="0.0.0.0")
