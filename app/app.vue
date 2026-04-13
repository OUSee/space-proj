<script
  setup
  lang="ts"
>
import { onMounted } from 'vue';
import { useNavStore } from '~/composables/useNavStore';

const store = useNavStore();
const isMobileDevice = ref(false);

onMounted(async () => {
  if (typeof window !== 'undefined') {
    // Detect if mobile device
    const ua = navigator.userAgent.toLowerCase();
    isMobileDevice.value = /iphone|ipad|ipod|android|mobile/.test(ua);

    // Set device mode
    if (isMobileDevice.value) {
      store.deviceMode = 'phone';
    } else {
      store.deviceMode = 'pc';
      store.init();
    }
  }
});
</script>

<template>
  <ClientOnly fallback="Loading 3D + WebRTC...">
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