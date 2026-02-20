import { createPublicClient, http, hexToBytes, toHex, decodeAbiParameters } from "https://esm.sh/viem@2.21.0";

// URL 파라미터
const params = new URLSearchParams(window.location.search);
let BATCH_SIZE = parseInt(params.get('batchSize')) || 100; // config에서 덮어씀
const USE_MULTICALL = params.get('multicall') !== 'false';
const DEBUG = params.get('debug') === 'true';
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Config will be loaded from API
let CHUNK_SIZE = 15000; // 15KB fallback
let RPC_URL = "https://mainnet.megaeth.com/rpc";
const HEADER_OFFSET = 4; // 4 bytes for header length

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
const videoContainer = document.getElementById('video-container');
const videoPlayer = document.getElementById('video-player');
const streamDot = document.getElementById('streamDot');
const streamStatus = document.getElementById('streamStatus');
const bufferBar = document.getElementById('bufferBar');
const bufferText = document.getElementById('bufferText');
const chunksLoadedEl = document.getElementById('chunksLoaded');
const bytesLoadedEl = document.getElementById('bytesLoaded');
const bufferSecondsEl = document.getElementById('bufferSeconds');
const phaseTextEl = document.getElementById('phaseText');
const videoSizeEl = document.getElementById('videoSize');
const videoCodecEl = document.getElementById('videoCodec');
const overlayBufferedEl = document.getElementById('overlayBuffered');
const overlayChunksEl = document.getElementById('overlayChunks');

// State
let mediaSource = null;
let sourceBuffer = null;
let totalChunks = 0;
let loadedChunks = 0;
let totalBytesLoaded = 0;
let isPlaying = false;
let leafAddresses = [];
let chunkDataMap = new Map(); // chunkIndex -> Uint8Array
let segmentMap = []; // from header
let headerLength = 0;
let initSegmentAppended = false;

// === UTILITY FUNCTIONS ===
function log(msg) {
    console.log(`[Stream] ${msg}`);
}

function setPhase(phase) {
    if (phaseTextEl) phaseTextEl.textContent = phase;
}

