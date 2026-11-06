import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { Config } from "../config.ts"
import { FactoryApiKeyMissing } from "./errors.ts"
import type { JsonValue } from "./protocol.ts"

/**
 * The hosted Factory API (computers and machine templates) is not the daemon:
 * it is HTTPS with a bearer key and JSON bodies. The SDK already speaks it, so
 * this service only supplies credentials and turns rejections into one error.
 */

export class RestRejected extends Schema.TaggedError<RestRejected>()("RestRejected", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class RestUnavailable extends Schema.TaggedError<RestUnavailable>()("RestUnavailable", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export type RestError = RestRejected | RestUnavailable | FactoryApiKeyMissing

export interface RestApi {
  readonly call: <A>(name: string, run: () => Promise<A>) => Effect.Effect<A, RestError>
}

export class RestService extends Context.Service<RestService, RestApi>()("droid-mcp/RestService") {}

/** A promise-returning SDK call, mapped onto the server's error contract. */
const attempt = <A>(name: string, run: () => Promise<A>): Effect.Effect<A, RestError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RestUnavailable({
        message: "the Factory API call " + name + " failed",
        detail: cause instanceof Error ? cause.message : undefined,
      }),
  })

export const restLayer = (config: Config): Layer.Layer<RestService> =>
  Layer.succeed(RestService, {
    call: (name, run) =>
      config.factoryApiKey === undefined
        ? Effect.fail(
            new FactoryApiKeyMissing({
              message: "FACTORY_API_KEY is not set; Factory API tools need it",
            }),
          )
        : attempt(name, run),
  })

/**
 * Tool results cross the wire as JSON. The SDK's return types carry optional
 * members, which `effect/Schema`'s `Json` rejects, so the payload is normalized
 * the same way a JSON response body would be.
 */
export const jsonOf = <A>(value: A): JsonValue => {
  // SAFETY: every REST helper returns a parsed JSON body; the round trip drops
  // `undefined` members that `Schema.Json` refuses.
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)) as JsonValue)
}
