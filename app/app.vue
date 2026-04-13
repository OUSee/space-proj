<script
  setup
  lang="ts"
>
import { onMounted } from 'vue';
import { useNavStore } from '~/composables/useNavStore';

const init = typeof window !== 'undefined' ? useNavStore().init : () => { };

onMounted(init);
</script>

<template>
  <div id="app">
    <h1>Indoor Navigation AEKF Demo</h1>
    <ClientOnly>
      <SensorPanel />
      <NavVisualizer />
      <MetricsHUD />
    </ClientOnly>
  </div>
</template>

<style>
#app {
  font-family: monospace;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>