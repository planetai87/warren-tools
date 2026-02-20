import { createPublicClient, http, hexToBytes, toHex, decodeAbiParameters } from "https://esm.sh/viem@2.21.0";

// URL parameters
const params = new URLSearchParams(window.location.search);
let BATCH_SIZE = parseInt(params.get('batchSize')) || 100; // config에서 덮어씀
const USE_MULTICALL = params.get('multicall') !== 'false';
const DEBUG = params.get('debug') === 'true';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Config will be loaded from API
let CHUNK_SIZE = 15000; // 15KB fallback
let RPC_URL = "https://mainnet.megaeth.com/rpc";

// ABIs
const masterAbi = [{
    name: 'getCurrentSiteInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{
        type: 'tuple',
        components: [
            { name: 'rootChunk', type: 'address' },
            { name: 'depth', type: 'uint8' },
            { name: 'totalSize', type: 'uint256' },
            { name: 'siteType', type: 'uint8' }
        ]
    }]
}];

// MasterNFT ABI (for registry mode)
const masterNFTAbi = [{
    name: 'getSiteData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{
        type: 'tuple',
        components: [
            { name: 'rootChunk', type: 'address' },
            { name: 'depth', type: 'uint8' },
            { name: 'totalSize', type: 'uint256' },
            { name: 'siteType', type: 'uint8' },
            { name: 'creator', type: 'address' },
            { name: 'version', type: 'uint256' },
            { name: 'createdAt', type: 'uint256' },
            { name: 'updatedAt', type: 'uint256' }
        ]
    }]
}];

const pageAbi = [{
    name: 'read',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes' }]
}];

const multicall3Abi = [{
    name: 'aggregate3',
    type: 'function',
    stateMutability: 'view',
    inputs: [{
        name: 'calls',
        type: 'tuple[]',
        components: [
            { name: 'target', type: 'address' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'callData', type: 'bytes' }
        ]
    }],
    outputs: [{
        name: 'returnData',
        type: 'tuple[]',
        components: [
            { name: 'success', type: 'bool' },
            { name: 'returnData', type: 'bytes' }
        ]
    }]
}];

// Viem client
let client = null;

// DOM Elements
const loaderContainer = document.getElementById('loader-container');
const audioContainer = document.getElementById('audio-container');
const audioPlayer = document.getElementById('audio-player');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const chunksLoadedEl = document.getElementById('chunksLoaded');
const bytesLoadedEl = document.getElementById('bytesLoaded');
const phaseTextEl = document.getElementById('phaseText');
const audioSizeEl = document.getElementById('audioSize');
const audioTypeEl = document.getElementById('audioType');

// State
let totalChunks = 0;
let loadedChunks = 0;
let totalBytesLoaded = 0;

// === UTILITY FUNCTIONS ===
function log(msg) {
    console.log(`[Audio] ${msg}`);
}

function setPhase(phase) {
    if (phaseTextEl) phaseTextEl.textContent = phase;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function updateStats() {
    if (chunksLoadedEl) chunksLoadedEl.textContent = loadedChunks;
    if (bytesLoadedEl) bytesLoadedEl.textContent = formatBytes(totalBytesLoaded);

    const percent = totalChunks > 0 ? Math.round((loadedChunks / totalChunks) * 100) : 0;
    if (progressBar) progressBar.style.width = percent + '%';
    if (progressText) progressText.textContent = percent + '%';
}

// === UTILITY: Error message sanitization ===
function sanitizeErrorMessage(message) {
    if (!message) return 'Unknown error';
    return message.replace(/https?:\/\/[^\s]+/gi, '[RPC]')
                  .replace(/wss?:\/\/[^\s]+/gi, '[RPC]');
}

// === NETWORK FUNCTIONS ===
async function fetchChunkData(address, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await client.readContract({
                address,
                abi: pageAbi,
                functionName: 'read'
            });
            return hexToBytes(data);
        } catch (err) {
            if (i === retries - 1) throw err;
            const delay = 300 * Math.pow(2, i);
            await new Promise(r => setTimeout(r, Math.min(delay, 3000)));
        }
    }
}

