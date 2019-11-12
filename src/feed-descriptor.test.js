import ram from 'random-access-memory';
import crypto from 'hypercore-crypto';

import { FeedDescriptor } from './feed-descriptor';

describe('FeedDescriptor operations', () => {
  let fd = null;

  test('Create with empty', () => {
    const fd = new FeedDescriptor();

    expect(fd).toBeInstanceOf(FeedDescriptor);
    expect(fd.path).toBe(fd.key.toString('hex'));
    expect(fd.secretKey).toBeDefined();
  });

  test('Create custom keys', () => {
    const { publicKey, secretKey } = crypto.keyPair();
    const fd = new FeedDescriptor({
      path: '/test',
      key: publicKey,
      secretKey
    });

    expect(fd.key).toBe(publicKey);
    expect(fd.secretKey).toBe(secretKey);
  });

  test('Create custom options', () => {
    const metadata = {
      subject: 'books'
    };

    fd = new FeedDescriptor({
      storage: ram,
      path: '/books',
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

  test('Serialize metadata with buffers', async () => {
    const metadata = {
      subject: 'books',
      aBuffer: Buffer.from('test')
    };

    const fd = new FeedDescriptor({
      storage: ram,
      path: '/books',
      valueEncoding: 'json',
      metadata
    });

    expect(fd.metadata).toEqual(metadata);

    const data = fd.serialize();
    expect(data.metadata).toBeInstanceOf(Buffer);

    const fd2 = new FeedDescriptor(Object.assign({}, {
      storage: ram
    }, data));

    expect(fd2.metadata).toEqual(metadata);
    expect(fd2.metadata.aBuffer.toString()).toBe('test');
  });
});
