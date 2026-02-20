/**
 * WARREN Site Loader
 *
 * Loads site content from on-chain fractal tree.
 * Based on admin-panel/public/loader.js but adapted for extension use.
 * Uses raw JSON-RPC + Multicall3 for minimal dependencies.
 */

import { CONFIG } from "./config.js";
import { keccak256 } from "./keccak256.js";

const MULTICALL3_ADDRESS = CONFIG.MULTICALL3_ADDRESS;
const READ_SELECTOR = "0x57de26a4"; // keccak256("read()")[:4]

// MasterNFT getSiteData(uint256) selector
const GET_SITE_DATA_SELECTOR = "0x7328a941"; // keccak256("getSiteData(uint256)")[:4]

// WarrenContainer selectors
const CONTAINER_GET_SITE_DATA = "0x7328a941"; // getSiteData(uint256)
const CONTAINER_GET_FILE_PATHS = "0x45f6528d"; // getFilePaths(uint256)
const CONTAINER_GET_PATH_STRING = "0xd80f14a8"; // getPathString(bytes32)
const CONTAINER_GET_FILE = "0x702f2ee1"; // getFile(uint256,bytes32)

// Container site type constants
const CONTAINER_SITE_TYPE = {
  SITE_CONTAINER: 1,
  NFT_CONTAINER: 2,
};

const DEFAULT_FILES = {
  1: "/index.html",
  2: "/collection.json",
};

/**
 * Load site content by tokenId from MasterNFT
 */
export async function loadMasterNFTSite(registryAddress, tokenId, rpcUrl, onProgress) {
  // 1. Get site data from MasterNFT
  const siteData = await getSiteData(registryAddress, tokenId, rpcUrl);

  if (!siteData.rootChunk || siteData.rootChunk === "0x0000000000000000000000000000000000000000") {
    throw new Error("Site not found");
  }

  // 2. Load content from fractal tree
  return loadContent(siteData.rootChunk, siteData.depth, siteData.totalSize, siteData.siteType, rpcUrl, onProgress);
}

/**
 * Get site data from MasterNFT registry
 */
async function getSiteData(registryAddress, tokenId, rpcUrl) {
  const tokenIdHex = tokenId.toString(16).padStart(64, "0");
  const calldata = GET_SITE_DATA_SELECTOR + tokenIdHex;

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: registryAddress, data: calldata },
    "latest",
  ]);

  if (!result || result === "0x") {
    throw new Error("getSiteData returned empty");
  }

  // SiteData struct (8 fields, each 32 bytes = 64 hex chars):
  // [0] rootChunk (address), [1] depth (uint8), [2] totalSize (uint256),
  // [3] siteType (uint8), [4] creator, [5] version, [6] createdAt, [7] updatedAt
  const data = result.slice(2);
  return {
    rootChunk: "0x" + data.slice(24, 64),
    depth: parseInt(data.slice(64, 128), 16),
    totalSize: parseInt(data.slice(128, 192), 16),
    siteType: parseInt(data.slice(192, 256), 16),
  };
}

/**
 * Load content from fractal tree
 */
async function loadContent(rootChunk, depth, totalSize, siteType, rpcUrl, onProgress) {
  // Phase 1: Collect leaf addresses
  if (onProgress) onProgress({ phase: "scan", message: "Scanning tree..." });
  const leaves = [];
  await collectLeaves(rootChunk, depth, leaves, rpcUrl, onProgress);

  // Phase 2: Load all leaves individually with per-chunk progress
  const totalChunks = leaves.length;
  const allData = [];
  let loaded = 0;

  if (onProgress) {
    onProgress({ phase: "load", loaded: 0, total: totalChunks });
  }

  for (let i = 0; i < leaves.length; i++) {
    const data = await readChunk(leaves[i], rpcUrl);
    allData.push(data);
    loaded++;

    if (onProgress) {
      onProgress({ phase: "load", loaded, total: totalChunks });
    }

    // Rate limit between requests
    if (i < leaves.length - 1) {
      await sleep(50);
    }
  }

  if (onProgress) {
    onProgress({ phase: "load", loaded: totalChunks, total: totalChunks });
  }

  // Phase 3: Assemble
  const totalBytes = allData.reduce((sum, chunk) => sum + chunk.length, 0);
  const assembled = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of allData) {
    assembled.set(chunk, offset);
    offset += chunk.length;
  }

  return { data: assembled, siteType };
}

/**
 * Recursively collect leaf addresses from fractal tree
 */
