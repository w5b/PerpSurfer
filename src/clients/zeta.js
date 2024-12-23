import {
	Wallet,
	CrossClient,
	Exchange,
	Network,
	Market,
	utils,
	types,
	assets,
	constants,
	events,
} from "@zetamarkets/sdk";
import {
	PublicKey,
	Connection,
	Keypair,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
} from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import logger from "../utils/logger.js";
import { BN } from "@drift-labs/sdk";

dotenv.config();

export async function initializeExchange(markets) {
	const connection = new Connection(process.env.RPC_TRADINGBOT);

	// Create set of markets to load
	const marketsToLoad = new Set([constants.Asset.SOL, ...markets]);
	const marketsArray = Array.from(marketsToLoad);

	const loadExchangeConfig = types.defaultLoadExchangeConfig(
		Network.MAINNET,
		connection,
		{
			skipPreflight: true,
			preflightCommitment: "finalized",
			commitment: "finalized",
		},
		25, // 50rps chainstack = 20ms delay, set to 25 for funzies
		true,
		connection,
		marketsArray,
		undefined,
		marketsArray
	);

	await Exchange.load(loadExchangeConfig);

	logger.info("Exchange loaded successfully");

	Exchange.setUseAutoPriorityFee(false);
	await updatePriorityFees();

	return { connection };
}

export async function updatePriorityFees() {
	const helius_url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

	const response = await fetch(helius_url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "getPriorityFeeEstimate",
			params: [
				{
					accountKeys: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
					options: {
						includeAllPriorityFeeLevels: true,
					},
				},
			],
		}),
	});

	const data = await response.json();

	console.log("Fees: ", data.result.priorityFeeLevels);

	// Fees:  {
	//  min: 0,
	//  low: 0,
	//  medium: 1,
	//  high: 120000,
	//  veryHigh: 10526633,
	//  unsafeMax: 3988354006
	//  }

	Exchange.updatePriorityFee(data.result.priorityFeeLevels.high);

	console.log("Set Fee Level to high: ", data.result.priorityFeeLevels.high);
}

export class ZetaClientWrapper {
	constructor() {
		this.client = null;
		this.connection = null;
		this.wallet = null;
		this.activeMarket = constants.Asset.SOL;
		this.use_db_settings = true;

		this.priorityFees = null;
		this.priorityFeeMultiplier = 8;
		this.currentPriorityFee = 5_000;

		this.monitoringInterval = null;

		this.positionState = {
			isMonitoring: false,
			isAdjusting: false,
			marketIndex: null,
			position: null,
			orders: {
				takeProfit: null,
				stopLoss: null,
			},
			entryPrice: null,
			hasAdjustedStopLoss: false,
		};

		this.settings = {
			leverageMultiplier: 4,
			takeProfitPercentage: 0.036,
			stopLossPercentage: 0.018,
			trailingStopLoss: {
				progressThreshold: 0.6,
				stopLossDistance: 0.4,
				triggerDistance: 0.45,
			},
		};
	}

	/**
	 * Rounds a price to the nearest valid tick size increment
	 * @param {number} price - The price to round
	 * @param {number} [tickSize=0.0001] - The minimum price increment
	 * @returns {number} The price rounded to the nearest tick size
	 * @throws {Error} If price is not a valid number
	 */
	roundToTickSize(price) {
		// Validate input
		if (typeof price !== "number" || isNaN(price)) {
			throw new Error("Price must be a valid number");
		}

		const tickSize = 0.0001;

		// Round to nearest tick using Math.round for proper rounding behavior
		// First divide by tickSize to get number of ticks
		// Round that to nearest whole number
		// Multiply by tickSize to get final price
		const roundedPrice = Math.round(price / tickSize) * tickSize;

		// Format to 4 decimal places to match tick size precision
		return Number(roundedPrice.toFixed(4));
	}

	async initializeClient(connection = this.connection, keypairPath = null) {
		const keyPath = keypairPath || process.env.KEYPAIR_FILE_PATH;

		this.connection = connection;

		// Load wallet
		const secretKeyString = fs.readFileSync(keyPath, "utf8");
		const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
		const keypair = Keypair.fromSecretKey(secretKey);
		this.wallet = new Wallet(keypair);

		logger.info("Wallet initialized", { usingPath: keyPath });

		// Create client
		this.client = await CrossClient.load(
			this.connection,
			this.wallet,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			undefined
		);

		logger.info("ZetaClientWrapper initialized successfully");
	}

