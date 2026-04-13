<script
  setup
  lang="ts"
>
import { onMounted } from 'vue';
import { useNavStore } from '~/composables/useNavStore';

const router = useRouter();
const route = useRoute();
const isMobileDevice = ref(false);
const hasGyro = ref(false);

const init = typeof window !== 'undefined' ? useNavStore().init : () => { };

onMounted(async () => {
  if (typeof window !== 'undefined') {
    // 1. Детект мобильного
    const ua = navigator.userAgent.toLowerCase();
    isMobileDevice.value = /iphone|ipad|ipod|android|mobile/.test(ua);

    // 2. Детект гироскопа с TS-safe permission
    if ('DeviceMotionEvent' in window) {
      const checkGyro = async () => {
        // Type guard: check if requestPermission exists
        if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
          try {
            const permission = await (DeviceMotionEvent as any).requestPermission();
            if (permission === 'granted') {
              // Test event для gyro (rotationRate)
              window.addEventListener('devicemotion', (event: DeviceMotionEvent) => {
                hasGyro.value = !!(event.rotationRate?.alpha || event.rotationRate?.beta || event.rotationRate?.gamma);
              }, { once: true });
            }
          } catch (e) {
            console.warn('Gyro permission denied');
          }
        } else {
          // Non-iOS: просто check support (Android/PC)
          hasGyro.value = true;
        }
      };

      // Запрос после user gesture (клик/tap) для iOS
      const requestOnInteract = () => {
        checkGyro();
        document.removeEventListener('click', requestOnInteract);
        document.removeEventListener('touchstart', requestOnInteract);
      };
      document.addEventListener('click', requestOnInteract);
      document.addEventListener('touchstart', requestOnInteract);
    }

    // 3. Редирект (delay для gyro check)
    setTimeout(async () => {
      if (isMobileDevice.value && hasGyro.value && route.path !== '/phone') {
        await router.replace('/phone');
      } else {
        init();
      }
    }, 500);
  }
});
</script>

<template>
  <ClientOnly>
    <div id="app">
      <h1>Indoor Navigation AEKF Demo</h1>
      <SensorPanel />
      <NavVisualizer />
      <MetricsHUD />
    </div>
  </ClientOnly>
</template>

<style>
#app {
  font-family: monospace;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>