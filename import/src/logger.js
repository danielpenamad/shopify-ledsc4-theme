import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(__dirname, '..', 'logs', `run-${new Date().toISOString().slice(0, 10)}.log`),
      maxsize: 5_000_000,
      maxFiles: 10,
    }),
  ],
});

export default logger;
