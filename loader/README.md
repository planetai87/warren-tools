# Warren Loader - On-Chain Content Loader for MegaETH

Standalone client-side loader that retrieves and renders content stored on the MegaETH blockchain using Warren's fractal tree architecture. No build step required -- just serve the files with any HTTP server and it works.

Warren stores arbitrarily large files on-chain by splitting them into chunks distributed across a tree of smart contracts. This loader traverses that tree, reassembles the original content, and renders it in the browser -- all directly from the blockchain via RPC calls.

## Features

- **Fractal tree traversal** -- Recursively walks the on-chain tree structure to discover all data chunks, regardless of tree depth
- **Multicall3 batch loading** -- Fetches up to 100 chunks per RPC call using the universal Multicall3 contract, dramatically reducing load times
- **Multi-format support** -- Handles HTML pages, images (PNG/JPEG/GIF/WebP), video (MP4/WebM with MediaSource streaming), and audio (MP3/M4A/WAV/OGG)
- **Automatic content routing** -- Detects `siteType` from on-chain metadata and redirects to the appropriate specialized loader
- **Configurable via URL parameters** -- Batch size, multicall toggle, debug mode, and more
- **Resilient retry logic** -- Exponential backoff with up to 5 retry rounds for failed chunks; automatic fallback from multicall to individual loading
- **No backend required** -- Reads directly from any MegaETH RPC endpoint; no API server needed for basic usage
- **Zero build step** -- Pure ES modules loaded from CDN; no npm install, no bundler, no transpiler

## Files

| File | Purpose |
|------|---------|
| `loader.html` | Main HTML page with loading UI (donut chart, chunk grid, progress stats) |
| `loader.js` | Core loader for HTML/text content. Traverses the fractal tree, assembles data, renders via `document.write()` |
| `image-loader.js` | Specialized loader for on-chain images. Detects format via magic bytes and renders as `<img>` |
| `video-loader.js` | Specialized loader for on-chain video. Supports MediaSource streaming (fMP4) with segment-based playback, or direct blob fallback |
| `audio-loader.js` | Specialized loader for on-chain audio. Detects MP3/M4A/WAV/OGG and renders with `<audio>` player |
| `config.js` | Shared fallback configuration (chunk size, group size, RPC URL). Used when `/api/config` endpoint is unavailable |

## Usage

### Self-Hosted

Serve the files with any static web server:

```bash
# Using Python
python3 -m http.server 8080

# Using Node.js (npx)
npx serve .

# Using any web server (nginx, Apache, Caddy, etc.)
# Just point the document root to this directory
```

Then open the loader in your browser with the appropriate URL parameters.

### URL Parameters

#### Content Address (one required)

| Parameter | Description | Example |
|-----------|-------------|---------|
| `master` | Legacy Master contract address | `?master=0xABC...` |
| `registry` + `id` | MasterNFT registry address and token ID | `?registry=0xDEF...&id=42` |
| `site` | Simplified site ID (requires MasterNFT configured via `/api/config`) | `?site=42` |

#### Loader Options (all optional)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `batchSize` | `100` | Number of chunks per multicall batch |
| `multicall` | `true` | Set to `false` to disable Multicall3 and load chunks individually |
| `debug` | `false` | Set to `true` for verbose console logging |
| `bot` | `0` | Set to `1` to skip view analytics recording |
| `raw` | `false` | (Video only) Force direct blob playback instead of MediaSource streaming |
| `chunkSize` | `15000` | Override chunk size for tree traversal calculation |

#### Examples

```
# Load HTML content from a legacy Master contract
loader.html?master=0x1234567890abcdef1234567890abcdef12345678

# Load from MasterNFT registry
loader.html?registry=0xf299F428Efe1907618360F3c6D16dF0F2Bf8ceFC&id=5

# Load with simplified site ID
loader.html?site=5

# Load with debug logging and smaller batches
loader.html?site=5&debug=true&batchSize=20

# Load without multicall (individual RPC calls)
loader.html?site=5&multicall=false
```

### Path-Based URLs

The loader also supports clean URL paths:

```
/v/site=42
/v/master=0xABC...
```

## How It Works

The loader uses a three-phase loading strategy optimized for RPC reliability:

### Phase 1: Collection (Tree Traversal)

Starting from the root contract address, the loader recursively traverses the fractal tree:

1. Read the root node's bytecode data via the `Page.read()` function
2. If depth > 0, the data contains packed 20-byte child addresses
3. Parse child addresses and recursively traverse each child
4. At depth 0, the node is a leaf containing actual content data
5. Collect all leaf addresses in order

