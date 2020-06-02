//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import multi from 'multi-read-stream';
import pump from 'pump';
import through from 'through2';
import eos from 'end-of-stream';

import createBatchStream from './create-batch-stream';

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
  constructor (filter, inBatch = false) {
    assert(typeof filter === 'function' || typeof filter === 'object');

    if (typeof filter === 'function') {
      this._filter = filter;
      this._options = {};
    } else {
      this._filter = all;
      this._options = filter;
    }

    this._inBatch = inBatch;
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

  get sync () {
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

      // feeds to sync
      if (descriptor.feed.length > 0) {
        this._feedsToSync.add(descriptor.feed);
      }

      this._syncState[descriptor.key.toString('hex')] = 0;

      return { descriptor, streamOptions };
    }));

    validFeeds.filter(Boolean).forEach(({ descriptor, streamOptions }) => {
      this._addFeedStream(descriptor, streamOptions);
    });

    // empty feedsToSync
    if (this.sync) {
      this._stream.emit('sync', this._syncState);
    }
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

  _checkFeedSync (feed, seq, sync) {
    if (this.sync) return;
    if (sync && this._feedsToSync.has(feed)) {
      this._syncState[feed.key.toString('hex')] = seq;
      this._feedsToSync.delete(feed);
      if (this.sync) {
        process.nextTick(() => this._stream.emit('sync', this._syncState));
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
    const { feed, path, metadata } = descriptor;

    streamOptions = Object.assign({
      metadata: { path, metadata }
    }, this._options, typeof streamOptions === 'object' ? streamOptions : {});

    const stream = createBatchStream(feed, streamOptions);

    eos(stream, () => {
      this._feeds.delete(feed);
    });

    const transform = through.obj((messages, _, next) => {
      if (this._inBatch) {
        transform.push(messages);
      } else {
        for (const message of messages) {
          transform.push(message);
        }
      }

      const last = messages[messages.length - 1];
      this._checkFeedSync(feed, last.seq, last.sync);

      next();
    });

    this._stream.add(pump(stream, transform));
    this._feeds.add(feed);
  }
}
