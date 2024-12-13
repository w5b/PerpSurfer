# PerpSurfer Trading Bot

The PerpSurfer Trading Bot is an automated trading system for Zeta Markets perpetual futures. It features dual-direction trading capabilities with sophisticated risk management, including dynamic trailing stop losses and real-time market signal integration.

## Features

The PerpSurfer bot provides a complete perpetual futures trading solution with:

- Dual-direction trading using separate wallets for long and short positions 
- Real-time trading signals through secure WebSocket connection
- Intelligent position entry and management
- Dynamic trailing stop loss with automatic adjustment at profit targets
- Smart priority fee management for reliable transaction execution
- Optional Telegram notifications for trade monitoring
- Multi-market support across major assets

## How It Works

The PerpSurfer trading system operates as an integrated solution that receives real-time trading signals through our secure WebSocket connection. When a signal arrives, the system:
- Validates current market conditions
- Manages position entry using optimized priority fees
- Places coordinated take-profit and stop-loss orders
- Continuously monitors position progress
- Adjusts stop-loss levels automatically when reaching 60% of the take-profit target

Our risk management system includes:
- Complete wallet isolation between long and short positions
- Automatic stop-loss placement with each trade
- Dynamic trailing stop-loss adjustment based on profit targets
- Priority fee optimization for reliable execution
- Intelligent position size management based on account balance

## Setup Instructions

### 1. Get Your API Key

Access to our trading signals requires an API key:

1. Join our Discord server: https://discord.gg/dpzudaBwSa
2. Complete the server verification process
3. Navigate to the #PerpSurfer channel
4. Request an API key from the moderators
5. Keep your API key secure for configuration

### 2. Wallet Setup

The bot requires dedicated trading wallets for safety and position management:

1. Visit Zeta Markets using our affiliate link: https://dex.zeta.markets/?r=surf
2. Create two new wallets:
   - One designated for long positions
   - One designated for short positions
   - Important: Always use fresh wallets, never your main ones

3. Export your private keys:
   - In SolFlare, click on your wallet address
   - Select "Export Private Key"
   - Save the exported array format [1,2,3,...]
   - Perform this for both wallets

4. Create your wallet files:
   ```bash
   # Create a secure directory for wallets
   mkdir -p ~/.perpsurfer/wallets
   
   # Create and secure wallet files
   nano ~/.perpsurfer/wallets/long-wallet.json
   nano ~/.perpsurfer/wallets/short-wallet.json
   ```

   Paste the respective private key arrays into each file.

### 3. RPC and Priority Fees Setup

The bot requires two separate configurations for optimal performance: an RPC endpoint for transaction processing and a Helius API key for priority fee management.

