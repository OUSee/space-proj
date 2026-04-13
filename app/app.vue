<script
  setup
  lang="ts"
>
import { onMounted, ref } from 'vue';

const appReady = ref(false);

onMounted(() => {
  appReady.value = true;
});
</script>

<template>
  <ClientOnly
    v-if="appReady"
    fallback="Loading Navigation Unit..."
  >
    <NuxtPage />
  </ClientOnly>
</template>

<style>
body {
  font-family: monospace;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background-color: #222222;
}
</style>