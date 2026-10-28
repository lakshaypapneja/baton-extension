# Baton: AI Chat Transfer

Move a conversation between ChatGPT, Claude and Gemini. Export the open chat as a Markdown file, import it into another platform, and keep going. Everything happens in your browser. No servers.

## Use it
1. Open the chat to move. Click **Export** (panel at the bottom right of the page, or the toolbar icon).
2. Open another assistant. Click **Import**, drop the file, click **Insert into chat box**. Press Send yourself.

Other buttons: **Copy** (clipboard), **Full chat / Short version** (word for word, or a compact version for very long chats), optional "what should the AI do next?" note on import.

## The file format
Plain Markdown with a small header so Baton can read it back:

```
---
baton: 1
title: My chat
platform: Claude
url: https://claude.ai/chat/...
exported: 2026-10-24T12:00:00.000Z
messages: 42
mode: full
---

# My chat

### You

First message…

### AI

Reply…
```

- A line inside a message that looks like a turn marker is escaped with a backslash and restored on import.
- `mode: short` files hold the compact version and are inserted as they are.
- Import also reads JSON: the ChatGPT data export (`conversations.json`), Claude-style `chat_messages`, and plain `[{role, content}]` lists.

## What it cannot do
- It reads the chat that is open. It does not export other chats from the sidebar.
- Import places the conversation in the new chat box as context. It does not recreate it in the site's chat history.
- Images and file contents are not carried over; file names are listed.
- These sites change their pages. If export or import stops working on one, the selectors in `content.js` need an update.

## Changelog
- 1.0.2: ChatGPT's 2026 page layout (class-based message markers), "Writing" blocks kept as quotes, class-name detection fallback for any site.
- 1.0.1: sturdier detection, attribute sniffing, "Copy diagnostics".
- 1.0.0: first release.

## If a site stops working
Click **Problem? Copy diagnostics** in the Baton panel. It copies the page's layout (tag names, attribute names, class names; no conversation text) so the site's selectors in `content.js` can be fixed.

## Permissions
`storage` only (two interface preferences). Runs on chatgpt.com, chat.openai.com, claude.ai and gemini.google.com. No network requests.
