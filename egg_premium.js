// egg_premium.js — Abstract NFT monitor with Egg Type lookup
// Monitors wallet for incoming NFT transfers, saves to JSON, polls Abstract RPC safely.

const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { ethers } = require("ethers");

// ======================= Config =======================
const RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const WATCH_WALLET = (process.env.WATCH_WALLET || "").toLowerCase();
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS).trim();

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "3000", 10);
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "2", 10);
const CHUNK = parseInt(process.env.CHUNK || "2000", 10);
const INIT_LOOKBACK = parseInt(process.env.INIT_LOOKBACK || "50000", 10);

if (!ethers.isAddress(WATCH_WALLET))
  throw new Error("WATCH_WALLET invalid or missing");
if (!ethers.isAddress(CONTRACT_ADDRESS))
  throw new Error("CONTRACT_ADDRESS invalid or missing");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const ERC721_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC721_ABI, provider);

// ======================= Paths =======================
const OUT_PATH = path.resolve("./incoming_transfers.json");
const PROGRESS_PATH = path.resolve("./last_processed.json");
const EGG_CACHE_PATH = path.resolve("./egg_cache.json");

// ======================= Helpers =======================
function loadJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function loadDb() {
  return loadJson(OUT_PATH, []);
}
function saveDb(rows) {
  saveJson(OUT_PATH, rows);
}
function makeKey(row) {
  return `${row.txHash.toLowerCase()}_${row.tokenId}`;
}
function loadProgress() {
  const d = loadJson(PROGRESS_PATH, { lastProcessed: 0 });
  return d.lastProcessed || 0;
}
function saveProgress(height) {
  saveJson(PROGRESS_PATH, { lastProcessed: height });
}

// ======================= Egg Type fetcher =======================
const eggCache = loadJson(EGG_CACHE_PATH, {});
function saveEggCache() {
  saveJson(EGG_CACHE_PATH, eggCache);
}

function parseEggTypeFromJson(json) {
  if (!json || !Array.isArray(json.attributes)) return null;
  const attr = json.attributes.find(
    (a) => String(a?.trait_type).toLowerCase() === "egg type"
  );
  return attr?.value || null;
}

async function fetchEggType(tokenId) {
  const key = String(tokenId);
  if (eggCache[key]?.eggType) return eggCache[key].eggType;

  const url = `https://gigaverse.io/api/pets/metadatav2/${encodeURIComponent(
    key
  )}`;
  let eggType = "Unknown";
  try {
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      const found = parseEggTypeFromJson(json);
      if (found) eggType = found;
      else log(`No 'Egg Type' found in response for token ${key}`);
    } else {
      log(`Egg API returned ${res.status} for ${url}`);
    }
  } catch (err) {
    log(`Egg API error for ${key}: ${err.message}`);
  }

  eggCache[key] = { eggType, cachedAt: new Date().toISOString() };
  saveEggCache();
  return eggType;
}

// ======================= Core =======================
async function enrichAndPersist(from, to, tokenId, logObj) {
  const block = await provider.getBlock(logObj.blockNumber);
  const isoDate = new Date(block.timestamp * 1000).toISOString();

  // Fetch egg type once per token
  const eggType = await fetchEggType(tokenId);

  const row = {
    receivedTo: to,
    sender: from,
    tokenId: tokenId.toString(),
    eggType,
    blockNumber: logObj.blockNumber,
    txHash: logObj.transactionHash,
    dateISO: isoDate,
  };

  const db = loadDb();
  const key = makeKey(row);
  if (!db.find((x) => makeKey(x) === key)) {
    db.push(row);
    db.sort((a, b) => b.blockNumber - a.blockNumber);
    saveDb(db);
    log("NEW", JSON.stringify(row));
  }
}

async function querySlice(filter, start, end) {
  const logs = await contract.queryFilter(filter, start, end);
  for (const ev of logs) {
    const fromAddr = (ev.args?.from || ev.args?.[0] || "").toLowerCase();
    const toAddr = (ev.args?.to || ev.args?.[1] || "").toLowerCase();
    const tokenId = ev.args?.tokenId ?? ev.args?.[2];
    await enrichAndPersist(fromAddr, toAddr, tokenId, ev.log ?? ev);
  }
}

async function scanHistorical() {
  const latest = await provider.getBlockNumber();
  let fromBlock;
  const progress = loadProgress();

  if (progress > 0) {
    fromBlock = Math.max(0, progress - CONFIRMATIONS);
    log(`Resuming from progress: ${fromBlock}`);
  } else if (process.env.FROM_BLOCK) {
    fromBlock = parseInt(process.env.FROM_BLOCK);
    log(`FROM_BLOCK provided: ${fromBlock}`);
  } else {
    fromBlock = Math.max(0, latest - INIT_LOOKBACK);
    log(`Starting historical scan from ${fromBlock}`);
  }

  const filter = contract.filters.Transfer(null, WATCH_WALLET);

  log(
    `Backfilling Transfer(to=${WATCH_WALLET}) from block ${fromBlock} -> ${latest}`
  );
  for (let start = fromBlock; start <= latest; start += CHUNK + 1) {
    const end = Math.min(latest, start + CHUNK);
    log(`  - Scan ${start}..${end}`);
    await querySlice(filter, start, end);
    saveProgress(end);
  }

  return latest;
}

async function startLivePoll(startFromBlock) {
  const filter = contract.filters.Transfer(null, WATCH_WALLET);
  let lastProcessed = Math.max(0, loadProgress() || startFromBlock);

  log(
    `Live polling started (interval=${POLL_INTERVAL_MS}ms, confirmations=${CONFIRMATIONS})`
  );

  const tick = async () => {
    try {
      const head = await provider.getBlockNumber();
      const safeHead = head - CONFIRMATIONS;
      if (safeHead <= lastProcessed) return;

      let cursor = lastProcessed + 1;
      while (cursor <= safeHead) {
        const sliceEnd = Math.min(cursor + CHUNK, safeHead);
        await querySlice(filter, cursor, sliceEnd);
        cursor = sliceEnd + 1;
      }

      lastProcessed = safeHead;
      saveProgress(lastProcessed);
    } catch (e) {
      log(`Polling error: ${e.message}`);
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

// ======================= Main =======================
(async () => {
  log("Abstract NFT monitor starting...");
  const net = await provider.getNetwork();
  log(`Connected chainId=${Number(net.chainId)} RPC=${RPC_URL}`);

  const last = await scanHistorical();
  await startLivePoll(last);

  log(
    `Writing to ${OUT_PATH}. (progress at ${PROGRESS_PATH}, egg cache at ${EGG_CACHE_PATH})`
  );
})();
