import { listRows, readStoredRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 水质检测报告工作流：已采样 → 检测中 → 待复核 → 已复核（或已退回后重新提交）。
// 检测列表、报告详情、复核面板都从这里读写，状态机只有这一份。
// 旧的通用 runAction 把「动作 → 终态」直接盖章，不校验流转、不写结论、不看权限，
// 是检测中直接跳到已复核、退回残留旧结论、待办对不上的共同根因，本模块不再走它。

const KEY = 'waterquality'
const ENTITY = '水质检测报告'

// 权限约定：检测员/管理员可登记采样、开始检测、提交检测结果；
// 复核员/管理员可复核，且复核人不能是出具报告的检测人本人（回避）。
export const DETECT_ROLES = ['检测员', '管理员']
export const REVIEW_ROLES = ['复核员', '管理员']

export const ROLE_OPTIONS = ['检测员', '复核员', '管理员']
export const UNIT_OPTIONS = ['第一检测中心', '第二检测中心']

// 旧版报告的状态：一律并入「待复核」继续走复核流程（旧报告兼容）。
const LEGACY_REVIEW_STATUSES = ['已出报告', '超标']

export type Identity = {
  operator: string
  role: string
  unit: string
}

function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function toNumber(value: unknown): number | null {
  const text = asText(value).trim()
  if (text === '') {
    return null
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function displayValue(value: unknown): string {
  const text = asText(value)
  return text === '' ? '—' : text
}

// 列表/详情里实时预览结论：检测值超过标准上限即超标。
export function previewConclusion(valueText: string, limit: unknown): '达标' | '超标' | null {
  const value = toNumber(valueText)
  const upper = toNumber(limit)
  if (value === null || upper === null) {
    return null
  }
  return value > upper ? '超标' : '达标'
}

// 兼容旧报告：老数据没有结论/检测单位/复核字段，状态也可能停在已出报告、超标。
export function normalizeReport(row: EntryRow): EntryRow {
  const status = asText(row.status)
  if (!LEGACY_REVIEW_STATUSES.includes(status)) {
    return row
  }
  const next: EntryRow = { ...row, status: '待复核' }
  if (asText(next.结论) === '') {
    next.结论 = status === '超标' ? '超标' : (previewConclusion(asText(next.检测值), next.标准上限) ?? '达标')
  }
  return next
}

function migrateRow(row: EntryRow): EntryRow {
  const normalized = normalizeReport(row)
  const status = asText(normalized.status)
  return {
    ...normalized,
    报告状态: status,
    // 待办口径：只有「已复核」算办结，其余状态都还在待办里。
    pending: status !== '已复核',
    abnormal: asText(normalized.结论) === '超标',
  }
}

let migrated = false

// 存量数据一次性迁移到新状态机，之后概览待办、检测列表、复核面板看到的都是同一份口径。
function ensureMigrated(): void {
  if (migrated) {
    return
  }
  migrated = true
  const rows = readStoredRows(KEY)
  if (rows.length === 0) {
    return
  }
  const next = rows.map(migrateRow)
  if (JSON.stringify(next) !== JSON.stringify(rows)) {
    saveRows(KEY, next)
  }
}

export function listReports(): EntryRow[] {
  ensureMigrated()
  return listRows(KEY).map(normalizeReport)
}

export function getReport(id: number): EntryRow | null {
  return listReports().find((row) => Number(row.id) === id) ?? null
}

// 所有写操作共用：重读 localStorage 里的最新行 → 校验 → 落库。
// 并发或重复提交时，只有先落库的结论生效，后到的在 guard 上就会被拒绝。
function commitReport(
  id: number,
  guard: (fresh: EntryRow) => string | null,
  mutate: (fresh: EntryRow) => EntryRow,
  okMessage: (next: EntryRow) => string,
): ActionResult {
  ensureMigrated()
  const stored = readStoredRows(KEY)
  const index = stored.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${ENTITY}` }
  }
  const fresh = normalizeReport(stored[index])
  const violation = guard(fresh)
  if (violation) {
    return { ok: false, message: violation }
  }
  const next = [...stored]
  next[index] = mutate(fresh)
  saveRows(KEY, next)
  return { ok: true, message: okMessage(next[index]) }
}

// 跨单位操作拒绝：旧报告没有检测单位的不卡死；有单位的一律要求同单位。
function sameUnitOrLegacy(row: EntryRow, identity: Identity): string | null {
  const owner = asText(row.检测单位).trim()
  if (owner !== '' && owner !== identity.unit) {
    return `报告属于${owner}，${identity.operator}所在的${identity.unit}无权操作（拒绝跨单位操作）`
  }
  return null
}

export function registerSampling(
  input: { 采样站点: string; 采样时间: string; 检测项目: string; 标准上限: string },
  identity: Identity,
): ActionResult {
  if (!DETECT_ROLES.includes(identity.role)) {
    return { ok: false, message: `${identity.operator}（${identity.role}）无权登记采样，需要检测员或管理员` }
  }
  const 采样站点 = input.采样站点.trim()
  const 采样时间 = input.采样时间.trim()
  const 检测项目 = input.检测项目.trim()
  const 标准上限 = toNumber(input.标准上限)
  if (采样站点 === '' || 采样时间 === '' || 检测项目 === '') {
    return { ok: false, message: '采样站点、采样时间、检测项目必填，登记失败，未写入任何中间字段' }
  }
  if (标准上限 === null) {
    return { ok: false, message: '标准上限必须是数值，登记失败，未写入任何中间字段' }
  }
  ensureMigrated()
  const rows = listRows(KEY)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const 报告编号 = `WQ-${String(id).padStart(4, '0')}`
  const row: EntryRow = {
    id,
    status: '已采样',
    pending: true,
    abnormal: false,
    报告编号,
    采样站点,
    采样时间,
    检测项目,
    检测值: '',
    标准上限,
    结论: '',
    检测人: '',
    检测单位: identity.unit,
    出具时间: '',
    复核人: '',
    复核结论: '',
    复核时间: '',
    退回原因: '',
    报告状态: '已采样',
  }
  saveRows(KEY, [...rows, row])
  return { ok: true, message: `报告${报告编号}已登记，当前状态「已采样」` }
}

export function startTesting(id: number, identity: Identity): ActionResult {
  if (!DETECT_ROLES.includes(identity.role)) {
    return { ok: false, message: `${identity.operator}（${identity.role}）无权开始检测，需要检测员或管理员` }
  }
  return commitReport(
    id,
    (fresh) =>
      sameUnitOrLegacy(fresh, identity) ??
      (asText(fresh.status) === '已采样'
        ? null
        : `只有「已采样」的报告才能开始检测，当前状态「${asText(fresh.status)}」`),
    (fresh) => ({ ...fresh, status: '检测中', 报告状态: '检测中', pending: true, abnormal: false }),
    (next) => `报告${asText(next.报告编号)}已开始检测`,
  )
}

// 出具报告：检测列表与报告详情两个检测入口都调这里，统一写入「待复核」。
export function submitDetection(id: number, input: { 检测值: string }, identity: Identity): ActionResult {
  if (!DETECT_ROLES.includes(identity.role)) {
    return { ok: false, message: `${identity.operator}（${identity.role}）无权提交检测结果，需要检测员或管理员` }
  }
  // 先校验再落库：任何失败都不会把检测值、结论等中间字段写进报告。
  const value = toNumber(input.检测值)
  if (value === null) {
    return { ok: false, message: '检测值必须填写数值，提交失败，未写入任何中间字段' }
  }
  return commitReport(
    id,
    (fresh) => {
      const unitViolation = sameUnitOrLegacy(fresh, identity)
      if (unitViolation) {
        return unitViolation
      }
      const status = asText(fresh.status)
      if (status === '待复核' || status === '已复核') {
        // 已有结论（含并发时别人先落库的）：再次提交只保留已有结论，不覆盖。
        return `该报告已有检测结论「${asText(fresh.结论)}」，再次提交只保留已有结论`
      }
      if (status !== '检测中' && status !== '已退回') {
        return `只有「检测中」或「已退回」的报告才能提交检测结果，当前状态「${status}」`
      }
      if (toNumber(fresh.标准上限) === null) {
        return '报告缺少有效的标准上限，无法判定超标结论，提交失败，未写入任何中间字段'
      }
      return null
    },
    (fresh) => {
      const conclusion = previewConclusion(String(value), fresh.标准上限) as '达标' | '超标'
      return {
        ...fresh,
        status: '待复核',
        报告状态: '待复核',
        检测值: value,
        结论: conclusion,
        检测人: identity.operator,
        检测单位: asText(fresh.检测单位).trim() || identity.unit,
        出具时间: now(),
        // 新一轮复核：清掉上一轮的复核痕迹。
        复核人: '',
        复核结论: '',
        复核时间: '',
        退回原因: '',
        pending: true,
        abnormal: conclusion === '超标',
      }
    },
    (next) => `报告${asText(next.报告编号)}已出具，结论「${asText(next.结论)}」，进入待复核`,
  )
}

export function submitReview(
  id: number,
  input: { 复核结论: '通过' | '退回'; 退回原因?: string },
  identity: Identity,
): ActionResult {
  if (!REVIEW_ROLES.includes(identity.role)) {
    return { ok: false, message: `${identity.operator}（${identity.role}）无权复核，需要复核员或管理员` }
  }
  const reason = (input.退回原因 ?? '').trim()
  if (input.复核结论 === '退回' && reason === '') {
    return { ok: false, message: '退回必须填写退回原因，提交失败，未写入任何中间字段' }
  }
  return commitReport(
    id,
    (fresh) => {
      const unitViolation = sameUnitOrLegacy(fresh, identity)
      if (unitViolation) {
        return unitViolation
      }
      const status = asText(fresh.status)
      if (status === '已复核') {
        // 已有复核结论（含并发时别人先落库的）：再次提交只保留已有结论。
        return `该报告已有复核结论「${asText(fresh.复核结论) || '通过'}」，再次提交只保留已有结论`
      }
      if (status !== '待复核') {
        return `只有「待复核」的报告才能复核，当前状态「${status}」`
      }
      if (asText(fresh.复核结论) !== '') {
        return '该报告已有先落库的复核结论，本次提交被拒绝'
      }
      if (asText(fresh.检测人) !== '' && asText(fresh.检测人) === identity.operator) {
        return '检测人不能复核本人出具的报告（回避）'
      }
      return null
    },
    (fresh) => {
      if (input.复核结论 === '通过') {
        return {
          ...fresh,
          status: '已复核',
          报告状态: '已复核',
          复核人: identity.operator,
          复核结论: '通过',
          复核时间: now(),
          退回原因: '',
          pending: false,
          abnormal: asText(fresh.结论) === '超标',
        }
      }
      // 退回：清空本轮检测的中间字段，不允许残留旧结论。
      return {
        ...fresh,
        status: '已退回',
        报告状态: '已退回',
        检测值: '',
        结论: '',
        出具时间: '',
        复核人: identity.operator,
        复核结论: '退回',
        复核时间: now(),
        退回原因: reason,
        pending: true,
        abnormal: false,
      }
    },
    (next) =>
      input.复核结论 === '通过'
        ? `报告${asText(next.报告编号)}复核通过，已办结`
        : `报告${asText(next.报告编号)}已退回，检测结论等中间字段已清空`,
  )
}
