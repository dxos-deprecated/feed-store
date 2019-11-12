//
// Copyright 2019 Wireline, Inc.
//

import { EventEmitter } from 'events';
import assert from 'assert';

import Codec from '@wirelineio/codec-protobuf';

import { FeedDescriptor, getDescriptor } from './feed-descriptor';
import IndexDB from './index-db';
import schema from './schema.json';

const debug = require('debug')('megafeed:feed-map');

const codec = new Codec({ verify: true });
codec.loadFromJSON(JSON.parse(schema));

const STORE_NAMESPACE = 'feed';

/**
 * FeedStore
 *
 * Management of multiple feeds to create, update, load, find and delete feeds
 * into a persist repository storage.
 *
 * @extends {EventEmitter}
 */
class FeedStore extends EventEmitter {
  /**
   * Create and initialize a new FeedStore
   *
   * @static
   * @param {HyperTrie} db
   * @param {RandomAccessStorage} storage RandomAccessStorage to use by default by the feeds.
   * @param {Object} options
   * @param {Object} options.feedOptions Default options for each feed.
   * @param {Object} options.codecs Define a list of available codecs to work with the feeds.
   * @returns {Promise<FeedStore>}
   */
  static async create (db, storage, options = {}) {
    const feedStore = new FeedStore(db, storage, options);
    await feedStore.initialize();
    return feedStore;
  }

  /*
   * Access to the feed descriptor.
   *
   * @returns {FeedDescriptor} descriptor
   */
  static getDescriptor (feed) {
    return getDescriptor(feed);
  }

  /**
   * constructor
   *
   * @param {HyperTrie} db
   * @param {RandomAccessStorage} storage RandomAccessStorage to use by default by the feeds.
   * @param {Object} options
   * @param {Object} options.feedOptions Default options for each feed.
   */
  constructor (db, storage, options = {}) {
    super();

    const { feedOptions = {}, codecs = {} } = options;

    this._indexDB = new IndexDB(
      db,
      {
        encode: message => codec.encode({ type: 'Feed', message }),
        decode: buffer => codec.decode(buffer, false)
      }
    );

    this._defaultStorage = storage;

    this._defaultFeedOptions = feedOptions;

    this.setCodecs(codecs);

    this._descriptors = new Map();

    this._ready = false;
  }

  /**
   * Initialized FeedStore reading the persisted options and created each FeedDescriptor.
   *
   * @returns {Promise}
   */
  async initialize () {
    const list = await this._indexDB.list(STORE_NAMESPACE);

    await Promise.all(
      list.map(async (data) => {
        const { path, ...options } = data;

        this._createDescriptor(path, options);
      })
    );

    process.nextTick(() => {
      this._ready = true;
      this.emit('ready');
    });
  }

  async ready () {
    if (this._ready) {
      return;
    }

    return new Promise((resolve) => {
      this.once('ready', resolve);
    });
  }

