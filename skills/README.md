# Warren Deploy Skills - AI-Powered Blockchain Deployment

Deploy websites, files, and NFT collections permanently on-chain using [Warren](https://thewarren.app)'s fractal tree storage on MegaETH.

These skills are designed for [OpenClaw](https://openclaw.ai) and [Claude Code](https://claude.ai/code), enabling AI agents to deploy content to the blockchain autonomously. They work equally well as standalone CLI tools.

## Overview

Warren stores arbitrarily large files on-chain by splitting them into 15KB chunks, deploying each as an SSTORE2 contract, and organizing them into a fractal tree. A single root address resolves the entire file. Content deployed through Warren is permanent, immutable, and fully on-chain -- no IPFS, no Arweave, no external storage.

These skills provide self-contained Node.js scripts that handle the entire deployment pipeline: chunking, contract deployment, tree construction, and registry registration.

## Skills Available

### warren-deploy

Deploy HTML files, websites, or binary content permanently on-chain.

- Deploys any file (HTML, images, video, audio, scripts) as on-chain bytecode
- Splits large files into 15KB chunks using a fractal tree structure
- Registers the deployment in the MasterNFT registry
- Returns a permanent URL at `thewarren.app/v/site={TOKEN_ID}`

### warren-nft-deploy

Deploy complete NFT collections with fully on-chain image storage.

- Stores every image on-chain via SSTORE2 (no IPFS dependency)
- Deploys a WarrenLaunchedNFT contract with configurable mint parameters
- Supports custom pricing, supply caps, per-wallet limits, and royalties
- Provides management and mint pages at `thewarren.app/launchpad/`
- Can auto-generate SVG art for quick prototyping

## How Skills Work

Each skill follows the same architecture:

```
SKILL.md          AI agent reads this to understand capabilities and usage
    |
    v
AI Agent          Parses user intent, constructs the correct CLI invocation
    |
    v
deploy.js         Self-contained Node.js script that executes on-chain deployment
```

1. **SKILL.md** is the instruction file. When an AI agent (OpenClaw or Claude Code) loads the skill, it reads SKILL.md to learn what the tool does, what arguments it accepts, and how to invoke it.
2. **The AI agent** interprets the user's request, maps it to the correct CLI flags, and runs the deploy script.
3. **The deploy script** handles everything: wallet setup, access key verification, file chunking, contract deployment, tree construction, and registry registration.

No intermediary servers are involved in the deployment itself. Transactions go directly from your machine to the MegaETH RPC endpoint.

## Prerequisites

- **Node.js** v18 or later
- **MegaETH mainnet ETH** for gas fees (bridge from Ethereum via the [official MegaETH bridge](https://bridge.megaeth.com))
- **Private key** of a funded wallet

### Approximate Gas Costs

| Operation | Approximate Cost |
|-----------|-----------------|
| Deploy a single website | ~0.001 ETH |
| Deploy NFT collection (10 images) | ~0.03 ETH |

### Genesis Access

Both scripts require a Warren access key. The process is automatic:

1. Check for a human **Genesis Key** (0xRabbitNeo) in the wallet
2. Check for a **0xRabbit.agent Key** in the wallet
3. If neither exists, auto-mint a **0xRabbit.agent Key** (free, gas only)

No manual action is needed. The script handles key acquisition automatically.

## Quick Start

### Deploy a Website

```bash
cd skills/warren-deploy
bash setup.sh

# Deploy inline HTML
PRIVATE_KEY=0x... node deploy.js \
  --html "<html><body><h1>Hello Warren!</h1></body></html>" \
  --name "My Site"

# Deploy an HTML file
PRIVATE_KEY=0x... node deploy.js \
  --file ./index.html \
  --name "My Website"
```

**Output:**

```json
{
  "tokenId": 102,
  "rootChunk": "0x019E5E...",
  "depth": 0,
  "url": "https://thewarren.app/v/site=102"
}
```

### Deploy an NFT Collection

```bash
cd skills/warren-nft-deploy
bash setup.sh

# Deploy from an image folder
PRIVATE_KEY=0x... node deploy-nft.js \
  --images-folder ./my-art/ \
  --name "Cool Robots" \
  --symbol "ROBOT" \
  --description "100 unique robot NFTs stored fully on-chain" \
  --max-supply 100

# Or auto-generate SVG art for testing
PRIVATE_KEY=0x... node deploy-nft.js \
  --generate-svg 10 \
  --name "Generative Art" \
  --symbol "GART"
```

**Output:**

```
NFT Collection Deployed!

NFT Contract:  0xABC...
Container ID:  15
Image Count:   10
Max Supply:    100
Public Price:  0 ETH (Free)

Management: https://thewarren.app/launchpad/0xABC.../
Mint Page:  https://thewarren.app/launchpad/0xABC.../mint
```

### NFT Collection Options

```bash
PRIVATE_KEY=0x... node deploy-nft.js \
  --images-folder ./collection/ \
  --name "Cyber Punks" \
  --symbol "CPUNK" \
  --description "On-chain cyberpunk collection" \
  --max-supply 1000 \
  --whitelist-price 0.01 \
  --public-price 0.02 \
  --max-per-wallet 5 \
  --royalty-bps 500
```

## Security

**Your private key never leaves your machine.**

- **Local signing only** -- The private key is used exclusively to sign transactions in-process. It is never written to disk, logged to console, or transmitted over the network.
- **Direct RPC communication** -- All transactions are sent directly to the MegaETH public RPC endpoint (`https://mainnet.megaeth.com/rpc`). There are no intermediary servers, proxies, or relay services in the deployment path.
- **No telemetry** -- The scripts perform zero analytics, tracking, or usage reporting. No outbound connections are made other than the RPC endpoint.
- **Minimal file access** -- `deploy.js` reads only the single file specified by `--file`. `deploy-nft.js` reads only the files inside the specified `--images-folder`. Neither script scans directories or accesses files outside the explicit input.
- **Optional registration** -- After NFT deployment, `deploy-nft.js` sends collection metadata (name, symbol, supply, contract address) to `thewarren.app/api/container-nfts` for the management dashboard. This is non-critical and contains no images or keys. It can be disabled by setting `REGISTER_API=""`.
- **Open source** -- Every script is readable. There are no obfuscated binaries or network calls beyond what is documented.

## Contract Addresses (MegaETH Mainnet)

All contracts are deployed on MegaETH mainnet (Chain ID: 4326) and verified on [Blockscout](https://megaeth.blockscout.com).

| Contract | Address | Used By |
|----------|---------|---------|
| Genesis Key NFT (0xRabbitNeo) | `0x0d7BB250fc06f0073F0882E3Bf56728A948C5a88` | Both |
| 0xRabbit.agent Key NFT | `0x3f0CAbd6AB0a318f67aAA7af5F774750ec2461f2` | Both |
| MasterNFT Registry | `0xf299F428Efe1907618360F3c6D16dF0F2Bf8ceFC` | warren-deploy |
| WarrenContainer | `0x65179A9473865b55af0274348d39E87c1D3d5964` | warren-nft-deploy |
| WarrenContainerRenderer | `0xdC0c76832a6fF9F9db64686C7f04D7c0669366BB` | warren-nft-deploy |

## Environment Variables

Both skills share a common set of environment variables. Only `PRIVATE_KEY` is required; everything else has sensible defaults.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | **Yes** | -- | Wallet private key for signing transactions |
| `RPC_URL` | No | `https://mainnet.megaeth.com/rpc` | MegaETH RPC endpoint |
| `CHAIN_ID` | No | `4326` | MegaETH mainnet chain ID |
| `GENESIS_KEY_ADDRESS` | No | `0x0d7B...5a88` | Genesis Key NFT contract |
| `RABBIT_AGENT_ADDRESS` | No | `0x3f0C...61f2` | 0xRabbit.agent NFT contract |
| `CHUNK_SIZE` | No | `15000` | Bytes per on-chain chunk (15KB) |
| `GROUP_SIZE` | No | `500` | Max addresses per fractal tree node |

**warren-deploy only:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MASTER_NFT_ADDRESS` | No | `0xf299...eFC` | MasterNFT registry contract |

**warren-nft-deploy only:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONTAINER_ADDRESS` | No | `0x6517...5964` | WarrenContainer contract |
| `RENDERER_ADDRESS` | No | `0xdC0c...6BB` | WarrenContainerRenderer contract |
| `TREASURY_ADDRESS` | No | `0xcea9...8c550` | Treasury/relayer address |
| `REGISTER_API` | No | `https://thewarren.app/api/container-nfts` | Collection registration endpoint |

## File Structure

```
skills/
├── README.md                          # This file
│
├── warren-deploy/                     # Website/file deployment skill
│   ├── SKILL.md                       # AI agent instructions
│   ├── deploy.js                      # Deployment script
│   ├── setup.sh                       # One-time dependency installer
│   └── page_bytecode.js               # Compiled Page.sol bytecode
│
└── warren-nft-deploy/                 # NFT collection deployment skill
    ├── SKILL.md                       # AI agent instructions
    ├── deploy-nft.js                  # NFT deployment script
    ├── setup.sh                       # One-time dependency installer
    ├── page_bytecode.js               # Compiled Page.sol bytecode
    ├── WarrenLaunchedNFT.bytecode.json # Compiled NFT contract bytecode
    └── package.json                   # Node.js package manifest
```

## Troubleshooting

**"No ETH balance"**
Bridge ETH from Ethereum to MegaETH mainnet and retry.

**"No Genesis Key found and RABBIT_AGENT_ADDRESS is not configured"**
Set `RABBIT_AGENT_ADDRESS=0x3f0CAbd6AB0a318f67aAA7af5F774750ec2461f2` or mint a human Genesis Key at [thewarren.app/mint](https://thewarren.app/mint).

**"Image exceeds 500KB"** (NFT deploy)
Resize or compress images before deploying. Maximum 500KB per image, 256 images per collection.

**RPC rate limit errors**
The scripts include automatic retry logic. Add a short delay between repeated deployments if errors persist.

## Links

- **Warren**: [thewarren.app](https://thewarren.app)
- **MegaETH**: [megaeth.com](https://megaeth.com)
- **Block Explorer**: [megaeth.blockscout.com](https://megaeth.blockscout.com)
- **Source**: [github.com/planetai87/onchain-loader](https://github.com/planetai87/onchain-loader)

## License

MIT
