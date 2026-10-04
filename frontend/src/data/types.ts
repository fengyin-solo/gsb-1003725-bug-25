/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 旧版本状态 → 新状态机状态的迁移映射，读取时自动兼容。 */
  legacyStatuses?: Record<string, string>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---------------------------------------------------------------------------
// 水质检测领域：采样 → 检测 → 出报告 → 复核（通过/退回 → 重新提交）
// ---------------------------------------------------------------------------

/** 超标/达标是「检测结论」，不是状态；状态只走下面五档。 */
export type WaterStatus = '已采样' | '检测中' | '待复核' | '已复核' | '退回'

export type WaterConclusion = '超标' | '达标'

export type WaterAction =
  | '开始检测'
  | '出具报告'
  | '复核通过'
  | '复核退回'
  | '重新提交'

export type WaterRole = '检测员' | '复核员' | '主管'

export type WaterOperator = {
  name: string
  role: WaterRole
  unit: string
}

export type WaterReportPayload = {
  检测值?: string
  标准上限?: string
  复核意见?: string
}

export type WaterActionResult = ActionResult & {
  version?: number
}
