export async function resolveRootSessionId(
  getSession: (id: string) => Promise<{ parentID?: string }>,
  sessionId: string,
  cache: Map<string, string>
): Promise<string> {
  const cachedRoot = cache.get(sessionId)
  if (cachedRoot !== undefined) return cachedRoot

  const visited = new Set<string>()
  const path: string[] = []
  let currentId = sessionId

  while (true) {
    const cachedParentRoot = cache.get(currentId)
    if (cachedParentRoot !== undefined) {
      for (const id of path) cache.set(id, cachedParentRoot)
      return cachedParentRoot
    }
    if (visited.has(currentId)) return sessionId

    visited.add(currentId)
    path.push(currentId)

    const { parentID } = await getSession(currentId)
    if (!parentID) {
      for (const id of path) cache.set(id, currentId)
      return currentId
    }
    currentId = parentID
  }
}

export function deriveIsSubagent(parentId?: string): boolean {
  return parentId !== undefined && parentId.length > 0
}
