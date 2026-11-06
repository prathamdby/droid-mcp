import { createHash, timingSafeEqual } from "node:crypto"

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

/**
 * The identity a request carries after admission. Its value is the first 8 hex
 * characters of the key's SHA-256 digest, so logs can name a caller without ever
 * holding the key.
 */
export class ApiKeyId extends Context.Service<ApiKeyId, string>()("droid-mcp/ApiKeyId") {}

const digest = (value: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(value).digest())

export const keyId = (key: string): string =>
  createHash("sha256").update(key).digest("hex").slice(0, 8)

export interface Keyring {
  /** Size of the key set; zero means no key can authenticate. */
  readonly size: number
  /** The caller's identity, or `undefined` when the header does not match. */
  readonly match: (authorization: string | undefined) => string | undefined
}

interface KeyDigest {
  readonly digest: Uint8Array
  readonly id: string
}

/** Builds the keyring from configured keys; blank entries never authenticate. */
export const keyringFrom = (keys: ReadonlyArray<string>): Keyring => {
  const digests: Array<KeyDigest> = []

  for (const key of keys) {
    if (key.trim().length > 0) digests.push({ digest: digest(key), id: keyId(key) })
  }

  return {
    size: digests.length,
    match: (authorization) => {
      if (authorization === undefined) return undefined
      const prefix = "bearer "

      if (authorization.slice(0, prefix.length).toLowerCase() !== prefix) return undefined
      const presented = authorization.slice(prefix.length).trim()

      if (presented.length === 0) return undefined
      const candidate = digest(presented)

      for (const entry of digests) {
        if (timingSafeEqual(entry.digest, candidate)) return entry.id
      }

      return undefined
    },
  }
}

const unauthorized = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({
    status: 401,
    headers: {
      "www-authenticate": "Bearer",
      "cache-control": "no-store",
    },
  })

/**
 * Router middleware that rejects a request without a valid bearer key. It
 * returns a response instead of failing, so a client sees `401` rather than an
 * internal error, and it provides `ApiKeyId` to the MCP handlers beneath it.
 */
export const authFor = (keyring: Keyring) =>
  HttpRouter.middleware<{ provides: ApiKeyId }>()((httpEffect) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const id = keyring.match(request.headers["authorization"])

      if (id === undefined) return Effect.succeed(unauthorized())

      return Effect.provideService(httpEffect, ApiKeyId, id)
    }),
  )

/** Auth as a layer on the MCP route, installed before any handler runs. */
export const layer = (keyring: Keyring) => authFor(keyring).layer
