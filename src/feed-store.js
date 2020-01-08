//
// Copyright 2019 DxOS.
//

import { EventEmitter } from 'events';
import assert from 'assert';
import multi from 'multi-read-stream';
import eos from 'end-of-stream';
import hypertrie from 'hypertrie';
import jsonBuffer from 'buffer-json-encoding';
import through from 'through2';
import pump from 'pump';

import FeedDescriptor from './feed-descriptor';
import IndexDB from './index-db';
import Locker from './locker';

const STORE_NAMESPACE = '@feedstore';

const OPENED = 'opened';
const CLOSED = 'closed';
const DESTROYED = 'destroyed';

/**
 *
 * @callback DescriptorCallback
 * @param {FeedDescriptor} descriptor
 * @returns {boolean}
 */

/**
 *
 * @callback StreamCallback
 * @param {FeedDescriptor} descriptor
 * @returns {(Object|undefined)}
 */

/**
 * FeedStore
 *
 * Management of multiple feeds to create, update, load, find and delete feeds
 * into a persist repository storage.
 *
 * @extends {EventEmitter}
 */
export class FeedStore extends EventEmitter {
  /**
   * Create and initialize a new FeedStore
   *
   * @static
   * @param {RandomAccessStorage} storage RandomAccessStorage to use by default by the feeds.
   * @param {Object} options
   * @param {Hypertrie} options.database Defines a custom hypertrie database to index the feeds.
   * @param {Object} options.feedOptions Default options for each feed.
   * @param {Object} options.codecs Defines a list of available codecs to work with the feeds.
   * @param {number} options.timeout Defines how much to wait for open or close a feed.
   * @param {Hypercore} options.hypercore Hypercore class to use.
   * @returns {Promise<FeedStore>}
   */
  static async create (storage, options = {}) {
    const feedStore = new FeedStore(storage, options);
    await feedStore.initialize();
    return feedStore;
  }

  /**
   * constructor
   *
   * @param {RandomAccessStorage} storage RandomAccessStorage to use by default by the feeds.
   * @param {Object} options
   * @param {Hypertrie} options.database Defines a custom hypertrie database to index the feeds.
   * @param {Object} options.feedOptions Default options for each feed.
   * @param {Object} options.codecs Defines a list of available codecs to work with the feeds.
   * @param {number} options.timeout Defines how much to wait for open or close a feed.
   * @param {Hypercore} options.hypercore Hypercore class to use.
   */
  constructor (storage, options = {}) {
    assert(storage, 'The storage is required.');

    super();

    this._defaultStorage = storage;

    const {
      database = hypertrie(storage, { valueEncoding: jsonBuffer }),
      feedOptions = {},
      codecs = {},
      timeout,
      hypercore
    } = options;

    this._indexDB = new IndexDB(database);

    this._defaultFeedOptions = feedOptions;

    this._codecs = codecs;

    this._timeout = timeout;

    this._hypercore = hypercore;

    this._descriptors = new Map();

    this._locker = new Locker();

    this._state = null;
  }

  /**
   * @type {Boolean}
   */
  get opened () {
    return this._state === OPENED;
  }

  /**
   * @type {Boolean}
   */
  get closed () {
    return this._state === CLOSED || this._state === DESTROYED;
  }

  /**
   * @type {Boolean}
   */
  get destroyed () {
    return this._state === DESTROYED;
  }

  /**
   * Initialized FeedStore reading the persisted options and created each FeedDescriptor.
   *
   * @returns {Promise}
   */
  async initialize () {
    const release = await this._locker.lock();

    if (this.opened) {
      await release();
      return;
    }

    if (this.closed) {
      await release();
      throw new Error('FeedStore closed');
    }

    try {
      const list = await this._indexDB.list(STORE_NAMESPACE);

      await Promise.all(
        list.map(async (data) => {
          const { path, key, secretKey, ...options } = data;

          this._createDescriptor(path, {
            key,
            secretKey,
            ...options
          });
        })
      );

      this._state = OPENED;
      this.emit('ready');
      await release();
    } catch (err) {
      await release();
      throw err;
    }
  }

  async ready () {
    if (this.opened) {
      return;
    }

    return new Promise((resolve) => {
      this.once('ready', resolve);
    });
  }

