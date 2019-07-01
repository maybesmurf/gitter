'use strict';

const leftMenuConstants = require('../../../../../public/js/vue/left-menu/constants');
const mount = require('../../vuex-mount');
const {
  default: MenuBarItemToggle
} = require('../../../../../public/js/vue/left-menu/components/menu-bar-item-toggle.vue');

describe('menu-bar-item-toggle', () => {
  it('toggle matches snapshot', () => {
    const { wrapper } = mount(MenuBarItemToggle, {
      type: leftMenuConstants.LEFT_MENU_TOGGLE_STATE
    });
    expect(wrapper.element).toMatchSnapshot();
  });

  it('calls store action "toggleLeftMenuPinnedState" when item is clicked', () => {
    const beforePinnedState = false;
    const { wrapper, stubbedActions } = mount(
      MenuBarItemToggle,
      {
        type: leftMenuConstants.LEFT_MENU_TOGGLE_STATE
      },
      store => {
        store.state.leftMenuPinnedState = beforePinnedState;
      }
    );

    wrapper.find({ ref: 'root' }).trigger('click');

    expect(stubbedActions.toggleLeftMenuPinnedState).toHaveBeenCalledWith(
      expect.anything(),
      !beforePinnedState,
      undefined
    );
  });
});
