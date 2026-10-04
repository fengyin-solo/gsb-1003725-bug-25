<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质检测管理</h2>
        <p class="page-desc">维护水质检测报告，围绕报告编号、采样站点、采样时间、检测项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水质检测报告</button>
        <button class="btn" type="button" @click="exportRows">导出水质检测清单</button>
      </div>
    </header>

    <WaterqualityTabs active="list" />

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="applyFilters">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="draftFilters[field]" :placeholder="`按${field}检索`" />
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
          <td v-for="column in columns" :key="column">{{ displayValue(row[column]) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button v-if="row.status === '已采样'" class="link" type="button" @click="start(row)">
              开始检测
            </button>
            <button v-if="row.status === '检测中'" class="link" type="button" @click="openDetect(row)">
              出具报告
            </button>
            <button v-if="row.status === '已退回'" class="link" type="button" @click="openDetect(row)">
              重新提交
            </button>
            <button v-if="row.status === '待复核'" class="link" type="button" @click="goReview">
              前往复核
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水质检测数据，可先登记水质检测报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条水质检测记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="createVisible" class="dialog-mask" @click.self="createVisible = false">
      <div class="dialog">
        <h3>登记水质检测报告</h3>
        <form class="dialog-form" @submit.prevent="submitCreate">
          <label>
            采样站点
            <input v-model="createForm.采样站点" placeholder="如：城东取水口" />
          </label>
          <label>
            采样时间
            <input v-model="createForm.采样时间" placeholder="如：2026-10-04 09:00" />
          </label>
          <label>
            检测项目
            <input v-model="createForm.检测项目" placeholder="如：氨氮" />
          </label>
          <label>
            标准上限
            <input v-model="createForm.标准上限" placeholder="数值，如：1.0" />
          </label>
          <div class="dialog-actions">
            <button class="btn ghost" type="button" @click="createVisible = false">取消</button>
            <button class="btn primary" type="submit">登记</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="detectTarget" class="dialog-mask" @click.self="closeDetect">
      <div class="dialog">
        <h3>出具检测报告 · {{ detectTarget.报告编号 }}</h3>
        <form class="dialog-form" @submit.prevent="submitDetect">
          <p class="dialog-meta">
            检测项目：{{ detectTarget.检测项目 }}　标准上限：{{ detectTarget.标准上限 }}
          </p>
          <label>
            检测值
            <input v-model="detectValue" placeholder="填写本次检测数值" />
          </label>
          <p v-if="detectPreview" class="dialog-meta">结论预览：{{ detectPreview }}（提交后进入待复核）</p>
          <div class="dialog-actions">
            <button class="btn ghost" type="button" @click="closeDetect">取消</button>
            <button class="btn primary" type="submit">提交检测结果</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { downloadEntries, filterRows, moduleMeta } from '@/api/local-service'
import {
  displayValue,
  listReports,
  previewConclusion,
  registerSampling,
  startTesting,
  submitDetection,
} from '@/api/waterquality-service'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow } from '@/data/types'

import WaterqualityTabs from './Tabs.vue'

const meta = moduleMeta('waterquality')
const columns = ["报告编号", "采样站点", "采样时间", "检测项目", "检测值", "标准上限", "结论", "检测人", "检测单位"]
const filterFields = columns.slice(0, 3)

const router = useRouter()
const store = useSessionStore()

const all = ref<EntryRow[]>([])
const appliedFilters = ref<Record<string, string>>({})
const draftFilters = reactive<Record<string, string>>({})
const message = ref('')
const messageOk = ref(false)

const createVisible = ref(false)
const createForm = reactive({ 采样站点: '', 采样时间: '', 检测项目: '', 标准上限: '' })

const detectTarget = ref<EntryRow | null>(null)
const detectValue = ref('')
const detectPreview = computed(() =>
  detectTarget.value ? previewConclusion(detectValue.value, detectTarget.value.标准上限) : null,
)

const rows = computed(() => filterRows(all.value, appliedFilters.value))
const stats = computed(() => {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return [
    { label: '本月检测次数', value: all.value.filter((row) => String(row.采样时间 ?? '').startsWith(month)).length },
    { label: '超标报告数', value: all.value.filter((row) => row.结论 === '超标').length },
    { label: '待复核报告', value: all.value.filter((row) => row.status === '待复核').length },
  ]
})
const statusSummary = computed(() =>
  meta.statuses.map((status) => ({
    status,
    count: all.value.filter((row) => String(row.status) === status).length,
  })),
)

function identity() {
  return { operator: store.operator, role: store.role, unit: store.unit }
}

function handle(result: ActionResult) {
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    reload()
  }
}

function applyFilters() {
  appliedFilters.value = { ...draftFilters }
}

function resetFilters() {
  for (const key of Object.keys(draftFilters)) {
    delete draftFilters[key]
  }
  appliedFilters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  createVisible.value = true
}

function submitCreate() {
  const result = registerSampling({ ...createForm }, identity())
  if (result.ok) {
    createVisible.value = false
    createForm.采样站点 = ''
    createForm.采样时间 = ''
    createForm.检测项目 = ''
    createForm.标准上限 = ''
  }
  handle(result)
}

function start(row: EntryRow) {
  handle(startTesting(Number(row.id), identity()))
}

function openDetect(row: EntryRow) {
  detectTarget.value = row
  detectValue.value = ''
}

function closeDetect() {
  detectTarget.value = null
}

function submitDetect() {
  if (!detectTarget.value) {
    return
  }
  const result = submitDetection(Number(detectTarget.value.id), { 检测值: detectValue.value }, identity())
  if (result.ok) {
    closeDetect()
  }
  handle(result)
}

function openDetail(row: EntryRow) {
  router.push(`/waterquality/report/${row.id}`)
}

function goReview() {
  router.push('/waterquality/review')
}

function reload() {
  all.value = listReports()
}

onMounted(reload)
</script>
