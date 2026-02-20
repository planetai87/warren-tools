/**
 * WARREN MegaNames Resolver
 *
 * Fallback chain:
 * 1. Gateway API (fast)
 * 2. On-chain RPC call to MegaNames contract
 */

import { keccak256 } from "./keccak256.js";
import { CONFIG } from "./config.js";

const ZERO_NODE = "0".repeat(64);
const MEGA_LABEL_HASH = keccak256("mega");
const MEGA_NODE = keccakPacked(ZERO_NODE, MEGA_LABEL_HASH);
const WARREN_SELECTOR = keccak256("warren(uint256)").slice(0, 8);
const ADDR_SELECTOR = keccak256("addr(uint256)").slice(0, 8);
const TEXT_SELECTOR = keccak256("text(uint256,string)").slice(0, 8);
const RECORDS_SELECTOR = keccak256("records(uint256)").slice(0, 8);
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const TEXT_KEYS = ["avatar", "description", "url", "com.twitter", "com.github", "com.discord", "org.telegram"];

/**
 * Resolve MegaName (bread.mega) to WARREN site info
 * Returns:
 * - { exists: true, owner, isWarren: true, warrenTokenId, isMaster }
 * - { exists: true, owner, isWarren: false, warrenTokenId: 0, isMaster: false }
 * - null (name does not exist)
 */
export async function resolveMega(name) {
  const normalizedName = normalizeMegaName(name);
  if (!normalizedName) return null;

  const apiResult = await resolveViaApi(normalizedName);
  if (apiResult) {
    return apiResult;
  }

  return resolveOnchain(normalizedName);
}