async function collectLeaves(address, depth, leaves, rpcUrl, onProgress) {
  if (depth === 0) {
    leaves.push(address);
    return;
  }

  // Read node data (contains child addresses, 20 bytes each)
  const nodeData = await readChunk(address, rpcUrl);
  const children = [];

  for (let i = 0; i < nodeData.length; i += 20) {
    const addr = "0x" + Array.from(nodeData.slice(i, i + 20))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    children.push(addr);
  }

  if (onProgress) {
    onProgress({ phase: "scan", depth, nodes: children.length });
  }

  for (const child of children) {
    await collectLeaves(child, depth - 1, leaves, rpcUrl, onProgress);
  }
}

/**
 * Read a single chunk via Page.read()
 */
async function readChunk(address, rpcUrl, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await rpcCall(rpcUrl, "eth_call", [
        { to: address, data: READ_SELECTOR },
        "latest",
      ]);

      if (!result || result === "0x") {
        throw new Error("Empty read result");
      }

      return decodeBytes(result);
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(300 * Math.pow(2, i));
    }
  }
}

/**
 * Multicall3 batch read for multiple Page contracts
 */
async function multicallRead(addresses, rpcUrl) {
  // Encode aggregate3 call
  // aggregate3(Call3[] calls) where Call3 = (address target, bool allowFailure, bytes callData)
  const AGGREGATE3_SELECTOR = "0x82ad56cb";

  // Encode the calls array
  const calls = addresses.map(addr => ({
    target: addr.toLowerCase().slice(2),
    allowFailure: true,
    callData: READ_SELECTOR,
  }));

  // ABI encode: complex tuple array encoding
  // Simplified: use individual calls as fallback if Multicall fails
  try {
    const encoded = encodeAggregate3(calls);
    const result = await rpcCall(rpcUrl, "eth_call", [
      { to: MULTICALL3_ADDRESS, data: AGGREGATE3_SELECTOR + encoded },
      "latest",
    ]);

    return decodeAggregate3Results(result, addresses.length);
  } catch (err) {
    console.warn("[loader] Multicall failed, falling back to individual:", err.message);
    return individualRead(addresses, rpcUrl);
  }
}

/**
 * Fallback: read chunks individually
 */
async function individualRead(addresses, rpcUrl) {
  const results = [];
  for (let i = 0; i < addresses.length; i++) {
    const data = await readChunk(addresses[i], rpcUrl);
    results.push(data);
    // Rate limit: small delay between requests
    if (i < addresses.length - 1) {
      await sleep(50);
    }
  }
  return results;
}

/**
 * Encode aggregate3 calls (simplified ABI encoding)
 */
function encodeAggregate3(calls) {
  // Dynamic array: offset + length + elements
  const n = calls.length;

  // Offset to array data (32 bytes)
  let hex = "0000000000000000000000000000000000000000000000000000000000000020";
  // Array length
  hex += n.toString(16).padStart(64, "0");

  // Each element offset (relative to array data start)
  const elementsStart = n * 32; // offsets area size
  const offsets = [];
  let dataOffset = elementsStart;

  for (let i = 0; i < n; i++) {
    offsets.push(dataOffset);
    // Each Call3: address(32) + allowFailure(32) + callData offset(32) + callData length(32) + callData padded
    const callDataLen = (calls[i].callData.length - 2) / 2; // bytes length
    const callDataPadded = Math.ceil(callDataLen / 32) * 32;
    dataOffset += 32 + 32 + 32 + 32 + callDataPadded;
  }

  // Write offsets
  for (const off of offsets) {
    hex += off.toString(16).padStart(64, "0");
  }

  // Write each Call3 element
  for (const call of calls) {
    // target (address, left-padded)
    hex += call.target.padStart(64, "0");
    // allowFailure (bool)
    hex += call.allowFailure ? "0000000000000000000000000000000000000000000000000000000000000001" : "0000000000000000000000000000000000000000000000000000000000000000";
    // callData offset (relative to this element start) = 96 (3 * 32)
    hex += "0000000000000000000000000000000000000000000000000000000000000060";
    // callData length
    const callDataHex = call.callData.startsWith("0x") ? call.callData.slice(2) : call.callData;
    const callDataBytes = callDataHex.length / 2;
    hex += callDataBytes.toString(16).padStart(64, "0");
    // callData (padded to 32 bytes)
    hex += callDataHex.padEnd(Math.ceil(callDataHex.length / 64) * 64, "0");
  }

  return hex;
}

/**
 * Decode aggregate3 results
 */
