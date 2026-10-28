const $ = id => document.getElementById(id);
const hints = {
  full: "Every message, word for word.",
  short: "A compact version: requests, decisions, code, files, where you left off."
};
let mode = "full";

function paint() {
  document.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.m === mode));
  $("hint").textContent = hints[mode];
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(action) {
  const tab = await activeTab();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "BATON_ACTION", action, mode });
    if (res?.ok) { window.close(); return; }
  } catch {}
  $("status").textContent = "Couldn't reach the chat page. Open ChatGPT, Claude or Gemini in this tab and try again.";
}

async function init() {
  try {
    const d = await chrome.storage.local.get("batonMode");
    mode = d.batonMode === "short" ? "short" : "full";
  } catch {}
  paint();

  let ok = false;
  try {
    const tab = await activeTab();
    ok = !!(await chrome.tabs.sendMessage(tab.id, { type: "BATON_PING" }))?.ok;
  } catch {}
  $("notice").classList.toggle("hidden", ok);
  ["export", "copy", "import"].forEach(id => { $(id).disabled = !ok; });
}

document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", async () => {
  mode = b.dataset.m;
  paint();
  try { await chrome.storage.local.set({ batonMode: mode }); } catch {}
}));
$("export").addEventListener("click", () => send("export"));
$("copy").addEventListener("click", () => send("copy"));
$("import").addEventListener("click", () => send("import"));
init();
