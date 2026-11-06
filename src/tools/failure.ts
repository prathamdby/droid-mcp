import * as Schema from "effect/Schema"

/**
 * Every tool reports failure as `{ code, message }`. The code is the snake-case
 * error contract from `src/droid/errors.ts`; the message is safe to show a user.
 */
export const ToolFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
})

export type ToolFailure = typeof ToolFailure.Type
