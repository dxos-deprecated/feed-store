//
// Copyright 2019 DxOS.
//

import ram from 'random-access-memory';
import crypto from 'hypercore-crypto';

import FeedDescriptor from './feed-descriptor';

describe('FeedDescriptor', () => {
  let fd = null;

  test('Create', () => {
    const fd = new FeedDescriptor('/foo');

    expect(fd).toBeInstanceOf(FeedDescriptor);
    expect(fd.path).toBe('/foo');
    expect(fd.key).toBeDefined();
    expect(fd.secretKey).toBeDefined();
  });

  test('Validate asserts', () => {
    expect(() => new FeedDescriptor()).toThrow(/path is required/);
    expect(() => new FeedDescriptor('/foo', { key: 'foo' })).toThrow(/key must be a buffer/);
    expect(() => new FeedDescriptor('/foo', { key: crypto.keyPair().publicKey, secretKey: 'foo' })).toThrow(/secretKey must be a buffer/);
    expect(() => new FeedDescriptor('/foo', { secretKey: crypto.keyPair().secretKey })).toThrow(/cannot have a secretKey without a key/);
    expect(() => new FeedDescriptor('/foo', { valueEncoding: {} })).toThrow(/valueEncoding must be a string/);
  });

  test('Create custom options', () => {
    const { publicKey, secretKey } = crypto.keyPair();

    const metadata = {
      subject: 'books'
    };

    fd = new FeedDescriptor('/books', {
      storage: ram,
      key: publicKey,
      secretKey,
      valueEncoding: 'json',
      metadata
    });

    expect(fd).toBeInstanceOf(FeedDescriptor);
    expect(fd.path).toBe('/books');
    expect(fd.key).toBeInstanceOf(Buffer);
    expect(fd.secretKey).toBeInstanceOf(Buffer);
    expect(fd.metadata).toEqual(metadata);
    expect(fd.valueEncoding).toBe('json');
  });

  test('Open', async () => {
    expect(fd.feed).toBeNull();
    expect(fd.opened).toBe(false);

    // Opening multiple times should actually open once.
    const [feed1, feed2] = await Promise.all([fd.open(), fd.open()]);
    expect(feed1).toBe(feed2);

    expect(fd.feed).toBe(feed1);
    expect(fd.feed.key).toBeInstanceOf(Buffer);
    expect(fd.opened).toBe(true);
  });

  test('Close', async () => {
    // Closing multiple times should actually close once.
    await Promise.all([fd.close(), fd.close()]);
    expect(fd.opened).toBe(false);

    fd.feed.append('test', (err) => {
      expect(err.message).toContain('This feed is not writable');
    });
  });

  test('on open error should unlock the resource', async () => {
    const fd = new FeedDescriptor('/foo', {
      storage: ram,
      hypercore: () => {
        throw new Error('open error');
      }
    });

    await expect(fd.open()).rejects.toThrow(/open error/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });

  test('on close error should unlock the resource', async () => {
    const fd = new FeedDescriptor('/foo', {
      storage: ram,
      hypercore: () => ({
        opened: true,
        ready (cb) { cb(); },
        close () {
          throw new Error('close error');
        }
      })
    });

    await fd.open();

    await expect(fd.close()).rejects.toThrow(/close error/);

    const release = await fd.lock();
    expect(release).toBeDefined();
    await release();
  });
});
