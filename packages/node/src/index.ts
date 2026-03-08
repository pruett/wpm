import { loadKeys } from "./keys.js";
import { replayChain, appendBlock, getChainFilePath } from "./persistence.js";
import { createGenesisBlock } from "./genesis.js";
import { Mempool } from "./mempool.js";
import { startProducer } from "./producer.js";
import { startApi } from "./api.js";
import { EventBus } from "./events.js";
import { logger } from "./logger.js";

const PORT = Number(process.env.PORT ?? 3001);
const chainFilePath = getChainFilePath();

logger.info("loading keys");
const keys = loadKeys();

logger.info("replaying chain", { chainFile: chainFilePath });
const state = replayChain(keys.poaPublicKey, chainFilePath);

if (state.chain.length === 0) {
  logger.info("no existing chain — creating genesis block");
  const genesis = createGenesisBlock(keys.poaPublicKey, keys.poaPrivateKey);
  appendBlock(genesis, chainFilePath);
  state.applyBlock(genesis);
  logger.info("genesis block created", {
    treasuryBalance: state.getBalance(state.treasuryAddress),
  });
} else {
  logger.info("chain loaded", { blockHeight: state.chain.length });
}

const mempool = new Mempool(keys.oraclePublicKey);
const eventBus = new EventBus();

const producer = startProducer(
  state,
  mempool,
  keys.poaPublicKey,
  keys.poaPrivateKey,
  chainFilePath,
  keys.oraclePublicKey,
  eventBus,
);

const api = startApi(
  state,
  mempool,
  { poaPublicKey: keys.poaPublicKey, poaPrivateKey: keys.poaPrivateKey },
  PORT,
  "0.0.0.0",
  eventBus,
);

logger.info("node started", { port: PORT, blockHeight: state.chain.length });
logger.metrics.blockHeight = state.chain.length;

function shutdown() {
  logger.info("shutting down");
  producer.stop();
  eventBus.closeAll();
  api.close().then(() => {
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