  /*
   * Set a list of available codecs to work with the feeds.
   *
   * @returns {FeedStore}
   */
  setCodecs (codecs) {
    this._codecs = Object.assign({}, codecs);

    Object.keys(this._codecs).forEach((prop) => {
      if (!this._codecs[prop].name) {
        this._codecs[prop].name = prop;
      }
    });

    return this;
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
   * Get the list of the opened descriptors.
   *
   * @returns {FeedDescriptor[]}
   */
  getOpenedDescriptors () {
    return this.getDescriptors()
      .filter(descriptor => descriptor.opened);
  }

  /**
   * Get a descriptor by a key.
   *
   * @param {Buffer} key
   * @returns {FeedDescriptor}
   */
  getDescriptorByKey (key) {
    return this.getDescriptors().find(descriptor => descriptor.key.equals(key));
  }

  /**
   * Get a descriptor by a path.
   *
   * @param {String} path
   * @returns {FeedDescriptor}
   */
  getDescriptorByPath (path) {
    return this.getDescriptors().find(descriptor => descriptor.path === path);
  }

  /**
   * Get the list of opened feeds.
   *
   * @returns {Hypercore[]}
   */
  getFeeds () {
    return this.getOpenedDescriptors()
      .map(descriptor => descriptor.feed);
  }

  /**
   * Find a feed using a filter callback.
   *
   * @param {descriptorCallback} callback
   * @returns {Hypercore}
   */
  findFeed (cb) {
    const descriptor = this.getOpenedDescriptors()
      .find(descriptor => cb(descriptor));

    if (descriptor) {
      return descriptor.feed;
    }
  }

  /**
   * Filter feeds using a filter callback.
   *
   * @param {descriptorCallback} callback
   * @returns {Hypercore[]}
   */
  filterFeeds (cb) {
    const descriptors = this.getOpenedDescriptors()
      .filter(descriptor => cb(descriptor));

    return descriptors.map(descriptor => descriptor.feed);
  }

  /**
   * Load feeds using a filter callback.
   *
   * @param {descriptorCallback} callback
   * @returns {Promise<Hypercore[]>}
   */
  async loadFeeds (cb) {
    await this.ready();

    const descriptors = this.getDescriptors()
      .filter(descriptor => cb(descriptor));

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
   * @param {String} path
   * @param {Object} options
   * @param {Buffer} options.key
   * @param {Buffer} options.secretKey
   * @param {String} options.valueEncoding
   * @param {Object} options.metadata
   * @returns {Hypercore}
   */
  async openFeed(path, options = {}) {
    assert(path, 'The path is required.')

    await this.ready();

    const { key } = options;

    let descriptor = this.getDescriptorByPath(path);

    if (descriptor && key && !key.equals(descriptor.key)) {
      throw new Error(`FeedStore: You are trying to open a feed with a different public key "${key.toString('hex')}".`);
    }

    if (!descriptor && key && this.getDescriptorByKey(key)) {
      throw new Error(`FeedStore: There is already a feed registered with the public key "${key.toString('hex')}"`);
    }

    if (!descriptor) {
      descriptor = this._createDescriptor(path, options);
    }

    return this._openFeed(descriptor);
  }

  /**
   * Close a feed by the path.
   *
   * @param {String} path
   * @returns {Promise}
   */
  async closeFeed(path) {
    assert(path, 'The path is required.')

    await this.ready();

    const descriptor = this.getDescriptorByPath(path);

    if (!descriptor) {
      throw new Error('Feed not found to close.');
    }

    return descriptor.close();
  }

  /**
   * Remove a descriptor from the indexDB by the path.
   *
   * IMPORTANT: This operation would not close the feed.
   *
   * @param {String} path
   * @returns {Promise}
   */
  async deleteDescriptor(path) {
    assert(path, 'The path is required.')

    await this.ready();

    const descriptor = this.getDescriptorByPath(path);

    let release;
    try {
      release = await descriptor.lock();

      await this._indexDB.delete(`${STORE_NAMESPACE}/${descriptor.key.toString('hex')}`);

      this._descriptors.delete(descriptor.discoveryKey.toString('hex'));

      this.emit('descriptor-remove', descriptor);
      await release();
    } catch (err) {
      await release();
      debug(err);
      throw err;
    }
  }

  /**
   * Close the hypertrie and their feeds.
   *
   * @returns {Promise}
   */
  async close () {
    await this.ready();

    try {
      await Promise.all(this.getOpenedDescriptors().map(fd => fd.close()));
      await this._indexDB.close();
    } catch (err) {
      debug(err);
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
   * @param {String} options.valueEncoding
   * @param {Object} options.metadata
   * @returns {FeedDescriptor}
   */
  _createDescriptor(path, options) {
    const defaultOptions = this._defaultFeedOptions;

    const { key, secretKey, metadata } = options;
    let { valueEncoding = defaultOptions.valueEncoding } = options;

    assert(!secretKey || (secretKey && key), 'You cannot have a secretKey without a publicKey.');
    assert(!valueEncoding || typeof valueEncoding === 'string', 'The valueEncoding can only be string.');

    valueEncoding = this._codecs[valueEncoding] || valueEncoding;

    const descriptor = new FeedDescriptor({
      storage: this._defaultStorage,
      path,
      key,
      secretKey,
      valueEncoding,
      metadata
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

    let release;

    try {
      await descriptor.open();

      release = await descriptor.lock();

      await this._persistFeed(descriptor);

      this._defineFeedEvents(descriptor);

      await release();

      return descriptor.feed;
    } catch (err) {
      debug(err);
      await release();
      throw err;
    }
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
    const data = await this._indexDB.get(key);
    const newData = descriptor.serialize();

    if (!data || (JSON.stringify(data) !== JSON.stringify(newData))) {
      await this._indexDB.put(key, newData);
    }
  }

  /**
   * Bubblings events from each feed to FeedStore.
   *
   * @private
   * @param {FeedDescriptor} descriptor
   * @returns {undefined}
   */
  _defineFeedEvents (descriptor) {
    const { feed } = descriptor;

    feed.on('append', () => this.emit('append', feed, descriptor));
    feed.on('download', (...args) => this.emit('download', ...args, feed, descriptor));

    process.nextTick(() => this.emit('feed', feed, descriptor));
  }
}

/**
 * Callback to filter and/or find descriptors.
 *
 * @callback descriptorCallback
 * @param {FeedDescriptor} descriptor
 */

export default FeedStore;
