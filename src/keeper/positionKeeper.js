import { Connection } from "@solana/web3.js";
import { Exchange, Network, types, constants } from "@zetamarkets/sdk";
import { ZetaClientWrapper } from "../clients/zeta.js";
import { ASSETS } from "../config/config.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

/**
 * Position Keeper for managing cryptocurrency trading positions on Zeta Markets.
 * Handles both long and short positions with support for fixed and ratchet strategies.
 * Implements automated stop-loss and take-profit management.
 */
class PositionKeeper {
    constructor() {
        // Core connections for interacting with the blockchain and exchange
        this.connection = null;        // Solana network connection
        this.longWrapper = null;       // Client wrapper for long positions
        this.shortWrapper = null;      // Client wrapper for short positions
        
        // State management for tracking positions and market data
        this.positions = {
            long: new Map(),           // Map<marketIndex, positionState>
            short: new Map()           // Map<marketIndex, positionState>
        };
        this.priceRegistry = new Map();      // Map<marketIndex, {price, timestamp}>
        this.monitoredMarkets = new Set();   // Set of active market indices
        this.tradingSymbols = [];            // List of supported trading pairs
        
        // Trading strategy configuration
        this.strategies = this.loadStrategies();
        
        // Monitoring state
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.recentCloseAttempts = new Map();  // Rate limiting for position closures
        
        // Configuration constants
        this.CHECK_INTERVAL = 3000;             // Position check frequency (ms)
        this.HEALTH_CHECK_INTERVAL = 300000;    // Health check frequency (5 min)
    }