	async getPosition(marketIndex) {
		await this.client.updateState();
		const positions = this.client.getPositions(marketIndex);
		console.log("Position check:", {
			marketIndex,
			hasPosition: !!positions[0],
			size: positions[0]?.size || 0,
		});
		return positions[0] || null;
	}

	getCalculatedMarkPrice(asset = this.activeMarket) {
		Exchange.getPerpMarket(asset).forceFetchOrderbook();
		const orderBook = Exchange.getOrderbook(asset);

		if (!orderBook?.asks?.[0]?.price || !orderBook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data");
		}

		return Number((orderBook.asks[0].price + orderBook.bids[0].price) / 2);
	}

	async checkPositionProgress() {
		if (this.positionState.hasAdjustedStopLoss) {
			this.stopPositionMonitoring();
			return;
		}

		await this.client.updateState();

		const positions = this.client.getPositions(this.positionState.marketIndex);
		const currentPosition = positions[0];

		if (!currentPosition) {
			logger.info("Position closed, stopping monitoring");
			this.stopPositionMonitoring();
			return;
		}

		const currentPrice = await this.getCalculatedMarkPrice(
			this.positionState.marketIndex
		);
		const newStopLossPrices = this.calculateTrailingStopLoss(currentPrice);

		if (newStopLossPrices) {
			const adjustmentSuccess = await this.adjustStopLossOrder(
				newStopLossPrices
			);
			if (!adjustmentSuccess) {
				throw new Error("Failed to adjust stop loss");
			}

			const verificationSuccess = await this.verifyStopLossAdjustment(
				newStopLossPrices
			);
			if (!verificationSuccess) {
				throw new Error("Stop loss adjustment failed verification");
			}

			this.positionState.hasAdjustedStopLoss = true;
			this.stopPositionMonitoring();
		}
	}

	async closePosition(marketIndex) {
		// Update state and get current position
		await this.client.updateState(true, true);

		const position = await this.getPosition(marketIndex);

    const side = position.size > 0 ? types.Side.ASK : types.Side.BID;

		// Early return if no position exists
		if (!position || position.size === 0) {
			logger.info(
				`No position to close for ${assets.assetToName(marketIndex)}`
			);
			return null;
		} else {
			logger.info(
				`Closing position for ${assets.assetToName(marketIndex)}`,
				position
			);
		}

		const closePrice = this.getClosePrice(marketIndex, side);

		// Calculate position size
		const rawPositionSize = Math.abs(position.size);
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(rawPositionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);
		const actualPositionSize = lotSize * decimalMinLotSize;

		logger.info(`Lots Debug:`, {
			rawPositionSize,
			decimalMinLotSize,
			lotSize,
			nativeLotSize,
			actualPositionSize,
		});

		await this.client.updateState(true, true);

		await updatePriorityFees();

		let transaction = new Transaction();

		const mainOrderIx = this.createMainOrderInstruction(
			marketIndex,
			closePrice,
			nativeLotSize,
			side,
			"taker"
		);

		transaction.add(mainOrderIx);

		try {
			const txid = await utils.processTransaction(
				this.client.provider,
				transaction,
				undefined,
				{
					skipPreflight: true,
					preflightCommitment: "finalized",
					commitment: "finalized",
				},
				false,
				utils.getZetaLutArr()
			);

			logger.info(`Transaction sent successfully. txid: ${txid}`);

			return txid;
		} catch (error) {
			logger.error(`Open Position TX Error:`, error);
		}
	}

