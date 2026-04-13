<script
    setup
    lang="ts"
>
import { ref } from 'vue';

const status = ref('Phone runs calculations locally - no PC connection needed');
</script>

<template>
    <div>
        <h3>📱 Navigation Unit (Local Processing)</h3>
        <div style="margin-top: 20px; padding: 15px; background: #0a2a0a; border: 1px solid #0f0;">
            <strong style="color: #0f0;">Status:</strong> {{ status }}
        </div>
        <p>All sensor calculations now run directly on the phone. No PC connection required.</p>
    </div>
</template>

<style
    scoped
    lang="scss"
>
* {
    color: white;
}

h3 {
    color: #0f0;
}

p {
    color: #aaa;
    font-size: 12px;
}
</style>