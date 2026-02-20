# WARREN Tools

> Open-source tools for the Warren on-chain CMS ecosystem on MegaETH

## What is Warren?

Warren is an on-chain permanent web CMS for [MegaETH](https://megaeth.com) that stores large HTML, image, and video files on the blockchain using a **fractal tree architecture**. It overcomes Ethereum's 24KB bytecode limit by breaking files into chunks stored across multiple contracts in a tree structure.

Every piece of content published through Warren lives permanently on-chain -- no IPFS, no centralized servers, no pinning services. The fractal tree design gives logarithmic read depth and enables parallel loading for fast content retrieval.

## Components

| Component | Description |
|-----------|-------------|
| [**Loader**](./loader/) | Standalone client-side loader for rendering on-chain content. No build step needed. Drop it into any HTML page to resolve and display Warren-hosted content. |
| [**Extension**](./extension/) | Chrome extension for seamless access to Warren-hosted sites via the browser. Intercepts navigation and renders on-chain pages transparently. |
| [**Deploy Skills**](./skills/) | OpenClaw / Claude Code skills for deploying websites and NFT collections on-chain through conversational AI. |

## Architecture

Warren stores files using a fractal tree of contracts. Large files are chunked, and chunk addresses are recursively grouped until a single root remains.

```
File (500KB)
     |
     v  chunk into 15KB pieces
[Chunk1] [Chunk2] [Chunk3] ... [Chunk34]    <-- Page contracts (SSTORE2)
     |       |        |             |
     +-------+--------+----...-----+
     |
     v  group addresses (20 bytes each)
[  Node1  ] [  Node2  ]                     <-- Intermediate node contracts
     |            |
     +------------+
     |
     v
[   Root   ]                                 <-- Master contract
     |
     v
  metadata: rootChunk address, depth, totalSize
```

**Reading** works top-down: the loader fetches the root, discovers child addresses at each level, and recursively traverses down to the leaf chunks where the actual data lives. Chunks are reassembled in order to reconstruct the original file.

**Writing** works bottom-up: the uploader deploys leaf chunks first, then groups their addresses into intermediate nodes, repeating until a single root is produced. The Master contract stores the root address along with the tree depth and total file size.

## Quick Links

- **Website**: [thewarren.app](https://thewarren.app)
- **Block Explorer**: [megaeth.blockscout.com](https://megaeth.blockscout.com)
- **MegaETH**: [megaeth.com](https://megaeth.com)

## Network

All Warren contracts are deployed on **MegaETH Mainnet**.

| Property | Value |
|----------|-------|
| Chain ID | `4326` (0x10E6) |
| RPC | `https://mainnet.megaeth.com/rpc` |
| Block Explorer | [megaeth.blockscout.com](https://megaeth.blockscout.com) |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change. For major changes, include a description of the motivation and proposed approach.

## License

[MIT](./LICENSE)
