import PositionKeeper from './positionKeeper.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

/**
 * Validates required configuration and files before startup
 */
function validateEnvironment() {
    // Check for required environment variables
    const requiredVars = [
        'KEYPAIR_FILE_PATH_LONG',
        'KEYPAIR_FILE_PATH_SHORT',
        'RPC_TRADINGBOT'
    ];

    const missing = requiredVars.filter(varName => !process.env[varName]);
    if (missing.length > 0) {
        console.error('Missing required environment variables:', missing.join(', '));
        process.exit(1);
    }

    // Check for strategies configuration
    const strategiesPath = path.join(process.cwd(), 'strategies.json');
    if (!fs.existsSync(strategiesPath)) {
        console.log('Creating default strategies configuration...');
        const defaultStrategies = {
            strategies: {
                default: {
                    type: "fixed",
                    takeProfit: 0.036,
                    stopLoss: 0.018,
                    triggers: {
                        at: 0.60,
                        moveStopLossTo: 0.40
                    }
                },
                BTC: {
                    type: "ratchet",
                    ratchet: {
                        threshold: 0.05,    // 5% move triggers ratchet
                        increment: 0.03     // Move stop loss 3% each time
                    }
                }
            }
        };

        fs.writeFileSync(strategiesPath, JSON.stringify(defaultStrategies, null, 2));
    }
}

/**
 * Main execution function
 */
async function main() {
    console.log('Starting Position Keeper...');
    
    try {
        // Validate environment and configuration
        validateEnvironment();

        // Create and initialize the keeper
        const keeper = new PositionKeeper();
        await keeper.initialize();

        // Handle shutdown signals
        const shutdownHandler = async (signal) => {
            console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
            try {
                await keeper.shutdown();
                console.log('Shutdown complete. Exiting...');
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdownHandler('SIGINT'));
        process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

        // Handle uncaught errors
        process.on('uncaughtException', async (error) => {
            console.error('Uncaught Exception:', error);
            await shutdownHandler('UNCAUGHT_EXCEPTION');
        });

        process.on('unhandledRejection', async (error) => {
            console.error('Unhandled Promise Rejection:', error);
            await shutdownHandler('UNHANDLED_REJECTION');
        });

        // Keep the process running
        console.log('Position Keeper running. Press Ctrl+C to exit.');
    } catch (error) {
        console.error('Fatal error during startup:', error);
        process.exit(1);
    }
}

// Execute main function
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});