import { ZetaClientWrapper, initializeExchange } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { Exchange, Network, types, constants, utils } from "@zetamarkets/sdk";
import dotenv from "dotenv";
import fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

dotenv.config();

// Command line argument setup with improved descriptions
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .example('$0 -d long -s SOL', 'Open a long SOL position with default settings')
  .example('$0 -d short -s ETH -l 3 --tp 0.04', 'Open a 3x leveraged short ETH position with 4% take profit')
  .option("direction", {
    alias: "d",
    description: "Position direction (long = buy, short = sell)",
    choices: ["long", "short"],
    required: true,
    group: "Required:"
  })
  .option("symbol", {
    alias: "s",
    description: "Trading asset symbol (e.g., SOL, ETH, BTC)",
    choices: Object.keys(constants.Asset).filter(key => isNaN(Number(key))),
    required: true,
    group: "Required:"
  })
  .option("leverage", {
    alias: "l",
    description: "Position leverage multiplier (e.g., 4 means 4x leverage)",
    type: "number",
    default: 4,
    group: "Position Settings:"
  })
  .option("takeProfit", {
    alias: "tp",
    description: "Take profit percentage (0.036 = 3.6% profit target)",
    type: "number",
    default: 0.036,
    group: "Position Settings:"
  })
  .option("stopLoss", {
    alias: "sl",
    description: "Stop loss percentage (0.018 = 1.8% loss limit)",
    type: "number",
    default: 0.018,
    group: "Position Settings:"
  })
  .option("orderType", {
    alias: "o",
    description: "Order type (maker = limit order, taker = market order)",
    choices: ["maker", "taker"],
    default: "taker",
    group: "Position Settings:"
  })
  .option("priorityFeeMultiplier", {
    alias: "p",
    description: "Network fee multiplier (higher = faster execution, more expensive)",
    type: "number",
    default: 5,
    group: "Network Settings:"
  })
  .wrap(100)
  .epilogue('For more information about the trading parameters, check the documentation')
  .help()
  .alias("help", "h")
  .argv;


/**
 * Validates essential environment variables and files
 * @throws {Error} If required configuration is missing
 */
function validateConfig() {
  const requiredEnvVars = [
    "KEYPAIR_FILE_PATH_LONG",
    "KEYPAIR_FILE_PATH_SHORT",
    "RPC_TRADINGBOT"
  ];

  const missingVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
  if (missingVars.length > 0) {
    console.error(`Missing required environment variables: ${missingVars.join(", ")}`);
    process.exit(1);
  }

  // Verify wallet files exist
  const walletPath = argv.direction === "long" 
    ? process.env.KEYPAIR_FILE_PATH_LONG 
    : process.env.KEYPAIR_FILE_PATH_SHORT;

  if (!fs.existsSync(walletPath)) {
    console.error(`Wallet file not found at ${walletPath}`);
    process.exit(1);
  }
}

/**
 * Closes a position with specified parameters
 */
async function closePosition() {

    // Validate configuration first
    validateConfig();
    
    // Convert symbol to market index
    const marketIndex = constants.Asset[argv.symbol];
    
    // Initialize exchange and get connection
    const { connection } = await initializeExchange([marketIndex]);
    
    // Initialize ZetaWrapper
    const zetaWrapper = new ZetaClientWrapper();
    
    // Initialize client with appropriate wallet
    const walletPath = argv.direction === "long" 
      ? process.env.KEYPAIR_FILE_PATH_LONG 
      : process.env.KEYPAIR_FILE_PATH_SHORT;

    await zetaWrapper.initializeClient(connection, walletPath);
    
    const txid = await zetaWrapper.closePosition(marketIndex);
    
    process.exit(0);

  }

// Handle interruptions gracefully
process.on("SIGINT", async () => {
  console.log("\nGracefully shutting down...");
  process.exit(0);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Promise Rejection:", reason);
  process.exit(1);
});

// Start the position opening process
closePosition().catch(async error => {
  console.error("Fatal error:", error);
  process.exit(1);
});