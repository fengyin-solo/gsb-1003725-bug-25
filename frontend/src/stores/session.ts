import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    // 角色决定能走哪些流转：检测员/管理员可检测，复核员/管理员可复核。
    role: '管理员',
    // 检测单位：有单位的报告拒绝跨单位操作。
    unit: '第一检测中心',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setIdentity(patch: { operator?: string; role?: string; unit?: string }) {
      if (patch.operator !== undefined) {
        this.operator = patch.operator
      }
      if (patch.role !== undefined) {
        this.role = patch.role
      }
      if (patch.unit !== undefined) {
        this.unit = patch.unit
      }
    },
  },
})
