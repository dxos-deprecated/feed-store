//
// Copyright 2019 DxOS.
//

import assert from 'assert';
import multi from 'multi-read-stream';
import pump from 'pump';
import through from 'through2';
import eos from 'end-of-stream';

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
  }

  /**
   * @type {ReadableStream}
   */
  get stream () {
    return this._stream;
  }

  /**
   * Destroy stream.
   *
   * @param {Error} [err] Optional error object.
   */
  destroy (err) {
    process.nextTick(() => {
      if (!this._stream.destroyed) {
        this._stream.destroy(err);
      }
    });
  }

  /**
   * Adds a feed stream and stream the block data, seq, key and metadata.
   *
   * @param {FeedDescriptor} descriptor
   */
  async addFeedStream (descriptor) {
    const { feed, path, key, metadata } = descriptor;

    if (!feed || this._feeds.has(feed) || this._stream.destroyed) {
      return;
    }

    let streamOptions = await this._filter(descriptor);
    if (!streamOptions) {
      return;
    }

    streamOptions = Object.assign({}, this._options, typeof streamOptions === 'object' ? streamOptions : {});

    const { feedStoreInfo = false, ...feedStreamOptions } = streamOptions;

    const stream = feed.createReadStream(feedStreamOptions);

    eos(stream, () => {
      this._feeds.delete(feed);
    });

    if (!feedStoreInfo) {
      this._stream.add(stream);
      this._feeds.add(feed);
      return;
    }

    let seq = feedStreamOptions.start === undefined ? 0 : feedStreamOptions.start;

    const addFeedStoreInfo = through.obj((chunk, _, next) => {
      next(null, { data: chunk, seq: seq++, path, key, metadata });
    });

    this._stream.add(pump(stream, addFeedStoreInfo));
    this._feeds.add(feed);
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
}
