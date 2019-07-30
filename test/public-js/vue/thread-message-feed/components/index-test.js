'use strict';

const mount = require('../../vuex-mount');
const { createSerializedMessageFixture } = require('../../fixture-helpers');
const {
  default: Index
} = require('../../../../../public/js/vue/thread-message-feed/components/index.vue');

describe('thread-message-feed index', () => {
  const addDefaultUser = state => (state.user = { displayName: 'John Smith' });
  const addParentMessage = state => {
    const parentMessage = createSerializedMessageFixture();
    state.messageMap = { [parentMessage.id]: parentMessage };
    state.threadMessageFeed.parentId = parentMessage.id;
  };

  it('closed - matches snapshot', async () => {
    const { wrapper } = mount(Index, {}, store => {
      store.state.threadMessageFeed.isVisible = false;
      // Further state changes shouldn't be necessary but for some reason the `mount` helper
      // tries to render the v-if hidden child components as well and causes Vue warnings
      addParentMessage(store.state);
      addDefaultUser(store.state);
    });
    expect(wrapper.element).toMatchSnapshot();
  });

  it('opened - matches snapshot', () => {
    const { wrapper } = mount(Index, {}, store => {
      addParentMessage(store.state);
      addDefaultUser(store.state);
      store.state.threadMessageFeed.isVisible = true;
    });
    expect(wrapper.element).toMatchSnapshot();
  });

  it('dark theme - matches snapshot', () => {
    const { wrapper } = mount(Index, {}, store => {
      addParentMessage(store.state);
      addDefaultUser(store.state);
      store.state.threadMessageFeed.isVisible = true;
      store.state.darkTheme = true;
    });
    expect(wrapper.element).toMatchSnapshot();
  });

  it('missing parent message - matches snapshot', () => {
    const { wrapper } = mount(Index, {}, store => {
      addParentMessage(store.state);
      addDefaultUser(store.state);
      store.state.threadMessageFeed.isVisible = true;
      store.state.messageMap = {};
    });
    expect(wrapper.element).toMatchSnapshot();
  });
});