function decodeAggregate3Results(result, expectedCount) {
  if (!result || result === "0x") return Array(expectedCount).fill(null);

  try {
    const data = result.slice(2);
    // Skip array offset (32 bytes = 64 hex chars)
    let pos = 64;
    // Array length
    const len = parseInt(data.slice(pos, pos + 64), 16);
    pos += 64;

    // Element offsets
    const offsets = [];
    for (let i = 0; i < len; i++) {
      offsets.push(parseInt(data.slice(pos, pos + 64), 16));
      pos += 64;
    }

    // Decode each Result (success: bool, returnData: bytes)
    const results = [];
    const arrayDataStart = 64 + 64 + len * 64; // after initial offset + length + offsets

    for (let i = 0; i < len; i++) {
      const elemStart = (64 + 64 + offsets[i]) * 1; // hex position
      const elemHex = data.slice(elemStart);

      // success (bool)
      const success = parseInt(elemHex.slice(0, 64), 16) === 1;

      if (!success) {
        results.push(null);
        continue;
      }

      // returnData offset
      const rdOffset = parseInt(elemHex.slice(64, 128), 16) * 2; // to hex chars
      // returnData length
      const rdLen = parseInt(elemHex.slice(128, 192), 16);

      if (rdLen === 0) {
        results.push(null);
        continue;
      }

      // The returnData itself is ABI-encoded bytes
      // Skip the outer bytes encoding: offset(32) + length(32) + actual data
      const innerData = elemHex.slice(192);
      const innerOffset = parseInt(innerData.slice(0, 64), 16) * 2;
      const innerLen = parseInt(innerData.slice(64, 128), 16);
      const actualHex = innerData.slice(128, 128 + innerLen * 2);

      results.push(hexToBytes(actualHex));
    }

    return results;
  } catch (err) {
    console.error("[loader] Failed to decode multicall results:", err);
    return Array(expectedCount).fill(null);
  }
}

/**
 * Decode ABI-encoded bytes from eth_call result
 */
function decodeBytes(result) {
  const data = result.slice(2); // remove 0x
  // bytes: offset(32) + length(32) + data
  const offset = parseInt(data.slice(0, 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16);
  const hex = data.slice(offset + 64, offset + 64 + length * 2);
  return hexToBytes(hex);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Detect content type from magic bytes
 */
export function detectContentType(data) {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  if ((data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) ||
      (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
    const brand = String.fromCharCode(data[8], data[9], data[10], data[11]);
    if (brand.startsWith("M4A") || brand === "mp42") return "audio/mp4";
    return "video/mp4";
  }
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "video/webm";
  return "text/html";
}

/**
 * Load a file from a WarrenContainer site
 */
export async function loadContainerSite(containerAddress, containerId, rpcUrl, path, onProgress) {
  // 1. Get container site data
  if (onProgress) onProgress({ phase: "scan", message: "Getting container info..." });
  const siteData = await getContainerSiteData(containerAddress, containerId, rpcUrl);

  if (siteData.fileCount === 0) {
    throw new Error("Container is empty");
  }

  // 2. Determine file path
  let filePath = path;
  if (!filePath) {
    filePath = DEFAULT_FILES[siteData.siteType] || "/index.html";
  }
  if (!filePath.startsWith("/")) {
    filePath = "/" + filePath;
  }

  // 3. Hash path and get file entry
  if (onProgress) onProgress({ phase: "scan", message: `Loading ${filePath}...` });
  const pathHash = "0x" + keccak256(filePath);
  const fileEntry = await getContainerFile(containerAddress, containerId, pathHash, rpcUrl);

  if (!fileEntry.chunk || fileEntry.chunk === "0x0000000000000000000000000000000000000000") {
    throw new Error(`File not found: ${filePath}`);
  }

  // 4. Load content from fractal tree
  const { data } = await loadContent(fileEntry.chunk, fileEntry.depth, fileEntry.size, 0, rpcUrl, onProgress);

  // 5. Determine MIME type from extension
  const mimeType = getMimeType(filePath);

  return { data, filePath, mimeType, siteData };
}

/**
 * Load ALL files from a container (for inline CSS/JS/image support)
 */
export async function loadAllContainerFiles(containerAddress, containerId, rpcUrl, onProgress) {
  if (onProgress) onProgress({ phase: "scan", message: "Getting container info..." });
  const siteData = await getContainerSiteData(containerAddress, containerId, rpcUrl);

  if (siteData.fileCount === 0) {
    return { files: new Map(), siteData };
  }

  // Get all file path hashes
  if (onProgress) onProgress({ phase: "scan", message: "Getting file list..." });
  const pathHashes = await getContainerFilePaths(containerAddress, containerId, rpcUrl);

  const files = new Map();
  const totalFiles = pathHashes.length;

  for (let i = 0; i < pathHashes.length; i++) {
    const hash = pathHashes[i];

    // Resolve path string
    const pathStr = await getContainerPathString(containerAddress, hash, rpcUrl);
    if (!pathStr) continue;

    // Get file entry
    const fileEntry = await getContainerFile(containerAddress, containerId, hash, rpcUrl);
    if (!fileEntry.chunk || fileEntry.chunk === "0x0000000000000000000000000000000000000000") continue;

    if (onProgress) {
      onProgress({ phase: "load", loaded: i, total: totalFiles, message: `Loading ${pathStr}...` });
    }

    // Load file content
    const { data } = await loadContent(fileEntry.chunk, fileEntry.depth, fileEntry.size, 0, rpcUrl, null);
    const mimeType = getMimeType(pathStr);
    files.set(pathStr, { data, mimeType });

    await sleep(50);
  }

  if (onProgress) {
    onProgress({ phase: "load", loaded: totalFiles, total: totalFiles });
  }

  return { files, siteData };
}

/**
 * Get container site data
 */
async function getContainerSiteData(containerAddress, containerId, rpcUrl) {
  const tokenIdHex = containerId.toString(16).padStart(64, "0");
  const calldata = CONTAINER_GET_SITE_DATA + tokenIdHex;

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: containerAddress, data: calldata },
    "latest",
  ]);

  if (!result || result === "0x") {
    throw new Error("Container not found");
  }

  // SiteData struct: siteType(uint8), creator(address), version(uint32),
  // totalSize(uint32), fileCount(uint16), createdAt(uint40), updatedAt(uint40)
  const data = result.slice(2);
  return {
    siteType: parseInt(data.slice(0, 64), 16),
    creator: "0x" + data.slice(88, 128),
    version: parseInt(data.slice(128, 192), 16),
    totalSize: parseInt(data.slice(192, 256), 16),
    fileCount: parseInt(data.slice(256, 320), 16),
    createdAt: parseInt(data.slice(320, 384), 16),
    updatedAt: parseInt(data.slice(384, 448), 16),
  };
}

