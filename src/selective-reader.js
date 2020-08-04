//
// Copyright 2019 DXOS.org
//

import { Readable } from 'stream';
import createBatchStream from './create-batch-stream';

/**
 * Creates a multi ReadableStream for feed streams.
 */
export default class SelectiveReader extends Readable {
  /** @type {(feedDescriptor, message) => Promise<boolean>} */
  _evaluator;

  /** @type {Set<{ descriptor: FeedDescriptor, stream: any, buffer: any[] }>} */
  _feeds = new Set();

  /** @type {() => void} */
  _wakeUpReader;

  /** @type {Promise} */
  _hasData;

  /**
   * A guard to ensure `_read` is only executing once at a given time.
   */
  _reading = false;

  /**
   * Flag that gets set when `_read` gets called while the previous calls hasn't finished executing.
   * Used to signal to keep reading more messages.
   */
  _needsData = false;

  constructor (evaluator) {
    super({ objectMode: true });

    this._evaluator = evaluator;
    this._resetDataLock();
  }

  _resetDataLock () {
    this._hasData = new Promise(resolve => { this._wakeUpReader = resolve; });
  }

  async _read () {
    // `_read` can be called multiple times, this is a guard to ensure only single "thread" is executing read at a given time.
    if (this._reading) {
      this._needsData = true;
      return;
    }
    this._reading = true;
    this._needsData = false;

    // Main read loop, we break out of the loop when `this.push` returns false, meaning that we don't need to enque any more data.
    while (true) {
      // Sets `_hasData` promise to pending state. It is resolved once any of the feed streams fire `readable` event.
      this._resetDataLock();

      for (const feed of this._feeds.values()) {
        // If our internal buffer is empty, read from the feed.
        if (feed.buffer.length === 0) {
          const messages = feed.stream.read();
          if (!messages) continue; // No new messages, skipping to the next feed.
          feed.buffer.push(...messages);
        }

        let message;
        while ((message = feed.buffer.shift())) { // Drain the buffer one message at a time.
          if (await this._evaluator(feed.descriptor, message)) {
            // Since we are sending a message to the stream, we need to re-run the evaluator on the feeds we previously rejected.
            // This prevents us from gettings stuck on `this._hasData` promise.
            // TODO(marik-d): Is there a better way to do this?
            process.nextTick(() => this._wakeUpReader());
            this._needsData = false;
            if (!this.push(message)) {
              // Once `this.push` returns false, we have pushed enough data and can finish.
              this._reading = false;
              return;
            }
          } else {
            // Push the message we rejected back into the queue.
            feed.buffer.unshift(message);
            break;
          }
        }
      }

      // Yield so that other tasks can be processed,
      await new Promise(resolve => setTimeout(resolve, 0));

      // If we need to push more data and have them in the buffer, attempt to do the processing again.
      // TODO(marik-d): Can this cause an infitine loop?
      if (this._needsData && Array.from(this._feeds.values()).some(x => x.buffer.length > 0)) {
        continue;
      }
      // Wait for once of the feed stream to fire `readable` event
      await this._hasData;
    }
  }

  async addInitialFeedStreams (descriptors) {
    for (const descriptor of descriptors) {
      this.addFeedStream(descriptor);
    }
  }

  /**
   * Adds a feed stream and stream the block data, seq, key and metadata.
   *
   * @param {FeedDescriptor} descriptor
   */
  async addFeedStream (descriptor) {
    const stream = createBatchStream(descriptor.feed, { live: true });

    stream.on('readable', () => {
      this._wakeUpReader();
      this._read();
    });

    this._feeds.add({ descriptor, stream, buffer: [] });
  }
}
