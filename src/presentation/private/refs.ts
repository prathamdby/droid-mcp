/**
 * Detection and RFC 6901 shape of `{ "$from": "<stepId>", "path"?: "<pointer>" }`
 * references inside batch step arguments. Resolution itself is delegated to
 * `artifacts.part` by the presentation module, because only the artifacts
 * module may rewrap a selected part into a safe released value.
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

const FromReference = Schema.Struct({ $from: Schema.String, path: Schema.optional(Schema.String) })

const isFromReference = Schema.is(FromReference)

export type Reference = typeof FromReference.Type

export const isReferenceObject = (value: Schema.Json): value is Schema.Json & Reference =>
  isFromReference(value) && Object.keys(value).every((key) => key === "$from" || key === "path")

const isJsonObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(value) && !Array.isArray(value)

/** True when `value` or anything nested inside it is a `$from` reference. */
export const containsReference = (value: Schema.Json): boolean => {
  if (Array.isArray(value)) return value.some(containsReference)

  if (!isJsonObject(value)) return false

  if (isReferenceObject(value)) return true

  for (const item of Object.values(value)) {
    if (containsReference(item)) return true
  }

  return false
}

export class ReferenceProblem extends Error {
  readonly reason: "unknown_step" | "missing_part" | "failed_step"

  constructor(problem: { readonly reason: ReferenceProblem["reason"]; readonly detail: string }) {
    super(problem.detail)
    this.name = "ReferenceProblem"
    this.reason = problem.reason
  }
}
