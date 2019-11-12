//
// Copyright 2019 Wireline, Inc.
//

import path from 'path';
import assert from 'assert';
import crypto from 'hypercore-crypto';

import hypercore from 'hypercore';
import raf from 'random-access-file';
import pify from 'pify';
import bufferJson from 'buffer-json-encoding';

import Locker from './locker';

const kDescriptor = Symbol('descriptor');

/**
 * FeedDescriptor
 *
 * Abstract handler for an Hypercore instance.
 */
class FeedDescriptor {
  /**
   * constructor
   *
   * @param {Object} options
   * @param {RandomAccessStorage} options.storage
   * @param {String} options.path
   * @param {Buffer} options.key
   * @param {Buffer} options.secretKey
   * @param {Object|String} options.valueEncoding
   * @param {Object|Buffer} options.metadata
   */
  constructor (options = {}) {
    const { storage, path, key, secretKey, valueEncoding, metadata = {} } = options;

    assert(!path || (typeof path === 'string' && path.length > 0), 'FeedDescriptor: path is required.');
    assert(!key || Buffer.isBuffer(key), 'FeedDescriptor: key must be a buffer.');
    assert(!secretKey || Buffer.isBuffer(secretKey), 'FeedDescriptor: secretKey must be a buffer.');
    assert(!valueEncoding || typeof valueEncoding === 'string' || (typeof valueEncoding === 'object' && valueEncoding.name),
      'FeedDescriptor: valueEncoding must be a string or a codec object with a name prop that could be serializable.');

    this._storage = storage;
    this._path = path;
    this._key = key;
    this._secretKey = secretKey;
    this._valueEncoding = valueEncoding;

    if (Buffer.isBuffer(metadata)) {
      this._metadata = bufferJson.decode(metadata);
    } else {
      this._metadata = Object.assign({}, metadata);
    }

    if (!this._key) {
      const { publicKey, secretKey } = crypto.keyPair();
      this._key = publicKey;
      this._secretKey = secretKey;
    }

    this._discoveryKey = crypto.discoveryKey(this._key);

    if (!this._path) {
      this._path = this._key.toString('hex');
    }

    this._locker = new Locker();

    this._feed = null;
  }

  /**
   * @type {String}
   */
  get path () {
    return this._path;
  }

  /**
   * @type {Hypercore|null}
   */
  get feed () {
    return this._feed;
  }

  /**
   * @type {Boolean}
   */
  get opened () {
    return !!(this.feed && this._feed.opened && !this._feed.closed);
  }

  /**
   * @type {Buffer}
   */
  get key () {
    return this._key;
  }

  /**
   * @type {Buffer}
   */
  get secretKey () {
    return this._secretKey;
  }

  /**
   * @type {Buffer}
   */
  get discoveryKey() {
    return this._discoveryKey;
  }

  /**
   * @type {Object|String}
   */
  get valueEncoding () {
    return this._valueEncoding;
  }

  /**
   * @type {Object}
   */
  get metadata () {
    return this._metadata;
  }

  /**
   * Serialize the options need it for encoding.
   *
   * @returns {Object}
   */
  serialize () {
    const valueEncoding = this._valueEncoding;

    return {
      path: this._path,
      key: this._key,
      secretKey: this._secretKey,
      valueEncoding: typeof valueEncoding === 'object' ? valueEncoding.name : valueEncoding,
      metadata: bufferJson.encode(this._metadata)
    };
  }

  /*
   * Lock the resource.
   *
   * @returns {function} release
   */
  async lock () {
    return this._locker.lock();
  }

  /**
   * Open an Hypercore feed based on the related feed options.
   *
   * This is an atomic operation, FeedDescriptor makes
   * sure that the feed is not going to open again.
   *
   * @returns {Promise<Hypercore>}
   */
  async open () {
    const release = await this.lock();

    if (this.opened) {
      await release();
      return this._feed;
    }

    try {
      this._feed = hypercore(
        this._createStorage(this._key.toString('hex')),
        this._key,
        {
          secretKey: this._secretKey,
          valueEncoding: this._valueEncoding
        }
      );

      this._feed[kDescriptor] = this;

      await pify(this._feed.ready.bind(this._feed))();

      await release();

      return this._feed;
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Close the Hypercore referenced by the descriptor.
   *
   * @returns {Promise}
   */
  async close () {
    const release = await this.lock();

    try {
      if (this.opened) {
        await pify(this._feed.close.bind(this._feed))();
      }

      await release();
    } catch (err) {
      await release();
      throw err;
    }
  }

  /**
   * Defines the real path where the Hypercore is going
   * to work with the RandomAccessStorage specified.
   *
   * @private
   * @param {String} dir
   * @returns {Function}
   */
  _createStorage (dir) {
    const ras = this._storage;

    return (name) => {
      if (typeof ras === 'string') {
        return raf(path.join(ras, dir, name));
      }
      return ras(`${dir}/${name}`);
    };
  }
}

function getDescriptor (feed) {
  return feed[kDescriptor];
}

export { FeedDescriptor, getDescriptor };
