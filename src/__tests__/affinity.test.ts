import { describe, it, expect } from "bun:test"
import { pickLeastLoaded, relocate, selectProfileForRoot } from "../proxy/session/affinity"
import type { SelectProfileInput } from "../proxy/session/affinity"

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

describe("relocate", () => {
  it("excludes current and returns least-loaded remaining id", () => {
    const result = relocate("alpha", { alpha: 1, beta: 3, gamma: 2 }, ["alpha", "beta", "gamma"])

    expect(result).toBe("gamma")
  })

  it("returns current when it is the only eligible id", () => {
    const result = relocate("alpha", { alpha: 1 }, ["alpha"])

    expect(result).toBe("alpha")
  })

  it("returns current when eligible is empty", () => {
    const result = relocate("alpha", {}, [])

    expect(result).toBe("alpha")
  })

  it("returns least-loaded eligible id when current is not eligible", () => {
    const result = relocate("alpha", { beta: 3, gamma: 1 }, ["beta", "gamma"])

    expect(result).toBe("gamma")
  })
})

describe("selectProfileForRoot", () => {
  const cases: Array<{
    name: string
    input: SelectProfileInput
    expected: { profileId: string; firstSeen: boolean }
  }> = [
    {
      name: "explicit profile beats mapped, active, and default profiles",
      input: {
        explicit: "explicit",
        mapped: "mapped",
        counts: {},
        eligible: [],
        activeId: "active",
        defaultId: "default",
      },
      expected: { profileId: "explicit", firstSeen: false },
    },
    {
      name: "mapped profile beats active and default profiles",
      input: {
        mapped: "mapped",
        counts: {},
        eligible: [],
        activeId: "active",
        defaultId: "default",
      },
      expected: { profileId: "mapped", firstSeen: false },
    },
    {
      name: "first-seen root uses least-loaded eligible profile",
      input: {
        counts: { alpha: 3, beta: 1 },
        eligible: ["alpha", "beta"],
        activeId: "active",
        defaultId: "default",
      },
      expected: { profileId: "beta", firstSeen: true },
    },
    {
      name: "first-seen root with no eligible profile uses active profile",
      input: { counts: {}, eligible: [], activeId: "active", defaultId: "default" },
      expected: { profileId: "active", firstSeen: true },
    },
    {
      name: "first-seen root with no eligible or active profile uses default profile",
      input: { counts: {}, eligible: [], defaultId: "default" },
      expected: { profileId: "default", firstSeen: true },
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(selectProfileForRoot(testCase.input)).toEqual(testCase.expected)
    })
  }

  it("throws when no profile is available", () => {
    expect(() => selectProfileForRoot({ counts: {}, eligible: [] })).toThrow(
      "selectProfileForRoot: no profile available",
    )
  })
})
