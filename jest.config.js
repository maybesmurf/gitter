'use strict';

module.exports = {
  testMatch: ['<rootDir>/public/js/**/*-test.js'],
  moduleFileExtensions: ['js', 'json', 'vue'],
  moduleNameMapper: {
    '\\.(jpg|jpeg|png|svg)$': '<rootDir>/public/js/vue/__mocks__/file_mock.js'
  },
  modulePathIgnorePatterns: ['<rootDir>/output/app/'],
  transform: {
    '^.+\\.js$': 'babel-jest',
    '^.+\\.vue$': 'vue-jest',
    '^.+\\.hbs$': 'jest-handlebars'
  },
  resolver: '<rootDir>/test/jest-browser-resolver.js'
};
