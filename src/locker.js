//
// Copyright 2019 DxOS.
//

import mutexify from 'mutexify';

class Locker {
  constructor () {
    this._lock = mutexify();
  }

  lock () {
    return new Promise((resolve) => {
      this._lock((cbRelease) => {
        const release = () => new Promise(resolve => cbRelease(resolve));
        resolve(release);
      });
    });
  }
}

export default Locker;
