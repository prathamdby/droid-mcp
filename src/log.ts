import * as Layer from "effect/Layer"
/**
 * Structured logs go to stderr. Prompts, keys, file contents, and tool results
 * never appear here.
 */
import * as EffectLogger from "effect/Logger"
import type { LogLevel as EffectLogLevel } from "effect/LogLevel"
import * as References from "effect/References"

export type LogLevel = "debug" | "info" | "warn" | "error"

export const LOG_LEVELS: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"]

export const isLogLevel = (value: string): value is LogLevel =>
  LOG_LEVELS.some((level) => level === value)

export type LogFields = { readonly [key: string]: string | number | boolean | null }

export interface Logger {
  readonly level: LogLevel
  readonly log: (level: LogLevel, event: string, fields?: LogFields) => void
  readonly debug: (event: string, fields?: LogFields) => void
  readonly info: (event: string, fields?: LogFields) => void
  readonly warn: (event: string, fields?: LogFields) => void
  readonly error: (event: string, fields?: LogFields) => void
}

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level)

export const createLogger = (level: LogLevel): Logger => {
  const write = (entryLevel: LogLevel, event: string, fields?: LogFields): void => {
    if (rank(entryLevel) < rank(level)) return

    const entry = {
      ts: new Date().toISOString(),
      level: entryLevel,
      event,
      ...fields,
    }

    process.stderr.write(JSON.stringify(entry) + "\n")
  }

  return {
    level,
    log: write,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  }
}

export const silentLogger: Logger = createLogger("error")

const EFFECT_LEVELS = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
} satisfies { readonly [Level in LogLevel]: EffectLogLevel }

/**
 * Effect's own log output, routed into the same contract: one JSON object per
 * line on stderr, filtered at the configured level. Without this, the HTTP
 * server and MCP runtime print their own pretty logs.
 */
/** Effect's own JSON log line, written to stderr like every other log. */
const effectJsonLogger = EffectLogger.withConsoleError(EffectLogger.formatJson)

/**
 * Effect's own log output, routed into the same contract: one JSON object per
 * line on stderr, filtered at the configured level. Without this, the HTTP
 * server and MCP runtime print their own pretty logs to stdout.
 */
export const effectLoggingLayer = (level: LogLevel): Layer.Layer<never> =>
  Layer.mergeAll(
    EffectLogger.layer([effectJsonLogger]),
    Layer.succeed(References.MinimumLogLevel, EFFECT_LEVELS[level]),
  )
