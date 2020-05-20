//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import hypertrie from 'hypertrie';
import jsonBuffer from 'buffer-json-encoding';
import defaultHypercore from 'hypercore';
import { NanoresourcePromise } from 'nanoresource-promise/emitter';

import FeedDescriptor from './feed-descriptor';
import IndexDB from './index-db';
import Reader from './reader';

const STORE_NAMESPACE = '@feedstore';

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
export class FeedStore extends NanoresourcePromise {
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
    await feedStore.open();
    return feedStore;
  }

  /**
   * constructor
   *
   * @param {RandomAccessStorage} storage RandomAccessStorage to use by default by the feeds.
   * @param {Object} options
   * @param {function} options.database Defines a custom hypertrie database to index the feeds.
   * @param {Object} options.feedOptions Default options for each feed.
   * @param {Object} options.codecs Defines a list of available codecs to work with the feeds.
   * @param {number} options.timeout Defines how much to wait for open or close a feed.
   * @param {Hypercore} options.hypercore Hypercore class to use.
   */
  constructor (storage, options = {}) {
    assert(storage, 'The storage is required.');

    super({ reopen: true });

    this._storage = storage;

    const {
      database = (...args) => hypertrie(...args),
      feedOptions = {},
      codecs = {},
      hypercore = defaultHypercore,
      timeout
    } = options;

    this._database = database;

    this._defaultFeedOptions = feedOptions;

    this._codecs = codecs;

    this._timeout = timeout;

    this._hypercore = hypercore;

    this._descriptors = new Map();

    this._readers = new Set();

    this._indexDB = null;

    this.on('feed', (_, descriptor) => {
      this._readers.forEach(reader => {
        reader.addFeedStream(descriptor).catch(err => {
          reader.destroy(err);
        });
      });
    });
  }

  /**
   * @type {RandomAccessStorage}
   */
  get storage () {
    return this._storage;
  }

  /**
   * Old initialize method keep it for backward compatibility
   */
  initialize () {
    return this.open();
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
   * Fast access to a descriptor
   *
   * @param {Buffer} discoverKey
   * @returns {FeedDescriptor|undefined}
   */
  getDescriptorByDiscoveryKey (discoverKey) {
    return this._descriptors.get(discoverKey.toString('hex'));
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
    await this._isOpen();

    const descriptors = this.getDescriptors()
      .filter(descriptor => callback(descriptor));

    return Promise.all(descriptors.map(descriptor => descriptor.open()));
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

    await this._isOpen();

    if (!this.active()) {
      throw new Error('FeedStore closed');
    }

    try {
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

      const feed = await descriptor.open();

      this.inactive();
      return feed;
    } catch (err) {
      this.inactive();
      throw err;
    }
  }

  /**
   * Close a feed by the path.
   *
   * @param {string} path
   * @returns {Promise}
   */
  async closeFeed (path) {
    assert(path, 'Missing path');

    await this._isOpen();

    if (!this.active()) {
      throw new Error('FeedStore closed');
    }

    try {
      const descriptor = this.getDescriptors().find(fd => fd.path === path);

      if (!descriptor) {
        throw new Error(`Feed not found: ${path}`);
      }

      await descriptor.close();
      this.inactive();
    } catch (err) {
      this.inactive();
      throw err;
    }
  }

  /**
   * Remove all descriptors from the indexDB.
   *
   * NOTE: This operation would not close the feeds.
   *
   * @returns {Promise<Promise[]>}
   */
  async deleteAllDescriptors () {
    return Promise.all(this.getDescriptors().map(({ path }) => this.deleteDescriptor(path)));
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

    await this._isOpen();

    if (!this.active()) {
      throw new Error('FeedStore closed');
    }

    const descriptor = this.getDescriptors().find(fd => fd.path === path);

    let release;
    try {
      release = await descriptor.lock();

      await this._indexDB.delete(`${STORE_NAMESPACE}/${descriptor.key.toString('hex')}`);

      this._descriptors.delete(descriptor.discoveryKey.toString('hex'));

      this.emit('descriptor-remove', descriptor);
      await release();
      this.inactive();
    } catch (err) {
      await release();
      this.inactive();
      throw err;
    }
  }

  /**
   * Creates a ReadableStream from the loaded feeds.
   *
   * @param {StreamCallback|Object} [callback] Filter function to return options for each feed.createReadStream (returns `false` will ignore the feed) or default object options for each feed.createReadStream(options)
   * @returns {ReadableStream}
   */
  createReadStream (callback = () => true) {
    const reader = new Reader(callback);

    this._readers.add(reader);

    reader.onEnd(() => {
      this._readers.delete(reader);
    });

    this
      ._isOpen()
      .then(() => Promise.all(this
        .getDescriptors()
        .filter(descriptor => descriptor.opened)
        .map(descriptor => reader.addFeedStream(descriptor))
      ))
      .catch(err => {
        reader.destroy(err);
      });

    return reader.stream;
  }

  /**
   * Initialized FeedStore reading the persisted options and created each FeedDescriptor.
   *
   * @returns {Promise}
   */
  async _open () {
    this._indexDB = new IndexDB(this._database(this._storage, { valueEncoding: jsonBuffer }));

    const list = await this._indexDB.list(STORE_NAMESPACE);

    list.forEach(data => {
      const { path, ...options } = data;
      this._createDescriptor(path, options);
    });

    this.emit('ready');
  }

  /**
   * Close the hypertrie and their feeds.
   *
   */
  async _close () {
    this._readers.forEach(reader => {
      try {
        reader.destroy(new Error('FeedStore closed'));
      } catch (err) {
        // ignore
      }
    });

    await Promise.all(this
      .getDescriptors()
      .map(descriptor => descriptor.close())
    );

    this._descriptors.clear();

    await this._indexDB.close();

    this.emit('closed');
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
      storage: this._storage,
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

    const append = () => this.emit('append', descriptor.feed, descriptor);
    const download = (...args) => this.emit('download', ...args, descriptor.feed, descriptor);

    descriptor.watch(async (event) => {
      if (event === 'updated') {
        await this._persistDescriptor(descriptor);
        return;
      }

      const { feed } = descriptor;

      if (event === 'opened') {
        await this._persistDescriptor(descriptor);
        feed.on('append', append);
        feed.on('download', download);
        this.emit('feed', feed, descriptor);
        return;
      }

      if (event === 'closed') {
        feed.removeListener('append', append);
        feed.removeListener('download', download);
      }
    });

    return descriptor;
  }

  /**
   * Persist in the db the FeedDescriptor.
   *
   * @private
   * @param {FeedDescriptor} descriptor
   * @returns {Promise}
   */
  async _persistDescriptor (descriptor) {
    const key = `${STORE_NAMESPACE}/${descriptor.key.toString('hex')}`;

    const oldData = await this._indexDB.get(key);

    const newData = {
      path: descriptor.path,
      key: descriptor.key,
      secretKey: descriptor.secretKey,
      valueEncoding: descriptor.valueEncoding,
      metadata: descriptor.metadata
    };

    if (!oldData || (JSON.stringify(oldData.metadata) !== JSON.stringify(newData.metadata))) {
      await this._indexDB.put(key, newData);
    }
  }

  async _isOpen () {
    if (!this.opening && !this.opened) {
      throw new Error('FeedStore closed');
    }

    // If is opening we wait to be ready.
    return this.ready();
  }
}
