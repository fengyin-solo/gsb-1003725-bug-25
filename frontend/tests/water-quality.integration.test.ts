import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  listWaterReports,
  loadOverview,
  registerWaterReport,
  submitWaterAction,
  waterReportActions,
} from '../src/api/local-service'
import { VERSION_FIELD } from '../src/api/water-quality'
import type { WaterOperator } from '../src/data/types'

const centerTester: WaterOperator = { name: '周采样', role: '检测员', unit: '市水文监测中心' }
const centerReviewer: WaterOperator = { name: '王复核', role: '复核员', unit: '市水文监测中心' }
const centerBoss: WaterOperator = { name: '陈水清', role: '主管', unit: '市水文监测中心' }
const northReviewer: WaterOperator = { name: '赵审校', role: '复核员', unit: '江北分局' }

describe('local-service 集成（含旧种子数据迁移与待办统计）', () => {
  it('旧种子：已出报告/超标都进待复核，已复核报告不进待办，超标计入异常', () => {
    const { items, total } = listWaterReports()
    assert.equal(total, 5)
    const byCode = Object.fromEntries(items.map((row) => [row['报告编号'], row]))
    assert.equal(byCode['WATE-0003'].status, '待复核')
    assert.equal(byCode['WATE-0003']['检测结论'], '超标')
    assert.equal(byCode['WATE-0004'].status, '待复核')
    assert.equal(byCode['WATE-0004']['检测结论'], '超标')
    assert.equal(byCode['WATE-0005'].status, '已复核')

    const overview = loadOverview()
    const water = overview.modules.find((item) => item.name === '水质检测')
    assert.equal(water?.pending, 2)
    assert.equal(water?.abnormal, 2) // WATE-0003 / 0004 超标
  })

  it('完整链路：开始检测 → 出报告 → 复核通过，详情与待办始终一致', () => {
    // WATE-0001：已采样
    const start = submitWaterAction(1, { action: '开始检测', expectedVersion: 1 }, centerTester)
    assert.equal(start.ok, true)
    const afterStart = listWaterReports().items.find((row) => Number(row.id) === 1)
    assert.equal(afterStart?.status, '检测中')
    assert.equal(afterStart?.['检测结论'], undefined)

    const issue = submitWaterAction(
      1,
      { action: '出具报告', payload: { 检测值: '0.32', 标准上限: '0.20' }, expectedVersion: 2 },
      centerTester,
    )
    assert.equal(issue.ok, true)
    const afterIssue = listWaterReports().items.find((row) => Number(row.id) === 1)
    assert.equal(afterIssue?.status, '待复核')
    assert.equal(afterIssue?.['检测结论'], '超标')

    // 检测员复核被拒
    const testerReview = submitWaterAction(
      1,
      { action: '复核通过', expectedVersion: 3 },
      centerTester,
    )
    assert.equal(testerReview.ok, false)

    const pass = submitWaterAction(
      1,
      { action: '复核通过', payload: { 复核意见: '无误' }, expectedVersion: 3 },
      centerReviewer,
    )
    assert.equal(pass.ok, true)
    const afterPass = listWaterReports().items.find((row) => Number(row.id) === 1)
    assert.equal(afterPass?.status, '已复核')
    assert.equal(afterPass?.['复核人'], '王复核')
  })

  it('跨单位复核被拒；退回后旧复核字段清空；再次提交保留超标结论', () => {
    // WATE-0004 属江北分局且是旧「超标」迁移来的待复核
    const cross = submitWaterAction(
      4,
      { action: '复核通过', expectedVersion: 1 },
      centerReviewer,
    )
    assert.equal(cross.ok, false)
    assert.match(cross.message, /跨单位/)

    const back = submitWaterAction(
      4,
      { action: '复核退回', payload: { 复核意见: '采样疑点' }, expectedVersion: 1 },
      northReviewer,
    )
    assert.equal(back.ok, true)
    const afterBack = listWaterReports().items.find((row) => Number(row.id) === 4)
    assert.equal(afterBack?.status, '退回')
    assert.equal(afterBack?.['复核意见'], undefined)
    assert.equal(afterBack?.['检测结论'], '超标')
    assert.equal(afterBack?.abnormal, true)

    // 检测员重新提交：沿用已有值，结论仍是超标
    const again = submitWaterAction(
      4,
      { action: '重新提交', payload: { 检测值: '6.2', 标准上限: '5.0' }, expectedVersion: 2 },
      { name: '林测定', role: '检测员', unit: '江北分局' },
    )
    assert.equal(again.ok, true)
    const afterAgain = listWaterReports().items.find((row) => Number(row.id) === 4)
    assert.equal(afterAgain?.status, '待复核')
    assert.equal(afterAgain?.['检测结论'], '超标')
  })

  it('并发复核：主管用旧版本号落败，先落库的复核员结论保留，中间字段清空', () => {
    // WATE-0003 市中心超标报告，当前待复核 v1
    const row = listWaterReports().items.find((item) => Number(item.id) === 3)
    assert.equal(row?.status, '待复核')

    const first = submitWaterAction(
      3,
      { action: '复核通过', payload: { 复核意见: '先到结论' }, expectedVersion: 1 },
      centerReviewer,
    )
    assert.equal(first.ok, true)
    assert.equal(first.version, 2)

    const second = submitWaterAction(
      3,
      { action: '复核通过', payload: { 复核意见: '后到结论' }, expectedVersion: 1 },
      centerBoss,
    )
    assert.equal(second.ok, false)
    assert.match(second.message, /已被其他人先提交/)

    const final = listWaterReports().items.find((item) => Number(item.id) === 3)
    assert.equal(final?.status, '已复核')
    assert.equal(final?.['复核意见'], '先到结论')
    assert.equal(final?.['复核人'], '王复核')
    assert.equal(final?.[VERSION_FIELD], 2)
    assert.equal(final?._pendingComment, undefined)
  })

  it('另一个检测入口登记后直接写入待复核，与出报告入口在同一待办队列', () => {
    const before = listWaterReports().total
    const created = registerWaterReport(
      {
        报告编号: 'WATE-0099',
        采样站点: '新增断面',
        采样时间: '2026-10-04 09:00',
        检测项目: '总磷',
        检测值: '0.50',
        标准上限: '0.20',
      },
      centerTester,
    )
    assert.equal(created.ok, true)
    const after = listWaterReports()
    assert.equal(after.total, before + 1)
    const row = after.items.find((item) => item['报告编号'] === 'WATE-0099')
    assert.equal(row?.status, '待复核')
    assert.equal(row?.['检测结论'], '超标')
    assert.deepEqual(waterReportActions(row!, centerReviewer), ['复核通过', '复核退回'])
  })
})
