const mount = require('../../__test__/vuex-mount');
const { default: Index } = require('./export-data-modal.vue');

describe('Export data modal', () => {
  it('matches snapshot', () => {
    const { wrapper } = mount(Index, { title: 'Export data' });
    expect(wrapper.element).toMatchSnapshot();
  });

  it('clicking on the modal does NOT close the modal', () => {
    const { wrapper } = mount(Index, { title: 'Export data' });

    wrapper.findComponent({ ref: 'modal' }).trigger('click');

    expect(wrapper.emitted().exitModal).toBeFalsy();
  });

  it('closes modal when close button is clicked', () => {
    const { wrapper } = mount(Index, { title: 'Export data' });

    wrapper.findComponent({ ref: 'closeButton' }).trigger('click');

    expect(wrapper.emitted().exitModal).toBeTruthy();
  });

  it('closes modal when modal backdrop is clicked', () => {
    const { wrapper } = mount(Index, { title: 'Export data' });

    wrapper.findComponent({ ref: 'root' }).trigger('click');

    expect(wrapper.emitted().exitModal).toBeTruthy();
  });
});
