import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log rotation configuration
const rotateConfig = {
  datePattern: 'YYYY-MM-DD',
  maxSize: process.env.MAX_LOG_SIZE || '50m', // 50MB per file
  maxFiles: process.env.MAX_LOG_FILES || '7d', // Keep 7 days
  zippedArchive: true, // Compress old logs
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  )
};

// const logger = winston.createLogger({
//   level: process.env.LOG_LEVEL || 'warn', // Only warnings and errors to reduce noise
//   format: winston.format.combine(
//     winston.format.timestamp(),
//     winston.format.errors({ stack: true }),
//     winston.format.json()
//   ),
//   defaultMeta: { service: 'screen-intelligence' },
//   transports: [
//     // Error logs with rotation
//     new DailyRotateFile({
//       ...rotateConfig,
//       filename: path.join(__dirname, '../../../logs/screen-intelligence-error-%DATE%.log'),
//       level: 'error'
//     }),
//     // Combined logs with rotation
//     new DailyRotateFile({
//       ...rotateConfig,
//       filename: path.join(__dirname, '../../../logs/screen-intelligence-%DATE%.log')
//     })
//   ]
// });

// Console logging in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export default logger;
