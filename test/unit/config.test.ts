import { describe, expect, it } from "vitest"

import { ConfigError, parseConfig, parseContextHeaders, parseOrigin } from "../../src/config.ts"

const serve = (
  env: { readonly [key: string]: string | undefined },
  argv: ReadonlyArray<string> = [],
) => parseConfig(["serve", ...argv], env)

describe("base URL validation", () => {
  it("accepts http(s) origins and returns the origin", () => {
    expect(parseOrigin("X", "https://api.factory.ai")).toBe("https://api.factory.ai")
    expect(parseOrigin("X", "https://api.factory.ai/")).toBe("https://api.factory.ai")
    expect(parseOrigin("X", "http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(parseOrigin("X", "HTTPS://Prem.Example.com:443")).toBe("https://prem.example.com")
  })

  it.each([
    "https://api.factory.ai/api",
    "https://api.factory.ai/v0/",
    "https://api.factory.ai?x=1",
    "https://api.factory.ai/?",
    "https://api.factory.ai#frag",
    "https://user:pass@api.factory.ai",
    "https://user@api.factory.ai",
    "ftp://api.factory.ai",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(() => parseOrigin("FACTORY_BASE_URL", raw)).toThrow(ConfigError)
  })

  it("validates FACTORY_BASE_URL and --factory-base-url", () => {
    expect(serve({}).factoryBaseUrl).toBe("https://api.factory.ai")
    expect(serve({ FACTORY_BASE_URL: "http://localhost:9000/" }).factoryBaseUrl).toBe(
      "http://localhost:9000",
    )
    expect(serve({}, ["--factory-base-url", "https://staging.example"]).factoryBaseUrl).toBe(
      "https://staging.example",
    )
    expect(() => serve({ FACTORY_BASE_URL: "https://api.factory.ai/api/v0" })).toThrow(ConfigError)
    expect(() => serve({}, ["--factory-base-url=https://x.example?y"])).toThrow(ConfigError)
  })

  it("leaves the Context origin unset unless configured, and validates it", () => {
    expect(serve({}).factoryContextBaseUrl).toBeUndefined()
    expect(serve({ FACTORY_CONTEXT_BASE_URL: "" }).factoryContextBaseUrl).toBeUndefined()
    expect(serve({ FACTORY_CONTEXT_BASE_URL: "https://prem.example/" }).factoryContextBaseUrl).toBe(
      "https://prem.example",
    )
    expect(() => serve({ FACTORY_CONTEXT_BASE_URL: "https://prem.example/api/context" })).toThrow(
      ConfigError,
    )
  })
})

describe("FACTORY_CONTEXT_HEADERS", () => {
  it("parses a JSON object of string values", () => {
    expect(parseContextHeaders(undefined)).toEqual({})
    expect(parseContextHeaders("  ")).toEqual({})
    expect(parseContextHeaders('{"X-Factory-Org":"org-1","x-tenant":"t"}')).toEqual({
      "X-Factory-Org": "org-1",
      "x-tenant": "t",
    })
    expect(serve({ FACTORY_CONTEXT_HEADERS: '{"X-Org":"o"}' }).factoryContextHeaders).toEqual({
      "X-Org": "o",
    })
  })

  it.each(["not json", "[]", '["a"]', '"text"', "3", '{"X-Org":3}', '{"X-Org":null}'])(
    "rejects %s",
    (raw) => {
      expect(() => parseContextHeaders(raw)).toThrow(ConfigError)
    },
  )

  it.each([
    "authorization",
    "Authorization",
    "COOKIE",
    "host",
    "proxy-authorization",
    "connection",
    "content-length",
    "content-type",
    "transfer-encoding",
    "te",
    "upgrade",
    "keep-alive",
    "expect",
    "trailer",
  ])("rejects the reserved header %s", (name) => {
    expect(() => parseContextHeaders(JSON.stringify({ [name]: "v" }))).toThrow(ConfigError)
  })

  it("rejects invalid names and values that could split headers", () => {
    expect(() => parseContextHeaders('{"bad name":"v"}')).toThrow(ConfigError)
    expect(() => parseContextHeaders('{"X-Org":"a\\r\\nX-Evil: 1"}')).toThrow(ConfigError)
  })

  it("fails the whole config so the process exits 2", () => {
    expect(() => serve({ FACTORY_CONTEXT_HEADERS: '{"Cookie":"c"}' })).toThrow(ConfigError)
  })
})
