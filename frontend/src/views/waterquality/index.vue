<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质检测管理</h2>
        <p class="page-desc">采样 → 出报告 → 待复核 → 已复核；超标是检测结论而不是状态，结论由检测值与标准上限自动判定。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水质检测报告</button>
        <button class="btn" type="button" @click="exportRows">导出水质检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section v-if="canReview" class="todo-panel">
      <h3>复核待办（{{ store.unit }}，共 {{ todoRows.length }} 份待复核）</h3>
      <ul v-if="todoRows.length" class="todo-list">
        <li v-for="row in todoRows" :key="String(row.id)">
          {{ row['报告编号'] }} · {{ row['采样站点'] }} · {{ row['检测项目'] }} ·
          <span :class="row['检测结论'] === '超标' ? 'conclusion-bad' : 'conclusion-ok'">{{ row['检测结论'] }}</span>
          （检测值 {{ row['检测值'] }} / 上限 {{ row['标准上限'] }}，{{ row['检测人'] }}）
          <button class="link" type="button" @click="openReview(row)">去复核</button>
        </li>
      </ul>
      <p v-else class="page-desc">本单位暂无待复核报告。</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '检测结论'">
              <span :class="conclusionClass(row['检测结论'])">{{ row[column] ?? '—' }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td><span :class="statusTag(row.status)">{{ row.status }}</span></td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <template v-if="rowActions(row).length">
              <template v-for="action in rowActions(row)" :key="action">
                <button
                  v-if="action === '复核通过' || action === '复核退回'"
                  class="link"
                  type="button"
                  @click="openReview(row, action)"
                >
                  {{ action }}
                </button>
                <button
                  v-else-if="action === '出具报告' || action === '重新提交'"
                  class="link"
                  type="button"
                  @click="openIssue(row)"
                >
                  {{ action }}
                </button>
                <button v-else class="link" type="button" @click="doAction(row, action)">
                  {{ action }}
                </button>
              </template>
            </template>
            <span v-else-if="String(row['所属单位']) !== store.unit" class="page-desc">非本单位</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水质检测数据，可先登记水质检测报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水质检测记录 · 当前身份 {{ store.operator }}（{{ store.role }} / {{ store.unit }}）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 报告详情 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal-card">
        <h3 class="modal-title">水质报告详情 · {{ detailRow['报告编号'] }}</h3>
        <p class="modal-sub">采样站点、检测项目与超标结论以已落库数据为准。</p>
        <dl class="detail-grid">
          <template v-for="field in meta.fields" :key="field">
            <dt>{{ field }}</dt>
            <dd v-if="field === '检测结论'">
              <span :class="conclusionClass(detailRow[field])">{{ detailRow[field] ?? '—' }}</span>
            </dd>
            <dd v-else>{{ detailRow[field] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd><span :class="statusTag(detailRow.status)">{{ detailRow.status }}</span></dd>
        </dl>
        <div class="modal-actions">
          <button class="btn" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 出具报告 / 重新提交 -->
    <div v-if="issue" class="modal-mask" @click.self="issue = null">
      <div class="modal-card">
        <h3 class="modal-title">{{ issue.action }} · {{ issue.row['报告编号'] }}</h3>
        <p class="modal-sub">
          {{ issue.action === '重新提交' ? '再次提交只保留已有结论，改了检测值会重新判定，不能手工填写结论。' : '提交后进入待复核队列，结论由检测值与标准上限自动判定。' }}
        </p>
        <div class="form-grid">
          <label>
            <span>检测值</span>
            <input v-model="issue.value" placeholder="如 0.32" />
          </label>
          <label>
            <span>标准上限</span>
            <input v-model="issue.limit" placeholder="如 0.20" />
          </label>
          <label class="full">
            <span>结论预览（服务端判定）</span>
            <input :value="previewConclusion" disabled />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="issue = null">取消</button>
          <button class="btn primary" type="button" @click="submitIssue">提交并进入待复核</button>
        </div>
      </div>
    </div>

    <!-- 复核面板 -->
    <div v-if="review" class="modal-mask" @click.self="review = null">
      <div class="modal-card">
        <h3 class="modal-title">复核面板 · {{ review.row['报告编号'] }}</h3>
        <p class="modal-sub">
          仅复核员/主管可复核，且限本单位。版本号 {{ review.version }}：别人先提交后，本次提交将落败。
        </p>
        <dl class="detail-grid">
          <dt>采样站点</dt><dd>{{ review.row['采样站点'] }}</dd>
          <dt>检测项目</dt><dd>{{ review.row['检测项目'] }}</dd>
          <dt>检测值/上限</dt><dd>{{ review.row['检测值'] }} / {{ review.row['标准上限'] }}</dd>
          <dt>检测结论</dt>
          <dd><span :class="conclusionClass(review.row['检测结论'])">{{ review.row['检测结论'] }}</span></dd>
          <dt>检测人</dt><dd>{{ review.row['检测人'] }}</dd>
        </dl>
        <div class="form-grid">
          <label class="full">
            <span>复核意见</span>
            <textarea v-model="review.comment" rows="3" placeholder="退回时请填写原因；通过可留空"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="review = null">取消</button>
          <button class="btn" type="button" @click="submitReview('复核退回')">复核退回</button>
          <button class="btn primary" type="button" @click="submitReview('复核通过')">复核通过</button>
        </div>
      </div>
    </div>

    <!-- 另一个检测入口：登记并直接出报告 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal-card">
        <h3 class="modal-title">登记水质检测报告</h3>
        <p class="modal-sub">采样后直接录入检测结果，与列表「出具报告」走同一落库入口，登记成功即写入待复核待办。</p>
        <div class="form-grid">
          <label>
            <span>报告编号</span>
            <input v-model="createForm.报告编号" placeholder="如 WATE-0006" />
          </label>
          <label>
            <span>采样站点</span>
            <input v-model="createForm.采样站点" placeholder="如 清流河大桥断面" />
          </label>
          <label>
            <span>采样时间</span>
            <input v-model="createForm.采样时间" placeholder="2026-10-04 09:00" />
          </label>
          <label>
            <span>检测项目</span>
            <input v-model="createForm.检测项目" placeholder="如 氨氮" />
          </label>
          <label>
            <span>检测值</span>
            <input v-model="createForm.检测值" placeholder="如 0.8" />
          </label>
          <label>
            <span>标准上限</span>
            <input v-model="createForm.标准上限" placeholder="如 1.0" />
          </label>
          <label class="full">
            <span>结论预览（服务端判定）</span>
            <input :value="createPreview" disabled />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">登记并提交复核</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listWaterReports,
  moduleMeta,
  registerWaterReport,
  submitWaterAction,
  waterReportActions,
} from '@/api/local-service'
import { deriveConclusion, VERSION_FIELD } from '@/api/water-quality'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, WaterAction } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('waterquality')
const columns = [
  '报告编号',
  '所属单位',
  '采样站点',
  '采样时间',
  '检测项目',
  '检测值',
  '标准上限',
  '检测结论',
  '检测人',
  '复核人',
  '复核时间',
  '复核意见',
]
const filterFields = ['报告编号', '采样站点', '检测项目']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const detailRow = ref<EntryRow | null>(null)
const issue = ref<{ row: EntryRow; action: WaterAction; value: string; limit: string } | null>(null)
const review = ref<{ row: EntryRow; version: number; comment: string } | null>(null)
const creating = ref(false)
const createForm = reactive({
  报告编号: '',
  采样站点: '',
  采样时间: '',
  检测项目: '',
  检测值: '',
  标准上限: '',
})

const canReview = computed(() => store.role === '复核员' || store.role === '主管')

const todoRows = computed(() =>
  rows.value.filter(
    (row) => row.status === '待复核' && String(row['所属单位']) === store.unit,
  ),
)

const stats = computed(() => [
  { label: '本月检测次数', value: rows.value.length },
  { label: '待复核报告数', value: todoRows.value.length },
  {
    label: '超标报告数',
    value: rows.value.filter((row) => row['检测结论'] === '超标').length,
  },
  {
    label: '退回报告数',
    value: rows.value.filter((row) => row.status === '退回').length,
  },
])

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const previewConclusion = computed(() =>
  issue.value ? deriveConclusion(issue.value.value, issue.value.limit) ?? '待填写数字' : '',
)
const createPreview = computed(() =>
  deriveConclusion(createForm.检测值, createForm.标准上限) ?? '待填写数字',
)

function rowActions(row: EntryRow): WaterAction[] {
  return waterReportActions(row, store.currentOperator)
}

function conclusionClass(value: unknown): string {
  if (value === '超标') return 'conclusion-bad'
  if (value === '达标') return 'conclusion-ok'
  return ''
}

function statusTag(status: string): string {
  if (status === '待复核') return 'tag tag-pending'
  if (status === '已复核') return 'tag tag-done'
  if (status === '退回') return 'tag tag-back'
  if (status === '检测中') return 'tag tag-testing'
  return 'tag tag-sampled'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  Object.assign(createForm, {
    报告编号: '',
    采样站点: '',
    采样时间: '',
    检测项目: '',
    检测值: '',
    标准上限: '',
  })
  errorMessage.value = ''
  creating.value = true
}

function openDetail(row: EntryRow) {
  detailRow.value = row
}

function openIssue(row: EntryRow) {
  const action: WaterAction = row.status === '退回' ? '重新提交' : '出具报告'
  issue.value = {
    row,
    action,
    value: String(row['检测值'] ?? ''),
    limit: String(row['标准上限'] ?? ''),
  }
  errorMessage.value = ''
}

function openReview(row: EntryRow, preset?: WaterAction) {
  review.value = {
    row,
    version: Number(row[VERSION_FIELD] ?? 0),
    comment: preset === '复核退回' ? String(row['_pendingComment'] ?? '') : '',
  }
  errorMessage.value = ''
}

function doAction(row: EntryRow, action: WaterAction) {
  errorMessage.value = ''
  const result = submitWaterAction(
    Number(row.id),
    { action, expectedVersion: Number(row[VERSION_FIELD] ?? 0) },
    store.currentOperator,
  )
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function submitIssue() {
  if (!issue.value) return
  const { row, action, value, limit } = issue.value
  const result = submitWaterAction(
    Number(row.id),
    {
      action,
      payload: { 检测值: value, 标准上限: limit },
      expectedVersion: Number(row[VERSION_FIELD] ?? 0),
    },
    store.currentOperator,
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  issue.value = null
  reload()
}

function submitReview(action: WaterAction) {
  if (!review.value) return
  const { row, version, comment } = review.value
  const result = submitWaterAction(
    Number(row.id),
    { action, payload: { 复核意见: comment }, expectedVersion: version },
    store.currentOperator,
  )
  if (!result.ok) {
    errorMessage.value = result.message
    review.value = null
    reload()
    return
  }
  review.value = null
  reload()
}

function submitCreate() {
  const result = registerWaterReport({ ...createForm }, store.currentOperator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  creating.value = false
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listWaterReports(filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水质检测列表读取失败'
  }
}

onMounted(reload)
</script>
