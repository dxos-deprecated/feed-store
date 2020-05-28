//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import multi from 'multi-read-stream';
import pump from 'pump';
import through from 'through2';
import eos from 'end-of-stream';

import createReadStream from './create-read-stream';

const all = () => true;

/**
 * Creates a multi ReadableStream for feed streams.
 */
export default class Reader {
  /**
   * constructor
   *
   * @param {StreamCallback|Object} [callback] Filter function to return options for each feed.createReadStream (returns `false` will ignore the feed) or default object options for each feed.createReadStream(options)
   */
  constructor (filter) {
    assert(typeof filter === 'function' || typeof filter === 'object');

    if (typeof filter === 'function') {
      this._filter = filter;
      this._options = {};
    } else {
      this._filter = all;
      this._options = filter;
    }

    this._stream = multi.obj({ autoDestroy: false });
    this._feeds = new Set();
    this._feedsToSync = new Set();
    this._syncState = {};
  }

  /**
   * @type {ReadableStream}
   */
  get stream () {
    return this._stream;
  }

  get synced () {
    return this._feedsToSync.size === 0;
  }

  /**
   * Destroy stream.
   *
   * @param {Error} [err] Optional error object.
   */
  destroy (err) {
    process.nextTick(() => {
      this._stream.destroy(err);
    });
  }

  async addInitialFeedStreams (descriptors) {
    const validFeeds = await Promise.all(descriptors.map(async descriptor => {
      const streamOptions = await this._getFeedStreamOptions(descriptor);
      if (!streamOptions) return null;
      this._feedsToSync.add(descriptor.feed);
      return { descriptor, streamOptions };
    }));

    validFeeds.filter(Boolean).forEach(({ descriptor, streamOptions }) => {
      this._addFeedStream(descriptor, streamOptions);
    });
  }

  /**
   * Adds a feed stream and stream the block data, seq, key and metadata.
   *
   * @param {FeedDescriptor} descriptor
   */
  async addFeedStream (descriptor) {
    const streamOptions = await this._getFeedStreamOptions(descriptor);
    if (!streamOptions) {
      return false;
    }

    this._addFeedStream(descriptor, streamOptions);
    return true;
  }

  /**
   * Execute a callback on end of the stream.
   *
   * @param {function} [callback]
   */
  onEnd (callback) {
    eos(this._stream, (err) => {
      callback(err);
    });
  }

  _checkFeedSync (feed, len, seq) {
    if (this.synced) return;
    if (len === seq && this._feedsToSync.has(feed)) {
      this._syncState[feed.key.toString('hex')] = seq;
      this._feedsToSync.delete(feed);
      if (this.synced) {
        process.nextTick(() => {
          this._stream.emit('synced', this._syncState);
        });
      }
    }
  }

  async _getFeedStreamOptions (descriptor) {
    const { feed } = descriptor;

    if (!feed || this._feeds.has(feed) || this._stream.destroyed) {
      return false;
    }

    const streamOptions = await this._filter(descriptor);
    if (!streamOptions) {
      return false;
    }

    return streamOptions;
  }

  _addFeedStream (descriptor, streamOptions) {
    const { feed, path, key, metadata } = descriptor;

    streamOptions = Object.assign({}, this._options, typeof streamOptions === 'object' ? streamOptions : {});

    const { feedStoreInfo = false, ...feedStreamOptions } = streamOptions;

    const stream = createReadStream(feed, feedStreamOptions);

    eos(stream, () => {
      this._feeds.delete(feed);
    });

    const len = feed.length === 0 ? 0 : feed.length - 1;
    let seq = feedStreamOptions.start === undefined ? 0 : feedStreamOptions.start;
    let currentSeq = seq;
    const addFeedStoreInfo = through.obj((chunk, _, next) => {
      currentSeq = seq++;

      this._checkFeedSync(feed, len, currentSeq);

      if (feedStoreInfo) {
        next(null, { data: chunk, seq: currentSeq, path, key, metadata });
      } else {
        next(null, chunk);
      }
    });

    this._stream.add(pump(stream, addFeedStoreInfo));
    this._feeds.add(feed);
  }
}
