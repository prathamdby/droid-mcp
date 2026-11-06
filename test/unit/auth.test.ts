import { describe, expect, it } from "vitest"

import { keyId, keyringFrom } from "../../src/http/auth.ts"

describe("keyring", () => {
  const keyring = keyringFrom(["secret-key", "second-key"])

  it("accepts a valid key and returns a stable identity", () => {
    const id = keyring.match("Bearer secret-key")
    expect(id).toBe(keyId("secret-key"))
    expect(id).toHaveLength(8)
  })

  it("accepts a lowercase scheme", () => {
    expect(keyring.match("bearer secret-key")).toBe(keyId("secret-key"))
  })

  it("rejects a missing header", () => {
    expect(keyring.match(undefined)).toBeUndefined()
  })

  it("rejects a malformed header", () => {
    expect(keyring.match("secret-key")).toBeUndefined()
    expect(keyring.match("Bearer")).toBeUndefined()
    expect(keyring.match("Bearer   ")).toBeUndefined()
    expect(keyring.match("Basic secret-key")).toBeUndefined()
  })

  it("rejects a wrong key", () => {
    expect(keyring.match("Bearer secret-key-2")).toBeUndefined()
  })

  it("distinguishes keys in the same ring", () => {
    expect(keyring.match("Bearer second-key")).toBe(keyId("second-key"))
    expect(keyring.match("Bearer second-key")).not.toBe(keyId("secret-key"))
  })

  it("reports its size and ignores blank entries", () => {
    expect(keyring.size).toBe(2)
    expect(keyringFrom(["", "  "]).size).toBe(0)
    expect(keyringFrom([]).match("Bearer anything")).toBeUndefined()
  })

  it("never exposes the key itself", () => {
    const id = keyring.match("Bearer secret-key")
    expect(id).not.toContain("secret")
  })
})
