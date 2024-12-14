import { ZetaClientWrapper, initializeExchange } from "./clients/zeta.js";
import { Connection } from "@solana/web3.js";
import { ASSETS, SYMBOLS, ACTIVE_SYMBOLS } from "./config/config.js";
import logger from "./utils/logger.js";
import { constants, types, Network, Exchange, utils } from "@zetamarkets/sdk";
import {
	BN,
	PriorityFeeMethod,
	PriorityFeeSubscriber,
	fetchSolanaPriorityFee,
} from "@drift-labs/sdk";
import WebSocket from "ws";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

/**
 * System Configuration Constants
 * These values control the timing and behavior of various system components.
 * They're separated here for easy adjustment and maintenance.
 */
const WS_HOST = process.env.WS_HOST || "api.nosol.lol";
const WS_PORT = process.env.WS_PORT || 8080;
const API_KEY = process.env.WS_API_KEY;
const MAX_QUEUE_SIZE = 1000; // Maximum number of signals to queue before dropping old ones

// Interval timings for various monitoring activities
const MONITORING_INTERVALS = {
	ACTIVE_POSITION: 3000, // How often to check position status during active management
	WAITING_CLOSURE: 15000, // Reduced frequency after stop loss is adjusted
	RECONNECT_DELAY: 5000, // Time between WebSocket reconnection attempts
	HEALTH_CHECK: 300000, // 5 min - How often to verify system health
};

/**
 * Validates system configuration and trading symbols
 * Performs essential checks before system startup to prevent runtime errors
 * @returns {string[]} Array of validated trading symbols
 * @throws {Error} If configuration is invalid
 */
function validateConfig() {
	// Essential environment variables that must be present
	const requiredEnvVars = [
		"KEYPAIR_FILE_PATH_LONG",
		"KEYPAIR_FILE_PATH_SHORT",
		"WS_API_KEY",
		"RPC_TRADINGBOT",
	];

	// Check for missing variables
	const missingVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);
	if (missingVars.length > 0) {
		logger.error(
			`[INIT] Missing required environment variables: ${missingVars.join(", ")}`
		);
		process.exit(1);
	}

	// Verify wallet files exist
	if (
		!fs.existsSync(process.env.KEYPAIR_FILE_PATH_LONG) ||
		!fs.existsSync(process.env.KEYPAIR_FILE_PATH_SHORT)
	) {
		logger.error("[INIT] Wallet files not found");
		process.exit(1);
	}

	const tradingSymbols = ACTIVE_SYMBOLS;

	// Validate all symbols are supported
	const invalidSymbols = tradingSymbols.filter(
		(symbol) => !ASSETS.includes(constants.Asset[symbol])
	);
	if (invalidSymbols.length > 0) {
		logger.error(
			`[INIT] Invalid trading symbols found: ${invalidSymbols.join(", ")}`
		);
		process.exit(1);
	}

	return tradingSymbols;
}

/**
 * Top-level manager class that coordinates the entire trading system
 * Handles both long and short trading operations across multiple symbols
 */
class MultiTradingManager {
	constructor() {
		// Core management components
		this.longManager = null; // Handles all long positions
		this.shortManager = null; // Handles all short positions
		this.symbols = []; // Active trading symbols

		// WebSocket state
		this.ws = null;
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 5;
		this.connectionActive = false;

		// Message handling
		this.messageQueue = []; // FIFO queue for incoming signals
		this.isProcessingQueue = false; // Prevents concurrent queue processing

		// System monitoring
		this.healthCheckInterval = null;
	}

