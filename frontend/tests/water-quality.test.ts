import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  INTERIM_FIELDS,
  availableActions,
  createWaterReport,
  normalizeWaterRow,
  normalizeWaterRows,
  stageInterim,
  transitionWaterRow,
  VERSION_FIELD,
} from '../src/api/water-quality'
import type { EntryRow, WaterOperator, WaterRequest } from '../src/data/types'

const centerTester: WaterOperator = { name: '周采样', role: '检测员', unit: '市水文监测中心' }
const centerReviewer: WaterOperator = { name: '王复核', role: '复核员', unit: '市水文监测中心' }
const centerBoss: WaterOperator = { name: '陈水清', role: '主管', unit: '市水文监测中心' }
const northTester: WaterOperator = { name: '林测定', role: '检测员', unit: '江北分局' }
const northReviewer: WaterOperator = { name: '赵审校', role: '复核员', unit: '江北分局' }

function row(partial: Partial<EntryRow> & { id: number }): EntryRow {
  return {
    status: '已采样',
    pending: false,
    abnormal: false,
    报告编号: `WATE-${String(partial.id).padStart(4, '0')}`,
    所属单位: '市水文监测中心',
    采样站点: '测试断面',
    采样时间: '2026-10-01',
    检测项目: '氨氮',
    ...partial,
  }
}

function act(
  rows: EntryRow[],
  id: number,
  request: WaterRequest,
  operator: WaterOperator,
) {
  return transitionWaterRow(rows, id, request, operator)
}

describe('旧报告兼容', () => {
  it('旧「已出报告」迁到待复核，pending 为 true，结论由数值推出', () => {
    const normalized = normalizeWaterRow(
      row({ id: 1, status: '已出报告', pending: false, 检测值: '0.32', 标准上限: '0.20' }),
    )
    assert.equal(normalized.status, '待复核')
    assert.equal(normalized.pending, true)
    assert.equal(normalized['检测结论'], '超标')
    assert.equal(normalized.abnormal, true)
    assert.equal(normalized[VERSION_FIELD], 1)
  })

  it('旧「超标」状态同样进待复核队列，详情/列表/待办看到的是同一份结论', () => {
    const normalized = normalizeWaterRow(
      row({ id: 2, status: '超标', 检测值: '6.2', 标准上限: '5.0' }),
    )
    assert.equal(normalized.status, '待复核')
    assert.equal(normalized['检测结论'], '超标')
  })

  it('检测中/已采样残留的旧结论与复核字段会被清掉，不再带着旧结论跳转', () => {
    const normalized = normalizeWaterRow(
      row({
        id: 3,
        status: '检测中',
        检测值: '9',
        标准上限: '1',
        检测结论: '超标',
        复核人: '王复核',
      }),
    )
    assert.equal(normalized['检测结论'], undefined)
    assert.equal(normalized['复核人'], undefined)
    assert.equal(normalized.pending, false)
  })

  it('旧「已复核」报告原样可用，结论不重算、不丢复核意见', () => {
    const normalized = normalizeWaterRow(
      row({
        id: 4,
        status: '已复核',
        检测值: '7.4',
        标准上限: '9.0',
        检测结论: '达标',
        复核人: '王复核',
        复核意见: '同意',
      }),
    )
    assert.equal(normalized.status, '已复核')
    assert.equal(normalized['检测结论'], '达标')
    assert.equal(normalized['复核意见'], '同意')
    assert.equal(normalized.pending, false)
  })

  it('缺所属单位的更老数据按兜底单位补齐，保证跨单位校验有依据', () => {
    const normalized = normalizeWaterRow(
      row({ id: 5, 所属单位: '' as string }),
      undefined,
      '市水文监测中心',
    )
    assert.equal(normalized['所属单位'], '市水文监测中心')
  })
})

describe('正常调用链：采样 → 检测 → 出报告 → 复核', () => {
  it('检测员开始检测、出超标报告，进入待复核待办', () => {
    let rows = [row({ id: 1 })]
    rows = act(rows, 1, { action: '开始检测', expectedVersion: 1 }, centerTester).rows
    assert.equal(rows[0].status, '检测中')

    const issued = act(
      rows,
      1,
      { action: '出具报告', payload: { 检测值: '0.32', 标准上限: '0.20' }, expectedVersion: 2 },
      centerTester,
    )
    assert.equal(issued.result.ok, true)
    assert.equal(issued.rows[0].status, '待复核')
    assert.equal(issued.rows[0]['检测结论'], '超标')
    assert.equal(issued.rows[0].pending, true)
    assert.equal(issued.rows[0][VERSION_FIELD], 3)
  })

  it('复核员通过后落库复核人/意见/时间，状态变已复核、退出待办', () => {
    let rows = normalizeWaterRows([
      row({ id: 1, status: '待复核', 检测值: '0.1', 标准上限: '0.2', 检测结论: '达标' }),
    ])
    const done = act(
      rows,
      1,
      { action: '复核通过', payload: { 复核意见: '数据合理' }, expectedVersion: 1 },
      centerReviewer,
    )
    assert.equal(done.result.ok, true)
    assert.equal(done.rows[0].status, '已复核')
    assert.equal(done.rows[0]['复核人'], '王复核')
    assert.equal(done.rows[0]['复核意见'], '数据合理')
    assert.equal(done.rows[0].pending, false)
  })

  it('不能从检测中直接跳到已复核（旧的共同根因被状态机拦住）', () => {
    const rows = [row({ id: 1, status: '检测中' })]
    const rejected = act(
      rows,
      1,
      { action: '复核通过', expectedVersion: 1 },
      centerReviewer,
    )
    assert.equal(rejected.result.ok, false)
    assert.match(rejected.result.message, /前置状态/)
    assert.equal(rows[0].status, '检测中')
  })

  it('检测值/上限不是数字时拒绝出报告，不产生结论、不进待办', () => {
    const rows = [row({ id: 1, status: '检测中' })]
    const rejected = act(
      rows,
      1,
      { action: '出具报告', payload: { 检测值: 'abc', 标准上限: '0.2' }, expectedVersion: 1 },
      centerTester,
    )
    assert.equal(rejected.result.ok, false)
    assert.equal(rejected.rows, rows)
  })
})

