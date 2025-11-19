// items_erc1155_monitor.js
// Monitors incoming ERC-1155 transfers for specific item IDs on
// contract 0x50A5eb2B3B289D4cFda0e307609b655175a275b1
// Only records transfers where `to == WATCH_WALLET`

const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { ethers } = require("ethers");

// ======================= Config =======================
const RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const WATCH_WALLET = (process.env.WATCH_WALLET || "").toLowerCase();

const CONTRACT_ADDRESS =
  (process.env.CONTRACT_ADDRESS_ITEMS ||
    "0x50A5eb2B3B289D4cFda0e307609b655175a275b1").trim();

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "3000", 10);
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "2", 10);
const CHUNK = parseInt(process.env.CHUNK || "2000", 10);
const INIT_LOOKBACK = parseInt(process.env.INIT_LOOKBACK || "50000", 10);

// Item ID → Name mapping
const ITEM_TYPES = {
  "4": "Bolt",
  "5": "Pipe",
  "73": "Crusader Dust",
  "74": "Overseer Dust",
  "75": "Athena Dust",
  "76": "Archon Dust",
  "77": "Foxglove Dust",
  "78": "Summoner Dust",
  "79": "Chobo Dust",
  "80": "Crusader Shard",
  "81": "Overseer Shard",
  "82": "Athena Shard",
  "83": "Archon Shard",
  "84": "Foxglove Shard",
  "85": "Summoner Shard",
  "86": "Chobo Shard",
};

// Only watch these token IDs (keys of ITEM_TYPES)
const WATCH_TOKEN_IDS = new Set(Object.keys(ITEM_TYPES));

if (!ethers.isAddress(WATCH_WALLET))
  throw new Error("WATCH_WALLET invalid or missing");
if (!ethers.isAddress(CONTRACT_ADDRESS))
  throw new Error("CONTRACT_ADDRESS_ITEMS invalid or missing");

// === ERC-1155 ABI (TransferSingle + TransferBatch) ===
const ERC1155_ABI = [
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC1155_ABI, provider);

// ======================= Paths =======================
const OUT_PATH = path.resolve("./items_incoming_transfers.json");
const PROGRESS_PATH = path.resolve("./items_last_processed.json");

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
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function loadDb() {
  return loadJson(OUT_PATH, []);
}
function saveDb(rows) {
  saveJson(OUT_PATH, rows);
}
function loadProgress() {
  const d = loadJson(PROGRESS_PATH, { lastProcessed: 0 });
  return d.lastProcessed || 0;
}
function saveProgress(height) {
  saveJson(PROGRESS_PATH, { lastProcessed: height });
}

// ======================= Core =======================
async function enrichAndPersist(from, to, tokenIds, amounts, logObj) {
  const block = await provider.getBlock(logObj.blockNumber);
  const isoDate = new Date(block.timestamp * 1000).toISOString();

  const itemTypes = tokenIds.map(id => ITEM_TYPES[id.toString()] || "Unknown");
  const totalAmount = amounts.reduce((sum, amt) => sum + BigInt(amt.toString()), 0n).toString();

  const row = {
    receivedTo: to,
    sender: from,
    tokenIds: tokenIds.map(id => id.toString()),
    amounts: amounts.map(amt => amt.toString()),
    itemTypes,
    totalAmount, // sum of all amounts
    blockNumber: logObj.blockNumber,
    txHash: logObj.transactionHash,
    dateISO: isoDate,
    contract: CONTRACT_ADDRESS,
  };

  const db = loadDb();
  const txHash = logObj.transactionHash.toLowerCase();

  // Check if this txHash already exists
  const existingIdx = db.findIndex((x) => x.txHash.toLowerCase() === txHash);

  if (existingIdx === -1) {
    db.push(row);
    db.sort((a, b) => b.blockNumber - a.blockNumber);
    saveDb(db);
    log("NEW ITEM INCOMING", JSON.stringify(row));
  }
}

