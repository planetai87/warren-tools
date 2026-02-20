/**
 * WARREN DNS Resolver
 *
 * Fallback chain:
 * 1. Gateway API (fast, works when server is up)
 * 2. On-chain RPC (last resort, works when only RPC is alive)
 */

import { CONFIG } from "./config.js";

const DNS_ABI = [
  {
    name: "resolve",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "name", type: "string" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "siteType", type: "uint8" },
          { name: "registeredAt", type: "uint256" },
          { name: "isActive", type: "bool" },
        ],
      },
    ],
  },
];

/**
 * Resolve subdomain name → site info
 * Tries gateway API first, falls back to on-chain
 */
export async function resolve(name) {
  // 1st: Try gateway API
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.API_TIMEOUT_MS
    );

    const res = await fetch(
      `${CONFIG.GATEWAY_API}?name=${encodeURIComponent(name)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      console.log("[dns] Resolved via API:", name);
      return {
        source: "api",
        owner: data.owner,
        tokenId: data.tokenId,
        siteType: data.siteType, // "master_nft" or "container"
        isActive: data.isActive,
        masterNftAddress: data.masterNftAddress,
        warrenContainerAddress: data.warrenContainerAddress,
        rpcUrl: data.rpcUrl || CONFIG.RPC_URL,
      };
    }
  } catch (e) {
    console.warn("[dns] API fallback failed:", e.message);
  }

  // 2nd: On-chain direct query
  return resolveOnchain(name);
}

/**
 * Resolve directly from on-chain WarrenDNS contract
 */
async function resolveOnchain(name) {
  if (!CONFIG.DNS_CONTRACT) {
    throw new Error("DNS contract not configured");
  }

  console.log("[dns] Resolving on-chain:", name);

  // Encode function call: resolve(string)
  const nameHex = stringToHex(name);
  const selector = "0x5c23bdf5"; // keccak256("resolve(string)")[:4]

  // ABI encode: offset(32) + length(32) + padded string
  const offset = "0000000000000000000000000000000000000000000000000000000000000020";
  const length = nameHex.length / 2;
  const lengthHex = length.toString(16).padStart(64, "0");
  const paddedName = nameHex.padEnd(Math.ceil(nameHex.length / 64) * 64, "0");

  const calldata = selector + offset + lengthHex + paddedName;

  const response = await rpcCall("eth_call", [
    { to: CONFIG.DNS_CONTRACT, data: calldata },
    "latest",
  ]);

  if (!response || response === "0x" || response.length < 66) {
    return null;
  }

  // Decode response: (address owner, uint256 tokenId, uint8 siteType, uint256 registeredAt, bool isActive)
  const data = response.slice(2); // remove 0x
  const owner = "0x" + data.slice(24, 64);
  const tokenId = parseInt(data.slice(64, 128), 16);
  const siteType = parseInt(data.slice(128, 192), 16);
  const registeredAt = parseInt(data.slice(192, 256), 16);
  const isActive = parseInt(data.slice(256, 320), 16) === 1;

  if (owner === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  return {
    source: "onchain",
    owner,
    tokenId,
    siteType: siteType === 1 ? "container" : "master_nft",
    isActive,
    masterNftAddress: CONFIG.MASTER_NFT_ADDRESS,
    warrenContainerAddress: CONFIG.WARREN_CONTAINER_ADDRESS,
    rpcUrl: CONFIG.RPC_URL,
  };
}

/**
 * Raw JSON-RPC call
 */
async function rpcCall(method, params) {
  const res = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/**
 * Convert string to hex bytes (no 0x prefix)
 */
function stringToHex(str) {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
