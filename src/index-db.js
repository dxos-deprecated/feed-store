//
// Copyright 2019 DxOS.
//

import pify from 'pify';

/**
 * Index feed descriptors.
 */
class IndexDB {
  /**
   * @constructor
   * @param {Hypertrie} db
   */
  constructor (db) {
    console.assert(db);

    this._db = {
      put: pify(db.put.bind(db)),
      get: pify(db.get.bind(db)),
      delete: pify(db.del.bind(db)),
      list: pify(db.list.bind(db)),
      close: pify(db.feed.close.bind(db.feed))
    };
  }

  async list (path) {
    const list = await this._db.list(`${path}/`);
    return list.map(({ value }) => value);
  }

  async get (key) {
    const item = await this._db.get(key);
    return item && item.value;
  }

  async put (key, value) {
    return this._db.put(key, value);
  }

  async delete (key) {
    return this._db.delete(key);
  }

  async close () {
    return this._db.close();
  }
}

export default IndexDB;