describe('复核权限：复核员/主管可复核，检测员不可', () => {
  const rows = normalizeWaterRows([
    row({ id: 1, status: '待复核', 检测值: '0.1', 标准上限: '0.2', 检测结论: '达标' }),
  ])

  it('检测员没有复核动作，强行提交被拒', () => {
    assert.deepEqual(availableActions(rows[0], centerTester), [])
    const rejected = act(
      rows,
      1,
      { action: '复核通过', expectedVersion: 1 },
      centerTester,
    )
    assert.equal(rejected.result.ok, false)
    assert.match(rejected.result.message, /无权/)
  })

  it('复核员与主管都能复核', () => {
    assert.deepEqual(availableActions(rows[0], centerReviewer), ['复核通过', '复核退回'])
    assert.deepEqual(availableActions(rows[0], centerBoss), ['复核通过', '复核退回'])
  })
})

describe('跨单位操作拒绝', () => {
  const rows = normalizeWaterRows([
    row({ id: 1, 所属单位: '市水文监测中心', status: '待复核', 检测值: '0.1', 标准上限: '0.2', 检测结论: '达标' }),
    row({ id: 2, 所属单位: '江北分局', status: '检测中' }),
  ])

  it('江北复核员看不到、也不能复核市中心的报告', () => {
    assert.deepEqual(availableActions(rows[0], northReviewer), [])
    const rejected = act(
      rows,
      1,
      { action: '复核通过', expectedVersion: 1 },
      northReviewer,
    )
    assert.equal(rejected.result.ok, false)
    assert.match(rejected.result.message, /跨单位/)
  })

  it('市中心检测员不能动江北分局的检测', () => {
    const rejected = act(
      rows,
      2,
      { action: '出具报告', payload: { 检测值: '1', 标准上限: '2' }, expectedVersion: 1 },
      centerTester,
    )
    assert.equal(rejected.result.ok, false)
    assert.match(rejected.result.message, /跨单位/)
  })
})

describe('复核退回与再次提交', () => {
  it('退回后复核字段清空，状态为退回、异常置位，检测结论作为报告事实保留', () => {
    const rows = normalizeWaterRows([
      row({
        id: 1,
        status: '待复核',
        检测值: '0.32',
        标准上限: '0.20',
        检测结论: '超标',
      }),
    ])
    const backed = act(
      rows,
      1,
      { action: '复核退回', payload: { 复核意见: '采样存疑' }, expectedVersion: 1 },
      centerReviewer,
    )
    assert.equal(backed.result.ok, true)
    assert.equal(backed.rows[0].status, '退回')
    assert.equal(backed.rows[0]['复核人'], undefined)
    assert.equal(backed.rows[0]['复核意见'], undefined)
    assert.equal(backed.rows[0]['检测结论'], '超标')
    assert.equal(backed.rows[0].abnormal, true)
  })

  it('再次提交沿用已有检测值与结论，不允许手工塞结论', () => {
    const rows = normalizeWaterRows([
      row({
        id: 1,
        status: '退回',
        检测值: '0.32',
        标准上限: '0.20',
        检测结论: '超标',
        [VERSION_FIELD]: 2,
      }),
    ])
    const resubmitted = act(
      rows,
      1,
      {
        action: '重新提交',
        // 伪造结论不会被采信
        payload: { 检测值: '0.32', 标准上限: '0.20', 复核意见: 'x' } as never,
        expectedVersion: 2,
      },
      centerTester,
    )
    assert.equal(resubmitted.result.ok, true)
    assert.equal(resubmitted.rows[0].status, '待复核')
    assert.equal(resubmitted.rows[0]['检测结论'], '超标')
    assert.equal(resubmitted.rows[0]['复核意见'], undefined)
  })

  it('重新检测改了检测值，结论按新值重算；复核员无权重新提交', () => {
    const rows = normalizeWaterRows([
      row({
        id: 1,
        status: '退回',
        检测值: '0.32',
        标准上限: '0.20',
        检测结论: '超标',
        [VERSION_FIELD]: 2,
      }),
    ])
    const resubmitted = act(
      rows,
      1,
      { action: '重新提交', payload: { 检测值: '0.10', 标准上限: '0.20' }, expectedVersion: 2 },
      northTester,
    )
    // 这条是市中心的报告：江北检测员同样跨单位被拒
    assert.equal(resubmitted.result.ok, false)

    const own = act(
      rows,
      1,
      { action: '重新提交', payload: { 检测值: '0.10', 标准上限: '0.20' }, expectedVersion: 2 },
      centerTester,
    )
    assert.equal(own.result.ok, true)
    assert.equal(own.rows[0]['检测结论'], '达标')
    assert.equal(own.rows[0].abnormal, false)

    const reviewerTry = act(
      own.rows,
      1,
      { action: '重新提交', payload: {}, expectedVersion: 3 },
      centerReviewer,
    )
    assert.equal(reviewerTry.result.ok, false)
  })
})

