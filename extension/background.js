/**
 * WARREN Extension - Background Service Worker
 *
 * Minimal logic: omnibox handling + visit history.
 * All heavy RPC work is done in viewer page.
 */

const EXT_VIEWER = chrome.runtime.getURL("viewer/viewer.html");

const REDIRECT_RULES = [
  {
    id: 1000,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${EXT_VIEWER}?site=\\1&source=redirect`,
      },
    },
    condition: {
      regexFilter: "^https?://([a-z0-9][a-z0-9-]*[a-z0-9])\\.thewarren\\.app(/.*)?$",
      resourceTypes: ["main_frame"],
      excludedInitiatorDomains: ["thewarren.app"],
    },
  },
  {
    id: 1001,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${EXT_VIEWER}?site=\\1&source=redirect`,
      },
    },
    condition: {
      regexFilter: "^https?://([a-z0-9][a-z0-9-]*[a-z0-9])\\.megawarren\\.xyz(/.*)?$",
      resourceTypes: ["main_frame"],
      excludedInitiatorDomains: ["megawarren.xyz"],
    },
  },
  {
    id: 1002,
    priority: 2,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${EXT_VIEWER}?mega=\\1.mega&source=redirect`,
      },
    },
    condition: {
      regexFilter: "^https?://([a-z0-9][a-z0-9-]*[a-z0-9])\\.mega\\.thewarren\\.app(/.*)?$",
      resourceTypes: ["main_frame"],
      excludedInitiatorDomains: ["thewarren.app"],
    },
  },
];

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: REDIRECT_RULES,
  });
});

// Omnibox: "w mysite" → open viewer
chrome.omnibox.onInputEntered.addListener((text) => {
  const input = text.trim().toLowerCase();

  if (!input) return;

  let url;
  const isNumeric = /^\d+$/.test(input);
  const containerMatch = /^c(\d+)$/i.exec(input);

  if (input.endsWith(".mega")) {
    url = chrome.runtime.getURL(`viewer/viewer.html?mega=${encodeURIComponent(input)}`);
  } else if (containerMatch) {
    url = chrome.runtime.getURL(`viewer/viewer.html?containerId=${containerMatch[1]}`);
  } else if (isNumeric) {
    url = chrome.runtime.getURL(`viewer/viewer.html?tokenId=${input}`);
  } else {
    url = chrome.runtime.getURL(`viewer/viewer.html?site=${input}`);
  }

  chrome.tabs.update({ url });
});

// Omnibox suggestions from visit history
chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const { visitHistory = [] } = await chrome.storage.local.get("visitHistory");

  const suggestions = visitHistory
    .filter((entry) => entry.value.includes(text.toLowerCase()))
    .slice(0, 5)
    .map((entry) => {
      const content = entry.type === "container" ? `c${entry.value}` : entry.value;
      const desc = entry.type === "dns"
        ? `${entry.value}.thewarren.app`
        : entry.type === "mega"
        ? `${entry.value} (MegaName)`
        : entry.type === "container"
        ? `Container #${entry.value}`
        : `#${entry.value} (${entry.type})`;
      return { content, description: desc };
    });

  suggest(suggestions);
});

// Listen for visit events from viewer
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SITE_VISITED") {
    saveToHistory(message.value, message.accessType);
  }
});

async function saveToHistory(value, type) {
  const { visitHistory = [] } = await chrome.storage.local.get("visitHistory");

  const entry = { value, type, timestamp: Date.now() };
  const filtered = visitHistory.filter(
    (h) => !(h.value === value && h.type === type)
  );
  const updated = [entry, ...filtered].slice(0, 50);

  await chrome.storage.local.set({ visitHistory: updated });
}
