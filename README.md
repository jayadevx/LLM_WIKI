# LLM Wiki

A file-based wiki application powered by Claude AI, designed for knowledge management and documentation with AI-assisted content creation and exploration.

## Overview

LLM Wiki is a lightweight, file-based wiki system that combines the simplicity of markdown files with the power of AI. It uses Claude Code for AI-powered features, allowing you to create, edit, and explore wiki content with natural language commands.

## Features

- **File-Based Storage**: Wiki pages and sources stored as markdown files
- **AI Integration**: Powered by Claude Code for intelligent content assistance
- **SQLite Metadata**: Fast searching and organization using SQLite for metadata only
- **Real-Time Updates**: React-based frontend for smooth user experience
- **RESTful API**: Flask backend with clean API endpoints
- **No API Keys Required**: Uses Claude Code authentication

## Technology Stack

- **Backend**: Python 3, Flask
- **Frontend**: React (JSX)
- **Database**: SQLite (metadata only)
- **AI**: Claude Code CLI
- **Storage**: Markdown files

## Prerequisites

- Python 3.7+
- Node.js (for Claude Code)
- Claude Code CLI

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/jayadevx/LLM_WIKI.git
   cd LLM_WIKI
   ```

2. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Install and configure Claude Code**
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```

## Usage

1. **Start the server**
   ```bash
   python server.py
   ```
   The server will start on `http://localhost:5001` by default.

2. **Open in browser**
   Navigate to `http://localhost:5001` to access the wiki interface.

3. **Using Claude Code with your wiki**
   ```bash
   # Explain concepts in a wiki page
   claude "@wiki/machine-learning.md explain the key concepts"

   # Compare multiple pages
   claude "@wiki/index.md @wiki/neural-networks.md compare these"

   # Summarize a source document
   claude --print "@sources/paper.md summarize this paper"
   ```

## Project Structure

```
LLM_WIKI/
├── server.py           # Flask backend server
├── llm-wiki.jsx        # React frontend
├── index.html          # Entry point
├── requirements.txt    # Python dependencies
├── llm_wiki.db         # SQLite database (metadata)
├── wiki/              # Wiki pages (*.md)
└── sources/           # Source documents (*.md)
```

## Configuration

You can customize the application using environment variables:

- `WIKI_DIR`: Directory for wiki pages (default: `wiki`)
- `SOURCES_DIR`: Directory for source documents (default: `sources`)
- `DB_PATH`: Path to SQLite database (default: `llm_wiki.db`)
- `PORT`: Server port (default: `5001`)

Example:
```bash
export PORT=8080
export WIKI_DIR=my_wiki
python server.py
```

## API Endpoints

The Flask server provides RESTful endpoints for:

- `GET /api/pages` - List all wiki pages
- `GET /api/page/<slug>` - Get a specific page
- `POST /api/page/<slug>` - Create/update a page
- `DELETE /api/page/<slug>` - Delete a page
- `GET /api/log` - View activity log

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License - feel free to use this project for your own purposes.

## Acknowledgments

Built with [Claude Code](https://claude.com/claude-code) by Anthropic.