	async openPositionWithTPSLVersioned(
		direction,
		marketIndex = this.activeMarket,
		makerOrTaker = "maker"
	) {
		logger.info(
			`Opening ${direction} position for ${assets.assetToName(marketIndex)}`
		);

		await this.client.updateState(true, true);

		const openTriggerOrders = await this.getTriggerOrders(marketIndex);

		if (openTriggerOrders && openTriggerOrders.length > 0) {
			logger.info("Found Trigger Orders, Cancelling...", openTriggerOrders);

			this.client.cancelAllTriggerOrders(marketIndex);
		}

		await this.client.updateState(true, true);

		await updatePriorityFees();

		const settings = this.fetchSettings();

		logger.info(`Using settings:`, settings);

		const balance = Exchange.riskCalculator.getCrossMarginAccountState(
			this.client.account
		).balance;
		const side = direction === "long" ? types.Side.BID : types.Side.ASK;

		const { currentPrice, adjustedPrice, positionSize, nativeLotSize } =
			this.calculatePricesAndSize(
				side,
				marketIndex,
				balance,
				settings,
				"taker"
			);

		const {
			takeProfitPrice,
			takeProfitTrigger,
			stopLossPrice,
			stopLossTrigger,
		} = this.calculateTPSLPrices(direction, adjustedPrice, settings);

		logger.info(`
  Opening ${direction} position:
  ------------------------------
      Take Profit ⟶ $${takeProfitPrice}
                        ↑ 
      TP Trigger ⟶ $${takeProfitTrigger}
                        ↑ 
  -------- Entry ⟶ $${adjustedPrice} -----
                        ↓
      SL Trigger ⟶ $${stopLossTrigger}
                        ↓
        SL Price ⟶ $${stopLossPrice}
  ------------------------------`);

		await this.client.updateState(true, true);

		let transaction = new Transaction();

		let triggerBit_TP = this.client.findAvailableTriggerOrderBit();
		let triggerBit_SL = this.client.findAvailableTriggerOrderBit(
			triggerBit_TP + 1
		);

		const mainOrderIx = this.createMainOrderInstruction(
			marketIndex,
			adjustedPrice,
			nativeLotSize,
			side,
			"taker"
		);
		const tpOrderIx = this.createTPOrderInstruction(
			direction,
			marketIndex,
			takeProfitPrice,
			takeProfitTrigger,
			nativeLotSize,
			triggerBit_TP
		);
		const slOrderIx = this.createSLOrderInstruction(
			direction,
			marketIndex,
			stopLossPrice,
			stopLossTrigger,
			nativeLotSize,
			triggerBit_SL
		);

		transaction.add(mainOrderIx);
		transaction.add(tpOrderIx);
		transaction.add(slOrderIx);

		try {
			const txid = await utils.processTransaction(
				this.client.provider,
				transaction,
				undefined,
				{
					skipPreflight: true,
					preflightCommitment: "finalized",
					commitment: "finalized",
				},
				false,
				utils.getZetaLutArr()
			);

			logger.info(`Transaction sent successfully. txid: ${txid}`);

			return txid;
		} catch (error) {
			logger.error(`Open Position TX Error:`, error);
		}
	}

	async getTriggerOrders(marketIndex = this.activeMarket) {
		const triggerOrders = await this.client.getTriggerOrders(marketIndex);
		return triggerOrders;
	}

	fetchSettings() {
		return this.settings;
	}

	calculateTPSLPrices(direction, entryPrice, settings) {
		if (!direction || !entryPrice || !settings) {
			throw new Error("Invalid inputs for TP/SL calculation");
		}

		const { takeProfitPercentage, stopLossPercentage } = settings;
		const isLong = direction === "long";

		// Calculate raw prices first
		const rawTakeProfit = isLong
			? entryPrice * (1 + takeProfitPercentage)
			: entryPrice * (1 - takeProfitPercentage);

		const rawStopLoss = isLong
			? entryPrice * (1 - stopLossPercentage)
			: entryPrice * (1 + stopLossPercentage);

		// Calculate trigger distances (95% of the way to target)
		const tpDistance = Math.abs(rawTakeProfit - entryPrice);
		const slDistance = Math.abs(rawStopLoss - entryPrice);

		// Round all prices to tick size
		const takeProfitPrice = this.roundToTickSize(rawTakeProfit);
		const takeProfitTrigger = this.roundToTickSize(
			isLong ? entryPrice + tpDistance * 0.95 : entryPrice - tpDistance * 0.95
		);

		const stopLossPrice = this.roundToTickSize(rawStopLoss);
		const stopLossTrigger = this.roundToTickSize(
			isLong ? entryPrice - slDistance * 0.95 : entryPrice + slDistance * 0.95
		);

		return {
			takeProfitPrice,
			takeProfitTrigger,
			stopLossPrice,
			stopLossTrigger,
		};
	}

