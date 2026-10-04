import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  availableActions,
  createWaterReport,
  normalizeWaterRow,
  stageInterim,
  transitionWaterRow,
  type WaterRequest,
} from '@/api/water-quality'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  WaterOperator,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '退回']

const WATER_QUALITY_KEY = 'waterquality'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0)
    return rows
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const rows = listRows(key).map((row) =>
    key === WATER_QUALITY_KEY ? normalizeWaterRow(row) : row,
  )
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 水质检测有独立状态机与权限/并发校验，禁止再走通用跳转器（那正是跳级到已复核的根因）。
  if (key === WATER_QUALITY_KEY) {
    return { ok: false, message: '水质检测动作必须通过复核领域服务提交' }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 水质检测：采样 → 出报告 → 复核 的统一写入口，所有检测入口都在这里落结论
// ---------------------------------------------------------------------------

export function listWaterReports(filters: Record<string, string> = {}): PageResult {
  return listEntries(WATER_QUALITY_KEY, filters)
}

export function waterReportActions(row: EntryRow, operator: WaterOperator) {
  return availableActions(normalizeWaterRow(row), operator)
}

export function submitWaterAction(
  id: number,
  request: WaterRequest,
  operator: WaterOperator,
): ActionResult & { version?: number } {
  const rows = listRows(WATER_QUALITY_KEY).map((row) => normalizeWaterRow(row))
  const { rows: nextRows, result } = transitionWaterRow(rows, id, request, operator)
  if (result.ok) {
    saveRows(WATER_QUALITY_KEY, nextRows)
  } else if (nextRows !== rows) {
    // 并发落败等场景需要把「清空中间字段」落库，但不产生新结论、不推进状态。
    saveRows(WATER_QUALITY_KEY, nextRows)
  }
  return result
}

export function registerWaterReport(
  draft: {
    报告编号: string
    采样站点: string
    采样时间: string
    检测项目: string
    检测值: string
    标准上限: string
  },
  operator: WaterOperator,
): ActionResult & { version?: number } {
  const rows = listRows(WATER_QUALITY_KEY).map((row) => normalizeWaterRow(row))
  const { rows: nextRows, result } = createWaterReport(rows, draft, operator)
  if (result.ok) {
    saveRows(WATER_QUALITY_KEY, nextRows)
  }
  return result
}

export function saveWaterDraft(
  id: number,
  interim: Partial<Record<string, string>>,
  operator: WaterOperator,
): ActionResult {
  const rows = listRows(WATER_QUALITY_KEY).map((row) => normalizeWaterRow(row))
  const { rows: nextRows, result } = stageInterim(rows, id, interim, operator)
  if (result.ok) {
    saveRows(WATER_QUALITY_KEY, nextRows)
  }
  return result
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const rows = listRows(key).map((row) =>
    key === WATER_QUALITY_KEY ? normalizeWaterRow(row) : row,
  )
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function isPending(key: string, row: EntryRow): boolean {
  if (key === WATER_QUALITY_KEY) {
    // 待办语义：只有「待复核」算待办；检测中是检测员正在处理，不算复核待办。
    return normalizeWaterRow(row).status === '待复核'
  }
  return row.pending
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => isPending(meta.key, row)).length,
      abnormal: entries.filter((row) =>
        meta.key === WATER_QUALITY_KEY ? normalizeWaterRow(row).abnormal : row.abnormal,
      ).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
