<script>
import MenuBarItem from './menu-bar-item.vue';
import MenuBarItemCreate from './menu-bar-item-create.vue';
import MenuBarItemToggle from './menu-bar-item-toggle.vue';

export default {
  name: 'MenuBarBody',
  components: {
    MenuBarItem,
    MenuBarItemCreate,
    MenuBarItemToggle
  }
};
</script>

<template>
  <div class="menu-bar-root">
    <div class="menu-bar-top">
      <menu-bar-item type="all">
        <template v-slot:icon>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 1 49 45">
            <path
              d="M42.4 8.1c2 2.5 3 5.2 3 8.1 0 2.9-1 5.7-3 8.1s-4.8 4.5-8.3 5.9c-3.5 1.4-7.3 2.2-11.4 2.2-1.2 0-2.4-.1-3.7-.2-3.3 3-7.2 5-11.7 6.1-.8.2-1.8.4-2.9.6-.3 0-.5-.1-.7-.3-.2-.2-.3-.4-.4-.7-.1-.1-.1-.2 0-.3 0-.1.1-.2.1-.3 0 0 0-.1.1-.2s.1-.2.2-.2.1-.1.2-.2l.2-.2c.1-.1.4-.4.8-.9s.7-.8.9-1c.2-.2.4-.5.8-1 .3-.5.6-.9.8-1.3.2-.4.4-.9.7-1.5.3-.6.5-1.2.7-1.9-2.7-1.5-4.7-3.4-6.3-5.6C.8 21.1 0 18.7 0 16.2c0-2.9 1-5.7 3-8.1 2-2.5 4.8-4.5 8.3-5.9C14.8.7 18.6 0 22.7 0c4.1 0 7.9.7 11.4 2.2 3.5 1.4 6.2 3.4 8.3 5.9zM32.4 5c-3-1.2-6.2-1.8-9.7-1.8-3.4 0-6.7.6-9.7 1.8S7.7 7.8 5.9 9.8c-1.8 2-2.6 4.1-2.6 6.5 0 1.9.6 3.7 1.8 5.4 1.2 1.7 2.9 3.2 5.1 4.4l2.2 1.3-.7 2.4c-.4 1.5-1 3-1.8 4.4 2.6-1.1 4.9-2.5 7-4.3l1.1-1 1.4.2c1.2.1 2.3.2 3.3.2 3.4 0 6.7-.6 9.7-1.8 3-1.2 5.4-2.8 7.1-4.7s2.6-4.1 2.6-6.5c0-2.3-.9-4.5-2.6-6.5-1.8-2-4.1-3.6-7.1-4.8z"
            />
          </svg>
        </template>
      </menu-bar-item>

      <menu-bar-item type="search">
        <template v-slot:icon>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 43.7 43.5">
            <path
              d="M15.7 2.4C23 2.4 29 8.2 29 15.7S23.2 29 15.7 29 2.4 23.2 2.4 15.7 8.2 2.4 15.7 2.4m0-2.4C6.9 0 0 6.9 0 15.7s6.9 15.7 15.7 15.7 15.7-6.9 15.7-15.7S24.3 0 15.7 0z"
            />
            <path
              d="M42.6 43.5c-.4 0-.5-.2-.9-.4L25.8 27c-.5-.5-.5-1.3 0-1.6.5-.5 1.3-.5 1.6 0l15.9 16.1c.5.5.5 1.3 0 1.6-.2.4-.3.4-.7.4z"
            />
          </svg>
        </template>
      </menu-bar-item>

      <menu-bar-item type="people">
        <template v-slot:icon>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37.9 42.5">
            <path
              d="M18.9 21.3c-5.9 0-10.6-4.7-10.6-10.6S13.1 0 18.9 0s10.6 4.7 10.6 10.6-4.6 10.7-10.6 10.7zm0-19c-4.5 0-8.1 3.8-8.1 8.3s3.8 8.3 8.3 8.3 8.3-3.8 8.3-8.3-3.8-8.3-8.5-8.3zM36.7 42.5c-.7 0-1.3-.5-1.3-1.3 0-9.2-7.4-16.6-16.6-16.6S2.3 32.1 2.3 41.2c0 .7-.5 1.3-1.3 1.3s-1-.5-1-1.3c0-10.4 8.5-18.9 18.9-18.9s18.9 8.5 18.9 18.9c.2.8-.3 1.3-1.1 1.3z"
            />
          </svg>
        </template>
      </menu-bar-item>
    </div>

    <div class="menu-bar-bottom">
      <menu-bar-item-create type="create">
        <template v-slot:icon>
          +
        </template>
      </menu-bar-item-create>

      <menu-bar-item-toggle type="toggle">
        <template v-slot:icon>
          <svg viewBox="0 0 30 34">
            <path d="M0,6 l15,0 l15,0" />
            <path d="M0,17 l15,0 l15,0" />
            <path d="M0,28 l15,0 l15,0" />
          </svg>
        </template>
      </menu-bar-item-toggle>
    </div>
  </div>
</template>

<style lang="less" scoped>
@import (reference) 'trp3Vars';

.menu-bar-root {
  overflow: auto;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 100%;

  background-color: @main-application-bg-color;
  border-right: 1px solid @menu-border-color;
}

.menu-bar-top {
}

.menu-bar-bottom {
}
</style>