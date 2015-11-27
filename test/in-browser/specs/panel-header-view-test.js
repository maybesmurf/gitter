/*global describe:true, it:true, beforeEach:true */
'use strict';

var assert          = require('assert');
var Backbone        = require('backbone');
var PanelHeaderView = require('../../../public/js/views/menu/panel-header-view');

describe('PanelHeaderView', function() {

  var model;
  var panelHeaderView;
  var el;

  beforeEach(function() {
    model           = new Backbone.Model({ state: 'all' });
    el              = document.createElement('div');
    panelHeaderView = new PanelHeaderView({ el: el, model: model });
    panelHeaderView.render();
  });

  it('should render the correct initial content', function() {
    var result = panelHeaderView.$el.find('.panel-header__title--all').length;
    assert.equal(1, result);

  });

  it('should render the correct content when in the search state', function(){
    model.set('state', 'search');
    var result = panelHeaderView.$el.find('.panel-header__title--search');
    assert.equal(1, result.length);
  });

  it('should render the correct content when in the favourite state', function(){
    model.set('state', 'favourite');
    var result = panelHeaderView.$el.find('.panel-header__title--favourite');
    assert.equal(1, result.length);
  });

  it('should render the correct content when in the people state', function(){
    model.set('state', 'people');
    var result = panelHeaderView.$el.find('.panel-header__title--people');
    assert.equal(1, result.length);
  });


});
