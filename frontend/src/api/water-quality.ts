import type {
  EntryRow,
  WaterAction,
  WaterActionResult,
  WaterConclusion,
  WaterOperator,
  WaterReportPayload,
  WaterRole,
  WaterStatus,
} from '@/data/types'

/**
 * 水质检测领域服务（纯函数，不碰 localStorage）。
 *
 * 调用链：已采样 →(开始检测)→ 检测中 →(出具报告)→ 待复核 →(复核通过/复核退回)→ 已复核/退回
 *                                                                          ↳ 退回 →(重新提交)→ 待复核
 *
 * 「超标」是检测结论而不是状态：结论只能在出报告时由检测值与标准上限推出，
 * 任何入口都不允许直接写入结论，避免从检测中直接跳到已复核、退回后残留旧结论。
 */

export const WATER_STATUSES: WaterStatus[] = ['已采样', '检测中', '待复核', '已复核', '退回']

/** 正式落库的结论与复核字段。 */
const CONCLUSION_FIELDS = ['检测值', '标准上限', '检测结论'] as const
const REVIEW_FIELDS = ['复核人', '复核时间', '复核意见'] as const

/**
 * 中间（暂存）字段：复核面板打开/填写时先暂存，提交成功才转正；
 * 并发落败或校验失败时必须清空，绝不允许暂存内容污染正式结论。
 */
export const INTERIM_FIELDS = [
  '_pendingValue',
  '_pendingLimit',
  '_pendingReviewer',
  '_pendingComment',
  '_pendingAt',
] as const

export const VERSION_FIELD = '_version'

const ROLE_PERMISSION: Record<WaterAction, WaterRole[]> = {
  开始检测: ['检测员', '主管'],
  出具报告: ['检测员', '主管'],
  复核通过: ['复核员', '主管'],
  复核退回: ['复核员', '主管'],
  重新提交: ['检测员', '主管'],
}

/** 显式状态机：每个动作允许的前置状态。旧实现缺这张表，所以能从检测中直接跳到已复核。 */
const TRANSITIONS: Record<WaterAction, WaterStatus[]> = {
  开始检测: ['已采样'],
  出具报告: ['检测中'],
  复核通过: ['待复核'],
  复核退回: ['待复核'],
  重新提交: ['退回'],
}

export function waterStatus(row: Pick<EntryRow, 'status'>): WaterStatus | null {
  return WATER_STATUSES.includes(row.status as WaterStatus) ? (row.status as WaterStatus) : null
}

export function deriveConclusion(value: unknown, limit: unknown): WaterConclusion | null {
  const numericValue = Number(value)
  const numericLimit = Number(limit)
  if (value === '' || value === undefined || value === null || Number.isNaN(numericValue)) {
    return null
  }
  if (limit === '' || limit === undefined || limit === null || Number.isNaN(numericLimit)) {
    return null
  }
  return numericValue > numericLimit ? '超标' : '达标'
}

/** 旧报告兼容：旧状态迁到新状态机，缺失字段补齐；只迁移不改结论以外的业务事实。 */
export function normalizeWaterRow(
  row: EntryRow,
  legacyStatuses: Record<string, string> = { 已出报告: '待复核', 超标: '待复核' },
  fallbackUnit = '',
): EntryRow {
  const next: EntryRow = { ...row }
  const mapped = legacyStatuses[String(next.status)]
  if (mapped) {
    next.status = mapped
  }

  if (typeof next[VERSION_FIELD] !== 'number') {
    next[VERSION_FIELD] = 1
  }
  if (fallbackUnit && !String(next['所属单位'] ?? '').trim()) {
    next['所属单位'] = fallbackUnit
  }

  // 结论只在报告已出具之后才有意义；检测中/已采样阶段的残留结论一律不认。
  const status = waterStatus(next)
  const hasReport = status === '待复核' || status === '已复核' || status === '退回'
  if (!hasReport) {
    for (const field of [...CONCLUSION_FIELDS, ...REVIEW_FIELDS, ...INTERIM_FIELDS]) {
      delete next[field]
    }
  } else if (!next['检测结论']) {
    const derived = deriveConclusion(next['检测值'], next['标准上限'])
    if (derived) {
      next['检测结论'] = derived
    }
  }

  next.pending = next.status === '待复核'
  next.abnormal = next['检测结论'] === '超标' || next.status === '退回'
  return next
}

