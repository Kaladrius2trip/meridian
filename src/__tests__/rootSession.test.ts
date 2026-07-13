import { describe, expect, it } from "bun:test"
import { deriveIsSubagent, resolveRootSessionId } from "../../plugin/rootSession"

describe("resolveRootSessionId", () => {
  it("resolves every session in a parent chain and reuses cached roots", async () => {
    const sessions = new Map<string, { parentID?: string }>([
      ["R", {}],
      ["C", { parentID: "R" }],
      ["G", { parentID: "C" }],
    ])
    const calls: string[] = []
    const getSession = async (id: string) => {
      calls.push(id)
      return sessions.get(id) ?? {}
    }
    const cache = new Map<string, string>()

    expect(await resolveRootSessionId(getSession, "G", cache)).toBe("R")
    const callCount = calls.length
    expect(await resolveRootSessionId(getSession, "C", cache)).toBe("R")
    expect(await resolveRootSessionId(getSession, "R", cache)).toBe("R")
    expect(await resolveRootSessionId(getSession, "G", cache)).toBe("R")
    expect(calls).toHaveLength(callCount)
  })

  it("returns a parentless session as its own root", async () => {
    const getSession = async (_id: string) => ({})

    expect(await resolveRootSessionId(getSession, "R", new Map())).toBe("R")
  })

  it("returns the starting session when the parent chain cycles", async () => {
    const sessions = new Map<string, { parentID?: string }>([
      ["A", { parentID: "B" }],
      ["B", { parentID: "A" }],
    ])
    const getSession = async (id: string) => sessions.get(id) ?? {}

    expect(await resolveRootSessionId(getSession, "A", new Map())).toBe("A")
  })
})

describe("deriveIsSubagent", () => {
  it("returns false without a parent id", () => {
    expect(deriveIsSubagent(undefined)).toBe(false)
  })

  it("returns true with a parent id", () => {
    expect(deriveIsSubagent("x")).toBe(true)
  })
})
