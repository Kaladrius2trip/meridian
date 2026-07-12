import { describe, it, expect } from "bun:test"
import { pickLeastLoaded } from "../proxy/session/affinity"

describe("pickLeastLoaded", () => {
  it("returns first eligible id when counts are empty", () => {
    const result = pickLeastLoaded({}, ["alpha", "beta"])

    expect(result).toBe("alpha")
  })

  it("returns eligible id with smallest load", () => {
    const result = pickLeastLoaded({ alpha: 3, beta: 1, gamma: 2 }, ["alpha", "beta", "gamma"])

    expect(result).toBe("beta")
  })

  it("returns first eligible id when loads tie", () => {
    const result = pickLeastLoaded({ alpha: 2, beta: 2 }, ["beta", "alpha"])

    expect(result).toBe("beta")
  })

  it("ignores counts for non-eligible ids", () => {
    const result = pickLeastLoaded({ alpha: 5, outsider: -10 }, ["alpha", "beta"])

    expect(result).toBe("beta")
  })

  it("returns sole eligible id", () => {
    const result = pickLeastLoaded({ alpha: 99 }, ["alpha"])

    expect(result).toBe("alpha")
  })

  it("throws when eligible is empty", () => {
    expect(() => pickLeastLoaded({}, [])).toThrow("pickLeastLoaded: eligible must be non-empty")
  })
})
