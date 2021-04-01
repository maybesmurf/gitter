'use strict';

// See https://stackoverflow.com/a/58394828/796832
//
// We're removing all of the resolved entries in `package-lock.json`
// for `graceful-fs` so it can install the latest next time we `npm install`
//
// For example, we had 115 references to `graceful-fs` before and after running
// this script we have 60 because all of gulp packages are just relying
// on a single `graceful-fs@4.2.6` version now!

const path = require('path');
const fs = require('fs-extra');
const lockfile = require('../package-lock.json');

function recurseOverLockfile(lockfile) {
  if (lockfile.dependencies) {
    // Remove all of the `graceful-fs` entries defining the resolved package
    Object.keys(lockfile.dependencies).forEach(depKey => {
      if (depKey === 'graceful-fs') {
        delete lockfile.dependencies[depKey];
      } else {
        lockfile.dependencies[depKey] = recurseOverLockfile(lockfile.dependencies[depKey]);
      }
    });
  }

  if (lockfile.requires) {
    // Update all of the `graceful-fs` entries for the new version
    Object.keys(lockfile.requires).forEach(depKey => {
      if (depKey === 'graceful-fs') {
        lockfile.requires[depKey] = '^4.2.6';
      }
    });
  }

  return lockfile;
}

async function exec() {
  const resultantLockfile = recurseOverLockfile(lockfile);
  console.log('asfd', resultantLockfile);

  await fs.outputFile(
    path.join(__dirname, '../package-lock-result.json'),
    JSON.stringify(resultantLockfile, null, 2)
  );
}

exec();
