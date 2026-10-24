/** 会话 → 工作区目录定位（读 harness storages/workspace.json 的注册表）。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 返回会话所属工作区的绝对路径；找不到返回 null。 */
export async function getWorkspaceFolder(sessionId, dshHome) {
  const home = dshHome || process.env.DSH_HOME
  if (!home) return null
  try {
    const reg = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    const ws = reg?.tables?.workspaces || {}
    for (const rec of Object.values(ws)) {
      const sids = Array.isArray(rec.sessionIds) ? rec.sessionIds : []
      if (sids.includes(sessionId) && rec.path) return rec.path
    }
    return null
  } catch {
    return null
  }
}