```
Root (depth 2)
  |-- Node A (depth 1) -- contains addresses of leaves
  |     |-- Leaf 0 (15KB chunk)
  |     |-- Leaf 1 (15KB chunk)
  |     `-- Leaf 2 (15KB chunk)
  `-- Node B (depth 1)
        |-- Leaf 3 (15KB chunk)
        `-- Leaf 4 (15KB chunk)
```

### Phase 2: Batch Loading (Multicall3)

Once all leaf addresses are collected, the loader fetches their data in batches:

1. Group leaf addresses into batches (default: 100 per batch)
2. For each batch, construct a Multicall3 `aggregate3` call that invokes `read()` on every chunk contract in a single RPC request
3. Decode the returned data and track progress
4. If multicall fails for a batch, automatically fall back to individual sequential loading
5. Brief 100ms pause between batches to respect RPC rate limits

### Phase 3: Retry (Failed Chunks)

Any chunks that failed during Phase 2 are retried individually:

1. Up to 5 retry rounds with increasing delays (500ms, 1000ms, 1500ms, ...)
2. Each chunk is retried individually with 3 attempts and exponential backoff
3. 100ms pause between individual retries
4. Permanently failed chunks are logged

After all phases complete, chunks are sorted by index and assembled into the final byte array.

### Content Rendering

Depending on the content type (determined by `siteType` in the on-chain metadata):

| siteType | Content | Rendering Method |
|----------|---------|-----------------|
| 0 | HTML/File | `document.write()` replaces the loader page |
| 3 | Image | Blob URL assigned to `<img>` element |
| 4 | Video | MediaSource streaming (fMP4) or blob URL fallback |
| 5 | Audio | Blob URL assigned to `<audio>` element |

## Configuration

### Runtime Configuration (`/api/config`)

When hosted with the Warren admin panel, the loader fetches configuration from `/api/config` at startup. This endpoint provides:

```json
{
  "rpcUrl": "https://...",
  "chunkSize": 15000,
  "batchSize": 100,
  "masterNftAddress": "0x...",
  "digApiUrl": "https://..."
}
```

### Fallback Configuration (`config.js`)

When `/api/config` is not available (standalone deployment), the loader uses hardcoded fallback values:

```javascript
export const CHUNK_SIZE = 15000;  // 15KB per chunk
export const GROUP_SIZE = 500;    // Max children per tree node
export const RPC_URL = "https://mainnet.megaeth.com/rpc";
```

### Priority Order

Configuration values are resolved in this order:

1. URL parameters (highest priority)
2. `/api/config` endpoint response
3. Hardcoded fallback values in each loader script

## Dependencies

| Dependency | Version | Source | Purpose |
|------------|---------|--------|---------|
| [viem](https://viem.sh) | 2.21.0 | `https://esm.sh/viem@2.21.0` | Ethereum client library for RPC calls, ABI encoding/decoding |

viem is loaded as an ES module from the esm.sh CDN at runtime. No npm installation or build step is needed.

## Network

**MegaETH Mainnet**

| Property | Value |
|----------|-------|
| Chain ID | `4326` (0x10E6) |
| Public RPC | `https://mainnet.megaeth.com/rpc` |
| Block Explorer | https://megaeth.blockscout.com |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## Smart Contract Interfaces

The loader interacts with three types of contracts:

### Page Contract

Stores a single data chunk as contract bytecode via SSTORE2.

```solidity
function read() external view returns (bytes memory);
```

### Master Contract (Legacy)

Stores metadata for a single site.

```solidity
function getCurrentSiteInfo() external view returns (
    address rootChunk,
    uint8 depth,
    uint256 totalSize,
    uint8 siteType
);
```

### MasterNFT Registry

NFT-based registry that maps token IDs to site metadata.

```solidity
function getSiteData(uint256 tokenId) external view returns (
    address rootChunk,
    uint8 depth,
    uint256 totalSize,
    uint8 siteType,
    address creator,
    uint256 version,
    uint256 createdAt,
    uint256 updatedAt
);
```

## Troubleshooting

**Chunks fail to load**
- Enable debug mode: `?debug=true`
- Try reducing batch size: `?batchSize=10`
- Try disabling multicall: `?multicall=false`
- Check the browser console for detailed error messages

**Content loads partially or is corrupted**
- Verify the master contract address is correct
- Check that all chunks were deployed successfully on the block explorer
- Enable debug mode to see individual chunk sizes and detect gaps

**RPC rate limiting (429 errors)**
- Reduce batch size: `?batchSize=20`
- The loader will automatically retry failed chunks with exponential backoff

**Video does not play**
- Try forced raw mode: `?raw=true`
- Check if the browser supports MediaSource Extensions for the video codec
- Mobile Safari has limited MediaSource support; the loader falls back to blob playback automatically

## License

MIT
