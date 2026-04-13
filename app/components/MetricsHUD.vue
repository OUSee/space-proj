<script
    setup
    lang="ts"
>
import { storeToRefs } from 'pinia';
import { useNavStore } from '~/composables/useNavStore';

const store = useNavStore();
const { rmse, chi2, fps } = storeToRefs(store);

</script>

<template>
    <div>RMSE: {{ rmse }} | Chi2: {{ chi2 }} | FPS: {{ fps }}</div>
</template>


<style
    scoped
    lang='scss'
></style>