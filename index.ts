import { createBot } from "./bot";
import { logger } from "./logger";

const token = process.env["DISCORD_BOT_TOKEN"];

if (!token) {
  logger.error("DISCORD_BOT_TOKEN environment variable is required");
  process.exit(1);
}

try {
  // @ts-expect-error — no types ship with libsodium-wrappers
  const sodium = await import("libsodium-wrappers");
  const ready = (sodium.ready ?? sodium.default?.ready) as Promise<void> | undefined;
  if (ready) await ready;
  logger.info("libsodium ready");
} catch (err) {
  logger.warn({ err }, "libsodium-wrappers not available — relying on @noble/ciphers");
}

const client = createBot(token);

const shutdown = (signal: string) => {
  logger.info({ signal }, "Shutting down Discord bot");
  client
    .destroy()
    .catch((err) => logger.error({ err }, "Error during shutdown"))
    .finally(() => process.exit(0));
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
