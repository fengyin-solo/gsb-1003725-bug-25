<template>
  <nav class="tab-bar">
    <RouterLink to="/waterquality" class="tab-item" :class="{ 'tab-active': active === 'list' }">
      检测列表
    </RouterLink>
    <RouterLink to="/waterquality/review" class="tab-item" :class="{ 'tab-active': active === 'review' }">
      复核面板
    </RouterLink>
  </nav>
</template>

<script setup lang="ts">
defineProps<{ active: 'list' | 'review' }>()
</script>
