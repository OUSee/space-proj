<script
    setup
    lang="ts"
>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

onMounted(() => {
    if (typeof window !== 'undefined') {
        const router = useRouter();

        // Redirect to phone page - all calculations run locally
        router.replace('/phone');
    }
});
</script>

<template>
    <ClientOnly>
        <div style="padding: 20px; color: white; text-align: center; margin-top: 60px;">
            <h1>📱 Navigation Unit</h1>
            <p>Redirecting to local navigation interface...</p>
        </div>
    </ClientOnly>
</template>

<style scoped>
h1 {
    color: #0f0;
}

p {
    color: #aaa;
}
</style>
