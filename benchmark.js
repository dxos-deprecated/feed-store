//
// Copyright 2019 DxOS.
//

const ram = require('random-access-memory');
const { Suite } = require('@dxos/benchmark-suite');

const { FeedStore } = require('.');

const range = n => [...Array(n).keys()];

(async () => {
  const maxFeeds = 5;
  const maxMessages = 10000;
  const expectedMessages = count => {
    if (count !== maxFeeds * maxMessages) {
      throw new Error('messages amount expected incorrect');
    }
  };

  const fs = await FeedStore.create(ram, { feedOptions: { valueEncoding: 'utf8' } });
  const suite = new Suite(fs, { maxFeeds, maxMessages });

  suite.beforeAll(() => {
    return Promise.all(range(maxFeeds).map(async i => {
      const name = `feed/${i}`;
      const feed = await fs.openFeed(name);

      for (let i = 0; i < maxMessages; i++) {
        await new Promise((resolve, reject) => {
          feed.append(`${name}/${i}`, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      }

      return feed;
    }));
  });

  suite.test('getBatch', async ({ context }) => {
    let count = 0;

    await Promise.all(fs.getOpenFeeds().map(feed => {
      return new Promise((resolve, reject) => {
        feed.getBatch(0, maxMessages, (err, result) => {
          count += result.length;
          if (err) return reject(err);
          resolve();
        });
      });
    }));

    expectedMessages(count);
  });

  suite.test('createReadStream', async () => {
    const stream = fs.createReadStream({ batch: 100 });
    let count = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', (data) => {
        count++;
        if (count === maxMessages) resolve();
      });
    });

    expectedMessages(count);
  });

  suite.test('createBatchStream', async () => {
    const stream = fs.createBatchStream({ batch: 100 });
    let count = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', (data) => {
        count += data.length;
        if (count === maxMessages) resolve();
      });
    });

    expectedMessages(count);
  });

  const results = await suite.run();

  suite.print(results);
})();
