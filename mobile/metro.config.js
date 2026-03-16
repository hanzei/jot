const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const sharedDir = path.resolve(__dirname, '../shared');

config.watchFolders = [sharedDir];

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
];

config.resolver.extraNodeModules = {
  '@jot/shared': sharedDir,
};

module.exports = config;