	createTPOrderInstruction(
		direction,
		marketIndex,
		takeProfitPrice,
		takeProfitTrigger,
		nativeLotSize,
		triggerOrderBit = 0
	) {
		const tp_side = direction === "long" ? types.Side.ASK : types.Side.BID;
		const triggerDirection =
			direction === "long"
				? types.TriggerDirection.GREATERTHANOREQUAL
				: types.TriggerDirection.LESSTHANOREQUAL;

		// Convert decimal prices to native integers
		const nativeTakeProfit =
			utils.convertDecimalToNativeInteger(takeProfitPrice);
		const nativeTPTrigger =
			utils.convertDecimalToNativeInteger(takeProfitTrigger);

		return this.client.createPlaceTriggerOrderIx(
			marketIndex,
			nativeTakeProfit,
			nativeLotSize,
			tp_side,
			nativeTPTrigger,
			triggerDirection,
			new BN(0),
			types.OrderType.FILLORKILL,
			triggerOrderBit,
			{
				reduceOnly: true,
				tag: constants.DEFAULT_ORDER_TAG,
			}
		);
	}

	createSLOrderInstruction(
		direction,
		marketIndex,
		stopLossPrice,
		stopLossTrigger,
		nativeLotSize,
		triggerOrderBit = 1
	) {
		const sl_side = direction === "long" ? types.Side.ASK : types.Side.BID;
		const triggerDirection =
			direction === "long"
				? types.TriggerDirection.LESSTHANOREQUAL
				: types.TriggerDirection.GREATERTHANOREQUAL;

		// Convert decimal prices to native integers
		const nativeStopLoss = utils.convertDecimalToNativeInteger(stopLossPrice);
		const nativeSLTrigger =
			utils.convertDecimalToNativeInteger(stopLossTrigger);

		return this.client.createPlaceTriggerOrderIx(
			marketIndex,
			nativeStopLoss,
			nativeLotSize,
			sl_side,
			nativeSLTrigger,
			triggerDirection,
			new BN(0),
			types.OrderType.FILLORKILL,
			triggerOrderBit,
			{
				reduceOnly: true,
				tag: constants.DEFAULT_ORDER_TAG,
			}
		);
	}

	calculatePricesAndSize(
		side,
		marketIndex,
		balance,
		settings,
		makerOrTaker = "maker"
	) {
		// Input validation with detailed logging
		if (
			side === undefined ||
			side === null ||
			!marketIndex ||
			!balance ||
			!settings
		) {
			logger.error("Invalid inputs for price calculation:", {
				side,
				marketIndex,
				balance: balance?.toString(),
				hasSettings: !!settings,
				settingsContent: settings,
			});
			throw new Error("Invalid inputs for price and size calculation");
		}

		// Log settings received
		logger.info("Calculating prices and size with settings:", {
			side: side === types.Side.BID ? "BID" : "ASK",
			marketName: assets.assetToName(marketIndex),
			balance: balance.toString(),
			leverageMultiplier: settings.leverageMultiplier,
			orderType: makerOrTaker,
		});

		// Get orderbook data
		Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
		const orderbook = Exchange.getOrderbook(marketIndex);

		if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data for price calculation");
		}

		// Calculate current price based on side
		const currentPrice =
			side === types.Side.BID
				? orderbook.asks[0].price
				: orderbook.bids[0].price;

		logger.info("Market prices:", {
			bestAsk: orderbook.asks[0].price.toFixed(4),
			bestBid: orderbook.bids[0].price.toFixed(4),
			selectedPrice: currentPrice.toFixed(4),
		});

		// Calculate adjusted price with slippage
		const slippage = 0.0001;
		const adjustedPrice = this.roundToTickSize(
			makerOrTaker === "maker"
				? side === types.Side.BID
					? currentPrice + slippage
					: currentPrice - slippage
				: side === types.Side.BID
				? currentPrice * (1 + slippage * 5)
				: currentPrice * (1 - slippage * 5)
		);

