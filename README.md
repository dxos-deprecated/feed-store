# FeedStore

> A consistent store for your hypercore feeds.

[![Build Status](https://travis-ci.com/dxos/feed-store.svg?branch=master)](https://travis-ci.com/dxos/feed-store)
[![Coverage Status](https://coveralls.io/repos/github/dxos/feed-store/badge.svg?branch=master)](https://coveralls.io/github/dxos/feed-store?branch=master)
![npm (scoped)](https://img.shields.io/npm/v/@dxos/feed-store)
 [![Greenkeeper badge](https://badges.greenkeeper.io/dxos/feed-store.svg)](https://greenkeeper.io/)
[![js-semistandard-style](https://img.shields.io/badge/code%20style-semistandard-brightgreen.svg?style=flat-square)](https://github.com/standard/semistandard)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

FeedStore was created to administrate your hypercore feeds in a similar abstraction to work with files in a FileSystem.

Each feed created by FeedStore works with an underlying object `descriptor` which provides additional information about the feed and how to work with it.

Features:
- Open/Close hypercore feeds.
- Load hypercore feeds by demand.
- Persist feeds metadata into a hypertrie database.
- Search feeds by a path or any property related to the feed.
- Add metadata to your feed.
- Support for multiple codecs.

## Install

```
$ npm install @dxos/feed-store
```

## Usage

```javascript
import hypertrie from 'hypertrie';
import { FeedStore, getDescriptor } from '@dxos/feed-store';

(async () => {
  const feedStore = await FeedStore.create(
    // Database to index feeds.
    hypertrie('./db'),

    // RandomAccessStorage where the feeds are going to be stored.
    './db',

    // Options
    {
      feedOptions: { valueEncoding: 'utf-8' }
    }
  );

  // Open a feed. If the feed doesn't exist, it would be created.
  const foo = await feedStore.openFeed('/foo');

  foo.append('foo', () => {
    foo.head(console.log);
  });

  // You can open a feed with custom hypercore options.
  const bar = await feedStore.openFeed('/bar', {
    key: Buffer.from('...'),
    secretKey: Buffer.from('...'),
    valueEncoding: 'json',
    metadata: { tag: 'important' } // Save serializable feed metadata.
  });

  console.log(getDescriptor(bar).metadata); // { tag: 'important' }
})();
```

## API

#### `const feedStore = await feedStore.create(database, storage, [options])`

Creates and initializes a new FeedStore.

- `storage: RandomAccessStorage`: Storage used by the feeds to store their data.
- `options`:
  - `database: Hypertrie`: Defines a custom hypertrie database to index the feeds.
  - `feedOptions: Object`: Default hypercore options for each feed.
  - `codecs: Object`: Defines a list of available codecs to work with the feeds.
  - `timeout: number`: Defines the time (ms) to wait for open or close a feed. Default: `10 * 1000`.
  - `hypercore: Hypercore`: Defines the Hypercore class to create feeds.

#### `const feedStore = new FeedStore(database, storage, [options])`

Creates a new FeedStore `without wait for their initialization.`

> The initialization happens by running: `await feedStore.initialize()`

#### `feedStore.openFeed(path, [options]) -> Promise<Hypercore>`

Creates a new hypercore feed identified by a string path.

> If the feed exists but is not loaded it will load the feed instead of creating a new one.

- `path: string`: A require name to identify and index the feed to open.
- `options: Object`: Feed options.
  - `metadata: Object`: Serializable object with custom data about the feed.
  - `[...hypercoreOptions]`: Hypercore options.

#### `feedStore.closeFeed(path) -> Promise`

Close a feed by the path.

#### `feedStore.deleteDescriptor(path) -> Promise`

Remove a descriptor from the database by the path.

> This operation would not close the feed.

#### `feedStore.close() -> Promise`

Close the hypertrie database and their feeds.

#### `feedStore.loadFeeds((descriptor) => Boolean) -> Promise<Hypercore[]>`

Loads feeds using a function to filter what feeds you want to load from the database.

```javascript
const feeds = await feedStore.loadFeeds(descriptor => descriptor.metadata.tag === 'important')
```

#### `feedStore.ready() -> Promise`

Wait for feedStore to be ready.

#### `FeedStore.getDescriptor(feed) -> FeedDescriptor`

Each feed created by FeedStore set a unique private Symbol inside with the descriptor information.

Using the static method `getDescriptor` you can get that information.

A `FeedDescriptor` provides the next information:

- `path: string`
- `key: Buffer`
- `secretKey: Buffer`
- `discoveryKey: Buffer`
- `feed: (Hypercore|null)`
- `opened: Boolean`
- `valueEncoding: string|Codec`
- `metadata: Object`

#### `feedStore.getDescriptors() -> FeedDescriptor[]`

Returns a list of descriptors.

#### `feedStore.getOpenedDescriptors() -> FeedDescriptor[]`

Returns a list of descriptors with the feed opened.

#### `feedStore.getDescriptorByKey(key) -> FeedDescriptor`

Search a descriptor by their feed key.

- `key: Buffer`

#### `feedStore.getDescriptorByPath(path) -> FeedDescriptor`

Search a descriptor by their path.

#### `feedStore.getFeeds() -> Hypercore[]`

Returns a list of opened hypercore feeds.

#### `feedStore.findFeed((descriptor) => Boolean) -> Hypercore`

Find a opened feed using a callback function.

- `descriptor: FeedDescriptor`

#### `feedStore.filterFeeds((descriptor) => Boolean) -> Hypercore[]`

Filter the opened feeds using a callback function.

- `descriptor: FeedDescriptor`

#### `feedStore.createReadStream([options]) -> ReadableStream`

Creates a ReadableStream from the loaded feeds.

- `options: Object`: Options for the hypercore.createReadStream.

#### `feedStore.createReadStreamByFilter(descriptor => Boolean, [options]) -> ReadableStream`

Creates a ReadableStream from the loaded feeds filter by a callback function.

- `options: Object`: Options for the hypercore.createReadStream.

### Events

#### `feedStore.on('ready', () => {})`

Emitted when feedStore is loaded.

#### `feedStore.on('append', (feed, descriptor) => {})`

Emitted after an append in any of the loaded feeds.

- `feed: Hypercore`
- `descriptor: FeedDescriptor`

#### `feedStore.on('download', (index, data, feed, descriptor) => {})`

Emitted after a feed download event.

- `index: number` Block index.
- `data: Buffer`
- `feed: Hypercore`
- `descriptor: FeedDescriptor`

#### `feedStore.on('feed', (feed, descriptor) => {})`

Emitted when a feed is loaded.

- `feed: Hypercore`
- `descriptor: FeedDescriptor`

## Contributing

PRs accepted.

## License

GPL-3.0 © dxos
