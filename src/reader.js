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
    if (this.synced) {
      this._stream.emit('synced', this._syncState);
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

  _checkFeedSync (feed, seq, synced) {
    if (this.synced) return;
    if (synced && this._feedsToSync.has(feed)) {
      this._syncState[feed.key.toString('hex')] = seq;
      this._feedsToSync.delete(feed);
      return this.synced;
    }

    return false;
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

    streamOptions = Object.assign({}, this._options, typeof streamOptions === 'object' ? streamOptions : {});

    const stream = createBatchStream(feed, { metadata: { path, metadata }, ...streamOptions });

    eos(stream, () => {
      this._feeds.delete(feed);
    });

    const transform = through.obj((messages, _, next) => {
      const last = messages[messages.length - 1];
      const synced = this._checkFeedSync(feed, last.seq, last.synced);

      if (this._inBatch) {
        transform.push(messages);
      } else {
        for (const message of messages) {
          transform.push(message);
        }
      }

      if (synced) {
        this._stream.emit('synced', this._syncState);
      }

      next();
    });

    this._stream.add(pump(stream, transform));
    this._feeds.add(feed);
  }
}