  /**
   * Get the list of descriptors.
   *
   * @returns {FeedDescriptor[]}
   */
  getDescriptors () {
    return Array.from(this._descriptors.values());
  }

  /**
   * Get the list of opened feeds, with optional filter.
   *
   * @param {DescriptorCallback} [callback]
   * @returns {Hypercore[]}
   */
  getOpenFeeds (callback) {
    return this.getDescriptors()
      .filter(descriptor => descriptor.opened && (!callback || callback(descriptor)))
      .map(descriptor => descriptor.feed);
  }

  /**
   * Find an opened feed using a filter callback.
   *
   * @param {DescriptorCallback} callback
   * @returns {Hypercore}
   */
  getOpenFeed (callback) {
    const descriptor = this.getDescriptors()
      .find(descriptor => descriptor.opened && callback(descriptor));

    if (descriptor) {
      return descriptor.feed;
    }
  }

  /**
   * Open multiple feeds using a filter callback.
   *
   * @param {DescriptorCallback} callback
   * @returns {Promise<Hypercore[]>}
   */
  async openFeeds (callback) {
    await this.initialize();

    const descriptors = this.getDescriptors()
      .filter(descriptor => callback(descriptor));

    return Promise.all(descriptors.map(descriptor => this._openFeed(descriptor)));
  }

  /**
   * Open a feed to FeedStore.
   *
   * If the feed already exists but is not loaded it will load the feed instead of
   * creating a new one.
   *
   * Similar to fs.open
   *
   * @param {string} path
   * @param {Object} options
   * @param {Buffer} options.key
   * @param {Buffer} options.secretKey
   * @param {string} options.valueEncoding
   * @param {*} options.metadata
   * @returns {Hypercore}
   */
  async openFeed (path, options = {}) {
    assert(path, 'Missing path');

    await this.initialize();

    const { key } = options;

    let descriptor = this.getDescriptors().find(fd => fd.path === path);

    if (descriptor && key && !key.equals(descriptor.key)) {
      throw new Error(`Invalid public key "${key.toString('hex')}"`);
    }

    if (!descriptor && key && this.getDescriptors().find(fd => fd.key.equals(key))) {
      throw new Error(`Feed exists with same public key "${key.toString('hex')}"`);
    }

    if (!descriptor) {
      descriptor = this._createDescriptor(path, options);
    }

    return this._openFeed(descriptor);
  }

  /**
   * Close a feed by the path.
   *
   * @param {string} path
   * @returns {Promise}
   */
  async closeFeed (path) {
    assert(path, 'Missing path');

    await this.initialize();

    const descriptor = this.getDescriptors().find(fd => fd.path === path);

    if (!descriptor) {
      throw new Error(`Feed not found: ${path}`);
    }

    return descriptor.close();
  }