/**
 * Get file entry from container
 */
async function getContainerFile(containerAddress, containerId, pathHash, rpcUrl) {
  const tokenIdHex = containerId.toString(16).padStart(64, "0");
  const pathHashHex = pathHash.startsWith("0x") ? pathHash.slice(2) : pathHash;
  const calldata = CONTAINER_GET_FILE + tokenIdHex + pathHashHex.padStart(64, "0");

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: containerAddress, data: calldata },
    "latest",
  ]);

  if (!result || result === "0x") {
    throw new Error("File not found in container");
  }

  // FileEntry struct: chunk(address), size(uint32), depth(uint8)
  const data = result.slice(2);
  return {
    chunk: "0x" + data.slice(24, 64),
    size: parseInt(data.slice(64, 128), 16),
    depth: parseInt(data.slice(128, 192), 16),
  };
}

/**
 * Get file paths from container
 */
export async function getContainerFilePaths(containerAddress, containerId, rpcUrl) {
  const tokenIdHex = containerId.toString(16).padStart(64, "0");
  const calldata = CONTAINER_GET_FILE_PATHS + tokenIdHex;

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: containerAddress, data: calldata },
    "latest",
  ]);

  if (!result || result === "0x") return [];

  // Decode bytes32[] array
  const data = result.slice(2);
  const offset = parseInt(data.slice(0, 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16);
  const hashes = [];
  for (let i = 0; i < length; i++) {
    const start = offset + 64 + i * 64;
    hashes.push("0x" + data.slice(start, start + 64));
  }
  return hashes;
}

/**
 * Resolve path hash to string
 */
export async function getContainerPathString(containerAddress, pathHash, rpcUrl) {
  const hashHex = pathHash.startsWith("0x") ? pathHash.slice(2) : pathHash;
  const calldata = CONTAINER_GET_PATH_STRING + hashHex.padStart(64, "0");

  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: containerAddress, data: calldata },
    "latest",
  ]);

  if (!result || result === "0x") return null;

  // Decode string: offset + length + data
  const data = result.slice(2);
  const offset = parseInt(data.slice(0, 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16);
  const hex = data.slice(offset + 64, offset + 64 + length * 2);
  return hexToString(hex);
}

function hexToString(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function getMimeType(path) {
  const ext = path.split(".").pop().toLowerCase();
  const types = {
    html: "text/html", htm: "text/html",
    css: "text/css", js: "application/javascript",
    json: "application/json", xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
    mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    txt: "text/plain", md: "text/markdown",
  };
  return types[ext] || "application/octet-stream";
}

// Site type constants (from MasterNFT)
export const SITE_TYPES = {
  FILE: 0,      // HTML
  ARCHIVE: 1,   // Archive/Website
  NAMECARD: 2,
  IMAGE: 3,
  VIDEO: 4,
  AUDIO: 5,
  CONSTRUCT: 6,
  SCRIPT: 7,
  ENCRYPTED: 8,
};
