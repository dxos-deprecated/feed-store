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
import { FeedStore } from '@dxos/feed-store';

(async () => {
  const feedStore = await FeedStore.create('./db', {
    feedOptions: { valueEncoding: 'utf-8' }
  });

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
    metadata: { tag: 'bar' } // Save serializable feed metadata.
  });
})();
```

## API

#### `const feedStore = await feedStore.create(storage, [options])`

Creates and initializes a new FeedStore.

- `storage: RandomAccessStorage`: Storage used by the feeds to store their data.
- `options`:
  - `database: Hypertrie`: Defines a custom hypertrie database to index the feeds.
  - `feedOptions: Object`: Default hypercore options for each feed.
  - `codecs: Object`: Defines a list of available codecs to work with the feeds.
  - `timeout: number`: Defines the time (ms) to wait for open or close a feed. Default: `10 * 1000`.
  - `hypercore: Hypercore`: Defines the Hypercore class to create feeds.

#### `const feedStore = new FeedStore(storage, [options])`

Creates a new FeedStore `without wait for their initialization.`

> The initialization happens by running: `await feedStore.initialize()`

#### `feedStore.openFeed(path, [options]) -> Promise<Hypercore>`

Creates a new hypercore feed identified by a string path.

> If the feed exists but is not loaded it will load the feed instead of creating a new one.

- `path: string`: A require name to identify and index the feed to open.
- `options: Object`: Feed options.
  - `metadata: *`: Serializable value with custom data about the feed.
  - `[...hypercoreOptions]`: Hypercore options.

#### `feedStore.closeFeed(path) -> Promise`

Close a feed by the path.

#### `feedStore.deleteDescriptor(path) -> Promise`

Remove a descriptor from the database by the path.

> This operation would not close the feed.

#### `feedStore.close() -> Promise`

Close the hypertrie database and their feeds.

#### `feedStore.destroy() -> Promise`

Destroy the data of the hypertrie database and their feeds.

#### `feedStore.openFeeds((descriptor) => Boolean) -> Promise<Hypercore[]>`

Open multiple feeds using a function to filter what feeds you want to load from the database.

```javascript
const feeds = await feedStore.loadFeeds(descriptor => descriptor.metadata.tag === 'foo')
```

#### `feedStore.ready() -> Promise`

Wait for feedStore to be ready.

#### `FeedDescriptor`

For each feed created, FeedStore maintain `FeedDescriptor` object.

A `FeedDescriptor` provides the next information:

- `path: string`
- `key: Buffer`
- `secretKey: Buffer`
- `discoveryKey: Buffer`
- `feed: (Hypercore|null)`
- `opened: Boolean`
- `valueEncoding: string|Codec`
- `metadata: *`

#### `feedStore.getDescriptors() -> FeedDescriptor[]`

Returns a list of descriptors.

#### `feedStore.getOpenFeeds([descriptor => Boolean]) -> Hypercore[]`

Returns a list of opened hypercore feeds, with optional filter.

- `descriptor: FeedDescriptor`

#### `feedStore.getOpenFeed(descriptor => Boolean) -> Hypercore[]`

Find an opened feed using a filter callback.

- `descriptor: FeedDescriptor`

#### `feedStore.createReadStream([options], [callback]) -> ReadableStream`

Creates a ReadableStream from the loaded feeds.

- `options: Object`: Default options for each feed.createReadStream(options). Optional.
  - `feedStoreInfo: Boolean`: Enables streaming objects with additional feed information:
    - `data: Buffer`: The original chunk of the block data.
    - `seq: Number`: Sequence number of the read block.
    - `key: Buffer`: Key of the read feed.
    - `path: String`: FeedStore path of the read feed.
    - `metadata: Object`: FeedStore metadata of the read feed.
- `callback: descriptor => (Object|undefined)`: Filter function to return options for each feed.createReadStream(). Returns `undefined` will ignore the feed. Optional.
- `descriptor: FeedDescriptor`

Usage:

```javascript

// Live streaming from all the opened feeds.
const stream = feedStore.createReadStream({ live: true })

// Live streaming, from feeds filter by tag === 'foo'
const stream = feedStore.createReadStream({ live: true }, ({ metadata }) => {
  if (metadata.tag === 'foo') {
    return { start: 10 } // Start reading from index 10.
  }
})

// Live streaming, from feeds tag === 'foo'
const stream = feedStore.createReadStream({ metadata }) => {
  if (metadata.tag === 'foo') {
    return { live: true, start: 10 } // Start reading from index 10.
  }
})

// With additional information.
const stream = feedStore.createReadStream({ feedStoreInfo: true })
stream.on('data', data => {
  console.log(data) // { data, seq, key, path, metadata }
})
```

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