  /**
   * Remove a descriptor from the indexDB by the path.
   *
   * NOTE: This operation would not close the feed.
   *
   * @param {string} path
   * @returns {Promise}
   */
  async deleteDescriptor (path) {
    assert(path, 'Missing path');

    await this.initialize();

    const descriptor = this.getDescriptors().find(fd => fd.path === path);

    let release;
    try {
      release = await descriptor.lock();

      await this._indexDB.delete(`${STORE_NAMESPACE}/${descriptor.key.toString('hex')}`);

      this._descriptors.delete(descriptor.discoveryKey.toString('hex'));

      this.emit('descriptor-remove', descriptor);
      await release();
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Close the hypertrie and their feeds.
   *
   * @returns {Promise}
   */
  async close () {
    if (this.closed) {
      return true;
    }

    const release = await this._locker.lock();

    if (this.closed) {
      await release();
      return true;
    }

    if (!this.opened) {
      await release();
      throw new Error('FeedStore is not opened');
    }

    try {
      await Promise.all(this
        .getDescriptors()
        .map(descriptor => descriptor.close())
      );

      this._descriptors.clear();

      await this._indexDB.close();

      this._state = CLOSED;
      await release();
      return true;
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Creates a ReadableStream from the loaded feeds.
   *
   * @param {Object} [options] Default options for each feed.createReadStream(options).
   * @param {StreamCallback} [callback] Filter function to return options for each feed.createReadStream(). Returns `undefined` will ignore the feed.
   * @returns {ReadableStream}
   */
  createReadStream (options, callback = () => ({})) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (options === undefined) {
      options = {};
    }

    const multiReader = multi.obj();

    const addStream = descriptor => {
      let streamOptions = callback(descriptor);
      if (streamOptions) {
        streamOptions = Object.assign({}, options, streamOptions);
        multiReader.add(this._createFeedStream(descriptor, streamOptions));
      }
    };

    this
      .getDescriptors()
      .filter(descriptor => descriptor.opened)
      .forEach(addStream);

    const onFeed = (_, descriptor) => addStream(descriptor);

    this.on('feed', onFeed);
    eos(multiReader, () => this.removeListener('feed', onFeed));

    return multiReader;
  }

  /**
   * Destroy the database and their related feeds.
   *
   * @returns {Promise}
   */
  async destroy () {
    if (this._state === DESTROYED) {
      return true;
    }

    const descriptors = this.getDescriptors();

    await this.close();

    const release = await this._locker.lock();

    if (this._state === DESTROYED) {
      await release();
      return true;
    }

    try {
      await Promise.all(descriptors.map(descriptor => descriptor.destroy()));

      await this._indexDB.destroy();

      this._state = DESTROYED;
      await release();
      return true;
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Factory to create a new FeedDescriptor.
   *
   * @private
   * @param path
   * @param {Object} options
   * @param {Buffer} options.key
   * @param {Buffer} options.secretKey
   * @param {string} options.valueEncoding
   * @param {*} options.metadata
   * @returns {FeedDescriptor}
   */
  _createDescriptor (path, options) {
    const defaultOptions = this._defaultFeedOptions;

    const { key, secretKey, valueEncoding = defaultOptions.valueEncoding, metadata } = options;

    const descriptor = new FeedDescriptor(path, {
      storage: this._defaultStorage,
      key,
      secretKey,
      valueEncoding,
      metadata,
      timeout: this._timeout,
      hypercore: this._hypercore,
      codecs: this._codecs
    });

    this._descriptors.set(
      descriptor.discoveryKey.toString('hex'),
      descriptor
    );

    return descriptor;
  }

  /**
   * Atomic operation to open or create a feed referenced by the FeedDescriptor.
   *
   * @private
   * @param {FeedDescriptor} descriptor
   * @returns {Promise<Hypercore>}
   */
  async _openFeed (descriptor) {
    // Fast return without need to lock the descriptor.
    if (descriptor.opened) {
      return descriptor.feed;
    }

    await descriptor.open();

    await this._persistFeed(descriptor);

    const { feed } = descriptor;

    // Watch for data events: append and download.
    descriptor.watch((event, ...args) => this.emit(event, ...args));

    this.emit('feed', feed, descriptor);

    return descriptor.feed;
  }

  /**
   * Persist in the db the FeedDescriptor.
   *
   * @private
   * @param {FeedDescriptor} descriptor
   * @returns {Promise}
   */
  async _persistFeed (descriptor) {
    const key = `${STORE_NAMESPACE}/${descriptor.key.toString('hex')}`;

    const oldData = await this._indexDB.get(key);

    const newData = {
      path: descriptor.path,
      key: descriptor.key,
      secretKey: descriptor.secretKey,
      valueEncoding: descriptor.valueEncoding,
      metadata: descriptor.metadata
    };

    if (!oldData || (JSON.stringify(oldData) !== JSON.stringify(newData))) {
      await this._indexDB.put(key, newData);
    }
  }

  /**
   * Creates a feed stream and stream the block data, seq, key and metadata.
   *
   * @param {FeedDescriptor} descriptor
   * @param {Object} options
   * @returns {ReadableStream}
   */
  _createFeedStream (descriptor, options) {
    const { feed, path, key, metadata } = descriptor;

    const { feedStoreInfo = false, ...feedStreamOptions } = options;

    const stream = feed.createReadStream(feedStreamOptions);

    if (!feedStoreInfo) {
      return stream;
    }

    let seq = feedStreamOptions.start === undefined ? 0 : feedStreamOptions.start;

    const addFeedStoreInfo = through.obj((chunk, _, next) => {
      next(null, { data: chunk, seq: seq++, path, key, metadata });
    });

    return pump(stream, addFeedStoreInfo);
  }
}
