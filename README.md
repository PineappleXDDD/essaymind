# ◈ EssayMind — AI Essay Evaluator

A full-stack, locally-run AI essay evaluation web app powered by **Ollama**.  
Supports **PDF, DOCX, TXT, and OCR image** inputs with detailed rubric-based grading,  
grammar/punctuation error detection, improvement recommendations, and persistent chat history.

---

## 🚀 Quick Start

### 1. Install Ollama

Download from [ollama.com](https://ollama.com) and start it:

```bash
ollama serve
```

Pull a model (recommended):

```bash
ollama pull llama3.2        # Fast, good quality (~2GB)
# or
ollama pull mistral         # Also excellent for analysis
# or
ollama pull gemma2          # Google's model
```

---

### 2. Install Tesseract OCR (for image uploads)

**Windows:**  
Download installer from: https://github.com/UB-Mannheim/tesseract/wiki  
Add to PATH after installing.

**Mac:**  
```bash
brew install tesseract
```

**Linux (Ubuntu/Debian):**  
```bash
sudo apt install tesseract-ocr
```

---

### 3. Set Up Python Environment

```bash
# Clone / navigate to the project folder
cd essaymind

# Create virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

---

### 4. Run the App

```bash
python app.py
```

Open your browser: **http://localhost:5000**

---

## ✨ Features

| Feature | Details |
|---|---|
| **Essay Evaluation** | Rubric-based scoring across 5 customizable criteria |
| **Error Detection** | Grammar, punctuation, spelling, style, clarity errors |
| **Recommendations** | Specific, actionable improvement suggestions |
| **Strengths** | Highlights what the essay does well |
| **PDF Upload** | Full text extraction via PyMuPDF |
| **DOCX Upload** | Word document support via python-docx |
| **TXT Upload** | Plain text file support |
| **OCR Images** | Extract text from PNG/JPG/WebP via Tesseract |
| **Chat History** | Sessions saved to disk, persist across restarts |
| **Follow-up Chat** | Ask follow-up questions about any evaluation |
| **Light/Dark Mode** | Toggleable, remembered across sessions |
| **Custom Rubric** | Adjust weights per criterion (total = 100%) |
| **Model Selector** | Switch between any installed Ollama model |

---

## 🏗 Architecture (OOP Design)

### Python Backend (`app.py`)

| OOP Concept | Implementation |
|---|---|
| **Abstraction** | `BaseEvaluator` (ABC) defines `evaluate()`, `build_prompt()`, `parse_response()` |
| **Abstraction** | `FileProcessor` (ABC) defines `can_process()` and `extract_text()` |
| **Inheritance** | `EssayEvaluator` extends `BaseEvaluator` |
| **Inheritance** | `TextFileProcessor`, `PDFProcessor`, `DocxProcessor`, `ImageProcessor` extend `FileProcessor` |
| **Polymorphism** | Each `FileProcessor` subclass handles its file type differently via `extract_text()` |
| **Encapsulation** | `Rubric` manages criteria internally; `ChatHistoryManager` owns all persistence; `FileProcessorRegistry` selects processors |

### JavaScript Frontend (`app.js`)

| OOP Concept | Implementation |
|---|---|
| **Abstraction** | `BaseComponent` defines `render()` contract |
| **Inheritance** | `StatusBar`, `HistorySidebar`, `RubricModal`, `MessageRenderer` all extend `BaseComponent` |
| **Polymorphism** | Each component's `render()` behaves differently |
| **Encapsulation** | `ApiClient` encapsulates all HTTP calls; `RubricManager` owns rubric state/persistence |

---

## ⚙️ Configuration

You can set environment variables before running:

```bash
# Use a different Ollama URL (e.g., remote server)
OLLAMA_URL=http://192.168.1.100:11434 python app.py

# Default to a specific model
OLLAMA_MODEL=mistral python app.py
```

---

## 📁 Project Structure

```
essaymind/
├── app.py                  # Flask backend (Python OOP)
├── requirements.txt        # Python dependencies
├── data/
│   └── chat_history.json   # Persistent session storage (auto-created)
├── uploads/                # Temp file storage (auto-deleted after processing)
├── templates/
│   └── index.html          # Main HTML template
└── static/
    ├── css/
    │   └── styles.css      # Dark/light mode CSS design system
    └── js/
        └── app.js          # Frontend OOP JavaScript
```

---

## 🎓 Rubric Criteria (Default)

| Criterion | Weight | Description |
|---|---|---|
| Thesis & Argument | 20% | Clarity and strength of central claim |
| Structure & Organization | 20% | Intro, body, conclusion flow |
| Evidence & Support | 20% | Examples, citations, details |
| Language & Style | 20% | Word choice, tone, clarity |
| Grammar & Conventions | 20% | Spelling, grammar, punctuation |

All weights are configurable via the **Rubric** button in the interface.

---

## 🛠 Troubleshooting

**"Cannot connect to Ollama"**  
→ Run `ollama serve` in a terminal. Make sure it's on port 11434.

**"PyMuPDF not installed"**  
→ Run `pip install pymupdf`

**"Tesseract OCR not available"**  
→ Install Tesseract binary for your OS (see step 2 above), then `pip install pytesseract pillow`

**AI returns invalid JSON**  
→ Try a larger/better model: `ollama pull llama3.2` or `ollama pull mistral`

**Essay text too short**  
→ Minimum 50 characters required for evaluation.
