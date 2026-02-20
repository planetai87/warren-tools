/**
 * WARREN Extension Configuration
 */

export const CONFIG = {
  // MegaETH Mainnet
  RPC_URL: "https://mainnet.megaeth.com/rpc",
  CHAIN_ID: 4326,

  // Contract addresses (update after deployment)
  DNS_CONTRACT: "0x3f9EaD44f51690b18bd491Fc5A04786121f20D5b",           // WarrenDNS address
  MASTER_NFT_ADDRESS: "0xf299F428Efe1907618360F3c6D16dF0F2Bf8ceFC",     // MasterNFT registry (V2)
  WARREN_CONTAINER_ADDRESS: "0x65179A9473865b55af0274348d39E87c1D3d5964", // WarrenContainer (V2)

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

  // MegaNames
  MEGANAMES_ADDRESS: "0x5B424C6CCba77b32b9625a6fd5A30D409d20d997",
};
