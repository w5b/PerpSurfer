import winston from 'winston';
import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID } from './config.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Initialize Telegram only if configured
let bot = null;
const isTelegramConfigured = Boolean(TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID);

if (isTelegramConfigured) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
}

const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}] : ${message}`;
  if (stack) {
    msg += `\n${stack}`;
  }
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata, null, 2)}`;
  }
  return msg;
});

const logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp(),
    errors({ stack: true }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        logFormat
      )
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Helper functions
function getEmojiForLogLevel(level) {
  switch (level) {
    case 'error': return '🚫';
    case 'warn': return '⚠️';
    case 'info': return '✅';
    case 'http': return '🌐';
    case 'verbose': return '📝';
    case 'debug': return '🔍';
    case 'silly': return '🃏';
    default: return '🪵';
  }
}

function truncate(str, maxLength = 100) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

function safeStringify(obj, spaces = 2) {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value, spaces);
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function splitLongMessage(message, maxLength = 4000) {
  const parts = [];
  while (message.length > 0) {
    if (message.length <= maxLength) {
      parts.push(message);
      break;
    }
    
    let part = message.substr(0, maxLength);
    let lastNewline = part.lastIndexOf('\n');
    
    if (lastNewline > maxLength * 0.8) {
      part = part.substr(0, lastNewline);
    }
    
    parts.push(part);
    message = message.substr(part.length);
  }
  return parts;
}

// Debounce time in milliseconds (1000 ms) TG max 1 per second
const DEBOUNCE_TIME = 1000;

// Object to store accumulated messages for each log level
const accumulatedMessages = {};

// Timeout IDs for each log level
const timeouts = {};

async function sendAccumulatedMessages(level) {
  if (!isTelegramConfigured || !accumulatedMessages[level] || accumulatedMessages[level].length === 0) {
    return;
  }

  const emoji = getEmojiForLogLevel(level);
  const messages = accumulatedMessages[level].join('\n');
  const escapedMessages = escapeHtml(messages);
  const messageParts = splitLongMessage(`${emoji} ${level.toUpperCase()}:\n<pre>${escapedMessages}</pre>`);
  
  for (const part of messageParts) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, part, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Error sending message to admin:', error);
    }
  }
  
  accumulatedMessages[level] = [];
}

function formatMetadata(metadata) {
  if (Object.keys(metadata).length > 0) {
    return '\n' + safeStringify(metadata);
  }
  return '';
}

function log(level, message, metadata = {}) {
  if (metadata instanceof Error) {
    metadata = { error: metadata.message, stack: metadata.stack };
  }
  
  logger.log(level, message, metadata);

  // Only accumulate messages for Telegram if it's configured
  if (isTelegramConfigured && level !== 'debug' && level !== 'silly') {
    const formattedMetadata = formatMetadata(metadata);
    const telegramMessage = `${message}${formattedMetadata}`;

    if (!accumulatedMessages[level]) {
      accumulatedMessages[level] = [];
    }
    accumulatedMessages[level].push(telegramMessage);

    // Clear existing timeout (if any) and set a new one
    if (timeouts[level]) {
      clearTimeout(timeouts[level]);
    }
    timeouts[level] = setTimeout(() => sendAccumulatedMessages(level), DEBOUNCE_TIME);
  }
}

// Utility functions remain the same but now respect Telegram configuration
function logPerformance(action, duration) {
  log('info', `Performance: ${action} completed in ${duration.toFixed(2)}ms`);
  console.log(`Detailed timing - ${action}: ${duration.toFixed(2)}ms`);
}

function logError(message, error) {
  log('error', `Error: ${message}`, error);
}

function logInitialization(milestone) {
  log('info', `Initialization: ${milestone}`);
}

function logTransaction(summary, details) {
  log('info', `Transaction: ${summary}`, details);
}

function logPositionUpdate(summary, details) {
  log('info', `Position Update: ${summary}`, details);
}

function logStrategySignal(signal, details) {
  log('info', `Strategy Signal: ${signal}`, details);
}

function logConfiguration(summary, details) {
  log('info', `Configuration: ${truncate(summary)}`, details);
}

function logStateCheck(summary, details) {
  if (summary) {
    log('info', `State Check: ${summary}`, details);
  } else {
    console.log('State check details:', safeStringify(details));
  }
}

function logNetworkEvent(event, details = {}) {
  log('info', `Network Event: ${event}`, details);
}

function logPositionManagement(event, details) {
  log('info', `Position Management: ${event}`, details);
}

function logMarketData(summary, details) {
  console.log(`Market Data: ${summary}`, details ? safeStringify(details) : '');
}

function logDebug(message, data = null) {
  log('debug', message, data);
}

function logCritical(message) {
  log('error', `CRITICAL: ${message}`);
}

function logWarning(message, details = null) {
  log('warn', message, details);
}

export default {
  error: (message, metadata) => log('error', message, metadata),
  warn: (message, metadata) => log('warn', message, metadata),
  info: (message, metadata) => log('info', message, metadata),
  http: (message, metadata) => log('http', message, metadata),
  verbose: (message, metadata) => log('verbose', message, metadata),
  debug: (message, metadata) => log('debug', message, metadata),
  silly: (message, metadata) => log('silly', message, metadata),
  performance: logPerformance,
  logError,
  logInitialization,
  logTransaction,
  logPositionUpdate,
  logStrategySignal,
  logConfiguration,
  logStateCheck,
  logNetworkEvent,
  logPositionManagement,
  logMarketData,
  logDebug,
  logCritical,
  logWarning
};