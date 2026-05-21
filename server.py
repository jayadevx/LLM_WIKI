#!/usr/bin/env python3
"""
LLM Wiki Server — file-based edition
======================================
Wiki pages  →  wiki/*.md        (use @wiki/slug.md in Claude Code)
Sources     →  sources/*.md     (use @sources/title.md in Claude Code)
SQLite      →  metadata only    (slug, title, summary, date)
AI          →  claude -p        (no API key needed, uses Claude Code auth)

Setup
-----
    npm install -g @anthropic-ai/claude-code
    claude login
    pip install flask
    python server.py

Claude Code usage
-----------------
    claude "@wiki/machine-learning.md explain the key concepts"
    claude "@wiki/index.md @wiki/neural-networks.md compare these"
    claude --print "@sources/paper.md summarize this paper"
"""

import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

# ── directories & config ──────────────────────────────────────────────────────

BASE_DIR    = Path(__file__).parent
WIKI_DIR    = BASE_DIR / os.environ.get("WIKI_DIR",    "wiki")
SOURCES_DIR = BASE_DIR / os.environ.get("SOURCES_DIR", "sources")
DB_PATH     = BASE_DIR / os.environ.get("DB_PATH",     "llm_wiki.db")
PORT        = int(os.environ.get("PORT", 5001))

WIKI_DIR.mkdir(exist_ok=True)
SOURCES_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=str(BASE_DIR))


# ── CORS ──────────────────────────────────────────────────────────────────────

@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"]  = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


@app.route("/api/<path:_>", methods=["OPTIONS"])
def preflight(_):
    return "", 204


