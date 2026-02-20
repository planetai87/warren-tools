# Warren Extension - Decentralized Web Access for Chrome

A Chrome Extension (Manifest V3) for seamlessly accessing on-chain websites and content stored on [MegaETH](https://megaeth.com) via the [Warren](https://thewarren.app) protocol. Intercepts Warren domain requests and loads content directly from the blockchain -- even when centralized servers are down.

## Overview

Warren stores entire websites, images, videos, and other files permanently on-chain using a fractal tree architecture. This extension bridges the gap between the traditional web and on-chain content by intercepting requests to Warren domains and rendering blockchain-stored content natively in your browser.

When you visit `mysite.thewarren.app`, the extension resolves the site name through Warren DNS (on-chain or via gateway), traverses the fractal tree of smart contracts to collect the stored data chunks, reassembles the content, and renders it in a secure sandboxed environment.

## Features

- **Auto-redirect** for `*.thewarren.app` and `*.megawarren.xyz` domains
- **MegaNames (.mega)** domain resolution with on-chain profile display
- **Warren DNS resolution** with API-first, on-chain fallback strategy
- **Omnibox quick access** -- type `w sitename` in the address bar
- **Popup UI** with search input and visit history
- **Sandboxed HTML rendering** for security isolation
- **Multi-format support** -- HTML, images (PNG/JPEG/GIF/WebP), video (MP4/WebM), audio (MP3/WAV/OGG)
- **Container sites** -- multi-file websites with CSS/JS inlining and internal navigation
- **No external dependencies** -- pure ESM, no build step, no bundler

## Installation

Since this extension is not on the Chrome Web Store, install it in Developer Mode:

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the `extension/` directory.
6. The Warren extension icon will appear in your toolbar.

## How to Use

There are three ways to access on-chain content:

### 1. Auto-Redirect (Recommended)

Simply navigate to any Warren subdomain in your browser:

```
https://mysite.thewarren.app
https://mysite.megawarren.xyz
https://bread.mega.thewarren.app    # MegaName resolution
```

The extension automatically intercepts the request and loads content from the blockchain.

### 2. Omnibox

Type `w` in the Chrome address bar, press `Tab` or `Space`, then enter a query:

```
w mysite          # Warren DNS lookup
w bread.mega      # MegaName resolution
w 42              # Load by MasterNFT token ID
w c5              # Load WarrenContainer #5
```

The omnibox also provides autocomplete suggestions from your visit history.

### 3. Popup UI

Click the Warren extension icon in the toolbar to open the popup. Enter any of the following formats:

| Input | Type | Example |
|-------|------|---------|
| `sitename` | Warren DNS | `mysite` |
| `name.mega` | MegaName | `bread.mega` |
| `123` | MasterNFT token ID | `42` |
| `c123` | Container ID | `c5` |

## Architecture

```
background.js          Service worker: redirect rules, omnibox, visit history
    |
    +-- lib/
    |   +-- config.js              Network and contract configuration
    |   +-- dns-resolver.js        Warren DNS resolution (API + on-chain fallback)
    |   +-- meganames-resolver.js  MegaNames (.mega) resolution and profile fetching
    |   +-- site-loader.js         Fractal tree traversal and content assembly
    |   +-- keccak256.js           Keccak-256 hash (bundled js-sha3, MIT)
    |
    +-- viewer/
    |   +-- viewer.html            Content viewer page (loading UI + rendering)
    |   +-- viewer.js              Viewer logic: resolve -> load -> render
    |   +-- viewer.css             Viewer styles (loader, header, profile, errors)
    |   +-- sandbox.html           Sandboxed iframe for HTML content execution
    |
    +-- popup/
        +-- popup.html             Extension popup UI
        +-- popup.js               Popup logic: search + history
```

### Loading Flow

```
User navigates to site
        |
        v
background.js intercepts via declarativeNetRequest
        |
        v
Redirect to viewer/viewer.html?site=<name>
        |
        v
viewer.js: DNS resolve (API first, on-chain fallback)
        |
        v
site-loader.js: Traverse fractal tree, collect leaf addresses
        |
        v
site-loader.js: Read each leaf chunk via eth_call (Page.read())
        |
        v
viewer.js: Assemble bytes, detect content type, render
        |
        v
HTML -> sandbox.html (isolated iframe)
Image/Video/Audio -> blob URL rendering
```

## File Structure

```
extension/
+-- manifest.json                 Manifest V3 configuration
+-- background.js                 Service worker (redirect rules, omnibox, history)
+-- rules.json                    Declarative net request rules (static)
+-- icons/
|   +-- icon16.png
|   +-- icon48.png
|   +-- icon128.png
+-- lib/
|   +-- config.js                 RPC endpoint, contract addresses, timeouts
|   +-- dns-resolver.js           Resolves site names to token IDs
|   +-- meganames-resolver.js     Resolves .mega names, fetches on-chain profiles
|   +-- site-loader.js            Fractal tree loading + content type detection
|   +-- keccak256.js              Standalone keccak-256 implementation
+-- viewer/
|   +-- viewer.html               Main content viewer page
|   +-- viewer.js                 Viewer orchestration (resolve -> load -> render)
|   +-- viewer.css                All viewer styles
|   +-- sandbox.html              Sandboxed HTML renderer with fetch interception
+-- popup/
    +-- popup.html                Popup UI layout
    +-- popup.js                  Popup search and history logic
```

## Configuration

All configuration is centralized in `lib/config.js`:

```javascript
export const CONFIG = {
  // MegaETH Mainnet
  RPC_URL: "https://mainnet.megaeth.com/rpc",
  CHAIN_ID: 4326,

  // Contract addresses
  DNS_CONTRACT: "0x3f9EaD44f51690b18bd491Fc5A04786121f20D5b",           // WarrenDNS
  MASTER_NFT_ADDRESS: "0xf299F428Efe1907618360F3c6D16dF0F2Bf8ceFC",     // MasterNFT registry
  WARREN_CONTAINER_ADDRESS: "0x65179A9473865b55af0274348d39E87c1D3d5964", // WarrenContainer

  // Multicall3 (universal address)
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",

  // Batch settings
  BATCH_SIZE: 100,

  // Gateway API (for fallback)
  GATEWAY_API: "https://thewarren.app/api/dns/resolve",
  MEGANAMES_API: "https://thewarren.app/api/meganames/check",

  // Timeouts
  API_TIMEOUT_MS: 5000,
  RPC_TIMEOUT_MS: 10000,

  // MegaNames contract
  MEGANAMES_ADDRESS: "0x5B424C6CCba77b32b9625a6fd5A30D409d20d997",
};
```

To point the extension at a different RPC endpoint or contract deployment, edit these values and reload the extension.

## Security

### Manifest V3 Strict CSP

The extension enforces a strict Content Security Policy:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

No inline scripts, no remote script loading, no `eval()` on extension pages.

### Sandboxed Content Rendering

All user-provided HTML content is rendered inside a [sandboxed page](https://developer.chrome.com/docs/extensions/develop/concepts/sandboxed-pages) (`viewer/sandbox.html`). The sandbox:

- Runs in an isolated origin with no access to extension APIs
- Intercepts `fetch()` calls to serve container files from memory (no network requests for container assets)
- Intercepts link clicks for container-internal navigation via `postMessage`
- Cannot access `chrome.*` APIs, cookies, or extension storage

### Minimal Permissions

The extension requests only the permissions it needs:

| Permission | Purpose |
|------------|---------|
| `storage` | Persist visit history locally |
| `declarativeNetRequest` | Redirect Warren domain requests |
| `host_permissions` for `*.thewarren.app` and `*.megawarren.xyz` | Intercept only Warren domains |

### No Data Collection

- All DNS resolution and content loading happens directly between your browser and the MegaETH RPC endpoint
- Visit history is stored locally in `chrome.storage.local` and never transmitted
- The gateway API fallback (`thewarren.app/api/dns/resolve`) is only used for faster DNS lookups; the extension always falls back to direct on-chain resolution if the API is unavailable

## Network

**MegaETH Mainnet**

| Property | Value |
|----------|-------|
| Chain ID | `4326` (0x10E6) |
| RPC | `https://mainnet.megaeth.com/rpc` |
| Block Explorer | https://megaeth.blockscout.com |

**Key Contracts**

| Contract | Address |
|----------|---------|
| WarrenDNS | `0x3f9EaD44f51690b18bd491Fc5A04786121f20D5b` |
| MasterNFT | `0xf299F428Efe1907618360F3c6D16dF0F2Bf8ceFC` |
| WarrenContainer | `0x65179A9473865b55af0274348d39E87c1D3d5964` |
| MegaNames | `0x5B424C6CCba77b32b9625a6fd5A30D409d20d997` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## How It Works

### Fractal Tree Loading

Warren stores files on-chain using a fractal tree structure. Large files are split into chunks (~15KB each), each deployed as a `Page` contract using SSTORE2 bytecode storage. These chunks are organized into a tree:

```
Master Contract (stores root address + depth)
        |
    Root Node (contains child addresses packed as 20-byte entries)
        |
   +----+----+----+
   |    |    |    |
 Leaf  Leaf Leaf  Leaf  (each stores ~15KB via SSTORE2)
```

The extension traverses this tree by:

1. Querying the registry (`MasterNFT` or `WarrenContainer`) for the root chunk address and tree depth
2. Recursively reading node contracts to collect all leaf addresses
3. Reading each leaf via `Page.read()` (an `eth_call` using EXTCODECOPY)
4. Concatenating all chunks in order to reconstruct the original file

### DNS Resolution Strategy

Resolution follows a fallback chain for maximum availability:

1. **Gateway API** (`thewarren.app/api/dns/resolve`) -- fast, works when the server is up
2. **On-chain RPC** -- direct `eth_call` to the WarrenDNS contract, works even when all centralized infrastructure is down

This ensures content remains accessible as long as the MegaETH network is operational.

## Contributing

Contributions are welcome. When submitting changes:

1. Keep the zero-dependency principle -- no npm packages, no build tools
2. All modules must be valid ES modules (`.js` with `import`/`export`)
3. Test with the Chrome extension developer tools (`chrome://extensions` > Inspect views)
4. Ensure the strict CSP is not violated (no inline scripts, no `eval`)

## License

MIT
