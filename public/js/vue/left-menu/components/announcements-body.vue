<script>
export const ACTIVE_TILL = new Date('2023-03-01T00:00:00.000Z');

export const isAnnouncementActive = () => new Date(Date.now()) < ACTIVE_TILL;

export default {
  name: 'AnnouncementsBody'
};
</script>

<template>
  <div class="announcements-body-root">
    <h2 class="announcements-body-title">Announcement</h2>
    <p>
      Heads-up that on February 13th, you will be signed out and required to sign-in via
      app.gitter.im. This is part of the Gitter migration process to switch to a fully Matrix setup.
      Don't worry, all of your rooms and messages will still be available!
    </p>
    <p>
      Any bots and scripts using the Gitter API will be cut off and will need to be updated to use
      the Matrix APIs.
    </p>
    <p>
      You can read more about this pre-announcement in the
      <a
        href="https://blog.gitter.im/2023/01/16/gitter-is-going-fully-native-matrix-in-feb-2023/"
        target="_blank"
        >blog post</a
      >.
    </p>
  </div>
</template>

<style lang="less" scoped>
@import (reference) 'trp3Vars';
@import (reference) 'components/m-header-title';
@import (reference) 'dark-theme';

.announcements-body-root {
  padding: 10px;
  a {
    color: @blue;
  }
  .dark-theme & {
    color: @dark-theme-left-menu-text-color;
  }
}

.announcements-body-title {
  .m-header-title();
}
</style>