#### RPC Setup
You can use any reliable RPC provider of your choice for transaction processing. Some options include:
- Helius (https://helius.dev)
- QuickNode (https://quicknode.com)
- Chainstack (https://chainstack.com)
- Or any other Solana RPC provider

When selecting an RPC provider, consider their rate limits and reliability. Configure your throttle settings based on your provider's limits:

For providers with lower rate limits (like free tiers):
```javascript
const loadExchangeConfig = types.defaultLoadExchangeConfig(
  Network.MAINNET,
  connection,
  {
    skipPreflight: true,
    preflightCommitment: "finalized",
    commitment: "finalized",
  },
  500,  // Set throttle to 500ms for lower-tier RPCs
  true,
  connection,
  marketsArray,
  undefined,
  marketsArray,
);
```

For providers with higher rate limits (e.g., 50 RPS):
```javascript
  25,  // Set throttle to 25ms for high-performance RPCs
```

#### Priority Fees Setup
While you can choose any RPC provider for transactions, the priority fee estimation system specifically requires a Helius API key. This is necessary even if you're using a different RPC provider for transactions. To set this up:

1. Visit https://helius.dev
2. Create a free account
3. Generate an API key from your dashboard
4. Save this API key for your configuration

The free tier of Helius is sufficient for priority fee estimation, as this feature uses minimal API calls.

This separation allows you to optimize your setup: use your preferred RPC provider for transaction processing while leveraging Helius's priority fee estimation capabilities for optimal trade execution.

### 4. Project Installation

Install pnpm if you haven't already:
```bash
npm install -g pnpm
```

Install the project:
```bash
# Clone the repository
git clone https://github.com/SurfSolana/PerpSurfer
cd PerpSurfer

# Install dependencies
pnpm install
```

### 5. Configuration

1. Create your environment file:
   ```bash
   cp dotenv.example.txt .env
   ```

2. Edit the `.env` file with your details:
   ```env
   # Trading Signals API
   WS_API_KEY=your_api_key_from_discord
   WS_HOST=api.nosol.lol
   WS_PORT=8080

   # RPC and Priority Fee Configuration
   RPC_TRADINGBOT=your_preferred_rpc_endpoint
   HELIUS_API_KEY=your_helius_api_key_for_priority_fees

   # Wallet Paths - Update with your actual paths
   KEYPAIR_FILE_PATH_LONG=/home/yourusername/.perpsurfer/wallets/long-wallet.json
   KEYPAIR_FILE_PATH_SHORT=/home/yourusername/.perpsurfer/wallets/short-wallet.json
   ```

### 6. Optional Telegram Setup

For trade notifications:

1. Create a Telegram bot:
   - Message @BotFather on Telegram
   - Send /newbot
   - Follow the prompts
   - Save the provided API token

2. Get your Chat ID:
   - Message @userinfobot on Telegram
   - Save the ID number it provides

3. Add to your `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ADMIN_CHAT_ID=your_chat_id
   ```

### 7. Running the Bot

Start the bot:
```bash
node src/main.js
```

For production deployment, use PM2:
```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start src/main.js --name perpsurfer

# Make it start on system boot
pm2 startup
pm2 save
```

### 8. Opening Positions Manually

While the bot typically operates autonomously based on trading signals, you can also open positions manually using the included `open-position.js` script. This is useful for testing your setup or taking specific trades outside the automated system.

#### Basic Usage

The script accepts several command-line arguments to customize your trade. Here's a simple example:

```bash
# Open a long position in SOL with default settings
node open-position.js -d long -s SOL

# Open a short position in ETH with custom leverage
node open-position.js -d short -s ETH -l 3
```

#### Available Parameters

The script supports the following parameters to customize your trades:

Required Parameters:
- `-d, --direction`: Position direction (`long` or `short`)
- `-s, --symbol`: Trading asset (`SOL`, `ETH`, `BTC`, etc.)

Position Settings:
- `-l, --leverage`: Leverage multiplier (default: 4)
- `--tp, --takeProfit`: Take profit percentage (default: 0.036 = 3.6%)
- `--sl, --stopLoss`: Stop loss percentage (default: 0.018 = 1.8%)
- `-o, --orderType`: Order type (`maker` or `taker`, default: `taker`)

#### Examples

Here are some common use cases:

1. Open a basic long position:
   ```bash
   node open-position.js -d long -s SOL
   ```

2. Open a short with custom leverage and take profit:
   ```bash
   node open-position.js -d short -s ETH -l 3 --tp 0.04
   ```

3. Open a position as a maker order (limit order):
   ```bash
   node open-position.js -d long -s BTC -o maker
   ```

4. Open a position with custom risk parameters:
   ```bash
   node open-position.js -d long -s SOL -l 2 --tp 0.05 --sl 0.02
   ```

#### Understanding Order Types

- `taker` (default): Market orders that execute immediately at the best available price
- `maker`: Limit orders that wait for the market to come to your price

Maker orders typically have lower fees but might not fill immediately. Taker orders fill instantly but have higher fees.

#### Getting Help

For a full list of options and examples:
```bash
node open-position.js --help
```

The script will show detailed usage instructions and examples for all available parameters.

#### Important Notes

1. The script uses the same wallet configuration as the main bot:
   - Long positions use the wallet specified in `KEYPAIR_FILE_PATH_LONG`
   - Short positions use the wallet specified in `KEYPAIR_FILE_PATH_SHORT`

2. Risk parameters (-l, --tp, --sl) override the default bot settings only for the manual trade.

3. The script automatically handles:
   - Priority fee optimization
   - Take profit and stop loss order placement
   - Position size calculation based on your wallet balance
   - Market initialization and connection management

Remember to monitor your positions after opening them, as manually opened positions aren't automatically managed by the bot's trailing stop loss system.

## Risk Management Configuration

The bot's risk management system is configured through settings in the ZetaClientWrapper class. These settings control position sizing, take profits, stop losses, and trailing stop loss behavior.

### Position Size and Leverage

The bot implements a carefully designed leverage system that accounts for the different maximum leverage limits available on Zeta Markets for different assets. This is managed through the `leverageMultiplier` setting in your configuration.

Let's understand how the leverage system works:

For SOL, ETH, and BTC positions:
- The bot will use your configured `leverageMultiplier` setting directly
- While Zeta Markets allows up to 20x leverage for these assets, you should never use the maximum leverage
- Example: With `leverageMultiplier: 4`, a $1000 wallet can take positions worth $4000 in these markets

For all other assets:
- The bot automatically caps leverage at 1x regardless of your settings
- This is because these markets have a maximum leverage of 5x on Zeta Markets
- This built-in limitation helps protect against excessive risk in less liquid markets
- Example: With the same $1000 wallet, positions in these markets will be limited to $1000

The leverage logic is implemented in the `calculatePricesAndSize` function:

```javascript
const leverage =
  marketIndex === constants.Asset.SOL ||
  marketIndex === constants.Asset.ETH ||
  marketIndex === constants.Asset.BTC
    ? settings.leverageMultiplier
    : 1;
```

This means that if you set `leverageMultiplier: 4` in your settings:
- SOL, ETH, and BTC positions will use 4x leverage
- All other assets will automatically use 1x leverage for safety

When choosing your leverage setting, consider these important factors:
- Higher leverage means higher risk of liquidation
- Market volatility can quickly trigger stop losses or liquidations at higher leverage
- Consider starting with lower leverage until you're comfortable with the bot's operation
- Never use maximum leverage (20x) as this leaves no room for market volatility

### Take Profit and Stop Loss

The take profit and stop loss are set as percentages of your entry price:

```javascript
takeProfitPercentage: 0.036,  // 1.8% take profit
stopLossPercentage: 0.018,    // 2.5% stop loss
```

For example, if you enter a long position at $100:
- Take Profit would be set at $101.80 (100 + 1.8%)
- Stop Loss would be set at $97.50 (100 - 2.5%)

For short positions, these are reversed:
- Take Profit would be set at $98.20 (100 - 1.8%)
- Stop Loss would be set at $102.50 (100 + 2.5%)

### Trailing Stop Loss System

The trailing stop loss activates when your position moves in profit:

```javascript
trailingStopLoss: {
    progressThreshold: 0.6,    // 60% of the way to take profit
    stopLossDistance: 0.4,     // 40% of the total move
    triggerDistance: 0.45,     // 45% of the total move
}
```

Example for a long position entered at $100 with 1.8% take profit target ($101.80):
1. The total move to take profit is $1.80
2. When price reaches $101.08 (60% of the way to take profit):
   - The stop loss will move to $100.72 (locks in 40% of the move)
   - The trigger price will be set at $100.81 (45% of the move)

For short positions, the same percentages apply in the opposite direction.

## Monitoring

The bot creates two log files:
- `error.log`: Contains error messages only
- `combined.log`: Contains all log messages

If configured, Telegram notifications will inform you about:
- Trade entries and exits
- Stop loss adjustments
- Error conditions
- System status updates

## Best Practices

Security Practices:
1. Use dedicated trading wallets only
2. Keep your API keys secure
3. Keep your wallet private keys secure
4. Monitor your positions regularly

## Track wallets without logging in

You can easily track multiple wallets on zeta by going to the following links.

Set your *PUBLIC* key in the URL:

- https://dex.zeta.markets/portfolio/YOUR_LONG_WALLET_PUBLIC_KEY

- https://dex.zeta.markets/portfolio/YOUR_SHORT_WALLET_PUBLIC_KEY

## Support

We're here to help:
1. Discord: https://discord.gg/dpzudaBwSa
2. Website: https://surfsolana.com/
3. Trading signals support: #PerpSurfer channel on Discord
4. Technical support: #support channel on Discord

## Disclaimer

Trading cryptocurrency perpetual futures carries significant risk. This bot is provided as-is, with no guarantees of profit or performance. Always start with small position sizes and monitor the bot's performance carefully. Past performance does not indicate future results.