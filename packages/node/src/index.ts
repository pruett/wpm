import { loadKeys } from "./keys.js";
import { replayChain, appendBlock, getChainFilePath } from "./persistence.js";
import { createGenesisBlock } from "./genesis.js";
import { Mempool } from "./mempool.js";
import { startProducer } from "./producer.js";
import { startApi } from "./api.js";

const PORT = Number(process.env.PORT ?? 3001);
const chainFilePath = getChainFilePath();

console.log("Loading keys...");
const keys = loadKeys();

console.log("Replaying chain...");
const state = replayChain(keys.poaPublicKey, chainFilePath);

if (state.chain.length === 0) {
  console.log("No existing chain found — creating genesis block...");
  const genesis = createGenesisBlock(keys.poaPublicKey, keys.poaPrivateKey);
  appendBlock(genesis, chainFilePath);
  state.applyBlock(genesis);
  console.log(
    `Genesis block created. Treasury balance: ${state.getBalance(state.treasuryAddress)}`,
  );
} else {
  console.log(`Replayed ${state.chain.length} blocks.`);
}

const mempool = new Mempool();

const producer = startProducer(
  state,
  mempool,
  keys.poaPrivateKey,
  chainFilePath,
);

const api = startApi(state, mempool, { poaPublicKey: keys.poaPublicKey, poaPrivateKey: keys.poaPrivateKey }, PORT);

console.log(`Node running on port ${PORT} — block height: ${state.chain.length}`);

function shutdown() {
  console.log("Shutting down...");
  producer.stop();
  api.close().then(() => {
    console.log("Shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