    /**
     * Loads trading strategies from configuration file or returns defaults.
     * Supports both fixed and ratchet strategy types.
     */
    loadStrategies() {
        try {
            const configPath = path.join(process.cwd(), 'strategies.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log("[KEEPER] Loaded trading strategies");
            return config.strategies;
        } catch (error) {
            console.log("[KEEPER] Error loading strategies:", error.message);
            return {
                "default": {
                    type: "fixed",
                    takeProfit: 0.036,      // 3.6% take profit target
                    stopLoss: 0.01,         // 1% initial stop loss
                    triggers: {
                        at: 0.60,           // Move stop loss at 60% of target
                        moveStopLossTo: 0.40 // Move to 40% of the way to target
                    }
                }
            };
        }
    }

    /**
     * Initializes the Position Keeper system.
     * Sets up exchange connection, validates configuration, and starts monitoring.
     */
    async initialize() {
        try {
            this.tradingSymbols = this.validateConfig();
            console.log("[KEEPER] Starting Position Keeper", {
                symbols: this.tradingSymbols,
                longWallet: process.env.KEYPAIR_FILE_PATH_LONG.split("/").pop(),
                shortWallet: process.env.KEYPAIR_FILE_PATH_SHORT.split("/").pop()
            });

            await this.initializeExchange();
            await this.initializeWrappers();
            await this.detectExistingPositions();
            
            if (this.monitoredMarkets.size > 0) {
                this.startMonitoring();
                this.setupHealthCheck();
            }

            console.log("[KEEPER] Initialization complete");
        } catch (error) {
            console.log("[KEEPER] Critical initialization error:", error.message);
            throw error;
        }
    }

    /**
     * Validates required environment variables and configuration.
     * Ensures all necessary wallet files and settings are present.
     */
    validateConfig() {
        const requiredEnvVars = [
            "KEYPAIR_FILE_PATH_LONG",
            "KEYPAIR_FILE_PATH_SHORT",
            "RPC_TRADINGBOT"
        ];

        const missingVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
        if (missingVars.length > 0) {
            console.log("[KEEPER] Missing required environment variables:", missingVars.join(", "));
            process.exit(1);
        }

        if (!fs.existsSync(process.env.KEYPAIR_FILE_PATH_LONG) || 
            !fs.existsSync(process.env.KEYPAIR_FILE_PATH_SHORT)) {
            console.log("[KEEPER] Wallet files not found");
            process.exit(1);
        }

        // Supported trading pairs
        return ["SOL", "ETH", "BTC", "GOAT", "JUP", "EIGEN", "POPCAT", "JTO", "WIF"];
    }

    /**
     * Initializes connection to Solana network and Zeta exchange.
     * Sets up market subscriptions for supported trading pairs.
     */
    async initializeExchange() {
        try {
            this.connection = new Connection(process.env.RPC_TRADINGBOT);
            
            const marketsToLoad = new Set(
                this.tradingSymbols.map(sym => constants.Asset[sym])
            );
            const marketsArray = Array.from(marketsToLoad);

            const loadExchangeConfig = types.defaultLoadExchangeConfig(
                Network.MAINNET,
                this.connection,
                {
                    skipPreflight: true,
                    preflightCommitment: "finalized",
                    commitment: "finalized",
                },
                500,
                true,
                this.connection,
                marketsArray,
                undefined,
                marketsArray
            );

            await Exchange.load(loadExchangeConfig);
            console.log("[KEEPER] Exchange loaded");
        } catch (error) {
            console.log("[KEEPER] Exchange initialization failed:", error.message);
            throw error;
        }
    }

    /**
     * Initializes Zeta client wrappers for both long and short positions.
     * Sets up market subscriptions and loads wallet credentials.
     */
    async initializeWrappers() {
        try {
            this.longWrapper = new ZetaClientWrapper();
            this.shortWrapper = new ZetaClientWrapper();

            const marketIndices = this.tradingSymbols.map(symbol => constants.Asset[symbol]);
            
            await this.longWrapper.initialize(marketIndices, process.env.KEYPAIR_FILE_PATH_LONG);
            await this.shortWrapper.initialize(marketIndices, process.env.KEYPAIR_FILE_PATH_SHORT);
            
            console.log("[KEEPER] Zeta wrappers initialized");
        } catch (error) {
            console.log("[KEEPER] Failed to initialize wrappers:", error.message);
            throw error;
        }
    }

    /**
     * Detects and loads any existing positions from both wallets.
     * Sets up monitoring for markets with active positions.
     */
    async detectExistingPositions() {
        try {
            const markets = this.tradingSymbols.map(symbol => constants.Asset[symbol]);

            for (const marketIndex of markets) {
                // Check long positions
                const longPosition = await this.longWrapper.getPosition(marketIndex);
                if (longPosition && longPosition.size > 0) {
                    await this.processPosition(marketIndex, longPosition, "long");
                }

                // Check short positions
                const shortPosition = await this.shortWrapper.getPosition(marketIndex);
                if (shortPosition && shortPosition.size < 0) {
                    await this.processPosition(marketIndex, shortPosition, "short");
                }
            }

            this.updateMonitoredMarkets();
        } catch (error) {
            console.log("[KEEPER] Error detecting positions:", error.message);
            throw error;
        }
    }

    /**
     * Processes a detected position and sets up monitoring state.
     * Configures stop-loss and take-profit orders based on strategy.
     */
    async processPosition(marketIndex, position, direction) {
        const wrapper = direction === "long" ? this.longWrapper : this.shortWrapper;
        const symbol = constants.Asset[marketIndex];
        const strategy = this.strategies[symbol] || this.strategies.default;
        const triggerOrders = await wrapper.getTriggerOrders(marketIndex);
        const currentPrice = wrapper.getCalculatedMarkPrice(marketIndex);
        const entryPrice = Math.abs(position.costOfTrades / position.size);

        // Find existing stop loss and take profit orders
        const stopLoss = triggerOrders.find(order => 
            direction === "short" ? 
                order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL :
                order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL
        );

        const takeProfit = strategy.type === "fixed" ? triggerOrders.find(order => 
            direction === "short" ?
                order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL :
                order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL
        ) : null;

        // Create position state object for monitoring
        const positionState = {
            size: position.size,
            entryPrice,
            lastCheck: new Date().toISOString(),
            lastPrice: currentPrice,
            strategyType: strategy.type,
            lastRatchetLevel: 0,
            hasAdjustedStopLoss: false,
            stopLoss: stopLoss ? {
                triggerPrice: stopLoss.triggerPrice / 1e6,
                orderPrice: stopLoss.orderPrice / 1e6,
                direction: stopLoss.triggerDirection,
                orderId: stopLoss.orderId
            } : null,
            takeProfit: takeProfit ? {
                triggerPrice: takeProfit.triggerPrice / 1e6,
                orderPrice: takeProfit.orderPrice / 1e6,
                direction: takeProfit.triggerDirection,
                orderId: takeProfit.orderId
            } : null
        };

        this.positions[direction].set(marketIndex, positionState);
        
        console.log(`[KEEPER] Found ${symbol} ${direction} position:`, {
            strategy: strategy.type,
            size: position.size,
            entryPrice: entryPrice.toFixed(4),
            hasStopLoss: !!stopLoss,
            hasTakeProfit: !!takeProfit
        });

        if (!stopLoss) {
            console.log(`[KEEPER] WARNING: ${symbol} ${direction} missing stop loss order`);
        }
    }

    /**
     * Updates the set of markets being monitored based on active positions.
     */
    updateMonitoredMarkets() {
        this.monitoredMarkets.clear();
        
        for (const marketIndex of this.positions.long.keys()) {
            this.monitoredMarkets.add(marketIndex);
        }
        for (const marketIndex of this.positions.short.keys()) {
            this.monitoredMarkets.add(marketIndex);
        }

        if (this.monitoredMarkets.size > 0) {
            console.log("[KEEPER] Monitoring markets:", {
                markets: Array.from(this.monitoredMarkets).map(idx => constants.Asset[idx]),
                count: this.monitoredMarkets.size
            });
        }
    }

    /**
     * Starts the position monitoring loop if not already running.
     */
    startMonitoring() {
        if (this.isMonitoring) return;

        this.isMonitoring = true;
        this.monitoringInterval = setInterval(
            () => this.monitorPositions(),
            this.CHECK_INTERVAL
        );

        console.log("[KEEPER] Position monitoring started");
    }

    /**
     * Main monitoring loop that checks all active positions.
     * Updates prices and triggers strategy-specific checks.
     */
    async monitorPositions() {
        // Update prices for all monitored markets
        for (const marketIndex of this.monitoredMarkets) {
            const price = this.longWrapper.getCalculatedMarkPrice(marketIndex);
            this.priceRegistry.set(marketIndex, {
                price,
                timestamp: Date.now()
            });
        }

        // Check long positions
        for (const [marketIndex, state] of this.positions.long.entries()) {
            await this.checkPosition(marketIndex, state, "long");
        }

        // Check short positions
        for (const [marketIndex, state] of this.positions.short.entries()) {
            await this.checkPosition(marketIndex, state, "short");
        }
    }

    /**
     * Checks a single position against its strategy rules.
     * Handles stop-loss hits and strategy-specific adjustments.
     */
    async checkPosition(marketIndex, state, direction) {
        const symbol = constants.Asset[marketIndex];
        const strategy = this.strategies[symbol] || this.strategies.default;
        const wrapper = direction === "long" ? this.longWrapper : this.shortWrapper;
        const currentPrice = this.priceRegistry.get(marketIndex)?.price;
        
        try {
            const position = await wrapper.getPosition(marketIndex);
            
            // Check if position is closed
            if (!position || position.size === 0) {
                console.log(`[KEEPER] ${symbol} ${direction} position closed`);
                this.positions[direction].delete(marketIndex);
                this.updateMonitoredMarkets();
                return;
            }

            // Check for stop loss hit
            if (this.checkStopLossHit(currentPrice, state, direction)) {
                await this.closePosition(marketIndex, position, direction);
                return;
            }

            // Check for take profit hit if fixed strategy
            if (strategy.type === "fixed" && this.checkTakeProfitHit(currentPrice, state, direction)) {
                await this.closePosition(marketIndex, position, direction);
                return;
            }

            // Strategy-specific checks
            if (strategy.type === "fixed") {
                await this.checkFixedStrategy(marketIndex, state, direction, currentPrice, strategy);
            } else if (strategy.type === "ratchet") {
                await this.checkRatchetStrategy(marketIndex, state, direction, currentPrice, strategy);
            }

            // Update state
            state.lastCheck = new Date().toISOString();
            state.lastPrice = currentPrice;

        } catch (error) {
            console.log(`[KEEPER] Error checking ${symbol} ${direction} position:`, error.message);
        }
    }

    /**
     * Checks if current price has hit stop-loss level.
     */
    checkStopLossHit(currentPrice, state, direction) {
        if (!state.stopLoss) return false;
        
        const isShort = direction === "short";
        return isShort ? 
            currentPrice >= state.stopLoss.triggerPrice :
            currentPrice <= state.stopLoss.triggerPrice;
    }

    /**
     * Checks if current price has hit take-profit level.
     */
    checkTakeProfitHit(currentPrice, state, direction) {
        if (!state.takeProfit) return false;
        
        const isShort = direction === "short";
        return isShort ?
        currentPrice <= state.takeProfit.triggerPrice :
        currentPrice >= state.takeProfit.triggerPrice;
}

/**
 * Implements fixed strategy position management.
 * Moves stop-loss to lock in profits when position reaches defined threshold.
 */
async checkFixedStrategy(marketIndex, state, direction, currentPrice, strategy) {
    const symbol = constants.Asset[marketIndex];
    const isShort = direction === "short";

    if (state.hasAdjustedStopLoss) return;

    const entryPrice = state.entryPrice;
    const tpPrice = isShort ? 
        entryPrice * (1 - strategy.takeProfit) : 
        entryPrice * (1 + strategy.takeProfit);
    
    const totalDistance = Math.abs(tpPrice - entryPrice);
    const currentProgress = isShort ? 
        entryPrice - currentPrice : 
        currentPrice - entryPrice;
    const progressPercent = currentProgress / totalDistance;

    if (progressPercent >= strategy.triggers.at) {
        const newStopLoss = isShort ?
            entryPrice * (1 - strategy.triggers.moveStopLossTo) :
            entryPrice * (1 + strategy.triggers.moveStopLossTo);

        console.log(`[KEEPER] ${symbol} ${direction} fixed strategy trigger:`, {
            progress: (progressPercent * 100).toFixed(2) + '%',
            currentPrice: currentPrice.toFixed(4),
            newStopLoss: newStopLoss.toFixed(4)
        });

        await this.adjustStopLoss(marketIndex, state, newStopLoss, direction);
        state.hasAdjustedStopLoss = true;
    }
}

/**
 * Implements ratchet strategy position management.
 * Continuously moves stop-loss as position becomes more profitable.
 */
async checkRatchetStrategy(marketIndex, state, direction, currentPrice, strategy) {
    const symbol = constants.Asset[marketIndex];
    const isShort = direction === "short";
    const entryPrice = state.entryPrice;

    const progressFromEntry = isShort ?
        (entryPrice - currentPrice) / entryPrice :
        (currentPrice - entryPrice) / entryPrice;

    const increments = Math.floor(progressFromEntry / strategy.ratchet.threshold);
    
    if (increments > state.lastRatchetLevel && progressFromEntry > 0) {
        const newStopLossPercent = strategy.ratchet.increment * increments;
        const newStopLoss = isShort ?
            entryPrice * (1 - newStopLossPercent) :
            entryPrice * (1 + newStopLossPercent);

        console.log(`[KEEPER] ${symbol} ${direction} ratchet adjustment:`, {
            increment: increments,
            progressPercent: (progressFromEntry * 100).toFixed(2) + '%',
            newStopLoss: newStopLoss.toFixed(4)
        });

        await this.adjustStopLoss(marketIndex, state, newStopLoss, direction);
        state.lastRatchetLevel = increments;
    }
}

/**
 * Closes a position by placing a market order.
 * Includes rate limiting to prevent excessive close attempts.
 */
async closePosition(marketIndex, position, direction) {
    const wrapper = direction === "long" ? this.longWrapper : this.shortWrapper;
    const symbol = constants.Asset[marketIndex];
    const size = Math.abs(position.size);
    
    // Rate limiting check
    const key = `${symbol}-${direction}`;
    if (this.recentCloseAttempts.has(key)) {
        return;
    }

    try {
        const currentPrice = this.priceRegistry.get(marketIndex)?.price;
        const side = direction === "long" ? types.Side.ASK : types.Side.BID;

        console.log(`[KEEPER] Closing ${symbol} ${direction} position:`, {
            size,
            currentPrice: currentPrice.toFixed(4)
        });

        const tx = await wrapper.client.createPlacePerpOrderInstruction(
            marketIndex,
            utils.convertDecimalToNativeInteger(currentPrice),
            size * utils.getNativeMinLotSize(marketIndex),
            side,
            {
                orderType: types.OrderType.LIMIT,
                tifOptions: {
                    expiryOffset: 15
                }
            }
        );

        console.log(`[KEEPER] ${symbol} ${direction} close order placed:`, {
            txid: tx,
            price: currentPrice.toFixed(4),
            size
        });

        // Add to rate limiting tracker
        this.recentCloseAttempts.set(key, Date.now());
        setTimeout(() => this.recentCloseAttempts.delete(key), 60000);

        return tx;
    } catch (error) {
        console.log(`[KEEPER] Failed to close ${symbol} ${direction} position:`, error.message);
        throw error;
    }
}

/**
 * Adjusts stop-loss order for a position.
 * Updates internal state and exchange orders.
 */
async adjustStopLoss(marketIndex, state, newStopLossPrice, direction) {
    const wrapper = direction === "long" ? this.longWrapper : this.shortWrapper;
    const symbol = constants.Asset[marketIndex];
    
    try {
        const newTriggerPrice = direction === "long" ?
            newStopLossPrice * 1.001 :
            newStopLossPrice * 0.999;

        const newPrices = {
            orderPrice: utils.convertDecimalToNativeInteger(newStopLossPrice),
            triggerPrice: utils.convertDecimalToNativeInteger(newTriggerPrice)
        };

        await wrapper.adjustStopLossOrder(newPrices, marketIndex, state.size);
        
        state.stopLoss = {
            ...state.stopLoss,
            triggerPrice: newTriggerPrice,
            orderPrice: newStopLossPrice
        };

        console.log(`[KEEPER] ${symbol} ${direction} stop loss adjusted:`, {
            newStopLoss: newStopLossPrice.toFixed(4),
            newTrigger: newTriggerPrice.toFixed(4)
        });

    } catch (error) {
        console.log(`[KEEPER] Failed to adjust stop loss for ${symbol} ${direction}:`, error.message);
        throw error;
    }
}

/**
 * Sets up periodic health check monitoring.
 * Logs active position status and monitor health.
 */
setupHealthCheck() {
    setInterval(() => {
        const longCount = this.positions.long.size;
        const shortCount = this.positions.short.size;
        
        if (longCount > 0 || shortCount > 0) {
            const status = {
                longPositions: {
                    count: longCount,
                    positions: Array.from(this.positions.long.entries()).map(([marketIndex, state]) => ({
                        symbol: constants.Asset[marketIndex],
                        size: state.size,
                        entryPrice: state.entryPrice.toFixed(4),
                        currentPrice: state.lastPrice.toFixed(4),
                        strategy: state.strategyType,
                        stopLoss: state.stopLoss?.orderPrice.toFixed(4),
                        takeProfit: state.takeProfit?.orderPrice.toFixed(4)
                    }))
                },
                shortPositions: {
                    count: shortCount,
                    positions: Array.from(this.positions.short.entries()).map(([marketIndex, state]) => ({
                        symbol: constants.Asset[marketIndex],
                        size: state.size,
                        entryPrice: state.entryPrice.toFixed(4),
                        currentPrice: state.lastPrice.toFixed(4),
                        strategy: state.strategyType,
                        stopLoss: state.stopLoss?.orderPrice.toFixed(4),
                        takeProfit: state.takeProfit?.orderPrice.toFixed(4)
                    }))
                }
            };

            console.log("[KEEPER] Health check:", status);
        }
    }, this.HEALTH_CHECK_INTERVAL);
}

/**
 * Gracefully shuts down the position keeper.
 * Cleans up resources and closes connections.
 */
async shutdown() {
    console.log("[KEEPER] Initiating shutdown");

    try {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }

        await Exchange.close();

        this.isMonitoring = false;
        this.positions.long.clear();
        this.positions.short.clear();
        this.priceRegistry.clear();
        this.monitoredMarkets.clear();

        console.log("[KEEPER] Shutdown complete");
    } catch (error) {
        console.log("[KEEPER] Error during shutdown:", error.message);
        throw error;
    }
}
}

// Global error handlers
process.on("unhandledRejection", (error) => {
console.log("[KEEPER] Unhandled Promise Rejection:", error.message);
process.exit(1);
});

process.on("uncaughtException", (error) => {
console.log("[KEEPER] Uncaught Exception:", error.message);
process.exit(1);
});

// Main execution
async function main() {
const keeper = new PositionKeeper();

try {
    await keeper.initialize();

    // Setup shutdown handlers
    process.on("SIGINT", async () => {
        console.log("[KEEPER] Received SIGINT");
        await keeper.shutdown();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        console.log("[KEEPER] Received SIGTERM");
        await keeper.shutdown();
        process.exit(0);
    });

} catch (error) {
    console.log("[KEEPER] Fatal error:", error.message);
    process.exit(1);
}
}

// Start the keeper
main().catch((error) => {
console.log("[KEEPER] Unhandled error:", error.message);
process.exit(1);
});

export default PositionKeeper;