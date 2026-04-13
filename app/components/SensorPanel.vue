<script
    setup
    lang="ts"
>
import { ref } from 'vue';
import { useNavStore } from '~/composables/useNavStore';

const { connectPhone } = useNavStore();
const phoneId = ref('');
const status = ref('Disconnected');

const connect = async () => {
    try {
        await connectPhone(phoneId.value);
        status.value = 'Connected!';
    } catch (error) {
        status.value = 'Connection failed';
    }
};
</script>

<template>
    <div>
        <input
            style="background-color: grey;"
            v-model="phoneId"
            placeholder="Phone ID"
        />
        <button @click="connect">Connect</button>
        <div style="margin-top: 20px;">{{ status }}</div>
    </div>
</template>

<style
    scoped
    lang="scss"
>
* {
    color: white;
}

button {
    background-color: black;
    border: 1px solid lightgreen;
}
</style>