		// Determine leverage based on market
		const isMainAsset =
			marketIndex === constants.Asset.SOL ||
			marketIndex === constants.Asset.ETH ||
			marketIndex === constants.Asset.BTC;

		const leverage = isMainAsset ? settings.leverageMultiplier : 1;

		logger.info("Leverage calculation:", {
			asset: assets.assetToName(marketIndex),
			isMainAsset,
			configuredLeverage: settings.leverageMultiplier,
			finalLeverage: leverage,
			reason: isMainAsset
				? "Major asset - using configured leverage"
				: "Minor asset - fixed at 1x",
		});

		// Calculate position size
		const rawPositionSize = (balance * leverage) / currentPrice;
		const decimalMinLotSize = utils.getDecimalMinLotSize(marketIndex);
		const lotSize = Math.floor(rawPositionSize / decimalMinLotSize);
		const nativeLotSize = lotSize * utils.getNativeMinLotSize(marketIndex);
		const actualPositionSize = lotSize * decimalMinLotSize;

		logger.info("Position size calculation:", {
			rawSize: rawPositionSize,
			minLotSize: decimalMinLotSize,
			lotSize,
			finalSize: actualPositionSize,
			nativeLotSize: nativeLotSize.toString(),
			effectiveValue: (actualPositionSize * currentPrice).toFixed(2),
			effectiveLeverage:
				((actualPositionSize * currentPrice) / balance).toFixed(2) + "x",
		});

		return {
			currentPrice,
			adjustedPrice,
			positionSize: actualPositionSize,
			nativeLotSize,
		};
	}

	getClosePrice(marketIndex, side) {
		// Get orderbook data
		Exchange.getPerpMarket(marketIndex).forceFetchOrderbook();
		const orderbook = Exchange.getOrderbook(marketIndex);

		if (!orderbook?.asks?.[0]?.price || !orderbook?.bids?.[0]?.price) {
			throw new Error("Invalid orderbook data for price calculation");
		}

		// Calculate current price based on side
		const currentPrice =
			side === types.Side.BID
				? orderbook.asks[0].price
				: orderbook.bids[0].price;

		const makerOrTaker = "taker";

		// Calculate adjusted price with slippage
		const slippage = 0.0001;
		const closePrice = this.roundToTickSize(
			makerOrTaker === "maker"
				? side === types.Side.BID
					? currentPrice + slippage
					: currentPrice - slippage
				: side === types.Side.BID
				? currentPrice * (1 + slippage * 5)
				: currentPrice * (1 - slippage * 5)
		);

		return closePrice;
	}

	createMainOrderInstruction(
		marketIndex,
		adjustedPrice,
		nativeLotSize,
		side,
		makerOrTaker = "maker"
	) {
		// adjustedPrice comes in as a decimal value (e.g., 232.30)
		// We convert it directly to native format without additional division
		const nativePrice = utils.convertDecimalToNativeInteger(adjustedPrice);

		logger.info("Creating main order instruction:", {
			market: assets.assetToName(marketIndex),
			priceInfo: {
				originalPrice: adjustedPrice,
				nativePrice: nativePrice.toString(),
			},
			sizeInfo: {
				nativeLotSize: nativeLotSize.toString(),
			},
			orderDetails: {
				side: side === types.Side.BID ? "BID" : "ASK",
				type: makerOrTaker === "maker" ? "POST_ONLY_SLIDE" : "LIMIT",
				expiryOffset: 180,
			},
		});

		return this.client.createPlacePerpOrderInstruction(
			marketIndex,
			nativePrice,
			nativeLotSize,
			side,
			{
				orderType:
					makerOrTaker === "maker"
						? types.OrderType.POSTONLYSLIDE
						: types.OrderType.LIMIT,
				tifOptions: {
					expiryOffset: 180,
				},
			}
		);
	}

	stopPositionMonitoring() {
		if (this.monitoringInterval) {
			clearInterval(this.monitoringInterval);
			this.monitoringInterval = null;
			this.positionState = {
				isMonitoring: false,
				isAdjusting: false,
				marketIndex: null,
				position: null,
				orders: {
					takeProfit: null,
					stopLoss: null,
				},
				entryPrice: null,
				hasAdjustedStopLoss: false,
			};
		}
		console.log("[MONITOR] Stopped position monitoring");
	}
}
