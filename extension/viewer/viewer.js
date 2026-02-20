/**
 * WARREN Viewer - Extension Content Renderer
 *
 * Flow:
 * 1. Parse URL params (site=, tokenId=, containerId=)
 * 2. DNS resolve (API first, on-chain fallback)
 * 3. Load fractal tree content
 * 4. Render based on site type
 */

import { resolve } from "../lib/dns-resolver.js";
import { loadMasterNFTSite, loadAllContainerFiles, detectContentType, SITE_TYPES } from "../lib/site-loader.js";

const params = new URLSearchParams(window.location.search);
const siteName = params.get("site");
const megaName = params.get("mega");
const tokenId = params.get("tokenId");
const containerId = params.get("containerId");
const containerPath = params.get("path");
const source = params.get("source"); // "redirect" if from declarativeNetRequest

async function main() {
  try {
    if (megaName) {
      await loadByMegaName(megaName);
    } else if (siteName && siteName.toLowerCase().endsWith(".mega")) {
      await loadByMegaName(siteName);
    } else if (siteName) {
      await loadBySiteName(siteName);
    } else if (tokenId) {
      await loadByTokenId(parseInt(tokenId));
    } else if (containerId) {
      await loadByContainerId(parseInt(containerId), containerPath);
    } else {
      showError("No site specified. Use omnibox: w <sitename>");
    }
  } catch (err) {
    console.error("[viewer] Fatal error:", err);
    showError(err.message || "Failed to load site");
  }
}

async function loadByMegaName(name) {
  const normalizedName = name.trim().toLowerCase();
  updateUI("siteName", normalizedName);
  updatePhase("Resolving MegaName...");

  const [{ resolveMega }, { CONFIG }] = await Promise.all([
    import("../lib/meganames-resolver.js"),
    import("../lib/config.js"),
  ]);

  const megaResult = await resolveMega(normalizedName);
  if (!megaResult) {
    showError(`MegaName not found: ${normalizedName}`);
    return;
  }

  if (megaResult.exists && !megaResult.isWarren) {
    updatePhase("Loading profile...");
    const { fetchMegaProfile } = await import("../lib/meganames-resolver.js");
    const profile = await fetchMegaProfile(normalizedName);
    showMegaProfile(normalizedName, megaResult.owner, profile);
    return;
  }

  if (!megaResult.isWarren) {
    showError(`MegaName not found: ${normalizedName}`);
    return;
  }

  if (megaResult.isMaster) {
    await loadSite(
      CONFIG.MASTER_NFT_ADDRESS,
      megaResult.warrenTokenId,
      CONFIG.RPC_URL,
      normalizedName
    );
  } else {
    const loaded = await loadByContainerId(megaResult.warrenTokenId, containerPath, {
      recordVisit: false,
    });
    if (!loaded) return;
  }

  chrome.runtime.sendMessage({
    type: "SITE_VISITED",
    value: normalizedName,
    accessType: "mega",
  });
}

async function loadBySiteName(name) {
  updateUI("siteName", `${name}.thewarren.app`);

  // DNS resolve
  updatePhase("Resolving DNS...");
  const dnsResult = await resolve(name);

  if (!dnsResult) {
    showError(`Site not found: ${name}`);
    return;
  }

  if (!dnsResult.isActive) {
    showError(`Site deactivated: ${name}`);
    return;
  }

  // Show source badge
  const badge = document.getElementById("sourceBadge");
  if (badge) {
    badge.textContent = dnsResult.source === "onchain"
      ? "Loaded from blockchain (server down)"
      : "Loaded via gateway";
  }

  if (dnsResult.siteType === "container") {
    showError("Container subdomain loading is not yet supported via WarrenDNS");
    return;
  }

  // MasterNFT site
  await loadSite(
    dnsResult.masterNftAddress,
    dnsResult.tokenId,
    dnsResult.rpcUrl,
    name
  );

  // Record visit
  chrome.runtime.sendMessage({
    type: "SITE_VISITED",
    value: name,
    accessType: "dns",
  });
}

