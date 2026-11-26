import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { DiagnosticReport, ExistingEndpoint } from "./types.ts"

const PROBE_TIMEOUT_MS = 2_000

const probeHttp = async (
  options: Extract<ExistingEndpoint, { readonly transport: "http" }>,
): Promise<DiagnosticReport> => {
  try {
    const headers = new Headers({ "content-type": "application/json" })

    if (options.bearerToken !== undefined) {
      headers.set("authorization", "Bearer " + options.bearerToken)
    }

    const response = await fetch(options.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })

    // Reachability is a transport fact, even if the endpoint refuses access.
    await response.body?.cancel().catch(() => undefined)

    return { transport: "http", reachable: true, status: response.status }
  } catch {
    return { transport: "http", reachable: false }
  }
}

export const doctor = async (options: ExistingEndpoint): Promise<DiagnosticReport> => {
  if (options.transport === "http") return probeHttp(options)

  const [{ custodyLayer }, { DaemonLink, daemonLinkLayer }, { disclosureLayer }] =
    await Promise.all([
      import("../../custody/index.ts"),
      import("../../daemon-link/index.ts"),
      import("../../disclosure/index.ts"),
    ])

  const link = Layer.provide(
    daemonLinkLayer({
      endpoint: options.endpoint,
      auth: options.auth,
      connectTimeoutMs: PROBE_TIMEOUT_MS,
      handshakeTimeoutMs: PROBE_TIMEOUT_MS,
    }),
    Layer.merge(custodyLayer, disclosureLayer({})),
  )

  return Effect.runPromise(
    Effect.flatMap(DaemonLink, (daemon) => daemon.probeExisting()).pipe(
      Effect.match({
        onSuccess: (health): DiagnosticReport => ({
          transport: "daemon",
          reachable: health.reachable,
        }),
        onFailure: (): DiagnosticReport => ({ transport: "daemon", reachable: false }),
      }),
      Effect.provide(link),
    ),
  )
}
