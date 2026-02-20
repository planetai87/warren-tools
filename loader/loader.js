import { createPublicClient, http, hexToBytes, toHex, decodeAbiParameters } from "https://esm.sh/viem@2.21.0";

// URL 파라미터로 배치 사이즈 조정 가능
// /v/site=X 또는 /v/master=X 형식의 pathname도 지원
const params = new URLSearchParams(window.location.search);
const pathname = window.location.pathname;
if (pathname.startsWith('/v/site=')) {
    params.set('site', pathname.replace('/v/site=', ''));
} else if (pathname.startsWith('/v/master=')) {
    params.set('master', pathname.replace('/v/master=', ''));
}
let BATCH_SIZE = parseInt(params.get('batchSize')) || 100; // 기본값, config에서 덮어씀
const USE_MULTICALL = params.get('multicall') !== 'false'; // 기본 true
const DEBUG = params.get('debug') === 'true'; // 디버그 모드
const IS_BOT = params.get('bot') === '1'; // bot 모드: view 기록 스킵
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'; // Multicall3 (universal)

// Config will be loaded from API
let CHUNK_SIZE = 15000; // 15KB fallback
let RPC_URL = "https://mainnet.megaeth.com/rpc"; // fallback (Mainnet)
let DIG_API_URL = null;

// ABIs
// Legacy Master contract ABI
const masterAbi = [
    {
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
    }
];

// MasterNFT registry ABI
const masterNFTAbi = [
    {
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
    }
];
const pageAbi = [
    {
        name: 'read',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'bytes' }]
    }
];
const multicall3Abi = [
    {
        name: 'aggregate3',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            {
                name: 'calls',
                type: 'tuple[]',
                components: [
                    { name: 'target', type: 'address' },
                    { name: 'allowFailure', type: 'bool' },
                    { name: 'callData', type: 'bytes' }
                ]
            }
        ],
        outputs: [
            {
                name: 'returnData',
                type: 'tuple[]',
                components: [
                    { name: 'success', type: 'bool' },
                    { name: 'returnData', type: 'bytes' }
                ]
            }
        ]
    }
];

// Viem client will be created after loading config
let client = null;

// DOM Elements
const loaderContainer = document.getElementById('loader-container');
const logContainer = document.getElementById('log-container');
const donutScanned = document.getElementById('donut-scanned');
const donutLoaded = document.getElementById('donut-loaded');
const percentageDisplay = document.getElementById('percentage');
const percentageLabel = document.getElementById('percentageLabel');
const loadedCountDisplay = document.getElementById('loadedCount');
const scannedCountDisplay = document.getElementById('scannedCount');
const phaseTextDisplay = document.getElementById('phaseText');
const chunkGrid = document.getElementById('chunkGrid');
const bytesLoadedDisplay = document.getElementById('bytesLoaded');
const bytesTotalDisplay = document.getElementById('bytesTotal');

// State
let scannedChunks = 0;
let loadedChunks = 0;
let bytesLoaded = 0;
let chunkCells = [];
let expectedTotal = 0;
let isRetrying = false;

const DONUT_CIRCUMFERENCE = 251.2;

// === UTILITY FUNCTIONS ===
function log(msg) {
    console.log(msg);
    const div = document.createElement('div');
    div.textContent = `> ${msg}`;
    logContainer?.appendChild(div);
}