export function normalizeWaterRows(rows: EntryRow[], fallbackUnit = ''): EntryRow[] {
  return rows.map((row) => normalizeWaterRow(row, undefined, fallbackUnit))
}

/** 页面按此渲染动作按钮，业务判断仍收敛在服务层。 */
export function availableActions(row: EntryRow, operator: WaterOperator): WaterAction[] {
  const status = waterStatus(row)
  if (!status || String(row['所属单位'] ?? '') !== operator.unit) {
    return []
  }
  return (Object.keys(TRANSITIONS) as WaterAction[]).filter(
    (action) =>
      TRANSITIONS[action].includes(status) && ROLE_PERMISSION[action].includes(operator.role),
  )
}

function ensurePermission(
  row: EntryRow,
  action: WaterAction,
  operator: WaterOperator,
): WaterActionResult | null {
  if (String(row['所属单位'] ?? '') !== operator.unit) {
    return {
      ok: false,
      message: `跨单位操作被拒绝：该报告属于${row['所属单位'] || '其它单位'}，${operator.unit}人员不能操作`,
    }
  }
  if (!ROLE_PERMISSION[action].includes(operator.role)) {
    return {
      ok: false,
      message: `${operator.role}无权执行「${action}」，该操作需${ROLE_PERMISSION[action].join('或')}身份`,
    }
  }
  return null
}

function withoutInterim(row: EntryRow): EntryRow {
  const next = { ...row }
  for (const field of INTERIM_FIELDS) {
    delete next[field]
  }
  return next
}

function bumpVersion(row: EntryRow): EntryRow {
  return { ...row, [VERSION_FIELD]: Number(row[VERSION_FIELD] ?? 0) + 1 }
}

function refreshFlags(row: EntryRow): EntryRow {
  row.pending = row.status === '待复核'
  row.abnormal = row['检测结论'] === '超标' || row.status === '退回'
  return row
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export type WaterRequest = {
  action: WaterAction
  payload?: WaterReportPayload
  /** 打开面板时读到的版本号；并发提交时用它做乐观锁。 */
  expectedVersion: number
}

/**
 * 在一份 rows 快照上执行水质动作。
 * 并发提交：版本号不符说明已有人先落库，本次直接落败，只清空调用方暂存的中间字段，
 * 既不改状态也不覆盖先落库的结论。
 */
export function transitionWaterRow(
  rows: EntryRow[],
  id: number,
  request: WaterRequest,
  operator: WaterOperator,
): { rows: EntryRow[]; result: WaterActionResult } {
  const { action, payload = {}, expectedVersion } = request
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { rows, result: { ok: false, message: `没有找到编号为 ${id} 的水质检测报告` } }
  }

  const current = normalizeWaterRow(rows[index])
  const status = waterStatus(current)

  const denied = ensurePermission(current, action, operator)
  if (denied) {
    return { rows, result: denied }
  }

  // 乐观锁必须先于状态机校验：状态已被先到的提交改变（待复核 → 已复核/退回）时，
  // 后来者拿到的应是「并发落败」并清空中间字段，而不是一个具有迷惑性的状态不符错误。
  const currentVersion = Number(current[VERSION_FIELD] ?? 0)
  if (currentVersion !== expectedVersion) {
    const rejected = refreshFlags(withoutInterim(current))
    const nextRows = [...rows]
    nextRows[index] = rejected
    return {
      rows: nextRows,
      result: {
        ok: false,
        message: `该报告已被其他人先提交（版本 ${expectedVersion} → ${currentVersion}），本次提交未生效，请刷新后重试`,
      },
    }
  }

  if (!status || !TRANSITIONS[action].includes(status)) {
    return {
      rows,
      result: {
        ok: false,
        message: `「${action}」前置状态应为${TRANSITIONS[action].join('或')}，当前是「${current.status}」`,
      },
    }
  }

  let next = withoutInterim(current)

  if (action === '开始检测') {
    next.status = '检测中'
  }

  if (action === '出具报告' || action === '重新提交') {
    // 重新提交只保留已有结论：未重新检测就沿用原值，结论一律由服务端重算，
    // payload 里就算伪造了「检测结论」也不会被采信。
    const value = payload.检测值 !== undefined ? String(payload.检测值) : String(next['检测值'] ?? '')
    const limit =
      payload.标准上限 !== undefined ? String(payload.标准上限) : String(next['标准上限'] ?? '')
    const conclusion = deriveConclusion(value, limit)
    if (!conclusion) {
      // 输入不完整：不产生任何正式结论，同时清掉暂存，报告不进待复核队列。
      return {
        rows,
        result: { ok: false, message: '检测值与标准上限必须都是数字，才能出具报告' },
      }
    }
    next['检测值'] = value
    next['标准上限'] = limit
    next['检测结论'] = conclusion
    for (const field of REVIEW_FIELDS) {
      delete next[field]
    }
    next.status = '待复核'
  }

  if (action === '复核通过' || action === '复核退回') {
    if (action === '复核退回') {
      // 退回保留采样站点、检测项目与已有检测结论（报告事实），
      // 只清掉复核产生的字段与全部暂存，让报告回到退回态等待重新提交。
      for (const field of REVIEW_FIELDS) {
        delete next[field]
      }
      next.status = '退回'
    } else {
      next['复核人'] = operator.name
      next['复核时间'] = today()
      next['复核意见'] = payload.复核意见?.trim() || '同意出具检测结论'
      next.status = '已复核'
    }
  }

  next = refreshFlags(bumpVersion(next))
  const nextRows = [...rows]
  nextRows[index] = next
  return {
    rows: nextRows,
    result: {
      ok: true,
      message: `报告已${action}，当前状态「${next.status}」`,
      version: Number(next[VERSION_FIELD]),
    },
  }
}

