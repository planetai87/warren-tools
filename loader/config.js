/**
 * MegaWarren Shared Configuration (ES Module)
 *
 * This file contains FALLBACK configuration values for standalone loader scripts
 * in the public folder. These are only used when /api/config is not available.
 *
 * NOTE: Loaders should prefer fetching config from /api/config which provides
 * the optimized RPC URL with proper fallback chain:
 *   Priority 1: Private RPC (server-side only)
 *   Priority 2: Alchemy RPC
 *   Priority 3: Public RPC (this file)
 *
 * IMPORTANT: When changing these values, also update admin-panel/lib/config.ts
 * to keep the values in sync.
 */

/**
 * Chunk size in bytes for fractal tree uploads.
 * Files are split into chunks of this size before being stored on-chain.
 * Default: 15KB (fallback value when /api/config is unavailable)
 */
export const CHUNK_SIZE = 15000;

/**
 * Group size for fractal tree node layers.
 * Determines how many child addresses are grouped into a single parent node.
 */
export const GROUP_SIZE = 500;

/**
 * RPC URL for MegaETH network (PUBLIC FALLBACK).
 * This is only used when /api/config is unavailable.
 * For better performance, loaders fetch config from /api/config which may
 * return a private RPC URL or Alchemy RPC URL.
 */
export const RPC_URL = "https://mainnet.megaeth.com/rpc";