async function handleTransferSingle(ev) {
  const fromAddr = (ev.args?.from || ev.args?.[1] || "").toLowerCase();
  const toAddr = (ev.args?.to || ev.args?.[2] || "").toLowerCase();
  const id = ev.args?.id ?? ev.args?.[3];
  const value = ev.args?.value ?? ev.args?.[4];

  if (!id || !value) return;

  const idStr = id.toString();

  // Only our wallet
  if (toAddr !== WATCH_WALLET) return;

  // Only watched IDs
  if (!WATCH_TOKEN_IDS.has(idStr)) return;

  await enrichAndPersist(fromAddr, toAddr, [id], [value], ev.log ?? ev);
}

async function handleTransferBatch(ev) {
  const fromAddr = (ev.args?.from || ev.args?.[1] || "").toLowerCase();
  const toAddr = (ev.args?.to || ev.args?.[2] || "").toLowerCase();
  const ids = ev.args?.ids ?? ev.args?.[3];
  const values = ev.args?.[4] ?? ev.args?.values; // Index first, fallback to named property

  if (!Array.isArray(ids) || !Array.isArray(values)) return;
  if (toAddr !== WATCH_WALLET) return;

  const filteredIds = [];
  const filteredValues = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const value = values[i];
    if (!id || !value) continue;

    const idStr = id.toString();
    if (!WATCH_TOKEN_IDS.has(idStr)) continue;

    filteredIds.push(id);
    filteredValues.push(value);
  }

  if (filteredIds.length > 0) {
    await enrichAndPersist(fromAddr, toAddr, filteredIds, filteredValues, ev.log ?? ev);
  }
}

async function querySlice(start, end) {
  const singleFilter = contract.filters.TransferSingle();
  const batchFilter = contract.filters.TransferBatch();

  const [singleLogs, batchLogs] = await Promise.all([
    contract.queryFilter(singleFilter, start, end),
    contract.queryFilter(batchFilter, start, end),
  ]);

  log(
    `  - Block range ${start}..${end} | single=${singleLogs.length}, batch=${batchLogs.length}`
  );

  for (const ev of singleLogs) {
    await handleTransferSingle(ev);
  }

  for (const ev of batchLogs) {
    await handleTransferBatch(ev);
  }
}

async function scanHistorical() {
  const latest = await provider.getBlockNumber();
  let fromBlock;
  const progress = loadProgress();

  if (progress > 0) {
    fromBlock = Math.max(0, progress - CONFIRMATIONS);
    log(`Resuming from progress: ${fromBlock}`);
  } else if (process.env.FROM_BLOCK && process.env.FROM_BLOCK !== "") {
    fromBlock = parseInt(process.env.FROM_BLOCK, 10);
    log(`FROM_BLOCK provided: ${fromBlock}`);
  } else {
    fromBlock = Math.max(0, latest - INIT_LOOKBACK);
    log(`Starting historical scan from ${fromBlock}`);
  }

  log(
    `Backfilling ERC1155 Transfers (to=${WATCH_WALLET}, ids in ${[
      ...WATCH_TOKEN_IDS,
    ].join(", ")}) from block ${fromBlock} -> ${latest}`
  );

  for (let start = fromBlock; start <= latest; start += CHUNK + 1) {
    const end = Math.min(latest, start + CHUNK);
    await querySlice(start, end);
    saveProgress(end);
  }

  return latest;
}

async function startLivePoll(startFromBlock) {
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
        await querySlice(cursor, sliceEnd);
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
  log("Abstract Items ERC-1155 monitor starting...");
  const net = await provider.getNetwork();
  log(`Connected chainId=${Number(net.chainId)} RPC=${RPC_URL}`);
  log(`Watching wallet: ${WATCH_WALLET}`);
  log(`Contract: ${CONTRACT_ADDRESS}`);
  log(`Token IDs: ${[...WATCH_TOKEN_IDS].join(", ")}`);

  const last = await scanHistorical();
  await startLivePoll(last);

  log(
    `Writing incoming item transfers to ${OUT_PATH}. (progress at ${PROGRESS_PATH})`
  );
})();
