import * as types from './mutation-types';
import context from 'gitter-web-client-context';
import apiClient from '../../components/api-client';
import appEvents from '../../utils/appevents';
import * as leftMenuConstants from '../left-menu/constants';

export const setInitialData = ({ commit }, data) => commit(types.SET_INITIAL_DATA, data);
export const setTest = ({ commit }, testValue) => commit(types.SET_TEST, testValue);

export const trackStat = (actionMeta, statName) => {
  appEvents.trigger('stats.event', statName);
  appEvents.trigger('track-event', statName);
};

export const setLeftMenuState = ({ commit, dispatch }, newLeftMenuState) => {
  commit(types.SWITCH_LEFT_MENU_STATE, newLeftMenuState);

  dispatch('trackStat', `left-menu.minibar.activated.${newLeftMenuState}`);

  // When we switch to the search panel, re-search for messages in that room
  if (newLeftMenuState === leftMenuConstants.LEFT_MENU_SEARCH_STATE) {
    dispatch('fetchMessageSearchResults');
  }
};

export const toggleLeftMenuPinnedState = ({ commit, dispatch }, toggleState) => {
  commit(types.TOGGLE_LEFT_MENU_PINNED_STATE, toggleState);
  dispatch('trackStat', `left-menu.pinned.${toggleState}`);
};

export const toggleLeftMenu = ({ commit }, toggleState) =>
  commit(types.TOGGLE_LEFT_MENU, toggleState);

export const updateSearchInputValue = ({ commit }, newSearchInputValue) => {
  commit(types.UPDATE_SEARCH_INPUT_VALUE, newSearchInputValue);
};

export const fetchRoomSearchResults = ({ state, commit, dispatch }) => {
  const searchInputValue = state.search.searchInputValue;

  if (searchInputValue && searchInputValue.length > 0) {
    commit(types.UPDATE_ROOM_SEARCH_CURRENT);

    dispatch('trackStat', 'left-menu.search.input');

    commit(types.REQUEST_ROOM_SEARCH_REPO);
    apiClient.user
      .get('/repos', {
        q: searchInputValue,
        type: 'gitter',
        limit: 3
      })
      .then(result => {
        commit(types.RECEIVE_ROOM_SEARCH_REPO_SUCCESS, result && result.results);
      })
      .catch(err => {
        commit(types.RECEIVE_ROOM_SEARCH_REPO_ERROR, err);
      });

    commit(types.REQUEST_ROOM_SEARCH_ROOM);
    apiClient
      .get('/v1/rooms', {
        q: searchInputValue,
        type: 'gitter',
        limit: 3
      })
      .then(result => {
        commit(types.RECEIVE_ROOM_SEARCH_ROOM_SUCCESS, result && result.results);
      })
      .catch(err => {
        commit(types.RECEIVE_ROOM_SEARCH_ROOM_ERROR, err);
      });

    commit(types.REQUEST_ROOM_SEARCH_PEOPLE);
    apiClient
      .get('/v1/user', {
        q: searchInputValue,
        type: 'gitter',
        limit: 3
      })
      .then(result => {
        commit(types.RECEIVE_ROOM_SEARCH_PEOPLE_SUCCESS, result && result.results);
      })
      .catch(err => {
        commit(types.RECEIVE_ROOM_SEARCH_PEOPLE_ERROR, err);
      });
  } else {
    commit(types.SEARCH_CLEARED);
  }
};

export const fetchMessageSearchResults = ({ state, commit }) => {
  const searchInputValue = state.search.searchInputValue;

  if (searchInputValue && searchInputValue.length > 0) {
    commit(types.REQUEST_MESSAGE_SEARCH);
    apiClient.room
      .get('/chatMessages', {
        q: searchInputValue,
        lang: context.lang(),
        limit: 30
      })
      .then(result => {
        commit(types.RECEIVE_MESSAGE_SEARCH_SUCCESS, result);
      })
      .catch(err => {
        commit(types.RECEIVE_MESSAGE_SEARCH_ERROR, err);
      });
  }
};

export const changeDisplayedRoom = ({ state, commit, dispatch }, newRoomId) => {
  commit(types.CHANGE_DISPLAYED_ROOM, newRoomId);

  const newRoom = state.roomMap[newRoomId];

  if (newRoom) {
    dispatch('trackStat', 'left-menu.changeRoom');

    // If there is a current room, it means that the router-chat routing is in place to switch to other rooms
    const currentRoom = context.troupe();
    if (currentRoom && currentRoom.id) {
      appEvents.trigger('navigation', newRoom.url, 'chat', newRoom.name);
      appEvents.trigger('vue:change:room', newRoom);
    } else {
      // Otherwise, we need to redirect
      // We are using `window.location.assign` so we can easily mock/spy in the tests
      window.location.assign(newRoom.url);
    }
  }
};

export const jumpToMessageId = ({ commit, dispatch }, messageId) => {
  commit(types.CHANGE_HIGHLIGHTED_MESSAGE_ID, messageId);
  appEvents.trigger('vue:hightLightedMessageId', messageId);

  dispatch('trackStat', 'left-menu.search.messageNavigate');
};

export const updateRoom = ({ commit }, newRoomState) => commit(types.UPDATE_ROOM, newRoomState);
