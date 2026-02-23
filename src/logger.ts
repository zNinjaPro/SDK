/**
 * Structured logging interface for the shielded pool SDK.
 *
 * The SDK is silent by default (NoopLogger). Callers can inject their own
 * logger implementation to capture debug, info, warn, and error messages
 * without coupling to `console` or any specific logging framework.
 *
 * Usage:
 *   import { ConsoleLogger, setLogger } from "@zninja/sdk";
 *   setLogger(new ConsoleLogger());      // enable console output
 *   setLogger(myCustomLogger);           // inject your own Logger
 *   setLogger(null);                     // back to silent (default)
 */

// ─── Logger interface ────────────────────────────────────────────

/**
 * Minimal structured logger that the SDK delegates all output to.
 * Implement this interface to capture SDK telemetry in your own
 * logging infrastructure (winston, pino, sentry, etc.).
 */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ─── Built-in implementations ────────────────────────────────────

/** Silent logger — drops all messages. This is the SDK default. */
export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Logger that delegates to `console`. Useful for development / debugging. */
export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix = "[zNinja]") {
    this.prefix = prefix;
  }

  debug(msg: string, ...args: unknown[]): void {
    console.debug(this.prefix, msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    console.info(this.prefix, msg, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    console.warn(this.prefix, msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    console.error(this.prefix, msg, ...args);
  }
}

// ─── Global singleton ────────────────────────────────────────────

let _logger: Logger = new NoopLogger();

/**
 * Get the current SDK logger instance.
 * Returns the NoopLogger (silent) if no logger has been set.
 */
export function getLogger(): Logger {
  return _logger;
}

/**
 * Set the SDK-wide logger. Pass `null` to reset to silent (NoopLogger).
 *
 * @param logger - A Logger implementation, or null to disable logging
 */
export function setLogger(logger: Logger | null): void {
  _logger = logger ?? new NoopLogger();
}