// 개별 청크 순차 로딩 (Multicall 실패 시 폴백)
async function fetchChunksIndividually(addresses, retries = 3) {
    const results = [];
    for (const addr of addresses) {
        try {
            const data = await fetchChunkData(addr, retries);
            results.push({ success: true, data });
        } catch (err) {
            results.push({ success: false, error: sanitizeErrorMessage(err.message) });
        }
    }
    return results;
}

async function fetchChunksBatch(addresses, retries = 3) {
    if (!USE_MULTICALL || addresses.length === 0) {
        return fetchChunksIndividually(addresses, retries);
    }

    for (let i = 0; i < retries; i++) {
        try {
            const calls = addresses.map(addr => ({
                target: addr,
                allowFailure: true,
                callData: '0x57de26a4' // read() function selector
            }));

            const results = await client.readContract({
                address: MULTICALL3_ADDRESS,
                abi: multicall3Abi,
                functionName: 'aggregate3',
                args: [calls]
            });

            return results.map((result, idx) => {
                if (result.success && result.returnData !== '0x') {
                    try {
                        const decoded = decodeAbiParameters(
                            [{ type: 'bytes' }],
                            result.returnData
                        );
                        const data = hexToBytes(decoded[0]);
                        return { success: true, data };
                    } catch (e) {
                        return { success: false, error: `Decode error: ${e.message}` };
                    }
                }
                return { success: false, error: `Failed to fetch chunk ${idx}` };
            });
        } catch (err) {
            if (i === retries - 1) {
                // Multicall 최종 실패 시 개별 로딩으로 폴백
                console.log('⚠️ Multicall failed, falling back to individual loading');
                return fetchChunksIndividually(addresses, retries);
            }
            const delay = 300 * Math.pow(2, i);
            await new Promise(r => setTimeout(r, Math.min(delay, 3000)));
        }
    }
}

// === COLLECT LEAF ADDRESSES ===
async function collectLeafAddresses(rootChunk, depth) {
    const leaves = [];

    async function traverseNode(address, nodeDepth) {
        if (nodeDepth === 0) {
            leaves.push(address);
            return;
        }

        try {
            const data = await fetchChunkData(address, 3);
            const childAddrs = [];
            for (let i = 0; i < data.length; i += 20) {
                childAddrs.push(toHex(data.slice(i, i + 20)));
            }

            setPhase(`Scanning depth ${nodeDepth}: ${childAddrs.length} nodes`);

            for (const childAddr of childAddrs) {
                await traverseNode(childAddr, nodeDepth - 1);
            }
        } catch (err) {
            log(`Failed to traverse node: ${address.substring(0, 10)}...`);
            throw err;
        }
    }

    await traverseNode(rootChunk, depth);
    return leaves;
}

// === DETECT AUDIO TYPE ===
function detectAudioType(data) {
    // Check magic bytes
    // MP3: ID3 tag or sync word
    if ((data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) || // ID3
        (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0)) { // MPEG sync
        return 'audio/mpeg';
    }
    // M4A/AAC: ftyp box
    if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
        return 'audio/mp4';
    }
    // WAV: RIFF
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45) {
        return 'audio/wav';
    }
    // OGG
    if (data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
        return 'audio/ogg';
    }
    // Default
    return 'audio/mpeg';
}

