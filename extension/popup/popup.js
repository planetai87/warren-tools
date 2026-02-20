const input = document.getElementById("siteInput");
const goBtn = document.getElementById("goBtn");

goBtn.addEventListener("click", navigate);
input.addEventListener("keypress", (e) => {
  if (e.key === "Enter") navigate();
});

function navigate() {
  const value = input.value.trim();
  if (!value) return;

  const lowerValue = value.toLowerCase();
  const isNumeric = /^\d+$/.test(value);
  const containerMatch = /^c(\d+)$/i.exec(value);
  let url;

  if (lowerValue.endsWith(".mega")) {
    url = `viewer/viewer.html?mega=${encodeURIComponent(lowerValue)}`;
  } else if (containerMatch) {
    url = `viewer/viewer.html?containerId=${containerMatch[1]}`;
  } else if (isNumeric) {
    url = `viewer/viewer.html?tokenId=${value}`;
  } else {
    url = `viewer/viewer.html?site=${lowerValue}`;
  }

  chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  window.close();
}

async function loadHistory() {
  const { visitHistory = [] } = await chrome.storage.local.get("visitHistory");
  const container = document.getElementById("history");

  if (visitHistory.length === 0) {
    container.innerHTML = '<div class="empty">No recent visits</div>';
    return;
  }

  container.innerHTML = '<div class="history-title">Recent</div>';

  const typeLabels = { dns: "DNS", site: "Site", container: "Container", mega: "MegaName" };

  visitHistory.slice(0, 10).forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const displayName =
      entry.type === "dns"
        ? `${entry.value}.thewarren.app`
        : entry.type === "container"
        ? `Container #${entry.value}`
        : entry.type === "mega"
        ? entry.value
        : `#${entry.value}`;

    item.innerHTML = `
      <span class="name">${displayName}</span>
      <span class="type">${typeLabels[entry.type] || entry.type}</span>
    `;

    item.onclick = () => {
      let url;
      if (entry.type === "dns") {
        url = `viewer/viewer.html?site=${entry.value}`;
      } else if (entry.type === "container") {
        url = `viewer/viewer.html?containerId=${entry.value}`;
      } else if (entry.type === "mega") {
        url = `viewer/viewer.html?mega=${encodeURIComponent(entry.value)}`;
      } else {
        url = `viewer/viewer.html?tokenId=${entry.value}`;
      }
      chrome.tabs.create({ url: chrome.runtime.getURL(url) });
      window.close();
    };

    container.appendChild(item);
  });
}

loadHistory();