/** 暂存复核面板里填到一半的内容；不落结论、不动版本号。 */
export function stageInterim(
  rows: EntryRow[],
  id: number,
  interim: Partial<Record<(typeof INTERIM_FIELDS)[number], string>>,
  operator: WaterOperator,
): { rows: EntryRow[]; result: WaterActionResult } {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { rows, result: { ok: false, message: `没有找到编号为 ${id} 的水质检测报告` } }
  }
  const current = normalizeWaterRow(rows[index])
  if (String(current['所属单位'] ?? '') !== operator.unit) {
    return { rows, result: { ok: false, message: '跨单位操作被拒绝' } }
  }
  const next = { ...current }
  for (const [field, value] of Object.entries(interim)) {
    if (value && value.trim()) {
      next[field] = value
    } else {
      delete next[field]
    }
  }
  const nextRows = [...rows]
  nextRows[index] = next
  return { rows: nextRows, result: { ok: true, message: '' } }
}

/**
 * 另一个检测入口（登记弹窗）：采样后直接录入检测结果。
 * 与行内「出具报告」走同一个结论落库逻辑，登记成功即写入待复核待办。
 */
export function createWaterReport(
  rows: EntryRow[],
  draft: {
    报告编号: string
    采样站点: string
    采样时间: string
    检测项目: string
    检测值: string
    标准上限: string
  },
  operator: WaterOperator,
): { rows: EntryRow[]; result: WaterActionResult } {
  const conclusion = deriveConclusion(draft.检测值, draft.标准上限)
  if (!draft.报告编号.trim() || !draft.采样站点.trim() || !draft.检测项目.trim()) {
    return { rows, result: { ok: false, message: '报告编号、采样站点、检测项目不能为空' } }
  }
  if (!conclusion) {
    return { rows, result: { ok: false, message: '检测值与标准上限必须都是数字，才能登记并出报告' } }
  }
  if (rows.some((row) => String(row['报告编号'] ?? '') === draft.报告编号.trim())) {
    return { rows, result: { ok: false, message: `报告编号 ${draft.报告编号} 已存在` } }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = refreshFlags({
    id,
    status: '待复核',
    pending: true,
    abnormal: false,
    报告编号: draft.报告编号.trim(),
    所属单位: operator.unit,
    采样站点: draft.采样站点.trim(),
    采样时间: draft.采样时间 || today(),
    检测项目: draft.检测项目.trim(),
    检测值: String(draft.检测值),
    标准上限: String(draft.标准上限),
    检测结论: conclusion,
    检测人: operator.name,
    [VERSION_FIELD]: 1,
  })
  return {
    rows: [...rows, row],
    result: { ok: true, message: `报告已登记并进入待复核队列，结论「${conclusion}」`, version: 1 },
  }
}
