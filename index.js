//
// Copyright 2019 Wireline, Inc.
//

require('source-map-support').install();

const FeedStore = require('./dist/feed-store');
const { getDescriptor, FeedDescriptor } = require('./dist/feed-descriptor');

module.exports = {
  FeedDescriptor,
  FeedStore,
  getDescriptor
};
