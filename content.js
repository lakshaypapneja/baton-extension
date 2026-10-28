(() => {
  if (window.__batonLoaded) return;
  window.__batonLoaded = true;

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function findComposer() {
    const selectors = [
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="ask" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ];

    const candidates = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => {
        if (isVisible(el) && !el.disabled && !el.readOnly) {
          candidates.push(el);
        }
      });
      if (candidates.length) break;
    }

    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });

    return candidates[0] || null;
  }

  function setTextareaValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (setter) setter.call(element, value);
    else element.value = value;

    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditableValue(element, value) {
    element.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);

    let usedCommand = false;

    try {
      usedCommand = document.execCommand("insertText", false, value);
    } catch {}

    if (!usedCommand) {
      element.textContent = value;
    }

    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
  }

  function injectContext(text) {
    const composer = findComposer();

    if (!composer) {
      return { ok: false, reason: "composer_not_found" };
    }

    composer.focus();

    if (
      composer instanceof HTMLTextAreaElement ||
      composer instanceof HTMLInputElement
    ) {
      setTextareaValue(composer, text);
    } else {
      setContentEditableValue(composer, text);
    }

    return { ok: true };
  }

  // ---------- HTML -> Markdown (keeps code, lists, tables, bold, links) ----------
  const SKIP_TAGS = new Set(["SCRIPT","STYLE","BUTTON","SVG","NOSCRIPT","TEMPLATE","IFRAME","INPUT","TEXTAREA","SELECT"]);
  const BLOCK_TAGS = new Set(["DIV","SECTION","ARTICLE","MAIN","HEADER","FOOTER","ASIDE","FIGURE","DETAILS","SUMMARY"]);

  function keepsWhitespace(node) {
    try {
      const ws = node.parentElement && getComputedStyle(node.parentElement).whiteSpace;
      return !!ws && ws.startsWith("pre");
    } catch { return false; }
  }

  function walk(node) {
    if (node.nodeType === 3) {
      const text = node.textContent;
      return keepsWhitespace(node) ? text : text.replace(/\s+/g, " ");
    }
    if (node.nodeType !== 1) return "";

    const tag = node.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return "";
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.classList.contains("sr-only")) return "";

    const kids = () => [...node.childNodes].map(walk).join("");

    if (node.getAttribute("data-testid") === "chatgpt-writing-block") {
      const t = kids().replace(/^\s*Writing\s*/, "").replace(/\n{3,}/g, "\n\n").trim();
      return t ? `\n\n${t.split("\n").map(l => `> ${l}`).join("\n")}\n\n` : "";
    }

    switch (tag) {
      case "BR": return "\n";
      case "HR": return "\n\n---\n\n";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
        const text = kids().trim();
        return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
      }
      case "P": {
        const text = kids().trim();
        return text ? `\n\n${text}\n\n` : "";
      }
      case "STRONG": case "B": {
        const t = kids();
        return t.trim() ? `**${t.trim()}**` : t;
      }
      case "EM": case "I": {
        const t = kids();
        return t.trim() ? `*${t.trim()}*` : t;
      }
      case "CODE": {
        const t = node.textContent;
        return t.trim() ? `\`${t}\`` : "";
      }
      case "PRE": {
        const code = node.querySelector("code");
        const text = (code || node).textContent.replace(/\n$/, "");
        const lang = ((code?.className || "").match(/language-([\w+#.-]+)/) || [])[1] || "";
        return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
      }
      case "A": {
        const t = kids().trim();
        const href = node.getAttribute("href") || "";
        if (!t) return "";
        if (!/^https?:/i.test(href) || t === href) return t;
        return `[${t}](${href})`;
      }
      case "IMG": {
        const alt = (node.getAttribute("alt") || "").trim();
        let big = true;
        try {
          const r = node.getBoundingClientRect();
          big = r.width >= 60 && r.height >= 60;
        } catch {}
        if (!big || /^data:image\/svg/.test(node.getAttribute("src") || "")) return "";
        return alt && alt.length < 120 ? `[image attached: ${alt}]` : "[image attached]";
      }
      case "UL": case "OL": {
        const ordered = tag === "OL";
        let n = parseInt(node.getAttribute("start") || "1", 10) || 1;
        const lines = [];
        for (const li of node.children) {
          if (li.tagName.toUpperCase() !== "LI") continue;
          const inner = walk(li).trim().replace(/\n{2,}/g, "\n");
          if (!inner) continue;
          const marker = ordered ? `${n++}.` : "-";
          lines.push(`${marker} ${inner.replace(/\n/g, "\n" + " ".repeat(marker.length + 1))}`);
        }
        return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
      }
      case "BLOCKQUOTE": {
        const t = kids().trim();
        return t ? `\n\n${t.split("\n").map(l => `> ${l}`).join("\n")}\n\n` : "";
      }
      case "TABLE": {
        const rows = [...node.querySelectorAll("tr")].map(tr =>
          [...tr.children].map(cell =>
            walk(cell).replace(/\s*\n+\s*/g, " ").trim().replace(/\|/g, "\\|")
          )
        ).filter(r => r.length);
        if (!rows.length) return "";
        const width = Math.max(...rows.map(r => r.length));
        const pad = r => r.concat(Array(width - r.length).fill(""));
        const line = r => `| ${pad(r).join(" | ")} |`;
        const out = [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)];
        return `\n\n${out.join("\n")}\n\n`;
      }
      default:
        return BLOCK_TAGS.has(tag) ? `\n${kids()}\n` : kids();
    }
  }

  function toMarkdown(root) {
    return walk(root)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+\n/g, "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- Who said what ----------
  const YOU = "You";
  const AI = "AI";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wordsOf = t => (String(t).match(/\S+/g) || []).length;

  const ADAPTERS = [
    {
      test: h => /chatgpt\.com|openai\.com/.test(h),
      collect: () => {
        let els = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')];
        if (els.length) return els.map(el => ({ el, role: el.getAttribute("data-message-author-role") === "user" ? YOU : AI }));
        els = [...document.querySelectorAll('[data-turn="user"], [data-turn="assistant"]')];
        if (els.length) return els.map(el => ({ el, role: el.getAttribute("data-turn") === "user" ? YOU : AI }));
        // 2026 layout: your messages are "bg-user-message" bubbles; replies are "DilResponseRoot" / "MarkdownRoot" blocks.
        els = [...document.querySelectorAll('[class*="bg-user-message"], [class*="DilResponseRoot"], [class*="MarkdownRoot"]')];
        return els.map(el => ({ el, role: String(el.className).includes("bg-user-message") ? YOU : AI }));
      }
    },
    {
      test: h => /claude\.ai/.test(h),
      collect: () => {
        const users = '[data-testid="user-message"]';
        const ais = '.font-claude-response, .font-claude-message, [data-testid="assistant-message"]';
        let els = [...document.querySelectorAll(`${users}, ${ais}`)];
        if (!els.length) els = [...document.querySelectorAll(`${users}, [data-is-streaming]`)];
        return els.map(el => ({ el, role: el.matches(users) ? YOU : AI }));
      }
    },
    {
      test: h => /gemini\.google\.com/.test(h),
      collect: () => {
        let els = [...document.querySelectorAll("user-query, model-response")];
        if (els.length) return els.map(el => ({ el, role: el.tagName.toLowerCase() === "user-query" ? YOU : AI }));
        els = [...document.querySelectorAll(".user-query-container, .query-text, .model-response-text, message-content")];
        return els.map(el => ({ el, role: el.matches(".user-query-container, .query-text") ? YOU : AI }));
      }
    }
  ];

  // If the site's markup is not what we expect, look for messages by how they are labelled
  // (attribute values and tag names such as "user-message" or "model-response").
  const SNIFF_ATTRS = ["data-testid", "data-test-id", "data-role", "data-author", "data-sender", "data-turn", "data-message-author-role", "data-message-role", "data-from"];
  const USER_TOK = /(^|[^a-z])(user|human|you|query|prompt|request)([^a-z]|$)/i;
  const AI_TOK = /(^|[^a-z])(assistant|model|bot|ai|response|answer|reply|claude|gemini|chatgpt)([^a-z]|$)/i;
  const NOISE = /(menu|select|picker|dropdown|button|btn|avatar|icon|profile|label|header|nav|sidebar|input|composer|toolbar|tooltip|badge|chip|suggest|banner|modal|dialog|footer|title|name|setting|feedback|action|copy|share|edit|retry|thumb|upload|attach|mode|upgrade|plan|search)/i;

  const CLASS_USER = /^(?:bg|text|border)-user(?:-message|-bubble)?$|^user-(?:message|bubble|turn|query)[\w-]*$|^human-(?:message|turn)$/i;
  const CLASS_AI = /^(?:[\w-]*MarkdownRoot[\w-]*|[\w-]*ResponseRoot[\w-]*|assistant-(?:message|turn)[\w-]*|agent-(?:message|turn)[\w-]*|model-response[\w-]*|bot-(?:message|turn)[\w-]*)$/i;

  // Same idea, using class names. Tailwind variants like "group-hover/user-message:..." are skipped.
  function sniffByClass() {
    const items = [];
    for (const el of document.querySelectorAll("[class]")) {
      const cn = typeof el.className === "string" ? el.className : "";
      if (!cn) continue;
      let role = null;
      for (const tok of cn.split(/\s+/)) {
        if (!tok || /[:\/\[\(]/.test(tok)) continue;
        if (CLASS_USER.test(tok)) { role = YOU; break; }
        if (CLASS_AI.test(tok)) { role = AI; break; }
      }
      if (!role || !isVisible(el) || (el.textContent || "").trim().length < 2) continue;
      items.push({ el, role });
    }
    const kept = dropNested(items);
    const roles = new Set(kept.map(i => i.role));
    return kept.length >= 2 && roles.size === 2 ? kept : [];
  }

  function sniffMessages() {
    const sel = SNIFF_ATTRS.map(a => `[${a}]`).join(",") + ",user-query,model-response,user-message,assistant-message,human-message,ai-message";
    const items = [];
    for (const el of document.querySelectorAll(sel)) {
      const sig = SNIFF_ATTRS.map(a => el.getAttribute(a) || "").join(" ") + " " + el.tagName.toLowerCase();
      if (NOISE.test(sig)) continue;
      const u = USER_TOK.test(sig);
      const a = AI_TOK.test(sig);
      if (u === a) continue;
      if (!isVisible(el)) continue;
      if ((el.textContent || "").trim().length < 2) continue;
      items.push({ el, role: u ? YOU : AI });
    }
    const kept = dropNested(items);
    const roles = new Set(kept.map(i => i.role));
    return kept.length >= 2 && roles.size === 2 ? kept : [];
  }

  function dropNested(items) {
    const els = new Set(items.map(i => i.el));
    return items.filter(i => {
      let p = i.el.parentElement;
      while (p) {
        if (els.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  function cleanText(role, text) {
    return text.replace(/^(You said|Gemini said)\s*:?\s*\n?/i, "").trim();
  }

  // ---------- Clutter and file cards ----------
  const CLUTTER = [
    /^Ran (a|an|\d+) (command|commands|tool|tools)\b.*$/i,
    /^Used \d+ tools?\b.*$/i,
    /^Searched (the web|\d+ (sites?|pages?|sources?)).*$/i,
    /^Thought for .*$/i,
    /^Thinking\.*$/i,
    /^Show (thinking|more|less)$/i,
    /^(Copy|Retry|Regenerate|Edit|Share|Read aloud|Good response|Bad response)$/i,
    /^(Updated|Saved) memory.*$/i,
    /^Memory (updated|saved).*$/i,
    /^Created \d+ files?.*$/i,
    /^(Presented|Shared) files?$/i
  ];
  const FILE_TYPE = /^(ZIP|PDF|DOCX?|XLSX?|PPTX?|PNG|JPE?G|GIF|MD|TXT|CSV|JSON|HTML|PY|JS)$/;

  function cleanClutter(text) {
    const lines = text.split("\n");
    const out = [];
    let inCode = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) { inCode = !inCode; out.push(line); continue; }
      if (inCode) { out.push(line); continue; }

      const t = line.trim();
      if (t && CLUTTER.some(re => re.test(t))) continue;

      // File card: a short name line, maybe a blank line, then a bare type like ZIP.
      // Kept as a marker so the file is still known to the next AI.
      if (FILE_TYPE.test(t)) {
        let k = out.length - 1;
        while (k >= 0 && out[k].trim() === "") k--;
        const prev = k >= 0 ? out[k].trim() : "";
        if (prev && prev.length < 80 && !/[.!?:]$/.test(prev) && !/^\[file:/.test(prev)) {
          out.length = k;
          out.push(`[file: ${prev} (${t})]`);
        }
        continue;
      }
      out.push(line);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function titleFrom(text, max = 60) {
    let t = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[(file|image)[^\]]*\]/g, " ")
      .replace(/[#*_`>\[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    t = t.replace(/^((yes|yeah|yep|ok|okay|sure|hi|hey|hello|please|so|well)\b[,.!\s]*)+/i, "") || t;
    if (t.length <= max) return t;
    const cut = t.slice(0, max).replace(/\s+\S*$/, "");
    return (cut || t.slice(0, max)) + "…";
  }

  // The chat's own name, as the site shows it.
  const GENERIC_TITLE = /^(claude|chatgpt|gemini|google gemini|perplexity|grok|copilot|microsoft copilot|new chat|new conversation|untitled)$/i;
  function chatTitle(messages) {
    let t = (document.title || "").replace(/\s+/g, " ").trim();
    t = t
      .replace(/\s*[-|\u2013\u2014\u00b7]\s*(Claude|ChatGPT|Gemini|Google Gemini|Perplexity|Grok|Copilot|Microsoft Copilot)\s*$/i, "")
      .replace(/^(Claude|ChatGPT|Gemini|Google Gemini|Perplexity|Grok|Copilot)\s*[-|\u2013\u2014:\u00b7]\s*/i, "")
      .trim();
    if (!t || GENERIC_TITLE.test(t)) {
      const u = messages.find(m => m.role === YOU && m.text.length >= 12) ||
        messages.find(m => m.role === YOU) || messages[0];
      t = u ? titleFrom(u.text, 60) : "Captured chat";
    }
    return t.length > 90 ? titleFrom(t, 90) : t;
  }

  // Best effort: the model picker text, if the site shows one.
  function modelName() {
    const sels = ['[data-testid="model-switcher-dropdown-button"]', '[data-testid="model-selector-dropdown"]'];
    for (const s of sels) {
      const t = document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim();
      if (t && t.length <= 40) return t;
    }
    return "";
  }

  // ---------- Text helpers for the digest ----------
  function splitBlocks(text) {
    const blocks = [];
    let cur = [];
    let inCode = false;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        if (!inCode) {
          if (cur.length) { blocks.push(cur.join("\n")); cur = []; }
          inCode = true;
          cur.push(line);
        } else {
          cur.push(line);
          blocks.push(cur.join("\n"));
          cur = [];
          inCode = false;
        }
        continue;
      }
      if (inCode) { cur.push(line); continue; }
      if (line.trim() === "") {
        if (cur.length) { blocks.push(cur.join("\n")); cur = []; }
        continue;
      }
      cur.push(line);
    }
    if (cur.length) blocks.push(cur.join("\n"));
    return blocks;
  }

  function capCode(block, maxLines = 40) {
    const lines = block.split("\n");
    if (lines.length <= maxLines + 2) return block;
    return lines.slice(0, maxLines + 1).join("\n") +
      `\n… (${lines.length - maxLines - 2} more lines trimmed)\n\`\`\``;
  }

  const KEY_RE = /\b(decid|chose|choose|going with|go with|we'll|we will|must|need to|needs to|require|constraint|deadline|don't|do not|never|always|next step|todo|to-do|final|recommend|because|important)/i;

  function condenseAI(text) {
    const keep = [];
    let omitted = 0;
    let prose = 0;
    splitBlocks(text).forEach((b, i) => {
      if (/^\s*```/.test(b)) { keep.push(capCode(b, 30)); return; }
      const important = i === 0 || /^#{1,6}\s/.test(b) || /https?:\/\//.test(b) || KEY_RE.test(b);
      if (important && prose < 900) {
        const short = b.length > 500 ? b.slice(0, 500).replace(/\s+\S*$/, "") + " …" : b;
        keep.push(short);
        prose += short.length;
      } else {
        omitted++;
      }
    });
    if (omitted) keep.push(`*[${omitted} paragraph${omitted > 1 ? "s" : ""} trimmed]*`);
    return keep.join("\n\n");
  }

  function limitBlocks(text, maxWords) {
    const out = [];
    let w = 0;
    for (const b of splitBlocks(text)) {
      const bw = wordsOf(b);
      if (out.length && w + bw > maxWords) break;
      if (!out.length && bw > maxWords) {
        if (/^\s*```/.test(b)) { out.push(capCode(b, 15)); }
        else out.push(b.split(/\s+/).slice(0, maxWords).join(" ") + " …");
        break;
      }
      out.push(b);
      w += bw;
    }
    return out.join("\n\n");
  }

  function plain(text) {
    return text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[(file|image)[^\]]*\]/g, " ")
      .replace(/[*_`>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function brief(text, max) {
    const p = plain(text);
    if (p.length <= max) return p;
    return p.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }

  function sentencesOf(text) {
    return plain(text.replace(/\n+/g, ". "))
      .split(/(?<=[.!?])\s+/)
      .map(s => s.replace(/^[-•\d.)\s]+/, "").trim())
      .filter(s => s.length >= 25 && s.length <= 260);
  }

  const ACK_RE = /^(ok(ay)?|thanks?( you)?|thx|yes|yep|yeah|sure|continue|go on|go ahead|do it|cool|nice|great|perfect|good|lgtm)[.! ]*$/i;
  const USER_RE = /\b(want|need|must|should|don't|do not|never|always|only|make sure|prefer|require|deadline|budget|without|instead|has to|have to)\b/i;
  const AI_DECISION_RE = /\b(decid|decision|chose|chosen|going with|we('ll| will) (use|go|keep|build)|final(ly)?|approved|rejected|agreed|settled on)\b/i;

  function pickDecisions(messages, max) {
    const seen = new Set();
    const items = [];
    for (const m of messages) {
      const re = m.role === YOU ? USER_RE : (m.role === AI ? AI_DECISION_RE : USER_RE);
      for (const s of sentencesOf(m.text)) {
        if (!re.test(s)) continue;
        const key = s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(s.length > 220 ? s.slice(0, 220).replace(/\s+\S*$/, "") + "…" : s);
      }
    }
    if (items.length <= max) return items;
    const head = Math.min(4, Math.floor(max / 3));
    return [...items.slice(0, head), ...items.slice(-(max - head))];
  }

  function pickCode(messages, max, maxLines) {
    const all = [];
    messages.forEach((m, mi) => {
      for (const b of splitBlocks(m.text)) {
        if (!/^\s*```/.test(b)) continue;
        const lines = b.split("\n");
        const lang = (lines[0].match(/```\s*([\w+#.-]*)/) || [])[1] || "";
        const body = lines.slice(1, -1).join("\n");
        if (body.trim().split("\n").length < 2 && body.length < 60) continue;
        all.push({ mi, lang, body, head: body.trim().split("\n")[0].slice(0, 60) });
      }
    });
    const latest = new Map();
    all.forEach(b => latest.set(b.lang + "|" + b.head, b));
    return [...latest.values()].sort((a, b) => a.mi - b.mi).slice(-max)
      .map(b => capCode("```" + b.lang + "\n" + b.body + "\n```", maxLines));
  }

  function pickLinks(messages, max) {
    const set = new Set();
    for (const m of messages) {
      const text = m.text.replace(/```[\s\S]*?```/g, " ");
      for (const u of text.match(/https?:\/\/[^\s)\]>"'`]+/g) || []) {
        const clean = u.replace(/[.,;:!?]+$/, "");
        if (/claude\.ai\/chat|chatgpt\.com\/c\//.test(clean)) continue;
        set.add(clean);
      }
    }
    return [...set].slice(0, max);
  }

  // ---------- Files and attachments (names only; contents are not readable from the page) ----------
  const FILE_EXT = "pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|gif|webp|svg|zip|md|txt|json|py|js|ts|tsx|jsx|html|css|ipynb|mp3|mp4|wav|mov|rtf|epub";
  const FILE_RE = new RegExp("(?:^|[\\s(\\[\"'])([A-Za-z0-9][\\w\\-.()]{0,70}\\.(?:" + FILE_EXT + "))(?=$|[\\s)\\]\"',;:!?]|\\.(?:\\s|$))", "gi");

  function findFiles(messages) {
    const cards = { You: new Map(), AI: new Map(), Chat: new Map() };
    const images = { You: 0, AI: 0, Chat: 0 };
    const mentioned = new Map();
    for (const m of messages) {
      const who = m.role === YOU ? "You" : (m.role === AI ? "AI" : "Chat");
      for (const mm of m.text.matchAll(/\[file: (.+?) \(([A-Za-z0-9]+)\)\]/g)) cards[who].set(mm[1], mm[2]);
      images[who] += (m.text.match(/\[image attached[^\]]*\]/g) || []).length;
      const prose = m.text.replace(/```[\s\S]*?```/g, " ").replace(/\[file: .+?\]/g, " ").replace(/\[image[^\]]*\]/g, " ");
      for (const mm of prose.matchAll(FILE_RE)) {
        const n = mm[1].replace(/^[(\[]+|[)\]]+$/g, "");
        mentioned.set(n, (mentioned.get(n) || 0) + 1);
      }
    }
    const known = new Set([...cards.You.keys(), ...cards.AI.keys(), ...cards.Chat.keys()].map(s => s.toLowerCase()));
    const also = [...mentioned.entries()]
      .filter(([n]) => !known.has(n.toLowerCase()))
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
    return { cards, images, also };
  }

  function filesSection(f) {
    const lines = [];
    const fmt = map => [...map.entries()].map(([n, t]) => `${n} (${t})`).join(", ");
    if (f.cards.You.size) lines.push(`- You attached: ${fmt(f.cards.You)}`);
    if (f.cards.AI.size) lines.push(`- AI shared: ${fmt(f.cards.AI)}`);
    if (f.cards.Chat.size) lines.push(`- Files in the chat: ${fmt(f.cards.Chat)}`);
    if (f.images.You) lines.push(`- You attached ${f.images.You} image${f.images.You > 1 ? "s" : ""}`);
    if (f.images.AI) lines.push(`- The AI showed ${f.images.AI} image${f.images.AI > 1 ? "s" : ""}`);
    if (f.images.Chat) lines.push(`- ${f.images.Chat} image${f.images.Chat > 1 ? "s" : ""} in the chat`);
    if (f.also.length) lines.push(`- Also named in the chat: ${f.also.join(", ")}`);
    if (!lines.length) return "";
    lines.push("- Note: only file names are captured. The next AI cannot read these files. Re-upload any it needs.");
    return lines.join("\n");
  }

  // ---------- The shortened packet ----------
  const BUDGET_WORDS = 1000;
  const PLANS = [
    { req: 24, dec: 14, code: 6, codeLines: 40, links: 12, lastWords: 250 },
    { req: 14, dec: 10, code: 4, codeLines: 30, links: 8, lastWords: 160 },
    { req: 8, dec: 6, code: 3, codeLines: 20, links: 5, lastWords: 100 },
    { req: 5, dec: 4, code: 2, codeLines: 12, links: 3, lastWords: 60 }
  ];

  function digestBody(messages, labelled, P) {
    const parts = [];
    const users = messages.filter(m => m.role === YOU);

    if (labelled) {
      const opener = users.find(m => plain(m.text).length >= 8) || users[0];
      if (opener) parts.push(`## What this chat is about\n\n${brief(opener.text, 600)}`);

      let reqs = users
        .filter(m => m !== opener)
        .map(m => brief(m.text, 200))
        .filter(t => t.length >= 8 && !ACK_RE.test(t));
      if (reqs.length) {
        let list;
        if (reqs.length > P.req) {
          const head = reqs.slice(0, 4);
          const tail = reqs.slice(-(P.req - 4));
          const omitted = reqs.length - P.req;
          list = [...head, `*[…${omitted} more request${omitted > 1 ? "s" : ""} in between…]*`, ...tail];
        } else list = reqs;
        let n = 0;
        parts.push("## Your requests, in order\n\n" + list.map(t => /^\*\[/.test(t) ? t : `${++n}. ${t}`).join("\n"));
      }
    } else {
      const first = messages[0];
      if (first) parts.push(`## What this chat is about\n\n${brief(first.text, 600)}`);
    }

    const decisions = pickDecisions(messages, P.dec);
    if (decisions.length) {
      parts.push(`## ${labelled ? "Decisions and constraints" : "Key points"}\n\n` + decisions.map(d => `- ${d}`).join("\n"));
    }

    const code = pickCode(messages, P.code, P.codeLines);
    if (code.length) parts.push("## Code worth keeping\n\n" + code.join("\n\n"));

    const links = pickLinks(messages, P.links);
    if (links.length) parts.push("## Links\n\n" + links.map(l => `- ${l}`).join("\n"));

    const files = filesSection(findFiles(messages));
    if (files) parts.push("## Files and attachments\n\n" + files);

    const last = messages[messages.length - 1];
    const lastUser = [...messages].reverse().find(m => m.role === YOU);
    const lastAI = [...messages].reverse().find(m => m.role === AI);
    const left = [];
    if (labelled) {
      if (lastUser) left.push(`**Your last message:** ${brief(lastUser.text, 700)}`);
      if (lastAI) left.push(`**Last reply (shortened):**\n\n${limitBlocks(condenseAI(lastAI.text), P.lastWords)}`);
    } else if (last) {
      left.push(limitBlocks(condenseAI(last.text), P.lastWords));
    }
    if (left.length) parts.push("## Where we left off\n\n" + left.join("\n\n"));

    return parts.join("\n\n");
  }

  // ---------- Finding messages ----------
  function messageEls() {
    const host = location.hostname;
    for (const adapter of ADAPTERS) {
      if (!adapter.test(host)) continue;
      const items = dropNested(adapter.collect());
      const roles = new Set(items.map(i => i.role));
      // One role only (with more than one message) means half the selectors stopped matching.
      if (items.length === 1 || (items.length > 1 && roles.size === 2)) return { items, labelled: true };
    }

    const sniffed = sniffMessages();
    if (sniffed.length) return { items: sniffed, labelled: true };
    const byClass = sniffByClass();
    if (byClass.length) return { items: byClass, labelled: true };

    const selectors = [
      '[data-message-author-role]',
      '[data-testid*="message" i]',
      '[data-message-id]',
      '[data-role="user"], [data-role="assistant"]',
      '[class*="chat-message" i]',
      '[class*="message-content" i]',
      '[role="log"] [role="listitem"]',
      'main article',
      'main [role="article"]',
      'article'
    ];
    for (const selector of selectors) {
      const items = dropNested([...document.querySelectorAll(selector)]
        .filter(isVisible).map(el => ({ el, role: null })));
      if (items.length >= 2) return { items, labelled: false };
    }

    const root = document.querySelector("main") || document.body;
    const blocks = [...root.querySelectorAll("p, pre, blockquote, li")]
      .filter(isVisible).map(el => ({ el, role: null }));
    return blocks.length ? { items: blocks, labelled: false } : null;
  }

  function convertItems(items, labelled) {
    return items
      .map(i => ({ role: i.role, text: cleanClutter(cleanText(i.role, toMarkdown(i.el))) }))
      .filter(m => m.text && (labelled || m.text.length > 20));
  }

  function keyOf(m) {
    if (m._k) return m._k;
    const t = m.text.replace(/\s+/g, " ").trim();
    m._k = `${m.role || ""}|${t.length}|${t.slice(0, 120)}|${t.slice(-60)}`;
    return m._k;
  }

  function mergeBatch(order, batch) {
    if (!batch.length) return;
    if (!order.length) { order.push(...batch); return; }
    const ok = order.map(keyOf);
    const bk = batch.map(keyOf);
    for (let p = Math.max(0, order.length - bk.length - 60); p < order.length; p++) {
      const len = Math.min(bk.length, order.length - p);
      let match = true;
      for (let j = 0; j < len; j++) if (ok[p + j] !== bk[j]) { match = false; break; }
      if (match) {
        if (order.length - p < bk.length) order.push(...batch.slice(order.length - p));
        return;
      }
    }
    order.push(...batch);
  }

  function scrollParent(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        const oy = getComputedStyle(p).overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && p.scrollHeight > p.clientHeight + 20) return p;
      } catch {}
      p = p.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  let progress = () => {};

  // Loads the WHOLE chat: scrolls up until nothing new appears, then reads it top to bottom
  // (chat pages drop off-screen messages), and puts your scroll position back.
  async function collectFullChat() {
    const first = messageEls();
    if (!first) return null;
    const labelled = first.labelled;
    const sc = scrollParent(first.items[0].el);
    const fromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    let incomplete = false;

    try {
      // Stage 1: load older messages.
      const t1 = Date.now() + 30000;
      let stable = 0, prevH = -1, prevN = -1;
      while (stable < 3) {
        if (Date.now() > t1) { incomplete = true; break; }
        sc.scrollTop = 0;
        await sleep(450);
        const n = messageEls()?.items.length || 0;
        const h = sc.scrollHeight;
        stable = (h === prevH && n === prevN) ? stable + 1 : 0;
        prevH = h; prevN = n;
        progress(`Loading older messages… (${n} found)`);
      }

      // Stage 2: is everything mounted at once, or do we have to read in steps?
      const topSnap = convertItems(messageEls().items, labelled);
      sc.scrollTop = sc.scrollHeight;
      await sleep(400);
      const botSnap = convertItems(messageEls().items, labelled);
      if (topSnap.length && botSnap.length >= topSnap.length &&
          botSnap.some(m => keyOf(m) === keyOf(topSnap[0]))) {
        return { messages: botSnap, labelled, incomplete };
      }

      // Stage 3: read top to bottom and stitch.
      const order = [];
      sc.scrollTop = 0;
      await sleep(350);
      const step = Math.max(200, Math.floor(sc.clientHeight * 0.6));
      const t2 = Date.now() + 45000;
      let lastTop = -1;
      for (;;) {
        mergeBatch(order, convertItems(messageEls()?.items || [], labelled));
        progress(`Reading the chat… ${order.length} messages`);
        const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
        if (atBottom) break;
        if (Date.now() > t2) { incomplete = true; break; }
        if (sc.scrollTop === lastTop) break;
        lastTop = sc.scrollTop;
        sc.scrollTop += step;
        await sleep(280);
      }
      mergeBatch(order, convertItems(messageEls()?.items || [], labelled));
      return { messages: order, labelled, incomplete };
    } finally {
      sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - fromBottom);
    }
  }

  function isStreaming() {
    return !!document.querySelector([
      '[data-testid="stop-button"]',
      '[data-is-streaming="true"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]'
    ].join(","));
  }

  // ======================= BATON =======================

  // ---------- Platform ----------
  function platformName(host = location.hostname) {
    if (/chatgpt\.com|openai\.com/.test(host)) return "ChatGPT";
    if (/claude\.ai/.test(host)) return "Claude";
    if (/gemini\.google\.com/.test(host)) return "Gemini";
    return host;
  }

  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "chat";
  }

  // ---------- The short version of a chat ----------
  function buildDigest(title, messages, meta) {
    let body = "";
    for (const plan of PLANS) {
      body = digestBody(messages, true, plan);
      if (wordsOf(body) <= BUDGET_WORDS) break;
    }
    const src = meta.source || { page: location.href, website: location.hostname, label: "Exported" };
    const extra =
      (meta.model ? `- Model: ${meta.model}\n` : "") +
      `- Original: ${messages.length} messages, about ${meta.rawWords} words\n` +
      `- This version: about ${wordsOf(body)} words (shortened automatically)\n` +
      (meta.incomplete ? "- Note: loading stopped early, so the oldest messages may be missing.\n" : "");
    return `# ${title}\n\n## Source\n- Page: ${src.page}\n- Website: ${src.website}\n- ${src.label}: ${new Date().toISOString()}\n${extra}\n${body}\n`;
  }

  // ---------- Baton Markdown format ----------
  // A small header (so Baton can read the file back), then "### You" / "### AI" turns.
  // Lines in a message that look like a turn marker are escaped with a backslash.
  const FORMAT_VERSION = 1;
  const MARKER_RE = /^\\*### (You|AI)\s*$/;

  function escapeLine(line) { return MARKER_RE.test(line) ? "\\" + line : line; }
  function unescapeLine(line) { return /^\\+### (You|AI)\s*$/.test(line) ? line.slice(1) : line; }

  function frontMatter(obj) {
    const lines = Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}: ${String(v).replace(/\s*\n\s*/g, " ")}`);
    return `---\n${lines.join("\n")}\n---\n`;
  }

  function toBatonMd({ title, platform, url, model, messages, mode, body }) {
    const fm = frontMatter({
      baton: FORMAT_VERSION, title, platform, url, model,
      exported: new Date().toISOString(),
      messages: messages ? messages.length : undefined,
      mode
    });
    if (mode === "short") return `${fm}\n${body}\n`;
    const turns = messages
      .map(m => `### ${m.role}\n\n${m.text.split("\n").map(escapeLine).join("\n")}`)
      .join("\n\n");
    return `${fm}\n# ${title}\n\n${turns}\n`;
  }

  function parseFrontMatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { meta, body: text.slice(m[0].length) };
  }

  function parseBatonMd(input) {
    const text = String(input).replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
    const { meta, body } = parseFrontMatter(text);
    const platform = meta.platform || "";
    const url = meta.url || "";

    if (meta.mode === "short") {
      return { kind: "short", title: meta.title || "Imported chat", platform, url, model: meta.model || "", body: body.trim(), messages: [] };
    }

    let title = meta.title || "";
    const turns = [];
    let cur = null;
    for (const line of body.split("\n")) {
      const h = line.match(/^### (You|AI)\s*$/);
      if (h) { if (cur) turns.push(cur); cur = { role: h[1], lines: [] }; continue; }
      if (!cur) {
        const t = line.match(/^# (.+)$/);
        if (t && !title) title = t[1].replace(/\s*\(full transcript\)\s*$/i, "").trim();
        continue;
      }
      cur.lines.push(unescapeLine(line));
    }
    if (cur) turns.push(cur);

    const messages = turns.map(t => ({ role: t.role, text: t.lines.join("\n").trim() })).filter(m => m.text);
    if (!messages.length) {
      return { kind: "raw", title: title || "Imported text", platform, url, model: "", body: body.trim(), messages: [] };
    }
    return { kind: "chat", title: title || "Imported chat", platform, url, model: meta.model || "", messages };
  }

  // ---------- JSON import (Baton-neutral: generic chat JSON and the ChatGPT / Claude data exports) ----------
  function roleOf(x) {
    const r = String(x?.role || x?.author?.role || x?.sender || (typeof x?.author === "string" ? x.author : "") || x?.from || "").toLowerCase();
    if (/^(user|human|you|me)$/.test(r)) return "You";
    if (/^(assistant|ai|model|claude|chatgpt|gemini|bot)$/.test(r)) return "AI";
    return null;
  }

  function partsText(parts) {
    return parts.map(p => (typeof p === "string" ? p : (p && typeof p.text === "string" ? p.text : ""))).join("\n").trim();
  }

  function textOf(x) {
    const c = x?.content ?? x?.text ?? x?.message ?? x?.parts;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) return partsText(c);
    if (c && typeof c === "object") {
      if (Array.isArray(c.parts)) return partsText(c.parts);
      if (typeof c.text === "string") return c.text.trim();
    }
    return "";
  }

  function toMessages(arr) {
    return arr.map(x => ({ role: roleOf(x), text: textOf(x) })).filter(m => m.role && m.text);
  }

  function oneConversation(c) {
    if (!c || typeof c !== "object") return null;
    const title = c.title || c.name || c.chat_title || "Imported chat";
    if (c.mapping && typeof c.mapping === "object") {
      const chain = [];
      let id = c.current_node;
      let guard = 0;
      while (id && c.mapping[id] && guard++ < 100000) { chain.push(c.mapping[id]); id = c.mapping[id].parent; }
      chain.reverse();
      const messages = toMessages(chain.map(n => n.message).filter(Boolean));
      return messages.length ? { kind: "chat", title, platform: "ChatGPT", url: "", model: "", messages } : null;
    }
    const arr = c.messages || c.chat_messages || c.conversation || c.chat;
    if (Array.isArray(arr)) {
      const messages = toMessages(arr);
      return messages.length ? { kind: "chat", title, platform: c.platform || "", url: c.url || "", model: c.model || "", messages } : null;
    }
    return null;
  }

  function parseJsonChats(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    const out = [];
    if (Array.isArray(data)) {
      const first = data.find(Boolean);
      if (first && typeof first === "object" && (first.mapping || first.messages || first.chat_messages)) {
        for (const c of data) { const one = oneConversation(c); if (one) out.push(one); }
      } else {
        const messages = toMessages(data);
        if (messages.length) out.push({ kind: "chat", title: "Imported chat", platform: "", url: "", model: "", messages });
      }
    } else {
      const one = oneConversation(data);
      if (one) out.push(one);
    }
    return out;
  }

  // Returns a list of importable conversations (usually one).
  function readImport(text, filename = "") {
    const t = String(text || "").trim();
    if (!t) return { items: [], error: "Nothing to import yet." };
    if (/\.json$/i.test(filename) || /^[\[{]/.test(t)) {
      const items = parseJsonChats(t);
      if (items && items.length) return { items };
      if (/\.json$/i.test(filename) || items) return { items: [], error: "Couldn't find a conversation in this JSON file." };
    }
    const one = parseBatonMd(t);
    if (one.kind === "raw" && !one.body) return { items: [], error: "Couldn't read this file." };
    if (one.title === "Imported text" && filename) one.title = filename.replace(/\.[^.]+$/, "");
    return { items: [one] };
  }

  // ---------- What gets inserted into the new chat ----------
  function transcriptOf(messages) {
    return messages.map(m => `### ${m.role}\n\n${m.text}`).join("\n\n");
  }

  function totalWords(item) {
    return item.messages && item.messages.length
      ? item.messages.reduce((n, m) => n + wordsOf(m.text), 0)
      : wordsOf(item.body || "");
  }

  function buildInsertText(item, { shorten = false, task = "" } = {}) {
    let body;
    if (item.kind === "chat") {
      body = shorten
        ? buildDigest(item.title, item.messages, {
            rawWords: totalWords(item),
            model: item.model,
            source: { page: item.url || "(imported file)", website: item.platform || "file", label: "Imported" }
          })
        : transcriptOf(item.messages);
    } else {
      body = item.body;
    }
    const heading = /^#\s/.test(body) ? "" : `# ${item.title}\n\n`;
    const from = item.platform || "another AI assistant";
    const t = task.trim();
    return `You are receiving a conversation that was transferred from ${from}.

IMPORTANT:
- Continue from where the conversation ended. Do not restart or repeat completed work.
- Treat decisions and constraints in it as active unless I change them.
- Files and images mentioned in it are not attached. If you need one, ask me to upload it.
- ${t ? "Start on the task at the end right away." : "Reply with one short line confirming you are caught up, then continue when I send my next message."}

${heading}${body}
${t ? `\n---\n# Your task now\n${t}\n` : ""}
---
END OF TRANSFERRED CONVERSATION
`;
  }

  // ---------- Small helpers ----------
  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  async function getPrefs() {
    try {
      const d = await chrome.storage.local.get(["batonMode", "batonCollapsed"]);
      return { mode: d.batonMode === "short" ? "short" : "full", collapsed: !!d.batonCollapsed };
    } catch { return { mode: "full", collapsed: false }; }
  }

  async function setPref(key, value) {
    try { await chrome.storage.local.set({ [key]: value }); } catch {}
  }

  // ---------- Diagnostics (page structure only, never conversation text) ----------
  function collectDiagnostics() {
    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    const attrs = new Map(), tags = new Map(), classes = new Map();
    const ATTRS = ["data-testid", "data-test-id", "data-role", "data-turn", "data-author", "data-sender", "data-from",
      "data-message-author-role", "data-message-role", "data-is-streaming", "data-message-id", "role"];
    for (const el of document.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes("-")) bump(tags, tag);
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v === null) continue;
        const shown = a === "data-message-id" ? "(id)"
          : v.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "(uuid)").replace(/\d+/g, "N").slice(0, 60);
        bump(attrs, `${a}=${shown}`);
      }
      const cn = typeof el.className === "string" ? el.className : "";
      for (const cls of cn.split(/\s+/)) {
        if (cls && cls.length < 50 && /user|assistant|human|model|response|query|prompt|answer|message|turn|bubble|markdown|prose|chat/i.test(cls)) bump(classes, cls);
      }
    }
    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `  ${k}  x${v}`).join("\n") || "  (none)";

    let adapterLine = "no adapter for this host";
    const ad = ADAPTERS.find(a => a.test(location.hostname));
    if (ad) {
      const got = ad.collect();
      const u = got.filter(g => g.role === YOU).length;
      adapterLine = `${got.length} found (${u} user, ${got.length - u} assistant)`;
    }
    const sn = sniffMessages();
    let version = "?";
    try { version = chrome.runtime.getManifest().version; } catch {}

    return [
      "Baton diagnostics (page structure only. No conversation text is included.)",
      `Baton version: ${version}`,
      `Host: ${location.hostname}`,
      `Site adapter: ${adapterLine}`,
      `Attribute sniffing: ${sn.length} messages`,
      `Class sniffing: ${sniffByClass().length} messages`,
      "",
      "Attributes:", top(attrs, 45),
      "",
      "Custom tags:", top(tags, 30),
      "",
      "Class names (message-related):", top(classes, 45)
    ].join("\n");
  }

  // ---------- Export / copy ----------
  let working = false;
  let ui = null;

  async function runExport(action, modeOverride) {
    if (working) { ui?.status("Already working. Please wait."); return; }
    if (isStreaming()) { ui?.status("The reply is still being written. Wait for it to finish.", true); return; }
    working = true;
    ui?.setBusy(true);
    progress = text => ui?.status(text, false, true);
    try {
      const prefs = await getPrefs();
      const mode = modeOverride || prefs.mode;
      ui?.status("Loading the full chat…", false, true);

      const got = await collectFullChat();
      if (!got || !got.messages.length) {
        ui?.status("Couldn't find a conversation on this page.", true);
        return;
      }
      if (!got.labelled) {
        ui?.status("Baton couldn't read this chat's layout, so nothing was exported. The site may have changed. Click “Copy diagnostics” below and send it to the developer.", true);
        return;
      }

      const messages = got.messages;
      const title = chatTitle(messages);
      const platform = platformName();
      const model = modelName();
      const rawWords = messages.reduce((n, m) => n + wordsOf(m.text), 0);

      const md = mode === "short"
        ? toBatonMd({ title, platform, url: location.href, model, messages, mode: "short",
            body: buildDigest(title, messages, { rawWords, model, incomplete: got.incomplete }) })
        : toBatonMd({ title, platform, url: location.href, model, messages, mode: "full" });

      const n = messages.length;
      const warn = got.incomplete ? " Loading stopped early, so the oldest messages may be missing." : "";
      if (action === "copy") {
        const ok = await copyText(md);
        ui?.status(ok ? `Copied ${n} messages.${warn}` : "Couldn't copy. Use Export instead.", !ok);
      } else {
        downloadText(md, `${slug(platform)}-${slug(title)}-${new Date().toISOString().slice(0, 10)}.md`);
        ui?.status(`Exported ${n} messages as Markdown.${warn}`);
      }
    } catch (e) {
      ui?.status("Something went wrong: " + (e?.message || e), true);
    } finally {
      working = false;
      ui?.setBusy(false);
    }
  }

  // ---------- On-page interface ----------
  const ICON = {
    down: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0l-4 4m4-4l4 4M5 3h14"/></svg>',
    logo: '<svg viewBox="0 0 32 32" width="22" height="22"><rect width="32" height="32" rx="8" fill="#4338ca"/><g transform="rotate(-45 16 16)"><rect x="4.6" y="12.2" width="10.4" height="7.6" rx="3.8" fill="#fbbf24"/><rect x="17" y="12.2" width="10.4" height="7.6" rx="3.8" fill="#fff"/></g></svg>'
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; right: 16px; bottom: 96px; z-index: 2147483646; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; }
    .panel { width: 236px; background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
    .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 700; }
    button { font: inherit; cursor: pointer; }
    .min { border: 0; background: transparent; color: #6b7280; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
    .min:hover { background: #f3f4f6; }
    .btns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .btns button { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 4px; border: 1px solid #e5e7eb; background: #f9fafb; color: #111827; border-radius: 10px; font-size: 12px; font-weight: 600; }
    .btns button:hover:not(:disabled) { background: #eef2ff; border-color: #c7d2fe; }
    button:disabled { opacity: .55; cursor: wait; }
    .seg { display: grid; grid-template-columns: 1fr 1fr; margin-top: 8px; background: #f3f4f6; border-radius: 9px; padding: 2px; }
    .seg button { border: 0; background: transparent; padding: 5px 0; border-radius: 7px; font-size: 12px; color: #4b5563; }
    .seg button.on { background: #fff; color: #111827; font-weight: 700; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .hint { margin-top: 5px; font-size: 11px; color: #6b7280; }
    .link { border: 0; background: none; color: #4f46e5; font-size: 11px; padding: 0; margin-top: 4px; text-decoration: underline; }
    .msg { margin-top: 8px; font-size: 12px; color: #374151; min-height: 0; }
    .msg.err { color: #b91c1c; }
    .msg:empty { display: none; }
    .fab { width: 44px; height: 44px; border-radius: 12px; border: 1px solid #e5e7eb; background: #fff; display: grid; place-items: center; box-shadow: 0 6px 20px rgba(0,0,0,.2); padding: 0; }
    .hidden { display: none !important; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.45); display: grid; place-items: center; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card { width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; background: #fff; color: #111827; border-radius: 16px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h2 { margin: 0 0 6px; font-size: 18px; }
    .sub { margin: 0 0 14px; color: #4b5563; font-size: 13px; }
    .drop { display: grid; gap: 2px; place-items: center; text-align: center; padding: 22px 12px; border: 2px dashed #c7d2fe; background: #f5f7ff; border-radius: 12px; cursor: pointer; }
    .drop.over { background: #e0e7ff; border-color: #6366f1; }
    .drop span { color: #6b7280; font-size: 12px; }
    .or { text-align: center; margin: 12px 0 8px; font-size: 11px; letter-spacing: .08em; color: #9ca3af; }
    textarea, input[type=text], select { width: 100%; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 10px; font: inherit; color: #111827; background: #fff; }
    textarea { height: 96px; resize: vertical; }
    .info { margin: 10px 0 0; font-size: 13px; color: #065f46; min-height: 0; }
    .info.err { color: #b91c1c; }
    .info:empty { display: none; }
    select { margin-top: 10px; }
    .chk { display: flex; gap: 8px; align-items: center; margin: 12px 0 8px; font-size: 13px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
    .actions button { border-radius: 10px; padding: 9px 14px; border: 1px solid #d1d5db; background: #fff; color: #111827; font-weight: 600; }
    .actions .go { background: #4338ca; border-color: #4338ca; color: #fff; }
    .actions .go:disabled { opacity: .45; cursor: not-allowed; }
    @media (prefers-color-scheme: dark) {
      .panel, .card, .fab { background: #1f2937; color: #f3f4f6; border-color: #374151; }
      .btns button { background: #111827; color: #f3f4f6; border-color: #374151; }
      .btns button:hover:not(:disabled) { background: #312e81; border-color: #4f46e5; }
      .seg { background: #111827; } .seg button { color: #9ca3af; } .seg button.on { background: #374151; color: #f9fafb; }
      .min:hover { background: #374151; } .min, .hint, .sub, .drop span { color: #9ca3af; }
      .link { color: #a5b4fc; }
      .msg { color: #d1d5db; } .msg.err, .info.err { color: #fca5a5; } .info { color: #6ee7b7; }
      .drop { background: #111827; border-color: #4f46e5; } .drop.over { background: #1e1b4b; }
      textarea, input[type=text], select { background: #111827; color: #f3f4f6; border-color: #374151; }
      .actions button { background: #111827; color: #f3f4f6; border-color: #374151; }
      .actions .go { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    }
  `;

  function createUI() {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="panel" id="panel">
          <div class="top">
            <span class="brand">${ICON.logo} Baton</span>
            <button class="min" id="min" title="Minimise">–</button>
          </div>
          <div class="btns">
            <button id="exp" title="Download this chat as a Markdown file">${ICON.down}Export</button>
            <button id="cp" title="Copy this chat to the clipboard">${ICON.copy}Copy</button>
            <button id="imp" title="Bring a chat in from a file">${ICON.up}Import</button>
          </div>
          <div class="seg" id="seg">
            <button data-m="full">Full chat</button>
            <button data-m="short">Short version</button>
          </div>
          <div class="hint" id="hint"></div>
          <button class="link" id="diag" title="Copies the page layout (no conversation text) so a problem can be fixed">Problem? Copy diagnostics</button>
          <div class="msg" id="msg"></div>
        </div>
        <button class="fab hidden" id="fab" title="Open Baton">${ICON.logo}</button>
      </div>
      <div class="overlay hidden" id="overlay">
        <div class="card" role="dialog" aria-label="Import a conversation">
          <h2>Import a conversation</h2>
          <p class="sub">Choose a file exported from ChatGPT, Claude or Gemini. Baton puts it in this chat box so you can keep going. It never presses Send for you.</p>
          <div class="drop" id="drop"><b>Drag &amp; drop a .md or .json file here</b><span>or click to choose a file</span>
            <input type="file" id="file" accept=".md,.markdown,.txt,.json,text/markdown,text/plain,application/json" hidden></div>
          <div class="or">OR PASTE TEXT</div>
          <textarea id="paste" placeholder="Paste exported Markdown or JSON here…" spellcheck="false"></textarea>
          <div class="info" id="info"></div>
          <select id="pick" class="hidden"></select>
          <label class="chk" id="shortenRow"><input type="checkbox" id="shorten"> Shorten first (recommended for long chats)</label>
          <input type="text" id="task" placeholder="What should the AI do next? (optional)">
          <div class="actions">
            <button id="cancel">Cancel</button>
            <button id="copyIns">Copy instead</button>
            <button class="go" id="insert" disabled>Insert into chat box</button>
          </div>
        </div>
      </div>`;

    const $ = id => root.getElementById(id);
    let msgTimer = null;
    let items = [];

    const hints = {
      full: "Every message, word for word.",
      short: "A compact version: requests, decisions, code, files, where you left off."
    };

    function applyMode(mode) {
      root.querySelectorAll("#seg button").forEach(b => b.classList.toggle("on", b.dataset.m === mode));
      $("hint").textContent = hints[mode];
    }

    function status(text, isError = false, sticky = false) {
      const el = $("msg");
      el.textContent = text;
      el.classList.toggle("err", !!isError);
      clearTimeout(msgTimer);
      if (!sticky && text) msgTimer = setTimeout(() => { el.textContent = ""; }, 9000);
    }

    function setBusy(b) {
      ["exp", "cp", "imp"].forEach(id => { $(id).disabled = b; });
    }

    function setCollapsed(c) {
      $("panel").classList.toggle("hidden", c);
      $("fab").classList.toggle("hidden", !c);
    }

    // ----- Import dialog -----
    function selected() { return items[Number($("pick").value) || 0]; }

    function refreshInfo() {
      const item = selected();
      const info = $("info");
      info.classList.remove("err");
      if (!item) { $("insert").disabled = true; return; }
      const words = totalWords(item);
      const label = item.kind === "chat"
        ? `${item.platform || "Unknown source"} · ${item.messages.length} messages · about ${words.toLocaleString()} words`
        : item.kind === "short"
          ? `Short version · about ${words.toLocaleString()} words`
          : `Plain text · about ${words.toLocaleString()} words`;
      info.textContent = "✓ " + label;
      const canShorten = item.kind === "chat";
      $("shortenRow").classList.toggle("hidden", !canShorten);
      if (canShorten && words > 12000 && !$("shorten").dataset.touched) $("shorten").checked = true;
      $("insert").disabled = false;
    }

    function loadText(text, filename = "") {
      const res = readImport(text, filename);
      items = res.items;
      const pick = $("pick");
      pick.innerHTML = "";
      if (!items.length) {
        $("info").textContent = res.error || "Couldn't read this.";
        $("info").classList.add("err");
        $("insert").disabled = true;
        pick.classList.add("hidden");
        return;
      }
      items.forEach((it, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `${it.title} (${it.kind === "chat" ? it.messages.length + " messages" : "text"})`;
        pick.appendChild(o);
      });
      pick.classList.toggle("hidden", items.length < 2);
      refreshInfo();
    }

    function openImport() {
      $("overlay").classList.remove("hidden");
      $("paste").focus();
    }

    function closeImport() {
      $("overlay").classList.add("hidden");
    }

    async function readFile(file) {
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) {
        $("info").textContent = "That file is too large (over 15 MB).";
        $("info").classList.add("err");
        return;
      }
      loadText(await file.text(), file.name);
    }

    function currentText() {
      const item = selected();
      if (!item) return "";
      return buildInsertText(item, { shorten: $("shorten").checked && item.kind === "chat", task: $("task").value });
    }

    $("min").addEventListener("click", () => { setCollapsed(true); setPref("batonCollapsed", true); });
    $("fab").addEventListener("click", () => { setCollapsed(false); setPref("batonCollapsed", false); });
    $("exp").addEventListener("click", () => runExport("download"));
    $("cp").addEventListener("click", () => runExport("copy"));
    $("imp").addEventListener("click", openImport);
    $("diag").addEventListener("click", async () => {
      const ok = await copyText(collectDiagnostics());
      status(ok ? "Diagnostics copied. They describe the page layout only, with no conversation text. Paste them to the developer." : "Couldn't copy the diagnostics.", !ok);
    });
    root.querySelectorAll("#seg button").forEach(b => b.addEventListener("click", () => {
      applyMode(b.dataset.m);
      setPref("batonMode", b.dataset.m);
    }));

    const drop = $("drop");
    drop.addEventListener("click", () => $("file").click());
    $("file").addEventListener("change", e => readFile(e.target.files[0]));
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => readFile(e.dataTransfer?.files?.[0]));

    let pasteTimer = null;
    $("paste").addEventListener("input", () => {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        const t = $("paste").value;
        if (t.trim()) loadText(t); else { items = []; $("info").textContent = ""; $("insert").disabled = true; }
      }, 250);
    });
    $("pick").addEventListener("change", refreshInfo);
    $("shorten").addEventListener("change", () => { $("shorten").dataset.touched = "1"; });
    $("cancel").addEventListener("click", closeImport);
    $("overlay").addEventListener("mousedown", e => { if (e.target === $("overlay")) closeImport(); });
    root.addEventListener("keydown", e => { if (e.key === "Escape") closeImport(); });

    $("insert").addEventListener("click", async () => {
      const text = currentText();
      if (!text) return;
      const res = injectContext(text);
      closeImport();
      if (res.ok) {
        status("Placed in the chat box. Review it, then press Send.");
      } else {
        const ok = await copyText(text);
        status(ok ? "Couldn't find the chat box, so it was copied. Paste it in." : "Couldn't insert or copy it.", !ok);
      }
    });

    $("copyIns").addEventListener("click", async () => {
      const text = currentText();
      if (!text) return;
      const ok = await copyText(text);
      closeImport();
      status(ok ? "Copied. Paste it into any chat." : "Couldn't copy.", !ok);
    });

    getPrefs().then(p => { applyMode(p.mode); setCollapsed(p.collapsed); });
    applyMode("full");
    document.documentElement.appendChild(host);
    return { status, setBusy, openImport, root };
  }

  // ---------- Messages from the toolbar popup ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "BATON_PING") { sendResponse({ ok: true, platform: platformName() }); return; }
    if (msg?.type === "BATON_ACTION") {
      if (msg.action === "export") runExport("download", msg.mode);
      else if (msg.action === "copy") runExport("copy", msg.mode);
      else if (msg.action === "import") ui?.openImport();
      sendResponse({ ok: true });
      return;
    }
  });

  ui = createUI();

  if (window.__BATON_TEST__) {
    window.__baton = { parseBatonMd, readImport, buildInsertText, toBatonMd, buildDigest, runExport, escapeLine, unescapeLine, ui, collectFullChat, chatTitle, collectDiagnostics, sniffMessages, sniffByClass, messageEls };
  }
})();
