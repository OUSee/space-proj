<script
  setup
  lang="ts"
>
import { useNavStore } from '~/composables/useNavStore';

const { init } = useNavStore();
onMounted(init);
</script>

<template>
  <div id="app">
    <h1>Indoor Navigation AEKF Demo</h1>
    <SensorPanel />
    <NavVisualizer />
    <MetricsHUD />
  </div>
</template>

<style>
#app {
  font-family: monospace;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>