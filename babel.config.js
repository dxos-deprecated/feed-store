//
// Copyright 2019 Wireline, Inc.
//

module.exports = {
  presets: [
    [
      '@babel/preset-env'
    ]
  ],
  plugins: [
    [
      'babel-plugin-inline-import', {
        extensions: [
          '.proto',
          '.txt',
          '.json'
        ]
      }
    ],
    'add-module-exports',
    '@babel/plugin-proposal-export-default-from'
  ]
};
