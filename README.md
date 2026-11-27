# IssueMatcher — AI-Powered Similar Jira Issue Finder

IssueMatcher helps teams check whether a similar or duplicate Jira ticket already exists before creating a new one. It combines multi-pass Jira JQL retrieval, lexical/keyword scoring, and enterprise LLM semantic assessment in a lightweight Node.js + vanilla HTML/CSS/JS application.

## Features

- **Direct Jira Login (Username & Password or PAT):** Authenticate using Jira Data Center username + password (Basic Auth, default) or switch to a Personal Access Token (Bearer Auth). Credentials stay strictly in local Node.js server memory and are cleared on disconnect or server stop.
- **Scoped Jira Filters:** Dynamically loads **Program/Project** values (`customfield_15309`) and **Issue Types** directly from your Jira instance, plus an **Include resolved issues** toggle.
- **3-Stage Hybrid Search Pipeline:**
  1. **Understanding:** Detects direct Jira ticket keys (e.g. `TMRW-746582`) and enriches natural-language queries with your internal LLM to extract canonical phrasing, core keywords, and technical synonyms.
  2. **Retrieving:** Runs multi-pass JQL searches across summaries, descriptions, comments, components, labels, and linked issues using your own Jira permissions.
  3. **Ranking:** Combines IDF-weighted lexical scoring with AI semantic assessment to produce **Keyword Match**, **AI Relevance**, and **Overall Match** scores, plus **Shared concepts**, **Important differences**, and confidence badges.
- **Zero Build Step & Zero-Dependency Fallback:** Uses plain HTML, CSS, and vanilla JavaScript on the frontend and Node.js built-in HTTP/fetch on the backend (with a built-in `.env` parser fallback if `npm install` cannot be run).

## Project Structure

```text
issueFinder/
├── server.js                  # Lightweight Node.js HTTP server & REST APIs
├── lib/
│   ├── env.js                 # .env loader (uses dotenv or built-in fallback)
│   ├── jira-client.js         # Jira Basic/PAT auth, retry/429 handling, metadata & JQL search
│   ├── ai-client.js           # Enterprise OpenAI-compatible LLM client (/chat/completions)
│   └── similarity-engine.js   # 3-stage Understanding -> Retrieving -> Hybrid AI Ranking engine
├── public/
│   ├── index.html             # Single-page UI (Login + Search + Results + User Guide)
│   ├── styles.css             # Clean responsive stylesheet (no external CDNs)
│   └── app.js                 # Vanilla JS frontend logic
├── .env                       # Local environment config (gitignored — update on office laptop)
├── .env.example               # Template environment configuration
└── package.json
```

## Running on Your Office Laptop

1. **Prerequisites:** Node.js 18 or later.
2. **Configure `.env`:** Open `.env` and fill in your office values:
   - `JIRA_BASE_URL` (e.g., `https://jiraagilep.sg.uobnet.com`)
   - `INTERNAL_LLM_ENABLED=true`
   - `INTERNAL_LLM_BASE_URL`
   - `INTERNAL_LLM_MODEL` (e.g., `llama4`)
   - `INTERNAL_LLM_API_KEY`
   - If your internal Jira/LLM uses a corporate self-signed certificate that Node doesn't trust by default, set `ALLOW_INSECURE_TLS=true`.
3. **(Optional) Install dependencies:**
   ```bash
   npm install
   ```
   *(If corporate proxy blocks npm, you can skip this — `lib/env.js` includes a built-in `.env` loader so `node server.js` still runs directly.)*
4. **Start the server:**
   ```bash
   node server.js
   ```
5. **Open in browser:** Navigate to `http://localhost:3000`.
6. **Sign in:** Enter your Jira username and password (or switch to the PAT tab), then start searching.

## Security Notes

- Credentials are never written to disk, never saved in browser `localStorage`/`cookies`, and never returned by any API endpoint.
- The server binds strictly to `localhost` and sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on all responses.
- Sessions automatically expire after `SESSION_TTL_MINUTES` (default 60 minutes) of inactivity or immediately when clicking **Disconnect**.
