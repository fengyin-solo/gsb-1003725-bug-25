import { defineStore } from 'pinia'

import type { WaterOperator, WaterRole } from '@/data/types'

// 演示用身份：复核权只给复核员/主管；检测员只能发起检测与出报告，且一律限本单位。
export const SESSION_ACCOUNTS: WaterOperator[] = [
  { name: '陈水清', role: '主管', unit: '市水文监测中心' },
  { name: '周采样', role: '检测员', unit: '市水文监测中心' },
  { name: '王复核', role: '复核员', unit: '市水文监测中心' },
  { name: '林测定', role: '检测员', unit: '江北分局' },
  { name: '赵审校', role: '复核员', unit: '江北分局' },
]

export const useSessionStore = defineStore('session', {
  state: () => {
    const current = SESSION_ACCOUNTS[0]
    return {
      operator: current.name,
      role: current.role as WaterRole,
      unit: current.unit,
      shiftLabel: '白班 08:00-20:00',
      scope: '水文监测站网管理系统',
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
    currentOperator(state): WaterOperator {
      return { name: state.operator, role: state.role, unit: state.unit }
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchAccount(account: WaterOperator) {
      this.operator = account.name
      this.role = account.role
      this.unit = account.unit
    },
  },
})
