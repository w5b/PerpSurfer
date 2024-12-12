import { ZetaClientWrapper } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { Exchange, Network, types, constants, utils } from "@zetamarkets/sdk";
import { BN, PriorityFeeMethod, PriorityFeeSubscriber, fetchSolanaPriorityFee } from "@drift-labs/sdk";
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


// Priority fee handling
let priorityFees;
let currentPriorityFee;

/**
 * Sets up priority fee monitoring
 * @param {Connection} connection Solana connection instance
 */
async function setupPriorityFees(connection) {
  try {
    console.log("Setting up priority fees...");
    
    const config = {
      priorityFeeMethod: PriorityFeeMethod.DRIFT,
      frequencyMs: 5000,
      connection: connection
    };

    priorityFees = new PriorityFeeSubscriber({
      ...config,
      lookbackDistance: 150,
      addresses: [],
      connection: connection
    });

    await priorityFees.subscribe();
    await priorityFees.load();

    const recentFees = await fetchSolanaPriorityFee(connection, 150, []);
    
    // Calculate initial fee based on recent average
    const initialFee = recentFees
      ?.slice(0, 10)
      .reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || 1_000;

    currentPriorityFee = Math.floor(initialFee * argv.priorityFeeMultiplier);

    console.log("Priority fees initialized:", {
      baseFee: initialFee,
      multiplier: argv.priorityFeeMultiplier,
      effectiveFee: currentPriorityFee
    });

    // Update Exchange with our priority fee
    Exchange.updatePriorityFee(currentPriorityFee);
  } catch (error) {
    console.error("Error setting up priority fees:", error);
    throw error;
  }
}

/**
 * Updates current priority fee based on network conditions
 * @param {Connection} connection Solana connection instance
 */
async function updatePriorityFees(connection) {
  try {
    if (!priorityFees) {
      throw new Error("Priority Fees not initialized");
    }

    await priorityFees.load();
    const recentFees = await fetchSolanaPriorityFee(connection, 150, []);

    const newFee = recentFees
      ?.slice(0, 10)
      .reduce((sum, fee) => sum + fee.prioritizationFee, 0) / 10 || currentPriorityFee;

    currentPriorityFee = Math.floor(newFee * argv.priorityFeeMultiplier);

    console.log("Updated priority fee:", {
      baseFee: newFee,
      multiplier: argv.priorityFeeMultiplier,
      effectiveFee: currentPriorityFee
    });

    Exchange.updatePriorityFee(currentPriorityFee);
  } catch (error) {
    console.error("Error updating priority fees:", error);
    throw error;
  }
}

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
 * Initializes the Exchange with required markets
 * @param {number} marketIndex The market to initialize
 * @returns {Object} Connection instance
 */
async function initializeExchange(marketIndex) {
  try {
    console.log("Initializing exchange...");
    const connection = new Connection(process.env.RPC_TRADINGBOT);

    // Only load the specific market we need
    const marketsToLoad = [constants.Asset.SOL, marketIndex];
    
    const loadExchangeConfig = types.defaultLoadExchangeConfig(
      Network.MAINNET,
      connection,
      {
        skipPreflight: true,
        preflightCommitment: "finalized",
        commitment: "finalized"
      },
      150,
      true,
      connection,
      marketsToLoad,
      undefined,
      marketsToLoad
    );

    await Exchange.load(loadExchangeConfig);
    console.log("Exchange loaded successfully");

    // Initialize priority fees
    await setupPriorityFees(connection);

    return { connection };
  } catch (error) {
    console.error("Error initializing exchange:", error);
    throw error;
  }
}

/**
 * Opens a position with specified parameters
 */
async function openPosition() {
  try {
    // Validate configuration first
    validateConfig();
    
    // Convert symbol to market index
    const marketIndex = constants.Asset[argv.symbol];
    
    // Initialize exchange and get connection
    const { connection } = await initializeExchange(marketIndex);
    
    // Initialize ZetaWrapper
    const zetaWrapper = new ZetaClientWrapper();
    
    // Set custom trading settings
    zetaWrapper.settings = {
      leverageMultiplier: argv.leverage,
      takeProfitPercentage: argv.takeProfit,
      stopLossPercentage: argv.stopLoss,
      trailingStopLoss: {
        progressThreshold: 0.6,
        stopLossDistance: 0.4,
        triggerDistance: 0.45,
      },
    };
    
    // Initialize client with appropriate wallet
    const walletPath = argv.direction === "long" 
      ? process.env.KEYPAIR_FILE_PATH_LONG 
      : process.env.KEYPAIR_FILE_PATH_SHORT;
      
    await zetaWrapper.initializeClient(walletPath);

    // Update priority fees one last time before opening position
    await updatePriorityFees(connection);
    
    console.log("Opening position with parameters:", {
      direction: argv.direction,
      symbol: argv.symbol,
      leverage: argv.leverage + "x",
      takeProfit: (argv.takeProfit * 100).toFixed(2) + "%",
      stopLoss: (argv.stopLoss * 100).toFixed(2) + "%",
      orderType: argv.orderType,
      priorityFee: currentPriorityFee
    });
    
    // Open the position
    const txid = await zetaWrapper.openPosition(
      argv.direction,
      marketIndex,
      argv.orderType
    );
    
    console.log("Position opened successfully!");
    console.log("Transaction ID:", txid);
    
    // Clean up priority fee subscriber
    if (priorityFees) {
      await priorityFees.unsubscribe();
    }
    
    // Give time for position to be opened before exiting
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    process.exit(0);
  } catch (error) {
    console.error("Error opening position:", error);
    if (priorityFees) {
      await priorityFees.unsubscribe();
    }
    process.exit(1);
  }
}

// Handle interruptions gracefully
process.on("SIGINT", async () => {
  console.log("\nGracefully shutting down...");
  if (priorityFees) {
    await priorityFees.unsubscribe();
  }
  process.exit(0);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Promise Rejection:", reason);
  if (priorityFees) {
    await priorityFees.unsubscribe();
  }
  process.exit(1);
});

// Start the position opening process
openPosition().catch(async error => {
  console.error("Fatal error:", error);
  if (priorityFees) {
    await priorityFees.unsubscribe();
  }
  process.exit(1);
});