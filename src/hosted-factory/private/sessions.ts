/**
 * Hosted sessions on the account's cloud computers (`/api/v0/sessions`), not
 * local `session_*` handles. Hosted sessions run on a cloud computer and are
 * enabled for selected organizations; their ids are not local session_*
 * handles.
 */
import * as Schema from "effect/Schema"

import type { TargetRef } from "../../caller/index.ts"
import type { Definition } from "../../capabilities/index.ts"
import {
  binderOf,
  checkedDecode,
  destructiveAnnotations,
  hostedOperation,
  idempotentWriteAnnotations,
  jsonOutcome,
  hostedTransport,
  readOnlyAnnotations,
  schemaOf,
  segment,
  writeAnnotations,
} from "./kit.ts"
import type { BindOperation, HostedOutcome, OperationContext } from "./kit.ts"
import {
  BooleanFlag,
  Cursor,
  firstIdProblem,
  HostedId,
  JsonBody,
  PageLimit,
  queryEntries,
} from "./wire.ts"

const HOSTED =
  " Hosted sessions run on a cloud computer and are enabled for selected organizations; " +
  "their ids are not local session_* handles."

const SESSIONS = "/api/v0/sessions"

const sessionPath = (sessionId: string): string => SESSIONS + "/" + segment(sessionId)

const sessionsTarget: TargetRef = { kind: "hosted", id: "remote-sessions" }

const sessionTarget = (sessionId: string): TargetRef => ({
  kind: "hosted",
  id: "remote-session",
  scope: sessionId,
})

const SessionSettings = JsonBody.annotate({
  description:
    "Session settings forwarded as given, for example { model: 'auto', reasoningEffort: 'high' }.",
})

const Role = Schema.Literals(["user", "assistant", "tool"])

