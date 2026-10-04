<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质复核面板</h2>
        <p class="page-desc">
          复核员与管理员有权复核，检测人不能复核本人出具的报告，跨单位操作会被拒绝；
          复核通过即办结，退回则清空检测结论等中间字段。
        </p>
      </div>
    </header>

    <WaterqualityTabs active="review" />

    <div class="identity-bar">
      <label>
        操作人
        <input :value="store.operator" @input="setOperator" />
      </label>
      <label>
        角色
        <select :value="store.role" @change="setRole">
          <option v-for="role in roleOptions" :key="role" :value="role">{{ role }}</option>
        </select>
      </label>
      <label>
        检测单位
        <select :value="store.unit" @change="setUnit">
          <option v-for="unit in unitOptions" :key="unit" :value="unit">{{ unit }}</option>
        </select>
      </label>
      <span class="page-desc">待办：{{ pendingRows.length }} 条待复核</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in reviewColumns" :key="column">{{ column }}</th>
          <th>复核动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in pendingRows" :key="String(row.id)">
          <td v-for="column in reviewColumns" :key="column">{{ displayValue(row[column]) }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="pass(row)">复核通过</button>
            <button class="link" type="button" @click="openReject(row)">退回</button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!pendingRows.length">
          <td :colspan="reviewColumns.length + 1" class="empty-state">没有待复核的水质报告</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">复核记录</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in historyColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in historyRows" :key="String(row.id)">
          <td v-for="column in historyColumns" :key="column">{{ displayValue(row[column]) }}</td>
        </tr>
        <tr v-if="!historyRows.length">
          <td :colspan="historyColumns.length" class="empty-state">还没有复核记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>待复核 {{ pendingRows.length }} 条 · 已处理 {{ historyRows.length }} 条</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="rejectTarget" class="dialog-mask" @click.self="rejectTarget = null">
      <div class="dialog">
        <h3>退回报告 · {{ rejectTarget.报告编号 }}</h3>
        <form class="dialog-form" @submit.prevent="submitReject">
          <label>
            退回原因
            <textarea v-model="rejectReason" rows="3" placeholder="必填，退回后检测结论等中间字段将被清空"></textarea>
          </label>
          <div class="dialog-actions">
            <button class="btn ghost" type="button" @click="rejectTarget = null">取消</button>
            <button class="btn primary" type="submit">确认退回</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  ROLE_OPTIONS,
  UNIT_OPTIONS,
  displayValue,
  listReports,
  submitReview,
} from '@/api/waterquality-service'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow } from '@/data/types'

import WaterqualityTabs from './Tabs.vue'

const reviewColumns = ["报告编号", "采样站点", "检测项目", "检测值", "标准上限", "结论", "检测人", "检测单位", "出具时间"]
const historyColumns = ["报告编号", "采样站点", "检测项目", "结论", "复核人", "复核结论", "复核时间", "退回原因"]
const roleOptions = ROLE_OPTIONS
const unitOptions = UNIT_OPTIONS

const router = useRouter()
const store = useSessionStore()

const all = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(false)
const rejectTarget = ref<EntryRow | null>(null)
const rejectReason = ref('')

const pendingRows = computed(() => all.value.filter((row) => row.status === '待复核'))
const historyRows = computed(() =>
  all.value.filter((row) => row.status === '已复核' || row.status === '已退回'),
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

function setOperator(event: Event) {
  store.setIdentity({ operator: (event.target as HTMLInputElement).value })
}

function setRole(event: Event) {
  store.setIdentity({ role: (event.target as HTMLSelectElement).value })
}

function setUnit(event: Event) {
  store.setIdentity({ unit: (event.target as HTMLSelectElement).value })
}

function pass(row: EntryRow) {
  handle(submitReview(Number(row.id), { 复核结论: '通过' }, identity()))
}

function openReject(row: EntryRow) {
  rejectTarget.value = row
  rejectReason.value = ''
}

function submitReject() {
  if (!rejectTarget.value) {
    return
  }
  const result = submitReview(
    Number(rejectTarget.value.id),
    { 复核结论: '退回', 退回原因: rejectReason.value },
    identity(),
  )
  if (result.ok) {
    rejectTarget.value = null
  }
  handle(result)
}

function openDetail(row: EntryRow) {
  router.push(`/waterquality/report/${row.id}`)
}

function reload() {
  all.value = listReports()
}

onMounted(reload)
</script>
