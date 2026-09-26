import { buildApp } from './app.js';
import { DEFAULT_MAX_SEGMENTS, DEFAULT_TRANSFER_SIZE_RATIO } from './planner.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const maxSegments = Number(process.env.MAX_SEGMENTS ?? DEFAULT_MAX_SEGMENTS);
const transferSizeRatio = Number(process.env.TRANSFER_SIZE_RATIO ?? DEFAULT_TRANSFER_SIZE_RATIO);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}
if (!Number.isInteger(maxSegments) || maxSegments < 1) {
  console.error(`invalid MAX_SEGMENTS: ${process.env.MAX_SEGMENTS}`);
  process.exit(1);
}
if (!Number.isFinite(transferSizeRatio) || transferSizeRatio <= 0) {
  console.error(`invalid TRANSFER_SIZE_RATIO: ${process.env.TRANSFER_SIZE_RATIO}`);
  process.exit(1);
}

const app = buildApp({
  logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false,
  maxSegments,
  transferSizeRatio,
});

try {
  await app.listen({ port, host });
  app.log.info(`range-plan API listening on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