function setPhase(phase) {
    if (phaseTextDisplay) phaseTextDisplay.textContent = phase;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// === UI UPDATE FUNCTIONS ===
function updateDonutChart() {
    if (!donutScanned || !donutLoaded) return;

    const scannedRatio = expectedTotal > 0 ? scannedChunks / expectedTotal : 0;
    const scannedArc = Math.min(1, scannedRatio) * DONUT_CIRCUMFERENCE;
    donutScanned.setAttribute('stroke-dasharray', `${scannedArc} ${DONUT_CIRCUMFERENCE}`);

    const loadedRatio = expectedTotal > 0 ? loadedChunks / expectedTotal : 0;
    const loadedArc = loadedRatio * DONUT_CIRCUMFERENCE;
    donutLoaded.setAttribute('stroke-dasharray', `${loadedArc} ${DONUT_CIRCUMFERENCE}`);

    const percent = Math.round(loadedRatio * 100);
    if (percentageDisplay) percentageDisplay.textContent = `${percent}%`;
    if (percentageLabel) {
        percentageLabel.textContent = isRetrying ? 'RETRY' : 'LOADING';
    }

    if (loadedCountDisplay) loadedCountDisplay.textContent = String(loadedChunks);
    if (scannedCountDisplay) scannedCountDisplay.textContent = String(scannedChunks);
    if (bytesLoadedDisplay) bytesLoadedDisplay.textContent = formatBytes(bytesLoaded);
}

function initChunkGrid(total) {
    if (!chunkGrid) return;
    chunkGrid.innerHTML = '';
    chunkCells = [];

    const cols = Math.min(10, Math.ceil(Math.sqrt(total)));
    chunkGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    for (let i = 0; i < total; i++) {
        const cell = document.createElement('div');
        cell.className = 'chunk chunk-pending';
        cell.title = `Chunk #${i + 1}`;
        chunkGrid.appendChild(cell);
        chunkCells.push(cell);
    }
}

function updateChunkScanned(index) {
    if (index >= 0 && index < chunkCells.length) {
        chunkCells[index].className = 'chunk chunk-scanned';
    }
    scannedChunks++;
    updateDonutChart();
}

function updateChunkLoading(index) {
    if (index >= 0 && index < chunkCells.length) {
        chunkCells[index].className = 'chunk chunk-loading';
    }
}

function updateChunkLoaded(index) {
    if (index >= 0 && index < chunkCells.length) {
        chunkCells[index].className = 'chunk chunk-loaded';
    }
    loadedChunks++;
    updateDonutChart();
}

function updateChunkFailed(index) {
    if (index >= 0 && index < chunkCells.length) {
        chunkCells[index].className = 'chunk chunk-failed';
    }
}

function updateChunkRetrying(index) {
    if (index >= 0 && index < chunkCells.length) {
        chunkCells[index].className = 'chunk chunk-loading';
    }
}

// === UTILITY: Error message sanitization ===
// RPC URL을 에러 메시지에서 제거 (보안)
function sanitizeErrorMessage(message) {
    if (!message) return 'Unknown error';
    return message.replace(/https?:\/\/[^\s]+/gi, '[RPC]')
                  .replace(/wss?:\/\/[^\s]+/gi, '[RPC]');
}

// === NETWORK FUNCTIONS ===
// Fast sequential chunk fetch (no delay between requests)
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
            const delay = 200 * Math.pow(2, i);
            await new Promise(r => setTimeout(r, Math.min(delay, 2000)));
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

// Multicall을 사용하여 여러 청크를 한번에 가져오기
async function fetchChunksBatch(addresses, retries = 3) {
    if (!USE_MULTICALL || addresses.length === 0) {
        // Multicall 비활성화 시 순차 처리
        return fetchChunksIndividually(addresses, retries);
    }

    // Multicall3 사용
    for (let i = 0; i < retries; i++) {
        try {
            // Page.read() 함수 호출을 위한 calldata 생성
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

            // 결과 파싱
            return results.map((result, idx) => {
                if (result.success && result.returnData !== '0x') {
                    try {
                        // viem의 decodeAbiParameters를 사용하여 정확한 ABI 디코딩
                        const decoded = decodeAbiParameters(
                            [{ type: 'bytes' }],
                            result.returnData
                        );
                        const data = hexToBytes(decoded[0]);

                        if (DEBUG) {
                            console.log(`📦 Multicall chunk #${idx}: ${data.length} bytes`);
                        }

                        return { success: true, data };
                    } catch (e) {
                        if (DEBUG) {
                            console.error(`❌ Failed to decode chunk #${idx}:`, e.message);
                        }
                        return { success: false, error: `Decode error: ${e.message}` };
                    }
                }
                return { success: false, error: `Failed to fetch chunk ${idx}` };
            });
        } catch (err) {
            if (i === retries - 1) {
                // Multicall 최종 실패 시 개별 로딩으로 폴백
                if (DEBUG) console.log('⚠️ Multicall failed, falling back to individual loading');
                return fetchChunksIndividually(addresses, retries);
            }
            const delay = 300 * Math.pow(2, i);
            await new Promise(r => setTimeout(r, Math.min(delay, 3000)));
        }
    }
}

// === PHASE 1: COLLECT ALL LEAF ADDRESSES ===
async function collectLeafAddresses(rootChunk, depth) {
    const leaves = [];
    let currentIndex = 0;

    async function traverseNode(address, nodeDepth) {
        if (nodeDepth === 0) {
            leaves.push({ index: currentIndex++, address });
            updateChunkScanned(leaves.length - 1);
            return;
        }

        try {
            const data = await fetchChunkData(address, 3);
            const childAddrs = [];
            for (let i = 0; i < data.length; i += 20) {
                childAddrs.push(toHex(data.slice(i, i + 20)));
            }

            setPhase(`SCAN DEPTH ${nodeDepth}: ${childAddrs.length} nodes`);

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

// === PHASE 2: BATCH LOADING (Multicall 지원) ===
async function loadChunksInBatches(leaves) {
    const chunks = [];
    const failed = [];

    // 배치로 나누기
    for (let i = 0; i < leaves.length; i += BATCH_SIZE) {
        const batch = leaves.slice(i, Math.min(i + BATCH_SIZE, leaves.length));
        const batchAddresses = batch.map(l => l.address);

        setPhase(`LOADING ${i + 1}-${Math.min(i + BATCH_SIZE, leaves.length)} / ${leaves.length}${USE_MULTICALL ? ' (MULTICALL)' : ''}`);

        // 배치 내 모든 청크를 로딩 상태로 표시
        batch.forEach(leaf => updateChunkLoading(leaf.index));

        try {
            const results = await fetchChunksBatch(batchAddresses, 2);

            // 결과 검증 및 처리
            if (results.length !== batch.length) {
                console.error(`Result count mismatch: expected ${batch.length}, got ${results.length}`);
            }

            results.forEach((result, idx) => {
                const leaf = batch[idx];
                if (result.success && result.data) {
                    chunks.push({ index: leaf.index, data: result.data });
                    bytesLoaded += result.data.length;
                    updateChunkLoaded(leaf.index);

                    if (DEBUG) {
                        console.log(`✅ Chunk #${leaf.index}: ${result.data.length} bytes`);
                    }
                } else {
                    failed.push(leaf);
                    updateChunkFailed(leaf.index);
                    log(`❌ Chunk #${leaf.index + 1}: ${result.error || 'Unknown error'}`);
                }
            });
        } catch (err) {
            // 배치 전체 실패
            batch.forEach(leaf => {
                failed.push(leaf);
                updateChunkFailed(leaf.index);
            });
            log(`Batch ${i / BATCH_SIZE + 1} failed: ${err.message}`);
        }

        // 다음 배치 전 짧은 대기 (RPC 부하 감소)
        if (i + BATCH_SIZE < leaves.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    // 최종 검증
    if (DEBUG) {
        console.log(`Total chunks collected: ${chunks.length}, Expected: ${leaves.length}, Failed: ${failed.length}`);
        const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);
        for (let i = 0; i < sortedChunks.length; i++) {
            if (sortedChunks[i].index !== i) {
                console.error(`⚠️ Missing chunk at index ${i}`);
            }
        }
    }

    return { chunks, failed };
}

// === PHASE 3: RETRY FAILED CHUNKS ===
async function retryFailedChunks(failed, chunks) {
    if (failed.length === 0) return;

    isRetrying = true;
    let retryRound = 0;
    let toRetry = [...failed];

    while (toRetry.length > 0 && retryRound < 5) {
        retryRound++;
        const stillFailed = [];

        setPhase(`RETRY ${retryRound}: ${toRetry.length} chunks`);
        log(`Retry round ${retryRound}: ${toRetry.length} chunks`);

        await new Promise(r => setTimeout(r, 500 * retryRound));

        for (const leaf of toRetry) {
            updateChunkRetrying(leaf.index);

            try {
                const data = await fetchChunkData(leaf.address, 3);
                chunks.push({ index: leaf.index, data });
                bytesLoaded += data.length;
                updateChunkLoaded(leaf.index);
            } catch (err) {
                stillFailed.push(leaf);
                updateChunkFailed(leaf.index);
            }

            await new Promise(r => setTimeout(r, 100));
        }

        toRetry = stillFailed;
    }

    isRetrying = false;

    if (toRetry.length > 0) {
        log(`${toRetry.length} chunks permanently failed`);
    }
}

// === MAIN LOADER (BATCH/MULTICALL) ===
async function fetchTreeSequential(rootChunk, depth, totalSize) {
    initChunkGrid(expectedTotal);

    log(`Loader Config: BatchSize=${BATCH_SIZE}, Multicall=${USE_MULTICALL ? 'ON' : 'OFF'}, Debug=${DEBUG ? 'ON' : 'OFF'}`);

    // Phase 1: Collect all leaf addresses
    setPhase('PHASE 1: SCANNING');
    log("Phase 1: Collecting chunk addresses...");
    const leaves = await collectLeafAddresses(rootChunk, depth);
    log(`Found ${leaves.length} leaf chunks`);

    // Phase 2: Batch loading with optional multicall
    setPhase('PHASE 2: LOADING');
    log(`Phase 2: Loading in batches (${BATCH_SIZE} per batch)...`);
    const { chunks, failed } = await loadChunksInBatches(leaves);
    log(`Loaded: ${chunks.length}, Failed: ${failed.length}`);

    // Phase 3: Retry failed chunks
    if (failed.length > 0) {
        setPhase('PHASE 3: RETRY');
        log("Phase 3: Retrying failed chunks...");
        await retryFailedChunks(failed, chunks);
    }

    // Sort by index and assemble
    chunks.sort((a, b) => a.index - b.index);

    setPhase('ASSEMBLING');
    const totalBytes = chunks.reduce((sum, c) => sum + c.data.length, 0);
    const finalData = new Uint8Array(totalBytes);

    let offset = 0;
    for (const chunk of chunks) {
        finalData.set(chunk.data, offset);
        offset += chunk.data.length;
    }

    if (bytesTotalDisplay) bytesTotalDisplay.textContent = formatBytes(totalBytes);

    log(`Complete! ${chunks.length} chunks, ${formatBytes(totalBytes)}`);
    return finalData;
}

// === SITE TYPE REDIRECT ===
// siteType: 0=file, 1=archive, 2=namecard, 3=image, 4=video, 5=audio, 6=construct, 99=unlink
function redirectToSpecializedLoader(siteType, addressOrParams) {
    const loaders = {
        3: '/image-loader.html',  // image
        4: '/video-loader.html',  // video
        5: '/audio-loader.html',  // audio
    };

    const loaderUrl = loaders[siteType];
    if (loaderUrl) {
        const currentParams = new URLSearchParams(window.location.search);

        if (addressOrParams.includes('&id=')) {
            const [registry, idPart] = addressOrParams.split('&id=');
            currentParams.set('registry', registry);
            currentParams.set('id', idPart);
            currentParams.delete('master');
        } else {
            currentParams.set('master', addressOrParams);
        }

        window.location.href = `${loaderUrl}?${currentParams.toString()}`;
        return true;
    }
    return false;
}

// === INIT ===
async function init() {
    const masterAddress = params.get('master');
    let registryAddress = params.get('registry');
    let tokenId = params.get('id');
    let siteId = params.get('site'); // New simplified parameter
    // .mega gateway mode: read siteId from global variable injected by resolve API
    if (!siteId && window.__WARREN_MEGA_SITE) {
        siteId = window.__WARREN_MEGA_SITE;
    }

    // Load config from API first (for subdomain mode support)
    setPhase('LOADING CONFIG');
    let masterNftAddress = null;
    let configSiteId = null;
    try {
        const configRes = await fetch('/api/config');
        if (configRes.ok) {
            const config = await configRes.json();
            RPC_URL = config.rpcUrl;
            CHUNK_SIZE = config.chunkSize || 15000;
            masterNftAddress = config.masterNftAddress;
            configSiteId = config.siteId; // Subdomain mode: siteId from server
            DIG_API_URL = config.digApiUrl || null;
            // URL 파라미터가 없으면 서버 설정 사용
            if (!params.get('batchSize') && config.batchSize) {
                BATCH_SIZE = config.batchSize;
            }
            if (DEBUG) console.log(`Config loaded: RPC=${RPC_URL}, BatchSize=${BATCH_SIZE}, siteId=${configSiteId}`);
        }
    } catch (e) {
        console.warn('Failed to load config, using fallback values');
    }

    // iframe 내에서 실행 중이면 RPC 프록시 사용 (CORS 회피)
    try {
        if (window.self !== window.top) {
            RPC_URL = '/api/rpc-proxy';
            if (DEBUG) console.log('Running in iframe, using RPC proxy');
        }
    } catch (e) {
        // cross-origin iframe에서 window.top 접근 시 에러 → iframe 확정
        RPC_URL = '/api/rpc-proxy';
        if (DEBUG) console.log('Cross-origin iframe detected, using RPC proxy');
    }

    // Subdomain mode: use siteId from config if not provided in URL
    if (!siteId && configSiteId) {
        siteId = String(configSiteId);
        log(`Subdomain mode: site=${siteId}`);
    }

    if (!masterAddress && !(registryAddress && tokenId) && !siteId) {
        setPhase('ERROR: NO ADDRESS');
        log('Usage: ?master=0x... OR ?registry=0x...&id=123 OR ?site=123 OR via subdomain');
        return;
    }

    try {
        // Handle simplified ?site= parameter (or subdomain mode siteId)
        if (siteId && !registryAddress) {
            if (!masterNftAddress) {
                setPhase('ERROR: MASTER NFT NOT CONFIGURED');
                log('MasterNFT address not configured. Use ?registry=0x...&id=123 instead.');
                return;
            }
            registryAddress = masterNftAddress;
            tokenId = siteId;
            if (!configSiteId) {
                log(`Using simplified URL: site=${siteId}`);
            }
        }

        // Create viem client with loaded config
        client = createPublicClient({
            transport: http(RPC_URL)
        });

        setPhase('CONNECTING');

        let rootChunk, depth, totalSize, siteType;
        let displayAddress = masterAddress;

        if (registryAddress && tokenId) {
            // MasterNFT Registry 모드
            setPhase('READING NFT REGISTRY');
            log(`Registry: ${registryAddress.substring(0, 10)}..., Token ID: ${tokenId}`);

            const siteData = await client.readContract({
                address: registryAddress,
                abi: masterNFTAbi,
                functionName: 'getSiteData',
                args: [BigInt(tokenId)]
            });

            ({ rootChunk, depth, totalSize, siteType } = siteData);
            displayAddress = `${registryAddress}&id=${tokenId}`;
            log(`Version: ${siteData.version}, Creator: ${siteData.creator.substring(0, 10)}...`);
        } else {
            // Legacy Master 모드
            setPhase('READING CONTRACT');
            const info = await client.readContract({
                address: masterAddress,
                abi: masterAbi,
                functionName: 'getCurrentSiteInfo'
            });
            ({ rootChunk, depth, totalSize, siteType } = info);
        }

        log(`Root: ${rootChunk.substring(0, 10)}..., Depth: ${depth}, SiteType: ${siteType}`);

        // Check if we need to redirect to a specialized loader
        const numSiteType = Number(siteType);
        if (redirectToSpecializedLoader(numSiteType, displayAddress)) {
            return; // Redirecting to specialized loader
        }

        expectedTotal = Math.ceil(Number(totalSize) / CHUNK_SIZE);
        if (bytesTotalDisplay) bytesTotalDisplay.textContent = formatBytes(Number(totalSize));

        // Use sequential loader (no multicall)
        const htmlData = await fetchTreeSequential(rootChunk, Number(depth), Number(totalSize));

        setPhase('RENDERING');

        // Encoding detection and decoding
        const asciiPreview = new TextDecoder('ascii', { fatal: false }).decode(htmlData.slice(0, 2000));
        const charsetMatch = asciiPreview.match(/charset=["']?(euc-kr|cp949|ks_c_5601-1987)/i);

        let htmlString;
        if (charsetMatch) {
            log(`Encoding detected: ${charsetMatch[1]}`);
            htmlString = new TextDecoder('euc-kr').decode(htmlData);
        } else {
            htmlString = new TextDecoder('utf-8').decode(htmlData);
        }

        // Record view first (fire-and-forget) before top-level render replaces this document
        if (siteId && DIG_API_URL && !IS_BOT) {
            fetch(`${DIG_API_URL}/api/dig/site/${siteId}/view`, { method: 'POST', keepalive: true }).catch(() => {});
        }

        loaderContainer.style.display = 'none';

        // Render final content at top-level (avoids iframe/srcdoc provider-context issues)
        document.open();
        document.write(htmlString);
        document.close();

        // best-effort marker (only available until document is replaced)
        window.__WARREN_LOADED = true;

    } catch (err) {
        log(`Error: ${err.message}`);
        setPhase('ERROR');
        console.error(err);
    }
}

init();
