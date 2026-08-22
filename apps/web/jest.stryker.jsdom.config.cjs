/** @type {import('jest').Config} */
// Entry point for the jsdom-environment Stryker run. See jest.stryker.config.cjs for why the two
// environments are separate runs rather than jest `projects`.
module.exports = require('./jest.stryker.config.cjs').jsdomConfig;