/** Builds the hosted-session operation binding thunks against one validated installation. */
export const remoteSessionBinders = (ctx: OperationContext): ReadonlyArray<BindOperation> => {
  const transport = hostedTransport(ctx)

  interface ListSessionsInput {
    readonly computerId?: string
    readonly limit?: number
    readonly cursor?: string
  }

  const listRemoteSessions: Definition<ListSessionsInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_list_remote_sessions",
    description: "List hosted sessions across the account's computers, newest first." + HOSTED,
    inputSchema: schemaOf({
      computerId: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" },
    }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        computerId: Schema.optionalKey(HostedId),
        limit: Schema.optionalKey(PageLimit),
        cursor: Schema.optionalKey(Cursor),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["computerId", input.computerId]]),
    ),
    target: () => sessionsTarget,
    perform: (input) =>
      jsonOutcome(transport, "rest_list_remote_sessions", {
        method: "GET",
        path: SESSIONS,
        query: queryEntries([
          ["computerId", input.computerId],
          ["limit", input.limit],
          ["cursor", input.cursor],
        ]),
      }),
  })

  interface CreateSessionInput {
    readonly body: {
      readonly computerId: string
      readonly cwd?: string
      readonly sessionSettings?: Schema.Json
    }
  }

  const createRemoteSession: Definition<CreateSessionInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_create_remote_session",
    description:
      "Create a hosted session on the cloud computer `computerId`, optionally in `cwd` and " +
      "with `sessionSettings` such as the model." +
      HOSTED,
    inputSchema: schemaOf({ body: { type: "object" } }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        body: Schema.Struct({
          computerId: HostedId,
          cwd: Schema.optionalKey(Schema.String),
          sessionSettings: Schema.optionalKey(SessionSettings),
        }),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["body.computerId", input.body.computerId]]),
    ),
    target: () => sessionsTarget,
    perform: (input) => {
      const entries: Array<readonly [string, Schema.Json]> = [["computerId", input.body.computerId]]

      if (input.body.cwd !== undefined) entries.push(["cwd", input.body.cwd])

      if (input.body.sessionSettings !== undefined) {
        entries.push(["sessionSettings", input.body.sessionSettings])
      }

      return jsonOutcome(transport, "rest_create_remote_session", {
        method: "POST",
        path: SESSIONS,
        query: [],
        body: Object.fromEntries(entries),
      })
    },
  })

  interface SessionInput {
    readonly sessionId: string
    readonly computerId?: string
  }

  const sessionInputSchema = Schema.Struct({
    sessionId: HostedId,
    computerId: Schema.optionalKey(HostedId),
  })

  const sessionCheck = (input: SessionInput): string | undefined =>
    firstIdProblem([
      ["sessionId", input.sessionId],
      ["computerId", input.computerId],
    ])

  const getRemoteSession: Definition<SessionInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_remote_session",
    description: "Read one hosted session, including its status and settings." + HOSTED,
    inputSchema: schemaOf({
      sessionId: { type: "string" },
      computerId: { type: "string" },
    }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(sessionInputSchema, "arguments do not match the schema", sessionCheck),
    target: (input) => sessionTarget(input.sessionId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_remote_session", {
        method: "GET",
        path: sessionPath(input.sessionId),
        query: queryEntries([["computerId", input.computerId]]),
      }),
  })

  interface UpdateSessionInput {
    readonly sessionId: string
    readonly body: {
      readonly sessionSettings?: Schema.Json
    }
  }

  const updateRemoteSession: Definition<UpdateSessionInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_update_remote_session",
    description: "Change a hosted session's settings." + HOSTED,
    inputSchema: schemaOf({
      sessionId: { type: "string" },
      body: { type: "object" },
    }),
    annotations: writeAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(
      Schema.Struct({
        sessionId: HostedId,
        body: Schema.Struct({
          sessionSettings: Schema.optionalKey(SessionSettings),
        }),
      }),
      "arguments do not match the schema",
      (input) => firstIdProblem([["sessionId", input.sessionId]]),
    ),
    target: (input) => sessionTarget(input.sessionId),
    perform: (input) => {
      const entries: Array<readonly [string, Schema.Json]> = []

      if (input.body.sessionSettings !== undefined) {
        entries.push(["sessionSettings", input.body.sessionSettings])
      }

      return jsonOutcome(transport, "rest_update_remote_session", {
        method: "PATCH",
        path: sessionPath(input.sessionId),
        query: [],
        body: Object.fromEntries(entries),
      })
    },
  })

  const deleteRemoteSession: Definition<SessionInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_delete_remote_session",
    description:
      "Delete a hosted session and its messages. Destructive; confirm before calling." + HOSTED,
    inputSchema: schemaOf({
      sessionId: { type: "string" },
      computerId: { type: "string" },
    }),
    annotations: destructiveAnnotations,
    effect: "write",
    replay: "no_retry",
    decode: checkedDecode(sessionInputSchema, "arguments do not match the schema", sessionCheck),
    target: (input) => sessionTarget(input.sessionId),
    perform: (input) =>
      jsonOutcome(
        transport,
        "rest_delete_remote_session",
        {
          method: "DELETE",
          path: sessionPath(input.sessionId),
          query: queryEntries([["computerId", input.computerId]]),
        },
        { emptyResponse: true },
      ),
  })

  interface InterruptSessionInput {
    readonly sessionId: string
  }

  const interruptInputSchema = Schema.Struct({ sessionId: HostedId })

  const interruptCheck = (input: InterruptSessionInput): string | undefined =>
    firstIdProblem([["sessionId", input.sessionId]])

  const interruptRemoteSession: Definition<InterruptSessionInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_interrupt_remote_session",
      description: "Stop the hosted session's current turn; returns its new status." + HOSTED,
      inputSchema: schemaOf({ sessionId: { type: "string" } }),
      annotations: idempotentWriteAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        interruptInputSchema,
        "arguments do not match the schema",
        interruptCheck,
      ),
      target: (input) => sessionTarget(input.sessionId),
      perform: (input) =>
        jsonOutcome(transport, "rest_interrupt_remote_session", {
          method: "POST",
          path: sessionPath(input.sessionId) + "/interrupt",
          query: [],
        }),
    },
  )

  interface ListMessagesInput {
    readonly sessionId: string
    readonly limit?: number
    readonly cursor?: string
    readonly computerId?: string
    readonly role?: "user" | "assistant" | "tool"
  }

  const listRemoteSessionMessages: Definition<ListMessagesInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_list_remote_session_messages",
      description:
        "Page through a hosted session's messages, optionally only one `role`. Pass the " +
        "returned `pagination.nextCursor` as `cursor` for the next page." +
        HOSTED,
      inputSchema: schemaOf({
        sessionId: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
        computerId: { type: "string" },
        role: { type: "string" },
      }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(
        Schema.Struct({
          sessionId: HostedId,
          limit: Schema.optionalKey(PageLimit),
          cursor: Schema.optionalKey(Cursor),
          computerId: Schema.optionalKey(HostedId),
          role: Schema.optionalKey(Role),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["sessionId", input.sessionId],
            ["computerId", input.computerId],
          ]),
      ),
      target: (input) => sessionTarget(input.sessionId),
      perform: (input) =>
        jsonOutcome(transport, "rest_list_remote_session_messages", {
          method: "GET",
          path: sessionPath(input.sessionId) + "/messages",
          query: queryEntries([
            ["limit", input.limit],
            ["cursor", input.cursor],
            ["computerId", input.computerId],
            ["role", input.role],
          ]),
        }),
    },
  )

  interface PostMessageInput {
    readonly sessionId: string
    readonly body: {
      readonly text: string
      readonly computerId?: string
    }
  }

  const postRemoteSessionMessage: Definition<PostMessageInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_post_remote_session_message",
      description:
        "Send a user message (`text`, with optional images, files, or sender) to a hosted " +
        "session and start its turn. Returns the message id and session status; read replies " +
        "with rest_list_remote_session_messages." +
        HOSTED,
      inputSchema: schemaOf({
        sessionId: { type: "string" },
        body: { type: "object" },
      }),
      annotations: writeAnnotations,
      effect: "write",
      replay: "no_retry",
      decode: checkedDecode(
        Schema.Struct({
          sessionId: HostedId,
          body: Schema.Struct({
            text: Schema.String.annotate({
              description: "The message text; may be empty when images or files carry the message.",
            }),
            computerId: Schema.optionalKey(HostedId),
          }),
        }),
        "arguments do not match the schema",
        (input) =>
          firstIdProblem([
            ["sessionId", input.sessionId],
            ["body.computerId", input.body.computerId],
          ]),
      ),
      target: (input) => sessionTarget(input.sessionId),
      perform: (input) => {
        const entries: Array<readonly [string, Schema.Json]> = [["text", input.body.text]]

        if (input.body.computerId !== undefined) {
          entries.push(["computerId", input.body.computerId])
        }

        return jsonOutcome(transport, "rest_post_remote_session_message", {
          method: "POST",
          path: sessionPath(input.sessionId) + "/messages",
          query: [],
          body: Object.fromEntries(entries),
        })
      },
    },
  )

  interface GetMessageInput {
    readonly sessionId: string
    readonly messageId: string
    readonly computerId?: string
  }

  const getRemoteSessionMessage: Definition<GetMessageInput, HostedOutcome> = hostedOperation(ctx, {
    id: "rest_get_remote_session_message",
    description: "Read one message of a hosted session." + HOSTED,
    inputSchema: schemaOf({
      sessionId: { type: "string" },
      messageId: { type: "string" },
      computerId: { type: "string" },
    }),
    annotations: readOnlyAnnotations,
    effect: "read",
    replay: "safe_read",
    decode: checkedDecode(
      Schema.Struct({
        sessionId: HostedId,
        messageId: HostedId,
        computerId: Schema.optionalKey(HostedId),
      }),
      "arguments do not match the schema",
      (input) =>
        firstIdProblem([
          ["sessionId", input.sessionId],
          ["messageId", input.messageId],
          ["computerId", input.computerId],
        ]),
    ),
    target: (input) => sessionTarget(input.sessionId),
    perform: (input) =>
      jsonOutcome(transport, "rest_get_remote_session_message", {
        method: "GET",
        path: sessionPath(input.sessionId) + "/messages/" + segment(input.messageId),
        query: queryEntries([["computerId", input.computerId]]),
      }),
  })

  interface ListChildrenInput {
    readonly sessionId: string
    readonly includeArtifacts?: boolean
    readonly includeAttention?: boolean
    readonly includeUsage?: boolean
  }

  const listRemoteSessionChildren: Definition<ListChildrenInput, HostedOutcome> = hostedOperation(
    ctx,
    {
      id: "rest_list_remote_session_children",
      description:
        "List the child sessions a hosted session started, optionally with artifacts, " +
        "attention state, and usage." +
        HOSTED,
      inputSchema: schemaOf({
        sessionId: { type: "string" },
        includeArtifacts: { type: "boolean" },
        includeAttention: { type: "boolean" },
        includeUsage: { type: "boolean" },
      }),
      annotations: readOnlyAnnotations,
      effect: "read",
      replay: "safe_read",
      decode: checkedDecode(
        Schema.Struct({
          sessionId: HostedId,
          includeArtifacts: Schema.optionalKey(BooleanFlag),
          includeAttention: Schema.optionalKey(BooleanFlag),
          includeUsage: Schema.optionalKey(BooleanFlag),
        }),
        "arguments do not match the schema",
        (input) => firstIdProblem([["sessionId", input.sessionId]]),
      ),
      target: (input) => sessionTarget(input.sessionId),
      perform: (input) =>
        jsonOutcome(transport, "rest_list_remote_session_children", {
          method: "GET",
          path: sessionPath(input.sessionId) + "/children",
          query: queryEntries([
            ["includeArtifacts", input.includeArtifacts],
            ["includeAttention", input.includeAttention],
            ["includeUsage", input.includeUsage],
          ]),
        }),
    },
  )

  return [
    binderOf(listRemoteSessions),
    binderOf(createRemoteSession),
    binderOf(getRemoteSession),
    binderOf(updateRemoteSession),
    binderOf(deleteRemoteSession),
    binderOf(interruptRemoteSession),
    binderOf(listRemoteSessionMessages),
    binderOf(postRemoteSessionMessage),
    binderOf(getRemoteSessionMessage),
    binderOf(listRemoteSessionChildren),
  ]
}