function setStreamStatus(status, state = 'buffering') {
    if (streamStatus) streamStatus.textContent = status;
    if (streamDot) streamDot.className = 'stream-dot ' + state;
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
    if (bufferBar) bufferBar.style.width = percent + '%';
    if (bufferText) bufferText.textContent = percent + '%';

    if (overlayChunksEl) overlayChunksEl.textContent = `${loadedChunks}/${totalChunks}`;
    if (overlayBufferedEl) overlayBufferedEl.textContent = percent + '%';

    if (videoPlayer && videoPlayer.buffered.length > 0) {
        const bufferedEnd = videoPlayer.buffered.end(0);
        if (bufferSecondsEl) bufferSecondsEl.textContent = bufferedEnd.toFixed(1) + 's';
    }
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

// Multicall batch loading
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

                        if (DEBUG) {
                            console.log(`📦 Video chunk #${idx}: ${data.length} bytes`);
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

// === PARSE HEADER TO GET SEGMENT MAP ===
function parseHeaderFromChunks() {
    // First 4 bytes = header length
    const chunk0 = chunkDataMap.get(0);
    if (!chunk0 || chunk0.length < 4) {
        log('Chunk 0 not loaded yet');
        return null;
    }

    const view = new DataView(chunk0.buffer, chunk0.byteOffset, 4);
    headerLength = view.getUint32(0);
    log(`Header length: ${headerLength} bytes`);

    // Collect enough chunks to read the full header
    const headerEnd = 4 + headerLength;
    const chunksNeeded = Math.ceil(headerEnd / CHUNK_SIZE);

    for (let i = 0; i < chunksNeeded; i++) {
        if (!chunkDataMap.has(i)) {
            log(`Need chunk ${i} for header, not loaded yet`);
            return null;
        }
    }

    // Assemble header bytes
    const headerBytes = new Uint8Array(headerLength);
    let offset = 4; // skip the 4-byte length
    let headerBytesOffset = 0;

    for (let i = 0; i < chunksNeeded && headerBytesOffset < headerLength; i++) {
        const chunk = chunkDataMap.get(i);
        const startInChunk = (i === 0) ? 4 : 0;
        const available = chunk.length - startInChunk;
        const needed = headerLength - headerBytesOffset;
        const toCopy = Math.min(available, needed);

        headerBytes.set(chunk.slice(startInChunk, startInChunk + toCopy), headerBytesOffset);
        headerBytesOffset += toCopy;
    }

    // Parse JSON
    try {
        const jsonStr = new TextDecoder().decode(headerBytes);
        const parsed = JSON.parse(jsonStr);
        log(`Parsed segment map: ${parsed.length} segments`);
        return parsed;
    } catch (e) {
        log(`Header parse error: ${e.message}`);
        return null;
    }
}

// === ADJUST SEGMENT BYTE OFFSETS FOR HEADER ===
function adjustSegmentOffsets(segments) {
    const headerSize = 4 + headerLength;
    return segments.map(seg => ({
        ...seg,
        // Adjust byte positions to account for [4-byte len][header] prefix
        adjustedByteStart: seg.byteStart + headerSize,
        adjustedByteEnd: seg.byteEnd + headerSize,
        adjustedChunkStart: Math.floor((seg.byteStart + headerSize) / CHUNK_SIZE),
        adjustedChunkEnd: Math.ceil((seg.byteEnd + headerSize) / CHUNK_SIZE)
    }));
}

// === CHECK IF SEGMENT IS COMPLETE ===
function isSegmentComplete(segment) {
    for (let i = segment.adjustedChunkStart; i < segment.adjustedChunkEnd; i++) {
        if (!chunkDataMap.has(i)) return false;
    }
    return true;
}

// === EXTRACT SEGMENT DATA FROM CHUNKS ===
function extractSegmentData(segment) {
    const headerSize = 4 + headerLength;
    const chunks = [];

    for (let i = segment.adjustedChunkStart; i < segment.adjustedChunkEnd; i++) {
        chunks.push(chunkDataMap.get(i));
    }

    // Calculate byte positions within assembled chunks
    const firstChunkOffset = segment.adjustedChunkStart * CHUNK_SIZE;
    const startInData = (segment.byteStart + headerSize) - firstChunkOffset;
    const segmentLength = segment.byteEnd - segment.byteStart;

    // Assemble chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const assembled = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.length;
    }

    // Extract segment
    return assembled.slice(startInData, startInData + segmentLength);
}

// === MEDIA SOURCE SETUP ===
let selectedMimeType = 'video/mp4';

function setupMediaSource(mimeType) {
    selectedMimeType = mimeType;
    return new Promise((resolve, reject) => {
        mediaSource = new MediaSource();
        videoPlayer.src = URL.createObjectURL(mediaSource);

        mediaSource.addEventListener('sourceopen', () => {
            log('MediaSource opened');
            log(`Adding SourceBuffer with: ${mimeType}`);

            try {
                sourceBuffer = mediaSource.addSourceBuffer(mimeType);
                sourceBuffer.mode = 'sequence';

                sourceBuffer.addEventListener('error', (e) => {
                    log('SourceBuffer error: ' + e);
                });

                if (videoCodecEl) videoCodecEl.textContent = 'fMP4/H.264';
                resolve();
            } catch (e) {
                log('Failed to add SourceBuffer: ' + e.message);
                reject(e);
            }
        });

        mediaSource.addEventListener('error', (e) => {
            reject(new Error('MediaSource error'));
        });
    });
}

// === APPEND SEGMENT TO SOURCEBUFFER ===
async function appendSegment(segmentData) {
    return new Promise((resolve, reject) => {
        if (!sourceBuffer || sourceBuffer.updating) {
            setTimeout(() => appendSegment(segmentData).then(resolve).catch(reject), 50);
            return;
        }

        const onUpdateEnd = () => {
            sourceBuffer.removeEventListener('updateend', onUpdateEnd);
            resolve();
        };

        sourceBuffer.addEventListener('updateend', onUpdateEnd);

        try {
            sourceBuffer.appendBuffer(segmentData);
        } catch (e) {
            sourceBuffer.removeEventListener('updateend', onUpdateEnd);
            reject(e);
        }
    });
}

// === PLAYBACK CONTROL ===
function startPlayback() {
    if (isPlaying) return;

    isPlaying = true;
    setStreamStatus('Streaming', 'playing');

    loaderContainer.style.display = 'none';
    videoContainer.classList.add('active');

    videoPlayer.muted = true;
    videoPlayer.play().then(() => {
        log('Playback started (muted - click video to unmute)');
    }).catch(e => {
        log('Auto-play blocked: ' + e.message);
    });
}

// === MAIN STREAMING LOGIC ===
async function streamVideoWithSegments(rootChunk, depth, totalSize, mimeType) {
    setPhase('Scanning chunks...');
    setStreamStatus('Scanning...', 'buffering');

    // Phase 1: Collect addresses
    leafAddresses = await collectLeafAddresses(rootChunk, depth);
    totalChunks = leafAddresses.length;
    log(`Found ${totalChunks} chunks`);

    // Setup MediaSource
    setPhase('Setting up player...');
    await setupMediaSource(mimeType);

    // Phase 2: Load chunks and process segments
    setPhase('Buffering...');
    setStreamStatus('Buffering...', 'buffering');

    let segmentsParsed = false;
    let adjustedSegments = [];
    let nextSegmentToAppend = 0;

    // Phase 2: Load chunks in batches with optional multicall
    for (let i = 0; i < leafAddresses.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, leafAddresses.length);
        const batch = leafAddresses.slice(i, batchEnd);

        setPhase(`Loading ${i + 1}-${batchEnd}/${totalChunks}${USE_MULTICALL ? ' (MULTICALL)' : ''}`);

        try {
            const results = await fetchChunksBatch(batch, 2);

            results.forEach((result, idx) => {
                const chunkIndex = i + idx;
                if (result.success && result.data) {
                    chunkDataMap.set(chunkIndex, result.data);
                    loadedChunks++;
                    totalBytesLoaded += result.data.length;
                    updateStats();
                } else {
                    log(`Failed chunk ${chunkIndex + 1}: ${result.error}`);
                }
            });

            // Process loaded chunks
            const firstChunkInBatch = i;

            // Parse header once we have enough chunks
            if (!segmentsParsed) {
                segmentMap = parseHeaderFromChunks();
                if (segmentMap) {
                    adjustedSegments = adjustSegmentOffsets(segmentMap);
                    segmentsParsed = true;
                    log(`Segments ready: ${adjustedSegments.length} segments`);
                }
            }

            // Try to append complete segments
            if (segmentsParsed) {
                while (nextSegmentToAppend < adjustedSegments.length) {
                    const seg = adjustedSegments[nextSegmentToAppend];

                    if (!isSegmentComplete(seg)) break;

                    const segData = extractSegmentData(seg);
                    log(`Appending ${seg.type} segment ${nextSegmentToAppend}: ${formatBytes(segData.length)}`);

                    try {
                        await appendSegment(segData);

                        // Start playback after init segment + first media segment
                        if (!isPlaying && nextSegmentToAppend >= 1) {
                            startPlayback();
                        }
                    } catch (e) {
                        log(`Segment append error: ${e.message}`);
                    }

                    nextSegmentToAppend++;
                }
            }

            // Rate limiting between batches
            if (batchEnd < leafAddresses.length) {
                await new Promise(r => setTimeout(r, 100));
            }

        } catch (err) {
            log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
        }
    }

    // Append any remaining segments
    while (nextSegmentToAppend < adjustedSegments.length) {
        const seg = adjustedSegments[nextSegmentToAppend];
        if (!isSegmentComplete(seg)) break;

        const segData = extractSegmentData(seg);
        log(`Final append ${seg.type} segment ${nextSegmentToAppend}: ${formatBytes(segData.length)}`);

        try {
            await appendSegment(segData);
        } catch (e) {
            log(`Final segment error: ${e.message}`);
        }
        nextSegmentToAppend++;
    }

    // End stream
    if (mediaSource.readyState === 'open') {
        try {
            mediaSource.endOfStream();
        } catch (e) {
            log('EndOfStream error: ' + e.message);
        }
    }

    if (!isPlaying) startPlayback();

    setPhase('Complete');
    if (videoSizeEl) videoSizeEl.textContent = formatBytes(totalBytesLoaded);
    log(`Streaming complete: ${totalChunks} chunks, ${adjustedSegments.length} segments`);
}