async function loadByTokenId(id) {
  updateUI("siteName", `Site #${id}`);

  // Use config defaults — no DNS needed
  const { CONFIG } = await import("../lib/config.js");

  if (!CONFIG.MASTER_NFT_ADDRESS) {
    showError("MasterNFT address not configured in extension");
    return;
  }

  await loadSite(CONFIG.MASTER_NFT_ADDRESS, id, CONFIG.RPC_URL, `#${id}`);

  chrome.runtime.sendMessage({
    type: "SITE_VISITED",
    value: id.toString(),
    accessType: "site",
  });
}

async function loadByContainerId(id, path, options = {}) {
  const { recordVisit = true } = options;
  const displayName = path ? `Container #${id} - ${path}` : `Container #${id}`;
  updateUI("siteName", displayName);

  const { CONFIG } = await import("../lib/config.js");

  if (!CONFIG.WARREN_CONTAINER_ADDRESS) {
    showError("WarrenContainer address not configured");
    return false;
  }

  updatePhase("Loading all container files...");

  const { files, siteData } = await loadAllContainerFiles(
    CONFIG.WARREN_CONTAINER_ADDRESS,
    id,
    CONFIG.RPC_URL,
    onProgress
  );

  // Determine which file to render
  let targetPath = path;
  if (!targetPath) {
    targetPath = siteData.siteType === 2 ? "/collection.json" : "/index.html";
  }
  if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

  const targetFile = files.get(targetPath);
  if (!targetFile) {
    showError(`File not found: ${targetPath}`);
    return false;
  }

  renderContainerContent(targetFile.data, targetFile.mimeType, targetPath, displayName, id, files);

  if (recordVisit) {
    chrome.runtime.sendMessage({
      type: "SITE_VISITED",
      value: id.toString(),
      accessType: "container",
    });
  }

  return true;
}

async function loadSite(registryAddress, tokenId, rpcUrl, displayName) {
  updatePhase("Loading from blockchain...");

  const { data, siteType } = await loadMasterNFTSite(
    registryAddress,
    tokenId,
    rpcUrl,
    onProgress
  );

  // Render
  renderContent(data, siteType, displayName);
}

function renderContent(data, siteType, displayName) {
  const loader = document.getElementById("loader-container");
  const content = document.getElementById("content");

  loader.style.display = "none";
  content.style.display = "block";

  // Create header
  const header = document.createElement("div");
  header.className = "warren-header";
  header.innerHTML = `
    <div class="warren-logo">WARREN</div>
    <div class="warren-site-name">${displayName}</div>
    <div class="warren-badge">On-chain</div>
  `;
  content.appendChild(header);

  if (siteType === SITE_TYPES.IMAGE || siteType === 3) {
    const contentType = detectContentType(data);
    const blob = new Blob([data], { type: contentType });
    const img = document.createElement("img");
    img.src = URL.createObjectURL(blob);
    img.alt = displayName;
    content.appendChild(img);
  } else if (siteType === SITE_TYPES.VIDEO || siteType === 4) {
    // Check for header (from video-loader.js fallback logic)
    let videoData = data;
    const isRawMP4 = data.length >= 8 &&
      data[4] === 0x66 && data[5] === 0x74 &&
      data[6] === 0x79 && data[7] === 0x70;

    if (!isRawMP4 && data.length > 4) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const hdrLen = view.getUint32(0);
      if (hdrLen < data.length && hdrLen < 10000) {
        videoData = data.slice(4 + hdrLen);
      }
    }

    const contentType = detectContentType(videoData);
    const blob = new Blob([videoData], { type: contentType });
    const video = document.createElement("video");
    video.src = URL.createObjectURL(blob);
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    content.appendChild(video);
  } else if (siteType === SITE_TYPES.AUDIO || siteType === 5) {
    const contentType = detectContentType(data);
    const blob = new Blob([data], { type: contentType });
    const audio = document.createElement("audio");
    audio.src = URL.createObjectURL(blob);
    audio.controls = true;
    audio.autoplay = true;
    content.appendChild(audio);
  } else {
    // HTML / default
    const html = new TextDecoder("utf-8").decode(data);

    // Use sandbox page to bypass extension CSP.
    // Sandbox pages allow unsafe-inline/unsafe-eval, and the inner
    // iframe with blob URL has no CSP restrictions at all.
    const sandbox = document.createElement("iframe");
    sandbox.src = chrome.runtime.getURL("viewer/sandbox.html");
    sandbox.style.cssText = "width:100%;height:calc(100vh - 40px);border:none;";
    content.appendChild(sandbox);

    sandbox.addEventListener("load", () => {
      sandbox.contentWindow.postMessage({ type: "RENDER_HTML", html }, "*");
    });
  }

  document.title = `${displayName} - WARREN`;
}