async function resolveViaApi(name) {
  if (!CONFIG.MEGANAMES_API) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.API_TIMEOUT_MS
    );

    const res = await fetch(
      `${CONFIG.MEGANAMES_API}?name=${encodeURIComponent(name)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json();
    const parsed = parseResolveResult(data);

    if (parsed) {
      console.log("[mega] Resolved via API:", name, parsed.isWarren ? "(warren)" : "(profile)");
      return parsed;
    }
  } catch (e) {
    console.warn("[mega] API fallback failed:", e.message);
  }

  return null;
}

async function resolveOnchain(name) {
  if (!CONFIG.MEGANAMES_ADDRESS) {
    throw new Error("MegaNames contract not configured");
  }

  const tokenIdHex = computeMegaTokenId(name);
  console.log("[mega] Resolving on-chain:", name);

  const warrenCalldata = "0x" + WARREN_SELECTOR + tokenIdHex;
  const warrenResponse = await rpcCall("eth_call", [
    { to: CONFIG.MEGANAMES_ADDRESS, data: warrenCalldata },
    "latest",
  ]);

  const warrenResult = decodeWarrenResponse(warrenResponse);
  if (warrenResult && warrenResult.isWarren) {
    return { exists: true, owner: null, ...warrenResult };
  }

  const addrCalldata = "0x" + ADDR_SELECTOR + tokenIdHex;
  const addrResponse = await rpcCall("eth_call", [
    { to: CONFIG.MEGANAMES_ADDRESS, data: addrCalldata },
    "latest",
  ]);

  const owner = decodeAddressResponse(addrResponse);
  if (owner && owner !== ZERO_ADDRESS) {
    return {
      exists: true,
      owner,
      isWarren: false,
      warrenTokenId: 0,
      isMaster: false,
    };
  }

  return null;
}

function computeMegaTokenId(name) {
  const label = name.slice(0, -5); // remove ".mega"
  const labelHash = keccak256(label);
  return keccakPacked(MEGA_NODE, labelHash);
}

function decodeWarrenResponse(response) {
  if (!response || response === "0x") return null;

  const raw = response.startsWith("0x") ? response.slice(2) : response;
  if (raw.length < 64 * 3) return null;

  const warrenTokenId = Number(BigInt("0x" + raw.slice(0, 64)));
  const isMaster = parseBoolWord(raw.slice(64, 128));
  const isWarren = parseBoolWord(raw.slice(128, 192));

  return { warrenTokenId, isMaster, isWarren };
}

function decodeAddressResponse(response) {
  if (!response || response === "0x") return null;

  const raw = response.startsWith("0x") ? response.slice(2) : response;
  if (raw.length < 64) return null;

  return "0x" + raw.slice(raw.length - 40).toLowerCase();
}

function parseResolveResult(data) {
  const payload = data?.result ?? data?.data ?? data;
  if (!payload || typeof payload !== "object") return null;

  if (payload.exists !== undefined && !parseBoolean(payload.exists)) {
    return null;
  }

  const isWarren = parseBoolean(payload.isWarren);
  const owner = parseAddress(payload.owner ?? payload.addr ?? payload.address);
  const hasNonWarrenSignal =
    payload.exists !== undefined ||
    payload.isWarren !== undefined ||
    owner !== null;

  if (!isWarren) {
    if (!hasNonWarrenSignal || owner === ZERO_ADDRESS) return null;
    return {
      exists: true,
      owner,
      isWarren: false,
      warrenTokenId: 0,
      isMaster: false,
    };
  }

  const warrenTokenId = parseInteger(payload.warrenTokenId);
  if (warrenTokenId === null) return null;

  return {
    exists: true,
    owner,
    warrenTokenId,
    isMaster: parseBoolean(payload.isMaster),
    isWarren: true,
  };
}

function parseInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    if (Number.isFinite(num)) return Math.trunc(num);
  }

  return null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  return false;
}

function parseAddress(value) {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return null;

  return normalized;
}

function parseBoolWord(wordHex) {
  return BigInt("0x" + wordHex) !== 0n;
}

function normalizeMegaName(name) {
  if (typeof name !== "string") return null;

  let normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  if (!normalized.endsWith(".mega")) {
    normalized += ".mega";
  }

  const label = normalized.slice(0, -5);
  if (!LABEL_PATTERN.test(label)) return null;

  return normalized;
}

/**
 * solidityPacked(["bytes32", "bytes32"], [left, right])
 */
function keccakPacked(leftHex, rightHex) {
  return keccak256(hexToBytes(leftHex + rightHex));
}

function hexToBytes(hex) {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }

  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Fetch full on-chain profile for a MegaName.
 * Called when name exists but is not connected to Warren.
 */
export async function fetchMegaProfile(name) {
  const normalizedName = normalizeMegaName(name);
  if (!normalizedName) return null;

  const tokenIdHex = computeMegaTokenId(normalizedName);

  // addr() — owner address (API may not return it)
  const addrCalldata = "0x" + ADDR_SELECTOR + tokenIdHex;
  const addrPromise = rpcCall("eth_call", [
    { to: CONFIG.MEGANAMES_ADDRESS, data: addrCalldata }, "latest",
  ]).then(decodeAddressResponse).catch(() => null);

  // records() — label, expiresAt
  const recordsCalldata = "0x" + RECORDS_SELECTOR + tokenIdHex;
  const recordsPromise = rpcCall("eth_call", [
    { to: CONFIG.MEGANAMES_ADDRESS, data: recordsCalldata }, "latest",
  ]).then(decodeRecordsResponse).catch(() => null);

  // text() records — 7 keys in parallel
  const textPromises = TEXT_KEYS.map(key => {
    const calldata = encodeTextCall(tokenIdHex, key);
    return rpcCall("eth_call", [
      { to: CONFIG.MEGANAMES_ADDRESS, data: calldata }, "latest",
    ]).then(decodeStringResponse).catch(() => "");
  });

  const [owner, recordsData, ...textResults] = await Promise.all([addrPromise, recordsPromise, ...textPromises]);

  const textRecords = {};
  TEXT_KEYS.forEach((key, i) => { textRecords[key] = textResults[i] || ""; });

  return {
    owner: (owner && owner !== ZERO_ADDRESS) ? owner : null,
    label: recordsData?.label || normalizedName.slice(0, -5),
    expiresAt: recordsData?.expiresAt || 0,
    avatar: textRecords.avatar,
    description: textRecords.description,
    url: textRecords.url,
    twitter: textRecords["com.twitter"],
    github: textRecords["com.github"],
    discord: textRecords["com.discord"],
    telegram: textRecords["org.telegram"],
  };
}

// ABI-encode text(uint256,string) call
function encodeTextCall(tokenIdHex, key) {
  const keyHex = utf8ToHex(key);
  const keyLen = key.length;
  const paddedKeyLen = Math.max(32, Math.ceil(keyLen / 32) * 32);

  return "0x" + TEXT_SELECTOR
    + tokenIdHex
    + "0".repeat(62) + "40"                          // offset to string = 64
    + "0".repeat(64 - keyLen.toString(16).length) + keyLen.toString(16)
    + keyHex.padEnd(paddedKeyLen * 2, "0");
}

// Decode ABI-encoded string response
function decodeStringResponse(response) {
  if (!response || response === "0x") return "";
  const raw = response.startsWith("0x") ? response.slice(2) : response;
  if (raw.length < 128) return "";

  const offset = parseInt(raw.slice(0, 64), 16) * 2;
  if (offset + 64 > raw.length) return "";
  const length = parseInt(raw.slice(offset, offset + 64), 16);
  if (length === 0) return "";
  const hexStr = raw.slice(offset + 64, offset + 64 + length * 2);
  return hexToUtf8(hexStr);
}

// Decode records() response: (string label, uint256 parent, uint64 expiresAt, ...)
function decodeRecordsResponse(response) {
  if (!response || response === "0x") return null;
  const raw = response.startsWith("0x") ? response.slice(2) : response;
  if (raw.length < 64 * 5) return null;

  // word[0] = offset to label string, word[1] = parent, word[2] = expiresAt
  const expiresAt = Number(BigInt("0x" + raw.slice(128, 192)));

  const labelOffset = parseInt(raw.slice(0, 64), 16) * 2;
  if (labelOffset + 64 > raw.length) return { label: "", expiresAt };
  const labelLen = parseInt(raw.slice(labelOffset, labelOffset + 64), 16);
  const label = labelLen > 0
    ? hexToUtf8(raw.slice(labelOffset + 64, labelOffset + 64 + labelLen * 2))
    : "";

  return { label, expiresAt };
}

function utf8ToHex(str) {
  return Array.from(new TextEncoder().encode(str))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToUtf8(hex) {
  if (!hex || hex.length === 0) return "";
  const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

export async function rpcCall(method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.RPC_TIMEOUT_MS
  );

  const res = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
