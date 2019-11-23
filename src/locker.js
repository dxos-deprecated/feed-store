//
// Copyright 2019 DxOS.
//

import mutexify from 'mutexify';

/**
 * Async mutex.
 */
class Locker {
  constructor () {
    this._lock = mutexify();
  }

  async lock () {
    return new Promise((resolve) => {
      this._lock((callback) => {
        const release = () => new Promise(resolve => callback(resolve));
        resolve(release);
      });
    });
  }
}

export default Locker;
