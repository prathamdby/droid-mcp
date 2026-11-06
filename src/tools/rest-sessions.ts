import * as Schema from "effect/Schema"

import {
  BooleanFlag,
  Cursor,
  DESTRUCTIVE,
  Id,
  JsonBody,
  PageLimit,
  restDomain,
  restTool,
} from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"

/** Hosted sessions on the account's cloud computers (`/api/v0/sessions`), not local `session_*` handles. */

const HOSTED =
  " Hosted sessions run on a cloud computer and are enabled for selected organizations; " +
  "their ids are not local session_* handles."

const SESSION = "/api/v0/sessions/{sessionId}"

const SessionSettings = JsonBody.annotate({
  description:
    "Session settings forwarded as given, for example { model: 'auto', reasoningEffort: 'high' }.",
})

const Role = Schema.Literals(["user", "assistant", "tool"])

export const remoteSessionTools = (): RestDomain =>
  restDomain([
    restTool({
      name: "rest_list_remote_sessions",
      operation: "listSessions",
      description: "List hosted sessions across the account's computers, newest first." + HOSTED,
      method: "GET",
      path: "/api/v0/sessions",
      inputs: {
        computerId: Schema.optional(Schema.String),
        limit: Schema.optional(PageLimit),
        cursor: Schema.optional(Cursor),
      },
      query: ["computerId", "limit", "cursor"],
    }),
    restTool({
      name: "rest_create_remote_session",
      operation: "createSession",
      description:
        "Create a hosted session on the cloud computer `computerId`, optionally in `cwd` and " +
        "with `sessionSettings` such as the model." +
        HOSTED,
      method: "POST",
      path: "/api/v0/sessions",
      body: {
        computerId: Id,
        cwd: Schema.optional(Schema.String),
        sessionSettings: Schema.optional(SessionSettings),
      },
    }),
    restTool({
      name: "rest_get_remote_session",
      operation: "getSession",
      description: "Read one hosted session, including its status and settings." + HOSTED,
      method: "GET",
      path: SESSION,
      inputs: { sessionId: Id, computerId: Schema.optional(Schema.String) },
      query: ["computerId"],
    }),
    restTool({
      name: "rest_update_remote_session",
      operation: "updateSession",
      description: "Change a hosted session's settings." + HOSTED,
      method: "PATCH",
      path: SESSION,
      inputs: { sessionId: Id },
      body: { sessionSettings: Schema.optional(SessionSettings) },
    }),
    restTool({
      name: "rest_delete_remote_session",
      operation: "deleteSession",
      description: "Delete a hosted session and its messages. " + DESTRUCTIVE + HOSTED,
      method: "DELETE",
      path: SESSION,
      inputs: { sessionId: Id, computerId: Schema.optional(Schema.String) },
      query: ["computerId"],
      response: "empty",
    }),
    restTool({
      name: "rest_interrupt_remote_session",
      operation: "interruptSession",
      description: "Stop the hosted session's current turn; returns its new status." + HOSTED,
      method: "POST",
      path: SESSION + "/interrupt",
      inputs: { sessionId: Id },
    }),
    restTool({
      name: "rest_list_remote_session_messages",
      operation: "getMessages",
      description:
        "Page through a hosted session's messages, optionally only one `role`. Pass the " +
        "returned `pagination.nextCursor` as `cursor` for the next page." +
        HOSTED,
      method: "GET",
      path: SESSION + "/messages",
      inputs: {
        sessionId: Id,
        limit: Schema.optional(PageLimit),
        cursor: Schema.optional(Cursor),
        computerId: Schema.optional(Schema.String),
        role: Schema.optional(Role),
      },
      query: ["limit", "cursor", "computerId", "role"],
    }),
    restTool({
      name: "rest_post_remote_session_message",
      operation: "postMessage",
      description:
        "Send a user message (`text`, with optional images, files, or sender) to a hosted " +
        "session and start its turn. Returns the message id and session status; read replies " +
        "with rest_list_remote_session_messages." +
        HOSTED,
      method: "POST",
      path: SESSION + "/messages",
      inputs: { sessionId: Id },
      body: { text: Id, computerId: Schema.optional(Schema.String) },
    }),
    restTool({
      name: "rest_get_remote_session_message",
      operation: "getMessage",
      description: "Read one message of a hosted session." + HOSTED,
      method: "GET",
      path: SESSION + "/messages/{messageId}",
      inputs: { sessionId: Id, messageId: Id, computerId: Schema.optional(Schema.String) },
      query: ["computerId"],
    }),
    restTool({
      name: "rest_list_remote_session_children",
      operation: "listChildSessions",
      description:
        "List the child sessions a hosted session started, optionally with artifacts, " +
        "attention state, and usage." +
        HOSTED,
      method: "GET",
      path: SESSION + "/children",
      inputs: {
        sessionId: Id,
        includeArtifacts: Schema.optional(BooleanFlag),
        includeAttention: Schema.optional(BooleanFlag),
        includeUsage: Schema.optional(BooleanFlag),
      },
      query: ["includeArtifacts", "includeAttention", "includeUsage"],
    }),
  ])