describe('并发提交：只接受先落库结论', () => {
  it('第二个复核人版本号过期，提交落败且中间字段被清空', () => {
    const rows = normalizeWaterRows([
      row({
        id: 1,
        status: '待复核',
        检测值: '0.32',
        标准上限: '0.20',
        检测结论: '超标',
      }),
    ])
    // 复核人 A 先落库（版本 1 → 2）
    const first = act(
      rows,
      1,
      { action: '复核通过', payload: { 复核意见: 'A 通过' }, expectedVersion: 1 },
      centerReviewer,
    )
    assert.equal(first.result.ok, true)

    // 复核人 B 打开面板时还停在版本 1，先暂存了意见，再用旧版本号提交
    const staged = stageInterim(
      first.rows,
      1,
      { _pendingReviewer: 'B', _pendingComment: 'B 也想通过' },
      centerReviewer,
    )
    assert.equal(staged.rows[0]._pendingComment, 'B 也想通过')

    const second = act(
      staged.rows,
      1,
      { action: '复核通过', payload: { 复核意见: 'B 通过' }, expectedVersion: 1 },
      centerBoss,
    )
    assert.equal(second.result.ok, false)
    assert.match(second.result.message, /已被其他人先提交/)
    // 先落库的是 A 的结论，B 的暂存全部清空
    assert.equal(second.rows[0]['复核人'], '王复核')
    assert.equal(second.rows[0]['复核意见'], 'A 通过')
    for (const field of INTERIM_FIELDS) {
      assert.equal(second.rows[0][field], undefined, `${field} 应被清空`)
    }
    assert.equal(second.rows[0].status, '已复核')
  })

  it('并发落败不会推进状态或改动版本号以外的正式字段', () => {
    const rows = normalizeWaterRows([
      row({ id: 1, status: '待复核', 检测值: '0.1', 标准上限: '0.2', 检测结论: '达标' }),
    ])
    const first = act(
      rows,
      1,
      { action: '复核退回', expectedVersion: 1 },
      centerReviewer,
    )
    const second = act(
      first.rows,
      1,
      { action: '复核通过', expectedVersion: 1 },
      centerBoss,
    )
    assert.equal(second.result.ok, false)
    assert.equal(second.rows[0].status, '退回')
    assert.equal(second.rows[0]['检测结论'], '达标')
  })
})

describe('另一个检测入口：登记即写待复核', () => {
  it('登记的超标报告直接进待复核队列，结论服务端判定', () => {
    const { rows: nextRows, result } = createWaterReport(
      [],
      {
        报告编号: 'WATE-0099',
        采样站点: '新断面',
        采样时间: '2026-10-04',
        检测项目: '总磷',
        检测值: '0.5',
        标准上限: '0.2',
      },
      northTester,
    )
    assert.equal(result.ok, true)
    assert.equal(nextRows[0].status, '待复核')
    assert.equal(nextRows[0]['检测结论'], '超标')
    assert.equal(nextRows[0]['所属单位'], '江北分局')
    assert.equal(nextRows[0].pending, true)
  })

  it('登记入口校验：编号/站点/项目必填，数值非法拒绝', () => {
    const missing = createWaterReport(
      [],
      { 报告编号: '', 采样站点: 'x', 采样时间: '', 检测项目: 'y', 检测值: '1', 标准上限: '2' },
      northTester,
    )
    assert.equal(missing.result.ok, false)

    const badNumber = createWaterReport(
      [],
      { 报告编号: 'W1', 采样站点: 'x', 采样时间: '', 检测项目: 'y', 检测值: '高', 标准上限: '2' },
      northTester,
    )
    assert.equal(badNumber.result.ok, false)
  })

  it('报告编号不能重复', () => {
    const existing = [row({ id: 1, 报告编号: 'WATE-0001' })]
    const dup = createWaterReport(
      existing,
      { 报告编号: 'WATE-0001', 采样站点: 'x', 采样时间: '', 检测项目: 'y', 检测值: '1', 标准上限: '2' },
      centerTester,
    )
    assert.equal(dup.result.ok, false)
  })
})