// === Check if data is raw MP4 (ftyp box) ===
function isRawMP4(data) {
    // MP4 files start with ftyp box: [size][ftyp]
    // Check for 'ftyp' at bytes 4-7
    if (data.length < 8) return false;
    return data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70;
}

// === Detect video MIME type from magic bytes ===
function detectVideoMimeType(data) {
    if (data.length < 12) return 'video/mp4';

    // WebM: starts with 0x1A 0x45 0xDF 0xA3
    if (data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) {
        return 'video/webm';
    }

    // MP4/MOV: ftyp box
    if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
        return 'video/mp4';
    }

    return 'video/mp4'; // default
}

// === FALLBACK: Non-streaming load ===
async function fallbackLoad(rootChunk, depth, totalSize) {
    log('Using direct playback mode...');
    setPhase('Loading video...');

    leafAddresses = await collectLeafAddresses(rootChunk, depth);
    totalChunks = leafAddresses.length;

    const chunks = new Array(leafAddresses.length);

    // 멀티콜 배치 로딩 (iOS 포함 모든 플랫폼)
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

            // Rate limiting between batches
            if (batchEnd < leafAddresses.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (err) {
            log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
        }
    }

    // Assemble (filter out failed chunks)
    const validChunks = chunks.filter(c => c != null);
    const totalBytes = validChunks.reduce((sum, c) => sum + c.length, 0);
    const finalData = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of validChunks) {
        finalData.set(chunk, offset);
        offset += chunk.length;
    }

    let videoData;

    // Check if raw MP4/video (no header) or has segment header
    if (isRawMP4(finalData)) {
        // Raw MP4 binary - use directly
        log('Detected raw MP4 binary');
        videoData = finalData;
    } else {
        // Has header - try to parse
        try {
            const view = new DataView(finalData.buffer);
            const hdrLen = view.getUint32(0);
            if (hdrLen < totalBytes && hdrLen < 10000) {
                // Reasonable header length, extract video data
                videoData = finalData.slice(4 + hdrLen);
                log(`Extracted video from header (${hdrLen} bytes)`);
            } else {
                // Header doesn't make sense, use as raw
                videoData = finalData;
                log('Using data as raw video');
            }
        } catch {
            videoData = finalData;
            log('Using data as raw video (parse failed)');
        }
    }

    const mimeType = detectVideoMimeType(videoData);
    log(`Video MIME type: ${mimeType}`);

    const blob = new Blob([videoData], { type: mimeType });
    videoPlayer.src = URL.createObjectURL(blob);

    loaderContainer.style.display = 'none';
    videoContainer.classList.add('active');
    videoPlayer.play().catch(e => {
        log('Auto-play blocked, click to play');
    });

    if (videoSizeEl) videoSizeEl.textContent = formatBytes(videoData.length);
    setPhase('Complete');
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
        // Load config from API (RPC URL with env vars)
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
                if (DEBUG) console.log(`Config loaded: RPC=${RPC_URL}, BatchSize=${BATCH_SIZE}`);
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

        // Create viem client with loaded config
        client = createPublicClient({
            transport: http(RPC_URL)
        });

        setPhase('Connecting...');
        setStreamStatus('Connecting...', 'buffering');

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

        // Auto-detect streaming mode: Check if data has segment header
        // First, peek at the beginning to detect format
        const forceRaw = params.get('raw') === 'true';

        if (forceRaw) {
            // Forced raw mode - use direct playback
            log('Using direct playback mode (forced)');
            await fallbackLoad(rootChunk, Number(depth), Number(totalSize));
        } else {
            // Try streaming mode first (for fMP4 with segment headers)
            // Check MediaSource support
            const mimeTypes = [
                'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
                'video/mp4; codecs="avc1.42E01E"',
                'video/mp4; codecs="avc1.4D401E"',
                'video/mp4',
            ];

            let supportedMime = null;
            if ('MediaSource' in window) {
                for (const mime of mimeTypes) {
                    if (MediaSource.isTypeSupported(mime)) {
                        supportedMime = mime;
                        log(`MediaSource supports: ${mime}`);
                        break;
                    }
                }
            }

            if (supportedMime) {
                try {
                    log(`Trying segment-based streaming with: ${supportedMime}`);
                    await streamVideoWithSegments(rootChunk, Number(depth), Number(totalSize), supportedMime);
                } catch (streamErr) {
                    log(`Streaming failed: ${streamErr.message}, falling back to direct playback`);
                    await fallbackLoad(rootChunk, Number(depth), Number(totalSize));
                }
            } else {
                log('MediaSource not supported, using direct playback');
                await fallbackLoad(rootChunk, Number(depth), Number(totalSize));
            }
        }

    } catch (err) {
        log(`Error: ${err.message}`);
        setPhase('ERROR');
        console.error(err);
    }
}

// Start
init();

// Update buffer stats periodically
setInterval(updateStats, 1000);
