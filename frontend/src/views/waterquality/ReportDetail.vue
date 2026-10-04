<template>
  <section class="page" data-module="waterquality">
    <header class="page-head">
      <div>
        <h2>水质报告详情</h2>
        <p class="page-desc">报告 {{ report ? report.报告编号 : id }} 的采样、检测与复核全过程。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="back">返回检测列表</button>
      </div>
    </header>

    <WaterqualityTabs active="list" />

    <template v-if="report">
      <div class="flow-steps">
        <span
          v-for="step in steps"
          :key="step"
          class="flow-step"
          :class="{ active: step === report.status }"
        >
          {{ step }}
        </span>
      </div>

      <div class="detail-grid">
        <div v-for="field in detailFields" :key="field" class="detail-item">
          <span>{{ field }}</span>
          <strong>{{ displayValue(report[field]) }}</strong>
        </div>
      </div>

      <template v-if="canDetect">
        <h3 class="section-title">提交检测结果</h3>
        <form class="filter-bar" @submit.prevent="submitDetect">
          <label class="filter-item">
            <span>检测值（标准上限 {{ report.标准上限 }}）</span>
            <input v-model="detectValue" placeholder="填写本次检测数值" />
          </label>
          <button class="btn primary" type="submit">提交检测结果</button>
          <span v-if="detectPreview" class="dialog-meta">结论预览：{{ detectPreview }}，提交后进入待复核</span>
        </form>
      </template>

      <p v-if="report.status === '待复核'" class="page-desc">
        报告已出具，结论「{{ report.结论 }}」，等待复核；检测列表与复核面板看到的是同一份结论。
      </p>
      <p v-if="report.status === '已退回'" class="page-desc">
        报告被{{ displayValue(report.复核人) }}退回（{{ displayValue(report.退回原因) }}），检测结论已清空，请重新检测后提交。
      </p>
    </template>
    <p v-else class="empty-state">没有找到编号为 {{ id }} 的水质检测报告</p>

    <footer class="page-foot">
      <span>水质报告详情</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { displayValue, getReport, previewConclusion, submitDetection } from '@/api/waterquality-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

import WaterqualityTabs from './Tabs.vue'

const detailFields = [
  '报告编号',
  '采样站点',
  '采样时间',
  '检测项目',
  '检测值',
  '标准上限',
  '结论',
  '检测人',
  '检测单位',
  '出具时间',
  '复核人',
  '复核结论',
  '复核时间',
  '退回原因',
  '报告状态',
]

const route = useRoute()
const router = useRouter()
const store = useSessionStore()

const id = Number(route.params.id)
const report = ref<EntryRow | null>(null)
const detectValue = ref('')
const message = ref('')
const messageOk = ref(false)

const steps = computed(() => [
  '已采样',
  '检测中',
  '待复核',
  report.value?.status === '已退回' ? '已退回' : '已复核',
])
const canDetect = computed(
  () => report.value !== null && ['检测中', '已退回'].includes(String(report.value.status)),
)
const detectPreview = computed(() =>
  report.value ? previewConclusion(detectValue.value, report.value.标准上限) : null,
)

function submitDetect() {
  const result = submitDetection(
    id,
    { 检测值: detectValue.value },
    { operator: store.operator, role: store.role, unit: store.unit },
  )
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    detectValue.value = ''
    reload()
  }
}

function back() {
  router.push('/waterquality')
}

function reload() {
  report.value = getReport(id)
}

onMounted(reload)
</script>
