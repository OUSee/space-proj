<script
    setup
    lang="ts"
>
import { onMounted } from 'vue';
import { useNavStore } from '~/composables/useNavStore';

const store = useNavStore();

onMounted(() => {
    if (typeof window !== 'undefined') {
        const router = useRouter();

        // Detect mobile and redirect to phone page
        const ua = navigator.userAgent.toLowerCase();
        const isMobileDevice = /iphone|ipad|ipod|android|mobile/.test(ua);

        if (isMobileDevice) {
            router.replace('/phone');
        }
    }
});
</script>

<template>
    <ClientOnly>
        <div
            v-if="store.deviceMode === 'pc'"
            style="padding: 20px;"
        >
            <h1>🖥️ PC Navigation Center</h1>
            <SensorPanel />
            <NavVisualizer />
            <MetricsHUD />
        </div>
    </ClientOnly>
</template>

<style scoped>
h1 {
    color: white;
}
</style>