function renderContainerContent(data, mimeType, filePath, displayName, containerId, files) {
  const loader = document.getElementById("loader-container");
  const content = document.getElementById("content");

  loader.style.display = "none";
  content.style.display = "block";

  const header = document.createElement("div");
  header.className = "warren-header";
  header.innerHTML = `
    <div class="warren-logo">WARREN</div>
    <div class="warren-site-name">${displayName}</div>
    <div class="warren-badge">Container</div>
  `;
  content.appendChild(header);

  if (mimeType.startsWith("image/")) {
    const blob = new Blob([data], { type: mimeType });
    const img = document.createElement("img");
    img.src = URL.createObjectURL(blob);
    img.alt = filePath;
    content.appendChild(img);
  } else if (mimeType.startsWith("video/")) {
    const blob = new Blob([data], { type: mimeType });
    const video = document.createElement("video");
    video.src = URL.createObjectURL(blob);
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    content.appendChild(video);
  } else if (mimeType.startsWith("audio/")) {
    const blob = new Blob([data], { type: mimeType });
    const audio = document.createElement("audio");
    audio.src = URL.createObjectURL(blob);
    audio.controls = true;
    audio.autoplay = true;
    content.appendChild(audio);
  } else if (mimeType === "text/html") {
    let html = new TextDecoder("utf-8").decode(data);

    // Inline CSS files from container
    if (files) {
      html = html.replace(/<link\s+[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, (match, href) => {
        // Normalize: ./css/style.css → /css/style.css, css/style.css → /css/style.css
        let cssPath = href.replace(/^\.\//, "");
        if (!cssPath.startsWith("/")) cssPath = "/" + cssPath;
        const cssFile = files.get(cssPath);
        if (cssFile) {
          const cssText = new TextDecoder("utf-8").decode(cssFile.data);
          return `<style>/* ${href} */\n${cssText}</style>`;
        }
        return match;
      });

      // Remove any existing <base> tags (server injects them, not needed in sandbox)
      html = html.replace(/<base\s+[^>]*>/gi, "");
    }

    // Build serializable files map for sandbox (path → {arrayBuffer, mimeType})
    const filesForSandbox = {};
    if (files) {
      for (const [path, file] of files) {
        filesForSandbox[path] = {
          data: Array.from(file.data), // Uint8Array can't be cloned to sandbox
          mimeType: file.mimeType,
        };
      }
    }

    const sandbox = document.createElement("iframe");
    sandbox.src = chrome.runtime.getURL("viewer/sandbox.html");
    sandbox.style.cssText = "width:100%;height:calc(100vh - 40px);border:none;";
    content.appendChild(sandbox);

    sandbox.addEventListener("load", () => {
      sandbox.contentWindow.postMessage({
        type: "RENDER_HTML",
        html,
        containerId,
        files: filesForSandbox,
      }, "*");
    });
  } else if (mimeType === "application/json") {
    const text = new TextDecoder("utf-8").decode(data);
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:16px;color:#0f0;background:#111;overflow:auto;max-height:calc(100vh - 60px);";
    try {
      pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      pre.textContent = text;
    }
    content.appendChild(pre);
  } else {
    const text = new TextDecoder("utf-8").decode(data);
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:16px;color:#ccc;background:#111;overflow:auto;max-height:calc(100vh - 60px);";
    pre.textContent = text;
    content.appendChild(pre);
  }

  document.title = `${displayName} - WARREN`;
}

function onProgress(progress) {
  if (progress.phase === "scan") {
    updatePhase(
      progress.depth
        ? `Scanning depth ${progress.depth} (${progress.nodes} nodes)`
        : progress.message || "Scanning..."
    );
  } else if (progress.phase === "load") {
    const percent = Math.round((progress.loaded / progress.total) * 100);
    updatePhase(`Loading ${progress.loaded}/${progress.total}`);
    const bar = document.getElementById("progressBar");
    const text = document.getElementById("progressText");
    if (bar) bar.style.width = percent + "%";
    if (text) text.textContent = percent + "%";
  }
}

function updatePhase(text) {
  const el = document.getElementById("phaseText");
  if (el) el.textContent = text;
}

function updateUI(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showError(message) {
  document.getElementById("loader-container").style.display = "none";
  document.getElementById("content").style.display = "none";
  const errorEl = document.getElementById("error-container");
  errorEl.style.display = "flex";
  document.getElementById("errorMessage").textContent = message;
}

function showMegaProfile(name, owner, profile) {
  document.getElementById("loader-container").style.display = "none";
  document.getElementById("content").style.display = "none";
  document.getElementById("error-container").style.display = "none";

  const profileEl = document.getElementById("profile-container");
  profileEl.style.display = "flex";

  document.getElementById("profileName").textContent = name;

  // Owner — prefer profile.owner (from addr() on-chain) over resolveMega result
  const resolvedOwner = profile?.owner || owner;
  const ownerEl = document.getElementById("profileOwner");
  if (resolvedOwner) {
    const shortOwner = resolvedOwner.slice(0, 6) + "..." + resolvedOwner.slice(-4);
    ownerEl.textContent = shortOwner;
    ownerEl.title = resolvedOwner;
    ownerEl.href = `https://megaeth.blockscout.com/address/${resolvedOwner}`;
  } else {
    ownerEl.textContent = "Unknown";
    ownerEl.removeAttribute("title");
    ownerEl.removeAttribute("href");
  }

  // Avatar
  const avatarEl = document.getElementById("profileAvatar");
  if (profile?.avatar) {
    avatarEl.src = profile.avatar;
    avatarEl.style.display = "block";
  }

  // Bio / Description
  const bioEl = document.getElementById("profileBio");
  if (profile?.description) {
    bioEl.textContent = profile.description;
    bioEl.style.display = "block";
  }

  // Expiration
  const expiresEl = document.getElementById("profileExpires");
  if (profile?.expiresAt > 0) {
    const date = new Date(profile.expiresAt * 1000);
    expiresEl.textContent = date.toLocaleDateString();
  }

  // Social links
  const links = [];
  if (profile?.twitter) links.push({ icon: "\ud835\udd4f", url: `https://x.com/${profile.twitter}`, label: profile.twitter });
  if (profile?.github) links.push({ icon: "GH", url: `https://github.com/${profile.github}`, label: profile.github });
  if (profile?.telegram) links.push({ icon: "TG", url: `https://t.me/${profile.telegram}`, label: profile.telegram });
  if (profile?.discord) links.push({ icon: "DC", label: profile.discord });
  if (profile?.url) links.push({ icon: "\ud83d\udd17", url: profile.url, label: profile.url.replace(/^https?:\/\//, "") });

  const linksEl = document.getElementById("profileLinks");
  if (links.length > 0) {
    linksEl.innerHTML = links.map(l =>
      l.url
        ? `<a class="profile-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener"><span class="link-icon">${l.icon}</span>${escapeHtml(l.label)}</a>`
        : `<span class="profile-link"><span class="link-icon">${l.icon}</span>${escapeHtml(l.label)}</span>`
    ).join("");
    linksEl.style.display = "flex";
  }

  document.title = `${name} - WARREN`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Back button (CSP-compliant, no inline onclick)
document.getElementById("backBtn")?.addEventListener("click", () => {
  window.history.back();
});

document.getElementById("profileBackBtn")?.addEventListener("click", () => {
  window.history.back();
});

// Listen for container navigation from sandbox
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "CONTAINER_NAVIGATE") {
    const url = `viewer/viewer.html?containerId=${e.data.containerId}&path=${encodeURIComponent(e.data.path)}`;
    window.location.href = chrome.runtime.getURL(url);
  }
});

main();
