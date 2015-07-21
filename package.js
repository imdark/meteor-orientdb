Package.describe({
  name: 'imdark:meteor-orientdb',
  version: '0.0.1',
  // Brief, one-line summary of the package.
  summary: '',
  // URL to the Git repository containing the source code for this package.
  git: '',
  // By default, Meteor will default to using README.md for documentation.
  // To avoid submitting documentation, set this field to null.
  documentation: 'README.md'
});

Npm.depends({
  orientjs: "https://github.com/imdark/orientjs/archive/fd27c62a38f77dbf62ff7ddb3dfecaef01b8b8ba.tar.gz"
});

Package.onUse(function(api) {
  api.versionsFrom('1.1.0.2');
  api.addFiles('orient.js');
  api.addFiles(['./server/LiveOrientDB.js', './server/LiveOrientoSelect.js'], 'server');
  api.addFiles('./lib/OrientDBSubscription.js', ['client', 'server']);
  api.use('tracker');
  api.use('underscore');
});

Package.onTest(function(api) {
  api.use('tinytest');
  api.use('imdark:meteor-orientdb');
  api.addFiles('orient-tests.js');
});
