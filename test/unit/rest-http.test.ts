import { describe, expect, it } from "vitest"

import { redact } from "../../src/droid/redact.ts"
import {
  binaryEnvelope,
  decodeJsonText,
  encodePathSegment,
  errorDetail,
  isJsonContentType,
  scrubSecrets,
  serializeQuery,
} from "../../src/droid/rest-http.ts"

describe("rest-http", () => {
  it("encodes a value as exactly one path segment", () => {
    expect(encodePathSegment("a/b c?#")).toBe("a%2Fb%20c%3F%23")
    expect(encodePathSegment("c-1")).toBe("c-1")
    expect(encodePathSegment(".")).toBeUndefined()
    expect(encodePathSegment("..")).toBeUndefined()
    expect(encodePathSegment("...")).toBe("...")
  })

  it("serializes repeated keys and an empty query", () => {
    expect(
      serializeQuery([
        ["environmentIds", "a"],
        ["environmentIds", "b c"],
        ["flag", "true"],
      ]),
    ).toBe("environmentIds=a&environmentIds=b%20c&flag=true")
    expect(serializeQuery([])).toBe("")
  })

  it("decodes JSON text and refuses anything else", () => {
    expect(decodeJsonText('{"a":[1,null]}')).toEqual({ a: [1, null] })
    expect(decodeJsonText("<html>")).toBeUndefined()
    expect(decodeJsonText("")).toBeUndefined()
  })

  it("recognizes JSON content types", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true)
    expect(isJsonContentType("application/problem+json")).toBe(true)
    expect(isJsonContentType("application/zip")).toBe(false)
    expect(isJsonContentType(null)).toBe(false)
  })

  it("prefers detail, then title, then error", () => {
    expect(errorDetail(JSON.stringify({ detail: "d", title: "t", error: "e" }), [])).toBe("d")
    expect(errorDetail(JSON.stringify({ title: "t", error: "e" }), [])).toBe("t")
    expect(errorDetail(JSON.stringify({ error: "e" }), [])).toBe("e")
    expect(errorDetail(JSON.stringify({ detail: 3, title: " " }), [])).toBeUndefined()
    expect(errorDetail(JSON.stringify([1]), [])).toBeUndefined()
  })

  it("drops HTML and long plain-text bodies but keeps a short plain line", () => {
    expect(errorDetail("<html><body>oops</body></html>", [])).toBeUndefined()
    expect(errorDetail("upstream connect error", [])).toBe("upstream connect error")
    expect(errorDetail("x".repeat(201), [])).toBeUndefined()
    expect(errorDetail("line one\nline two", [])).toBeUndefined()
    expect(errorDetail("", [])).toBeUndefined()
  })

  it("truncates detail to 500 characters after scrubbing", () => {
    const detail = errorDetail(JSON.stringify({ detail: "s3cret " + "y".repeat(800) }), ["s3cret"])

    expect(detail?.length).toBe(500)
    expect(detail?.startsWith("[redacted] ")).toBe(true)
    expect(detail?.endsWith("…")).toBe(true)
  })

  it("scrubs every occurrence of non-empty secrets", () => {
    expect(scrubSecrets("a k1 b k1 c k2", ["k1", "k2", ""])).toBe(
      "a [redacted] b [redacted] c [redacted]",
    )
  })

  it("replaces a secret that contains a shorter one whole", () => {
    expect(scrubSecrets("x org-1234 y", ["org", "org-1234"])).toBe("x [redacted] y")
  })

  it("wraps bytes in a base64 envelope", () => {
    expect(binaryEnvelope(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/zip")).toEqual({
      encoding: "base64",
      contentType: "application/zip",
      sizeBytes: 4,
      data: "UEsDBA==",
    })
  })
})

describe("redact", () => {
  it("drops credential fields at any depth", () => {
    expect(
      redact(
        {
          id: "x",
          Authorization: "Bearer a",
          nested: { cookie: "c", password: "p", list: [{ accessToken: "t", keep: 1 }] },
          refreshToken: "r",
          clientSecret: "s",
          privateKey: "k",
        },
        [],
      ),
    ).toEqual({ id: "x", nested: { list: [{ keep: 1 }] } })
  })

  it("drops apiKey.value and the value of secret and upsert entries", () => {
    expect(
      redact(
        {
          apiKey: { id: "k-1", value: "minted", fingerprint: "f" },
          secrets: [{ key: "A", value: "1" }],
          upsert: [{ key: "B", value: "2" }],
          other: [{ key: "C", value: "3" }],
        },
        [],
      ),
    ).toEqual({
      apiKey: { id: "k-1", fingerprint: "f" },
      secrets: [{ key: "A" }],
      upsert: [{ key: "B" }],
      other: [{ key: "C", value: "3" }],
    })
  })

  it("replaces only the configured secret inside a string", () => {
    expect(
      redact(["plain", "has canary-123 inside", { deep: ["canary-123"] }], ["canary-123"]),
    ).toEqual(["plain", "has [redacted] inside", { deep: ["[redacted]"] }])
    expect(redact("anything", [""])).toBe("anything")
    expect(redact(42, ["4"])).toBe(42)
  })

  it("scrubs a minted key value wherever else the body repeats it", () => {
    expect(
      redact({ apiKey: { id: "k-2", value: "fk-live-9" }, hint: "export KEY=fk-live-9" }, []),
    ).toEqual({ apiKey: { id: "k-2" }, hint: "export KEY=[redacted]" })
  })
})