# ── SQLite — metadata only ────────────────────────────────────────────────────

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS pages (
                slug       TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                summary    TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS log (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                date  TEXT NOT NULL,
                type  TEXT NOT NULL,
                entry TEXT NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS log_date ON log(date DESC)")


# ── file helpers ──────────────────────────────────────────────────────────────

def wiki_path(slug: str) -> Path:
    """Absolute path to a wiki page file."""
    # Sanitise slug — only allow safe filesystem characters
    safe = re.sub(r"[^a-z0-9\-_]", "", slug.lower())
    return WIKI_DIR / f"{safe}.md"


def read_wiki_page(slug: str) -> str:
    p = wiki_path(slug)
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write_wiki_page(slug: str, content: str) -> Path:
    p = wiki_path(slug)
    p.write_text(content, encoding="utf-8")
    return p


def save_source(title: str, content: str) -> Path:
    """Archive a source document in sources/ for later @-reference."""
    date  = datetime.now().strftime("%Y-%m-%d")
    slug  = re.sub(r"[^a-z0-9\-]", "-", title.lower().strip())[:60] if title else "source"
    fname = f"{date}-{slug}.md"
    p     = SOURCES_DIR / fname
    p.write_text(content, encoding="utf-8")
    return p


def rebuild_index_file():
    """Write wiki/index.md from current DB metadata."""
    with db() as c:
        rows = c.execute(
            "SELECT slug, title, summary, created_at FROM pages ORDER BY updated_at DESC"
        ).fetchall()

    lines = ["# Wiki Index\n", f"*{len(rows)} pages — last updated {datetime.now():%Y-%m-%d}*\n"]
    for r in rows:
        lines.append(f"\n## [[{r['title']}]]")
        lines.append(f"- **file:** `@wiki/{r['slug']}.md`")
        lines.append(f"- **date:** {r['created_at']}")
        if r["summary"]:
            lines.append(f"- {r['summary']}")

    (WIKI_DIR / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── AI via claude -p ──────────────────────────────────────────────────────────

def run_claude(prompt: str) -> str:
    """
    Shell out to `claude -p <prompt>` and return stdout.
    Falls back to ANTHROPIC_API_KEY if claude CLI is not found.
    """
    try:
        result = subprocess.run(
            ["claude", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=180,
            cwd=str(BASE_DIR),   # so @wiki/ references resolve correctly
        )
    except FileNotFoundError:
        # claude CLI not installed — try direct API
        return _api_fallback(prompt)

    if result.returncode != 0:
        err = result.stderr.strip()
        raise RuntimeError(
            f"claude -p exited {result.returncode}.\n{err}\n\n"
            "Make sure Claude Code is installed and authenticated:\n"
            "  npm install -g @anthropic-ai/claude-code\n"
            "  claude login"
        )
    return result.stdout.strip()


def _api_fallback(prompt: str) -> str:
    """Direct Anthropic API call when claude CLI is unavailable."""
    import urllib.error
    import urllib.request

    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise RuntimeError(
            "claude CLI not found and ANTHROPIC_API_KEY is not set.\n"
            "Either install Claude Code (npm install -g @anthropic-ai/claude-code)\n"
            "or set ANTHROPIC_API_KEY environment variable."
        )

    payload = json.dumps({
        "model":      "claude-sonnet-4-20250514",
        "max_tokens": 4000,
        "messages":   [{"role": "user", "content": prompt}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key":          key,
            "anthropic-version":  "2023-06-01",
            "content-type":       "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data["content"][0]["text"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(json.loads(e.read()).get("error", {}).get("message", str(e)))


# ── /api/ai — unified AI endpoint ────────────────────────────────────────────

@app.route("/api/ai", methods=["POST"])
def ai_endpoint():
    """
    Accepts the same JSON format as the Anthropic API so the frontend
    needs no changes.  Internally routes through claude -p.
    """
    data     = request.json or {}
    system   = data.get("system", "")
    messages = data.get("messages", [])

    # Flatten system + last user message into a single prompt for claude -p
    user_msg = ""
    for m in messages:
        role    = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):          # handle content-block arrays
            content = " ".join(b.get("text", "") for b in content if b.get("type") == "text")
        if role == "user":
            user_msg = content

    full_prompt = f"{system}\n\n---\n\n{user_msg}" if system else user_msg

    try:
        text = run_claude(full_prompt)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500

    # Return Anthropic-compatible shape so the frontend works unchanged
    return jsonify({"content": [{"type": "text", "text": text}]})


# ── /api/pages ────────────────────────────────────────────────────────────────

@app.route("/api/pages", methods=["GET"])
def list_pages():
    with db() as c:
        rows = c.execute(
            "SELECT slug, title, summary, created_at AS date FROM pages ORDER BY updated_at DESC"
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/pages/<slug>", methods=["GET"])
def get_page(slug):
    with db() as c:
        row = c.execute("SELECT * FROM pages WHERE slug = ?", (slug,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404

    content = read_wiki_page(slug)
    return jsonify({**dict(row), "content": content, "file": f"wiki/{slug}.md"})


@app.route("/api/pages", methods=["POST"])
def save_pages():
    """
    Write each page as a .md file and upsert metadata into SQLite.
    Optionally archive the original source text.
    """
    payload    = request.json or {}
    pages      = payload.get("pages", [])
    source_txt = payload.get("source_text")
    source_ttl = payload.get("source_title", "")
    now        = datetime.now().isoformat()
    today      = now[:10]

    saved_files = []
    with db() as c:
        for p in pages:
            slug    = re.sub(r"[^a-z0-9\-_]", "", p["slug"].lower())
            content = p.get("content", "")
            path    = write_wiki_page(slug, content)
            saved_files.append(str(path.relative_to(BASE_DIR)))

            c.execute(
                """
                INSERT INTO pages (slug, title, summary, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                    title      = excluded.title,
                    summary    = excluded.summary,
                    updated_at = excluded.updated_at
                """,
                (slug, p["title"], p.get("summary", ""), today, now),
            )

    # Archive source document
    source_file = None
    if source_txt:
        sp          = save_source(source_ttl, source_txt)
        source_file = str(sp.relative_to(BASE_DIR))

    rebuild_index_file()

    return jsonify({
        "ok":          True,
        "count":       len(pages),
        "files":       saved_files,
        "source_file": source_file,
    })


@app.route("/api/pages/<slug>", methods=["DELETE"])
def delete_page(slug):
    wiki_path(slug).unlink(missing_ok=True)
    with db() as c:
        c.execute("DELETE FROM pages WHERE slug = ?", (slug,))
    rebuild_index_file()
    return jsonify({"ok": True})


# ── /api/log ──────────────────────────────────────────────────────────────────

@app.route("/api/log", methods=["GET"])
def get_log():
    limit = request.args.get("limit", 500, type=int)
    with db() as c:
        rows = c.execute(
            "SELECT date, type, entry FROM log ORDER BY id ASC LIMIT ?", (limit,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/log", methods=["POST"])
def add_log():
    e = request.json or {}
    with db() as c:
        c.execute(
            "INSERT INTO log (date, type, entry) VALUES (?, ?, ?)",
            (e["date"], e["type"], e["entry"]),
        )
    # Append to wiki/log.md as well so it's @-referenceable
    log_path = WIKI_DIR / "log.md"
    with log_path.open("a", encoding="utf-8") as f:
        ts    = e["date"].replace("T", " ")[:16]
        label = e["type"].upper()
        f.write(f"\n## [{ts}] {label}\n{e['entry']}\n")

    return jsonify({"ok": True})


# ── /api/reset ────────────────────────────────────────────────────────────────

@app.route("/api/reset", methods=["POST"])
def reset_wiki():
    # Remove all wiki .md files (keep sources)
    for f in WIKI_DIR.glob("*.md"):
        f.unlink()

    with db() as c:
        c.execute("DELETE FROM pages")
        c.execute("DELETE FROM log")
        c.execute("DELETE FROM sqlite_sequence WHERE name='log'")

    return jsonify({"ok": True})


# ── /api/files — browse the wiki directory ────────────────────────────────────

@app.route("/api/files", methods=["GET"])
def list_files():
    """List all .md files so Claude Code users can see what's @-referenceable."""
    wiki_files    = sorted(f.name for f in WIKI_DIR.glob("*.md"))
    source_files  = sorted(f.name for f in SOURCES_DIR.glob("*.md"))
    return jsonify({
        "wiki":    [f"@wiki/{n}"    for n in wiki_files],
        "sources": [f"@sources/{n}" for n in source_files],
    })


# ── /api/export ───────────────────────────────────────────────────────────────

@app.route("/api/export", methods=["GET"])
def export_wiki():
    with db() as c:
        pages = [dict(r) for r in c.execute("SELECT * FROM pages").fetchall()]
        logs  = [dict(r) for r in c.execute("SELECT date, type, entry FROM log ORDER BY id").fetchall()]

    # Include file content in export
    for p in pages:
        p["content"] = read_wiki_page(p["slug"])

    return jsonify({
        "pages":       pages,
        "log":         logs,
        "exported_at": datetime.now().isoformat(),
    })


# ── /api/stats ────────────────────────────────────────────────────────────────

@app.route("/api/stats", methods=["GET"])
def stats():
    with db() as c:
        page_count = c.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
        log_count  = c.execute("SELECT COUNT(*) FROM log").fetchone()[0]

    wiki_files   = len(list(WIKI_DIR.glob("*.md")))
    source_files = len(list(SOURCES_DIR.glob("*.md")))
    db_size_kb   = DB_PATH.stat().st_size // 1024 if DB_PATH.exists() else 0

    return jsonify({
        "pages":        page_count,
        "wiki_files":   wiki_files,
        "source_files": source_files,
        "log_entries":  log_count,
        "db_size_kb":   db_size_kb,
        "wiki_dir":     str(WIKI_DIR),
        "sources_dir":  str(SOURCES_DIR),
    })


# ── static frontend ───────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(str(BASE_DIR), "index.html")


# ── startup ───────────────────────────────────────────────────────────────────

def check_claude_cli() -> bool:
    try:
        r = subprocess.run(["claude", "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


if __name__ == "__main__":
    init_db()

    claude_ok = check_claude_cli()
    api_key   = bool(os.environ.get("ANTHROPIC_API_KEY"))

    print(f"\n  ◈ LLM WIKI SERVER")
    print(f"  ─────────────────────────────────────────")
    print(f"  URL         → http://localhost:{PORT}")
    print(f"  Wiki dir    → {WIKI_DIR}   (@wiki/*.md)")
    print(f"  Sources dir → {SOURCES_DIR}   (@sources/*.md)")
    print(f"  Database    → {DB_PATH}  (metadata only)")
    print(f"  ─────────────────────────────────────────")

    if claude_ok:
        print(f"  AI backend  → claude -p  ✓")
    elif api_key:
        print(f"  AI backend  → ANTHROPIC_API_KEY fallback  ✓")
    else:
        print(f"  AI backend  → ✗  NOT CONFIGURED")
        print(f"                   Install Claude Code:")
        print(f"                   npm install -g @anthropic-ai/claude-code")
        print(f"                   claude login")

    print(f"  ─────────────────────────────────────────")
    print(f"\n  Claude Code tips:")
    print(f"    claude \"@wiki/index.md what topics does this wiki cover?\"")
    print(f"    claude -p \"@wiki/page.md @wiki/other.md compare these\"\n")

    app.run(host="0.0.0.0", port=PORT, debug=False)