	/**
	 * Initializes the trading system
	 * Creates managers for both directions and establishes market connection
	 */
	// Inside MultiTradingManager class
	async initialize(symbols) {
		this.symbols = symbols;
		console.log("[INIT] Initializing Multi-Trading Manager", {
			symbols: this.symbols,
			longWallet: process.env.KEYPAIR_FILE_PATH_LONG,
			shortWallet: process.env.KEYPAIR_FILE_PATH_SHORT,
		});

    // Get all market indices at once
		const marketIndices = this.symbols.map((symbol) => constants.Asset[symbol]);

  	const { connection } = await initializeExchange(marketIndices);

		// Initialize both trading directions
		this.longManager = new DirectionalTradingManager("long", this.symbols);
		await this.longManager.initialize(connection);

		this.shortManager = new DirectionalTradingManager("short", this.symbols);
		await this.shortManager.initialize(connection);

		// Do position check after both managers are initialized
		logger.info("[INIT] Checking existing positions");
		await this.longManager.checkExistingPositions();
		await this.shortManager.checkExistingPositions();

		this.setupWebSocket();
		this.setupHealthCheck();

		logger.info("[INIT] Trading system initialized successfully", {
			symbols: this.symbols,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Sets up WebSocket connection and message handling
	 * Manages subscription to trading signals for all symbols
	 */
	setupWebSocket() {
		if (this.ws) {
			this.ws.terminate();
		}

		this.ws = new WebSocket(`ws://${WS_HOST}:${WS_PORT}?apiKey=${API_KEY}`);

		this.ws.on("open", () => {
			this.connectionActive = true;
			this.reconnectAttempts = 0;
			console.log("[WS] Connected to signal stream");

			// Subscribe to symbols with direction
			this.symbols.forEach((symbol) => {
				// Subscribe long manager to long signals
				this.ws.send(
					JSON.stringify({
						type: "subscribe",
						symbol,
						direction: "long",
					})
				);

				// Subscribe short manager to short signals
				this.ws.send(
					JSON.stringify({
						type: "subscribe",
						symbol,
						direction: "short",
					})
				);

				console.log(`[WS] Subscribed to ${symbol} signals for both directions`);
			});
		});

		// Handle incoming messages
		this.ws.on("message", async (data) => {
			const signalData = JSON.parse(data.toString());

			// Handle connection acknowledgment
			if (signalData.type === "connection") {
				console.log("[WS] Server acknowledged connection:", {
					availableSymbols: signalData.symbols,
				});
				return;
			}

			// Only queue signals for symbols we're actually trading
			if (!this.symbols.includes(signalData.symbol)) {
				// console.log(`[WS] Ignoring signal for untracked symbol: ${signalData.symbol}`);
				return;
			}

			// Queue management - drop oldest if full
			if (this.messageQueue.length >= MAX_QUEUE_SIZE) {
				console.log("[WS] Queue full, dropping oldest message");
				this.messageQueue.shift();
			}

			this.messageQueue.push(signalData);
			console.log(`[WS] Queued signal for ${signalData.symbol}`);

			await this.processMessageQueue();
		});

		// Error handling
		this.ws.on("error", (error) => {
			console.log("[WS] WebSocket error:", error.message);
			this.connectionActive = false;
		});

		this.ws.on("close", (code, reason) => {
			this.connectionActive = false;
			console.log(`[WS] Connection closed (${code}): ${reason}`);

			if (this.reconnectAttempts < this.maxReconnectAttempts) {
				this.reconnect();
			} else {
				logger.error("[WS] Max reconnection attempts reached");
			}
		});
	}

	/**
	 * Processes queued messages in order
	 * Prevents concurrent processing with mutex
	 */
	async processMessageQueue() {
		if (this.isProcessingQueue) return;
		this.isProcessingQueue = true;

		while (this.messageQueue.length > 0) {
			const signalData = this.messageQueue.shift();

			if (!signalData?.symbol || signalData.direction === undefined) {
				console.log("[QUEUE] Skipping invalid message:", signalData);
				continue;
			}

			// Route to appropriate manager based on signal direction
			const direction = signalData.direction === 1 ? "long" : "short";
			const manager =
				direction === "long" ? this.longManager : this.shortManager;

			await manager.processSignal(signalData);
		}

		this.isProcessingQueue = false;
	}

	/**
	 * Attempts to reconnect WebSocket
	 * Implements progressive backoff
	 */
	reconnect() {
		if (this.reconnectAttempts < this.maxReconnectAttempts) {
			this.reconnectAttempts++;
			console.log(
				`[WS] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`
			);
			setTimeout(
				() => this.setupWebSocket(),
				MONITORING_INTERVALS.RECONNECT_DELAY
			);
		}
	}

	/**
	 * Monitors system health
	 * Checks connections and initiates recovery if needed
	 */
	setupHealthCheck() {
		this.healthCheckInterval = setInterval(() => {
			if (!this.connectionActive) {
				console.log("[HEALTH] WebSocket disconnected, attempting reconnect");
				this.reconnect();
			}

			console.log("[HEALTH] System Status:", {
				wsConnected: this.connectionActive,
				queueLength: this.messageQueue.length,
				reconnectAttempts: this.reconnectAttempts,
				timestamp: new Date().toISOString(),
			});
		}, MONITORING_INTERVALS.HEALTH_CHECK);
	}

	/**
	 * Gracefully shuts down the trading system
	 * Ensures all components are properly closed
	 */
	shutdown() {
		logger.info("[SHUTDOWN] Initiating graceful shutdown");
		clearInterval(this.healthCheckInterval);

		if (this.ws) {
			this.ws.close();
		}

		this.longManager.shutdown();
		this.shortManager.shutdown();

		console.log("[SHUTDOWN] Shutdown complete");
	}
}

/**
 * Manages trading operations for a specific direction (long/short)
 * Coordinates multiple symbols while maintaining direction-specific logic
 */
class DirectionalTradingManager {
	constructor(direction, symbols) {
		this.direction = direction; // 'long' or 'short'
		this.symbols = symbols; // Array of trading symbols
		this.symbolManagers = new Map(); // Map of symbol -> SymbolTradingManager
		this.isProcessing = false; // Prevents concurrent signal processing
		this.zetaWrapper = null; // Shared ZetaWrapper instance
	}

	async initialize(connection) {
		logger.info(
			`[INIT] Initializing ${this.direction} trading manager for:`,
			this.symbols
		);

		// Initialize single ZetaWrapper for all markets in this direction
		this.zetaWrapper = new ZetaClientWrapper();
		const keypairPath =
			this.direction === "long"
				? process.env.KEYPAIR_FILE_PATH_LONG
				: process.env.KEYPAIR_FILE_PATH_SHORT;

		// Initialize one client with all market indices
		await this.zetaWrapper.initializeClient(connection, keypairPath);

    // Create managers for each symbol sharing the same wrapper
		for (const symbol of this.symbols) {
			const marketIndex = constants.Asset[symbol];
			const manager = new SymbolTradingManager(
				marketIndex,
				this.direction,
				this.zetaWrapper
			);
			this.symbolManagers.set(symbol, manager);
		}

		logger.info(
			`[INIT] ${this.direction} manager initialized with ${this.symbols.length} symbols`
		);
	}

	async processSignal(signalData) {
		// Verify signal matches our direction
		const signalDirection = signalData.direction === 1 ? "long" : "short";
		if (signalDirection !== this.direction) {
			console.log(`[${this.direction}] Ignoring ${signalDirection} signal`);
			return;
		}

		if (this.isProcessing) {
			console.log(
				`[${this.direction}] Already processing signal, queued for next cycle`
			);
			return;
		}

		this.isProcessing = true;
		const manager = this.symbolManagers.get(signalData.symbol);
		if (!manager) {
			console.log(
				`[${this.direction}] No manager found for ${signalData.symbol}`
			);
			return;
		}

		await manager.processSignal(signalData);

		this.isProcessing = false;
	}

	// Inside DirectionalTradingManager class
	// In DirectionalTradingManager class
	async checkExistingPositions() {
		logger.info(
			`[INIT] Checking existing ${this.direction} positions for symbols:`,
			this.symbols
		);

		for (const [symbol, manager] of this.symbolManagers) {
			const marketIndex = constants.Asset[symbol];
			const position = await manager.zetaWrapper.getPosition(marketIndex);

			if (position && position.size !== 0) {
				// Verify position direction matches this manager
				const positionDirection = position.size > 0 ? "long" : "short";
				if (positionDirection === this.direction) {
					logger.info(
						`[INIT] Found existing ${this.direction} position for ${symbol}`,
						{
							size: position.size,
							entryPrice: position.costOfTrades
								? (position.costOfTrades / position.size).toFixed(4)
								: "N/A",
						}
					);

					await utils.sleep(250); // Jitter
					// Just use processSignal with a dummy signal to start monitoring if needed
					await manager.processSignal({
						symbol,
						direction: positionDirection === "long" ? 1 : -1,
						close: 0, // Price not needed for existing position check
						signal: 0,
					});
				}
			} else {
				logger.info(
					`[INIT] No existing ${this.direction} position found for ${symbol}`
				);
			}
		}
	}

	shutdown() {
		console.log(`[SHUTDOWN] Shutting down ${this.direction} trading manager`);
		// Clean up all symbol managers
		for (const manager of this.symbolManagers.values()) {
			manager.shutdown();
		}

		// Clean up the shared client
		if (this.zetaWrapper) {
			// Add any necessary cleanup for ZetaClientWrapper
			this.zetaWrapper = null;
		}
	}
}

/**
 * Manages trading operations for a specific symbol
 * Handles position entry, monitoring, and stop loss management
 */
class SymbolTradingManager {
	constructor(marketIndex, direction, zetaWrapper) {
		this.marketIndex = marketIndex;
		this.direction = direction;
		this.symbol = constants.Asset[marketIndex];
		this.zetaWrapper = zetaWrapper;
		this.monitoringIntervals = new Map();
		this.lastCheckedSize = null;
		this.monitoringState = new Map(); // Track monitoring state per position
		this.lastCheckedPrice = null;
		this.isAdjusting = false;

		this.baseMonitoringInterval = 3000; // Store base interval
		this.maxJitter = 1000; // Maximum jitter in milliseconds

		// Initialize progress tracking values
		this.hasReachedThreshold = false;
		this.maxProgressReached = 0;

		this.initialStopLossPrice = null; // Add this to track initial stop loss price
	}

	// Add this utility method to the class
	getJitteredInterval() {
		const jitter = Math.floor(Math.random() * this.maxJitter);
		return this.baseMonitoringInterval + jitter;
	}

	async processSignal(signalData) {
		const currentPosition = await this.zetaWrapper.getPosition(
			this.marketIndex
		);

		// For no position, only process entry signals
		if (!currentPosition || currentPosition.size === 0) {
			if (signalData.signal !== 0) {
				await this.openNewPosition(signalData);
			}
			return;
		}

		// For existing positions, start monitoring if not already doing so
		const positionId = this.generatePositionId(currentPosition);

		if (!this.monitoringIntervals.has(positionId)) {
			const monitorWithJitter = () => {
				const interval = this.getJitteredInterval();
				setTimeout(async () => {
					await this.monitorPosition(currentPosition);
					if (this.monitoringIntervals.has(positionId)) {
						monitorWithJitter();
					}
				}, interval);
			};

			this.monitoringIntervals.set(positionId, true);
			monitorWithJitter();
		}
	}

	async openNewPosition(signalData) {
		logger.info(
			`[TRADE] Opening ${this.direction} position for ${this.symbol}`,
			{
				price: signalData.close,
				timestamp: new Date().toISOString(),
			}
		);



		const tx = await this.zetaWrapper.openPositionWithTPSLVersioned(
			this.direction,
			this.marketIndex,
			"taker"
		);

		await utils.sleep(10000);
		console.log("waiting 10s");

		await this.zetaWrapper.client.updateState(true, true); // <- I thnk we need this but it's working and i dont want to restart it.

		const newPosition = await this.zetaWrapper.getPosition(this.marketIndex);

		const hasNewPosition = newPosition !== null && newPosition.size !== 0;

		if (hasNewPosition) {
			logger.info(`[TRADE] Position opened for ${this.symbol}`, {
				direction: this.direction,
				size: newPosition.size,
				price: signalData.close,
				txid: tx,
			});

			const positionId = this.generatePositionId(newPosition);
			const interval = setInterval(
				() => this.monitorPosition(newPosition),
				3000
			);
			this.monitoringIntervals.set(positionId, interval);
		} else {
			logger.error(`[TRADE] Failed to verify new position for ${this.symbol}`);
		}
	}

	async monitorPosition(originalPosition) {
		const positionId = this.generatePositionId(originalPosition);
		if (this.isProcessing) return;

		this.isProcessing = true;
		const currentPosition = await this.zetaWrapper.getPosition(
			this.marketIndex
		);

		if (!currentPosition || currentPosition.size === 0) {
			logger.info(
				`[${this.symbol}] Position closed or not found, stopping monitoring`
			);
			this.stopMonitoring(positionId);
			return;
		}

		const triggerOrders = await this.zetaWrapper.getTriggerOrders(
			this.marketIndex
		);
		const isShort = currentPosition.size < 0;
		const takeProfit = triggerOrders.find((order) =>
			isShort
				? order.triggerDirection === types.TriggerDirection.LESSTHANOREQUAL
				: order.triggerDirection === types.TriggerDirection.GREATERTHANOREQUAL
		);

		if (!takeProfit) {
			logger.info(
				`[${this.symbol}] Take profit order not found, stopping monitoring`
			);
			this.stopMonitoring(positionId);
			return;
		}

		const entryPrice = Math.abs(
			currentPosition.costOfTrades / currentPosition.size
		);
		const currentPrice = this.zetaWrapper.getCalculatedMarkPrice(
			this.marketIndex
		);
		const takeProfitPrice = this.zetaWrapper.roundToTickSize(
			takeProfit.orderPrice / 1e6
		);

		const totalDistanceToTP = Math.abs(takeProfitPrice - entryPrice);
		const currentDistance = isShort
			? entryPrice - currentPrice
			: currentPrice - entryPrice;
		const progressPercent = currentDistance / totalDistanceToTP;

		// Log only when price changes
		if (this.lastCheckedPrice !== currentPrice) {
			console.log(`[${this.symbol}] Position progress update`, {
				direction: isShort ? "SHORT" : "LONG",
				entry: entryPrice.toFixed(4),
				current: currentPrice.toFixed(4),
				takeProfit: takeProfitPrice.toFixed(4),
				progress: (progressPercent * 100).toFixed(2) + "%",
				thresholdReached: this.hasReachedThreshold,
			});
			this.lastCheckedPrice = currentPrice;
		}

		// Only track crossing the 60% threshold
		if (!this.hasReachedThreshold && progressPercent >= 0.6) {
			logger.info(
				`[${this.symbol}] Reached 60% threshold, monitoring for close conditions`
			);
			this.hasReachedThreshold = true;
		}

		// After threshold, check for closing conditions
		if (this.hasReachedThreshold) {
			if (progressPercent >= 1.0) {
				logger.info(
					`[${this.symbol}] Take profit target reached, closing position`
				);
				await this.closeAndVerifyPosition();
				return;
			}

			if (progressPercent <= 0.4) {
				logger.info(
					`[${this.symbol}] Price retraced below 40%, closing position`
				);
				await this.closeAndVerifyPosition();
				return;
			}
		}
		this.isProcessing = false;
	}

	async closeAndVerifyPosition() {
    
		logger.info(`[${this.symbol}] Attempting to close position`);

		const txid = await this.zetaWrapper.closePosition(this.marketIndex);

		logger.info(`[${this.symbol}] Close position transaction sent`, { txid });

		console.log("Waiting 5s...");
		await utils.sleep(5000);

		for (let i = 0; i < 5; i++) {
			await this.zetaWrapper.client.updateState();
			const position = await this.zetaWrapper.getPosition(this.marketIndex);

			if (!position || position.size === 0) {
				logger.info(`[${this.symbol}] Position closure verified`);
				this.stopMonitoring(this.generatePositionId(position));
				return true;
			}
			logger.info(
				`[${this.symbol}] Position still open, verification attempt ${i + 1}/5`
			);
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}

		logger.error(`[${this.symbol}] Failed to verify position closure`);
		return false;
	}

	// Modify stopMonitoring to work with new interval system
	stopMonitoring(positionId) {
		if (this.monitoringIntervals.has(positionId)) {
			this.monitoringIntervals.delete(positionId);
			console.log(`[${this.symbol}] Stopped monitoring ${positionId}`);
		}
	}

	generatePositionId(position) {
		return `${this.symbol}-${position.size > 0 ? "LONG" : "SHORT"}-${
			position.costOfTrades
		}`;
	}

	// Make sure to update the shutdown method
	shutdown() {
		for (const positionId of this.monitoringIntervals.keys()) {
			this.stopMonitoring(positionId);
		}
		logger.info(`[${this.symbol}] Manager shutdown complete`);
	}
}


/**
 * Main execution function
 * Initializes and runs the trading system
 */
async function main() {
	const tradingSymbols = validateConfig();
	logger.info("[INIT] Starting Multi-Symbol Trading System", {
		symbols: tradingSymbols,
	});

	const multiManager = new MultiTradingManager();
	await multiManager.initialize(tradingSymbols);

	// Add cleanup of priority fee interval
	process.on("SIGINT", () => {
		logger.info("[SHUTDOWN] Graceful shutdown initiated");
		// clearInterval(updateInterval);

		multiManager.shutdown();
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		logger.info("[SHUTDOWN] Graceful shutdown initiated");
		// clearInterval(updateInterval);

		multiManager.shutdown();
		process.exit(0);
	});
}

process.on("unhandledRejection", (reason, promise) => {
	logger.error("[ERROR] Unhandled Promise Rejection:", reason);
	process.exit(1);
});

process.on("uncaughtException", (error) => {
	logger.error("[ERROR] Uncaught Exception:", error);
	process.exit(1);
});

// Start the system
main().catch((error) => {
	logger.error("[MAIN] Unhandled error:", error);
	process.exit(1);
});