// === MAIN LOADER ===
async function loadAudio(rootChunk, depth, totalSize) {
    setPhase('Scanning chunks...');

    // Phase 1: Collect addresses
    const leafAddresses = await collectLeafAddresses(rootChunk, depth);
    totalChunks = leafAddresses.length;
    log(`Found ${totalChunks} chunks`);

    // Phase 2: Load chunks in batches
    setPhase('Loading audio...');
    const chunks = [];

    for (let i = 0; i < leafAddresses.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, leafAddresses.length);
        const batch = leafAddresses.slice(i, batchEnd);

        setPhase(`Loading ${i + 1}-${batchEnd}/${totalChunks}${USE_MULTICALL ? ' (MULTICALL)' : ''}`);

        try {
            const results = await fetchChunksBatch(batch, 2);

            results.forEach((result, idx) => {
                const chunkIndex = i + idx;
                if (result.success && result.data) {
                    chunks[chunkIndex] = result.data;
                    loadedChunks++;
                    totalBytesLoaded += result.data.length;
                    updateStats();
                } else {
                    log(`Failed chunk ${chunkIndex + 1}: ${result.error}`);
                }
            });

            // Rate limiting
            if (batchEnd < leafAddresses.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (err) {
            log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
        }
    }

    // Phase 3: Assemble audio
    setPhase('Assembling audio...');
    const totalBytes = chunks.reduce((sum, c) => sum + (c?.length || 0), 0);
    const finalData = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
        if (chunk) {
            finalData.set(chunk, offset);
            offset += chunk.length;
        }
    }

    // Detect type and display
    const mimeType = detectAudioType(finalData);
    const blob = new Blob([finalData], { type: mimeType });
    const audioUrl = URL.createObjectURL(blob);

    audioPlayer.src = audioUrl;

    // iOS에서는 canplay 이벤트가 사용자 상호작용 없이 발생하지 않으므로
    // 오디오 데이터 로드 완료 시 즉시 UI 전환
    loaderContainer.style.display = 'none';
    audioContainer.classList.add('active');

    if (audioSizeEl) audioSizeEl.textContent = formatBytes(totalBytes);
    if (audioTypeEl) {
        const typeMap = {
            'audio/mpeg': 'MP3',
            'audio/mp4': 'M4A',
            'audio/wav': 'WAV',
            'audio/ogg': 'OGG'
        };
        audioTypeEl.textContent = typeMap[mimeType] || mimeType.split('/')[1].toUpperCase();
    }

    setPhase('Complete');
    log(`Audio loaded: ${totalChunks} chunks, ${formatBytes(totalBytes)}`);
}

// === INIT ===
async function init() {
    const masterAddress = params.get('master');
    let registryAddress = params.get('registry');
    let tokenId = params.get('id');
    const siteId = params.get('site'); // New simplified parameter

    if (!masterAddress && !(registryAddress && tokenId) && !siteId) {
        setPhase('ERROR: NO ADDRESS');
        log('Usage: ?master=0x... OR ?registry=0x...&id=123 OR ?site=123');
        return;
    }

    try {
        // Load config from API
        setPhase('Loading config...');
        let masterNftAddress = null;
        try {
            const configRes = await fetch('/api/config');
            if (configRes.ok) {
                const config = await configRes.json();
                RPC_URL = config.rpcUrl;
                CHUNK_SIZE = config.chunkSize || 15000;
                masterNftAddress = config.masterNftAddress;
                if (!params.get('batchSize') && config.batchSize) {
                    BATCH_SIZE = config.batchSize;
                }
            }
        } catch (e) {
            console.warn('Failed to load config, using fallback values');
        }

        // iframe 내에서 실행 중이면 RPC 프록시 사용 (CORS 회피)
        try {
            if (window.self !== window.top) {
                RPC_URL = '/api/rpc-proxy';
            }
        } catch (e) {
            RPC_URL = '/api/rpc-proxy';
        }

        // Handle simplified ?site= parameter
        if (siteId && !registryAddress) {
            if (!masterNftAddress) {
                setPhase('ERROR: MASTER NFT NOT CONFIGURED');
                log('MasterNFT address not configured.');
                return;
            }
            registryAddress = masterNftAddress;
            tokenId = siteId;
            log(`Using simplified URL: site=${siteId}`);
        }

        // Create viem client
        client = createPublicClient({
            transport: http(RPC_URL)
        });

        setPhase('Connecting...');

        let rootChunk, depth, totalSize;

        if (registryAddress && tokenId) {
            // MasterNFT Registry 모드
            log(`Registry mode: ${registryAddress}, Token ID: ${tokenId}`);
            const siteData = await client.readContract({
                address: registryAddress,
                abi: masterNFTAbi,
                functionName: 'getSiteData',
                args: [BigInt(tokenId)]
            });
            rootChunk = siteData.rootChunk;
            depth = siteData.depth;
            totalSize = siteData.totalSize;
        } else {
            // Legacy Master Contract 모드
            const info = await client.readContract({
                address: masterAddress,
                abi: masterAbi,
                functionName: 'getCurrentSiteInfo'
            });
            rootChunk = info.rootChunk;
            depth = info.depth;
            totalSize = info.totalSize;
        }

        log(`Root: ${rootChunk.substring(0, 10)}..., Depth: ${depth}`);

        await loadAudio(rootChunk, Number(depth), Number(totalSize));

    } catch (err) {
        log(`Error: ${err.message}`);
        setPhase('ERROR');
        console.error(err);
    }
}

init();
