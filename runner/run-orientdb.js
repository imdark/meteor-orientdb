var files = require('./files.js');
var child_process = require('child_process');

var _ = require('underscore');
var Future = require('fibers/future');

var utils = {
	sleepMs: function (ms) {
	  if (ms <= 0)
	    return;

	  var fut = new Future;
	  setTimeout(function () { fut['return']() }, ms);
	  fut.wait();
	}
};

var fiberHelpers = {
	bindEnvironment: function (func) {
	  var boundValues = _.clone(Fiber.current._meteorDynamics || {});

	  return function (/* arguments */) {
	    var self = this;
	    var args = _.toArray(arguments);

	    var runWithEnvironment = function () {
	      var savedValues = Fiber.current._meteorDynamics;
	      try {
	        // Need to clone boundValues in case two fibers invoke this
	        // function at the same time
	        Fiber.current._meteorDynamics = _.clone(boundValues);
	        return func.apply(self, args);
	      } finally {
	        Fiber.current._meteorDynamics = savedValues;
	      }
	    };

	    if (Fiber.current)
	      return runWithEnvironment();
	    Fiber(runWithEnvironment).run();
	  };
	},
	waitForOne: function (/* futures */) {
	  var fiber = Fiber.current;
	  if (!fiber)
	    throw Error("Can't waitForOne without a fiber");
	  if (arguments.length === 0)
	    throw Error("Must wait for at least one future");

	  var combinedFuture = new Future;
	  for (var i = 0; i < arguments.length; ++i) {
	    var f = arguments[i];
	    if (f.isResolved()) {
	      // Move its value into combinedFuture.
	      f.resolve(combinedFuture.resolver());
	      break;
	    }
	    // Otherwise, this function will be invoked when the future is resolved.
	    f.resolve(function (err, result) {
	      if (!combinedFuture.isResolved()) {
	        combinedFuture.resolver()(err, result);
	      }
	    });
	  }

	  return combinedFuture.wait();
	}
};


// Find all running Mongo processes that were started by this program
// (even by other simultaneous runs of this program). If passed,
// appDir and port act as filters on the list of running mongos.
//
// Yields. Returns an array of objects with keys pid, port, appDir.
var findOrientDBPids;
if (process.platform === 'win32') {
  // Windows doesn't have a ps equivalent that (reliably) includes the command
  // line, so approximate using the combined output of tasklist and netstat.
  findOrientDBPids = function (app_dir, port) {
    var fut = new Future;

    child_process.exec('WMIC process where "commandline like \'%com.orientechnologies.orient.server.OServerMain%\' and caption=\'java.exe\'" get caption, processid',
      function (error, stdout, stderr) {
        if (error) {
          var additionalInfo = JSON.stringify(error);
          if (error.code === 'ENOENT') {
            additionalInfo = "wmic wasn't found on your system, it usually can be found at C:\\Windows\\System32\\.";
          }
          fut['throw'](new Error("Couldn't run wmic.exe: " +
            additionalInfo));
          return;
        } else {
          // Find the pids of all mongod processes
          var mongo_pids = [];
          _.each(stdout.split('\n'), function (line) {
            var m = line.match(/^java.exe\s+(\d+) /);
            if (m) {
              mongo_pids[m[1]] = true;
            }
          });

          // Now get the corresponding port numbers
          child_process.exec('netstat -ano', function (error, stdout, stderr) {
            if (error) {
              fut['throw'](new Error("Couldn't run netstat -ano: " +
                JSON.stringify(error)));
              return;
            } else {
              var pids = [];
              _.each(stdout.split('\n'), function (line) {
                var m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
                if (m) {
                  var found_pid =  parseInt(m[2], 10);
                  var found_port = parseInt(m[1], 10);

                  // We can't check the path app_dir so assume it always matches
                  if (mongo_pids[found_pid] && (!port || port === found_port)) {
                    // Note that if the mongo rest interface is enabled the
                    // initial port + 1000 is also likely to be open.
                    // So remove the pid so we only match it once.
                    delete mongo_pids[found_pid];
                    pids.push({
                      pid: found_pid,
                      port: found_port,
                      app_dir: null});
                  }
                }
              });

              fut['return'](pids);
            }
          });
        }
      });

    return fut.wait();
  };
} else {
  findOrientDBPids = function (appDir, port) {
    var fut = new Future;

    // 'ps ax' should be standard across all MacOS and Linux.
    child_process.exec(
      'ps ax',
      // we don't want this to randomly fail just because you're running lots of
      // processes. 10MB should be more than ps ax will ever spit out; the default
      // is 200K, which at least one person hit (#2158).
      {maxBuffer: 1024 * 1024 * 10},
      function (error, stdout, stderr) {
        if (error) {
          fut['throw'](new Error("Couldn't run ps ax: " +
            JSON.stringify(error) + "; " + error.message));
          return;
        }

        var ret = [];
        _.each(stdout.split('\n'), function (line) {
          // Matches mongos we start. Note that this matches
          // 'fake-mongod' (our mongod stub for automated tests) as well
          // as 'mongod'.
          var m = line.match(/^\s*(\d+).+java .*com.orientechnologies.orient.server.OServerMain.*/);
          if (m && m.length === 4) {
            var foundPid =  parseInt(m[1], 10);
            var foundPort = parseInt(m[2], 10);
            var foundPath = m[3];

            if ( (! port || port === foundPort) &&
                 (! appDir || appDir === foundPath)) {
              ret.push({
                pid: foundPid,
                port: foundPort,
                appDir: foundPath
              });
            }
          }
        });

        fut['return'](ret);
      });

    return fut.wait();
  };
}

// See if mongo is running already. Yields. Returns the port that
// mongo is running on or null if mongo is not running.
var findOrientDBPort = function (appDir) {
  var pids = findOrientDBPids(appDir);

  if (pids.length !== 1) {
    return null;
  }

  var pid = pids[0].pid;
  try {
    process.kill(pid, 0); // make sure it is still alive
  } catch (e) {
    return null;
  }

  return pids[0].port;
};

// XXX actually -- the code below is probably more correct than the code we
// have above for non-Windows platforms (since that code relies on
// `findOrientDBPids`). But changing this a few days before the 1.1 release
// seemed too bold. But if you're changing code around here, consider using
// the implementation below on non-Windows platforms as well.
if (process.platform === 'win32') {
  // On Windows, finding the Mongo pid, checking it and extracting the port
  // is often unreliable (XXX reliable in what specific way?). There is an
  // easier way to find the port of running Mongo: look it up in a METEOR-
  // PORT file that we generate when running. This may result into problems
  // where we try to connect to a mongod that is not running, or a wrong
  // mongod if our current app is not running but there is a left-over file
  // lying around. This still can be better than always failing to connect.
  findOrientDBPort = function (appDir) {
    var mongoPort = null;

    var portFile = files.pathJoin(appDir, '.meteor/local/db/METEOR-PORT');
    if (files.exists(portFile)) {
      mongoPort = files.readFile(portFile, 'utf8').replace(/\s/g, '');
    }

    // Now, check if there really is a Mongo server running on this port.
    // (The METEOR-PORT file may point to an old Mongo server that's now
    // stopped)
    var net = require('net');
    var mongoTestConnectFuture = new Future;
    var client = net.connect({port: mongoPort}, function() {
      // The server is running.
      client.end();
      mongoTestConnectFuture.return();
    });
    client.on('error', function () {
      mongoPort = null;
      mongoTestConnectFuture.return();
    });
    mongoTestConnectFuture.wait();

    return mongoPort;
  }
}

// Kill any mongos running on 'port'. Yields, and returns once they
// are all dead. Throws an exception on failure.
//
// This is a big hammer for dealing with still running mongos, but
// smaller hammers have failed before and it is getting tiresome.
var findOrientDBAndKillItDead = function (port, dbPath) {
  var pids = findOrientDBPids(null, port);

  // Go through the list serially. There really should only ever be
  // at most one but we're not taking any chances.
  _.each(pids, function (processInfo) {
    var pid = processInfo.pid;

    // Send kill attempts and wait. First a SIGINT, then if it isn't
    // dead within 2 sec, SIGKILL. Check every 100ms to see if it's
    // dead.
    for (var attempts = 1; attempts <= 40; attempts ++) {
      var signal = 0;
      if (attempts === 1)
        signal = 'SIGINT';
      else if (attempts === 20 || attempts === 30)
        signal = 'SIGKILL';

      try {
        process.kill(pid, signal);
      } catch (e) {
        // it's dead. on to the next one
        return;
      }

      utils.sleepMs(100);
    }

    // give up after 4 seconds.
    // XXX should actually catch this higher up and print a nice
    // error. foreseeable conditions should never result in exceptions
    // for the user.
    throw new Error("Can't kill running mongo (pid " + pid + ").");
  });

  // If we had to kill mongod with SIGKILL, or on Windows where all calls to
  // `process.kill` work like SIGKILL, mongod will not have the opportunity to
  // close gracefully. Delete a lock file that may have been left over.
  var mongodLockFile = files.pathJoin(dbPath, "mongod.lock");
  if (files.exists(mongodLockFile)) {
    files.unlink(mongodLockFile)
  }
};

var StoppedDuringLaunch = function () {};

// Starts a single instance of mongod, and configures it properly as a singleton
// replica set. Yields.  Returns once the mongod is successfully listening (or
// the process exited).
//
// Takes an onExit handler, which will be invoked when the process exits (which
// may be before or after this function returns depending on whether or not it
// ever successfully started).
//
// If the 'multiple' option is set, it actually sets up three mongod instances
// (launching the second and third on the next two ports after the specified
// port). In this case, if any of the three instances exit for any reason, all
// are killed (and onExit is then invoked). Also, the entirety of all three
// databases is deleted before starting up.  This is mode intended for testing
// mongo failover, not for normal development or production use.
var launchMongo = function (options) {
  var onExit = options.onExit || function () {};

  var noOplog = false;
  var mongod_path = files.pathJoin(
    files.getDevBundle(), 'mongodb', 'bin', 'mongod');
  var replSetName = 'meteor';

  // Automated testing: If this is set, instead of starting mongod, we
  // start our stub (fake-mongod) which can then be remote-controlled
  // by the test.
  if (process.env.METEOR_TEST_FAKE_MONGOD_CONTROL_PORT) {
    if (options.multiple)
      throw Error("Can't specify multiple with fake mongod");

    var fakeMongodCommand =
      process.platform === "win32" ? "fake-mongod.bat" : "fake-mongod";
    mongod_path = files.pathJoin(
      files.getCurrentToolsDir(), 'tools',
      'tests', 'fake-mongod', fakeMongodCommand);

    // oplog support requires sending admin commands to mongod, so
    // it'd be hard to make fake-mongod support it.
    noOplog = true;
  }

  // add .gitignore if needed.
  files.addToGitignore(files.pathJoin(options.appDir, '.meteor'), 'local');

  var subHandles = [];
  var stopped = false;
  var stopFuture = new Future;

  var handle = {
    stop: function () {
      if (stopped)
        return;
      stopped = true;
      _.each(subHandles, function (handle) {
        handle.stop();
      });

      stopFuture.throw(new StoppedDuringLaunch);
    }
  };

  var launchOneMongoAndWaitForReadyForInitiate = function (dbPath, port,
                                                           portFile) {
    files.mkdir_p(dbPath, 0755);

    var proc = null;
    var procExitHandler;

    if (options.allowKilling) {
      findOrientDBAndKillItDead(port, dbPath);
    }

    if (options.multiple) {
      // This is only for testing, so we're OK with incurring the replset
      // setup on each startup.
      files.rm_recursive(dbPath);
      files.mkdir_p(dbPath, 0755);
    } else if (portFile) {
      var portFileExists = false;
      var matchingPortFileExists = false;
      try {
        matchingPortFileExists = +(files.readFile(portFile)) === port;
        portFileExists = true;
      } catch (e) {
        if (!e || e.code !== 'ENOENT')
          throw e;
      }

      // If this is the first time we're using this DB, or we changed port since
      // the last time, then we want to destroy any existing replSet
      // configuration and create a new one. First we delete the "local"
      // database if it exists. (It's a pain and slow to change the port in an
      // existing replSet configuration. It's also a little slow to initiate a
      // new replSet, thus the attempt to not do it unless the port changes.)
      //
      // In the "multiple" case, we just wipe out the entire database and incur
      // the cost, because this won't affect normal users running meteor.
      if (!matchingPortFileExists) {
        // Delete the port file if it exists, so we don't mistakenly believe
        // that the DB is still configured.
        if (portFileExists)
          files.unlink(portFile);

        try {
          var dbFiles = files.readdir(dbPath);
        } catch (e) {
          if (!e || e.code !== 'ENOENT')
            throw e;
        }
        _.each(dbFiles, function (dbFile) {
          if (/^local\./.test(dbFile)) {
            files.unlink(files.pathJoin(dbPath, dbFile));
          }
        });
      }
    }

    // Let's not actually start a process if we yielded (eg during
    // findOrientDBAndKillItDead) and we decided to stop in the middle (eg, because
    // we're in multiple mode and another process exited).
    if (stopped)
      return;

    proc = spawnMongod(mongod_path, port, dbPath, replSetName);

    subHandles.push({
      stop: function () {
        if (proc) {
          proc.removeListener('exit', procExitHandler);
          proc.kill('SIGINT');
          proc = null;
        }
      }
    });

    procExitHandler = fiberHelpers.bindEnvironment(function (code, signal) {
      // Defang subHandle.stop().
      proc = null;

      // Kill any other processes too. This will also remove
      // procExitHandler from the other processes, so onExit will only be called
      // once.
      handle.stop();

      // Invoke the outer onExit callback.
      onExit(code, signal, stderrOutput, detectedErrors);
    });
    proc.on('exit', procExitHandler);

    var listening = false;
    var replSetReadyToBeInitiated = false;
    var replSetReady = false;

    var readyToTalkFuture = new Future;

    var maybeReadyToTalk = function () {
      if (readyToTalkFuture.isResolved())
        return;
      if (listening && (noOplog || replSetReadyToBeInitiated || replSetReady)) {
        proc.stdout.removeListener('data', stdoutOnData);
        readyToTalkFuture.return();
      }
    };

    var detectedErrors = {};
    var stdoutOnData = fiberHelpers.bindEnvironment(function (data) {
      // note: don't use "else ifs" in this, because 'data' can have multiple
      // lines
      if (/config from self or any seed \(EMPTYCONFIG\)/.test(data)) {
        replSetReadyToBeInitiated = true;
        maybeReadyToTalk();
      }

      if (/ \[initandlisten\] waiting for connections on port/.test(data)) {
        listening = true;
        maybeReadyToTalk();
      }

      if (/ \[rsMgr\] replSet (PRIMARY|SECONDARY)/.test(data)) {
        replSetReady = true;
        maybeReadyToTalk();
      }

      if (/Insufficient free space/.test(data)) {
        detectedErrors.freeSpace = true;
      }
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', stdoutOnData);

    var stderrOutput = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', function (data) {
      stderrOutput += data;
    });

    fiberHelpers.waitForOne(stopFuture, readyToTalkFuture);
  };


  try {
    if (options.multiple) {
      var dbBasePath = files.pathJoin(options.appDir, '.meteor', 'local', 'dbs');
      _.each(_.range(3), function (i) {
        // Did we get stopped (eg, by one of the processes exiting) by now? Then
        // don't start anything new.
        if (stopped)
          return;
        var dbPath = files.pathJoin(options.appDir, '.meteor', 'local', 'dbs', ''+i);
        launchOneMongoAndWaitForReadyForInitiate(dbPath, options.port + i);
      });
    } 
  } catch (e) {
    if (!(e instanceof StoppedDuringLaunch))
      throw e;
  }

  if (stopped)
    return null;

  return handle;
};

// This runs a Mongo process and restarts it whenever it fails. If it
// restarts too often, we give up on restarting it, diagnostics are
// logged, and onFailure is called.
//
// options: appDir, port, onFailure, multiple
var MongoRunner = function (options) {
  var self = this;
  self.appDir = options.appDir;
  self.port = options.port;
  self.onFailure = options.onFailure;
  self.multiple = options.multiple;

  self.handle = null;
  self.shuttingDown = false;
  self.startupFuture = null;

  self.errorCount = 0;
  self.errorTimer = null;
  self.restartTimer = null;
  self.firstStart = true;
  self.suppressExitMessage = false;
};

var MRp = MongoRunner.prototype;

_.extend(MRp, {
  // Blocks (yields) until the server has started for the first time and
  // is accepting connections. (It might subsequently die and be
  // restarted; we won't tell you about that.)
  //
  // If the server fails to start for the first time (after a few
  // restarts), we'll print a message and give up.
  start: function () {
    var self = this;

    if (self.handle)
      throw new Error("already running?");

    self._startOrRestart();

    // Did we properly start up? Great!
    if (self.handle)
      return;

    // Are we shutting down? OK.
    if (self.shuttingDown)
      return;

    // Otherwise, wait for a successful _startOrRestart, or a failure.
    if (!self.startupFuture) {
      self.startupFuture = new Future;
      self.startupFuture.wait();
    }
  },

  // Tries to launch Mongo once.  It returns when either (a) Mongo is listening
  // or (b) mongod exited before it got to the point of listening.
  //
  // (To be specific: in non-multiple mode, this means that the single mongod is
  // listening and the primary, or that the single mongod died. In multiple
  // mode, it means that the first mongod is listening and is primary and the
  // other mongods are listening and are secondary, or that any mongod died (and
  // it tried to kill the others).)
  //
  // In case (a), self.handle will be the handle returned from launchMongo; in
  // case (b) self.handle will be null.
  _startOrRestart: function () {
    var self = this;

    if (self.handle)
      throw new Error("already running?");

    var allowKilling = self.multiple || self.firstStart;
    self.firstStart = false;
    if (! allowKilling) {
      // If we're not going to try to kill an existing mongod first, then we
      // shouldn't annoy the user by telling it that we couldn't start up.
      self.suppressExitMessage = true;
    }

    self.handle = launchMongo({
      appDir: self.appDir,
      port: self.port,
      multiple: self.multiple,
      allowKilling: allowKilling,
      onExit: _.bind(self._exited, self)
    });

    // It has successfully started up, so if it exits after this point, that
    // actually is an interesting fact and we shouldn't suppress it.
    self.suppressExitMessage = false;

    if (self.handle) {
      self._allowStartupToReturn();
    }
  },

  _exited: function (code, signal, stderr, detectedErrors) {
    var self = this;

    self.handle = null;

    // If Mongo exited because (or rather, anytime after) we told it
    // to exit, great, nothing to do. Otherwise, we'll print an error
    // and try to restart.
    if (self.shuttingDown)
      return;

    // Only print an error if we tried to kill Mongo and something went
    // wrong. If we didn't try to kill Mongo, we'll do that on the next
    // restart. Not killing it on the first try is important for speed,
    // since findOrientDBAndKillItDead is a very slow operation.
    if (! self.suppressExitMessage) {
      // Print the last 20 lines of stderr.
      console.log(
        stderr.split('\n').slice(-20).join('\n') +
          "Unexpected mongo exit code " + code +
          (self.multiple ? "." : ". Restarting."));
    }

    // If we're in multiple mode, we never try to restart. That's to keep the
    // test-only multiple code simple.
    if (self.multiple) {
      self._fail();
      return;
    }

    // We'll restart it up to 3 times in a row. The counter is reset
    // when 5 seconds goes without a restart. (Note that by using a
    // timer instead of looking at the current date, we avoid getting
    // confused by time changes.)
    self.errorCount ++;
    if (self.errorTimer)
      clearTimeout(self.errorTimer);
    self.errorTimer = setTimeout(function () {
      self.errorTimer = null;
      self.errorCount = 0;
    }, 5000);

    if (self.errorCount < 3) {
      // Wait a second, then restart.
      self.restartTimer = setTimeout(fiberHelpers.bindEnvironment(function () {
        self.restartTimer = null;
        self._startOrRestart();
      }), 1000);
      return;
    }

    // Too many restarts, too quicky. It's dead. Print friendly
    // diagnostics and give up.
    var explanation = '' //mongoExitCodes.Codes[code];
    var message = "Can't start Mongo server.";

    if (explanation && explanation.symbol === 'EXIT_UNCAUGHT' &&
        detectedErrors.freeSpace) {
      message += "\n\n" +
        "Looks like you are out of free disk space under .meteor/local.";
    } else if (explanation) {
      message += "\n" + explanation.longText;
    }

//     if (explanation === mongoExitCodes.EXIT_NET_ERROR) {
//       message += "\n\n" +
// "Check for other processes listening on port " + self.port + "\n" +
// "or other Meteor instances running in the same project.";
//     }

    if (! explanation && /GLIBC/i.test(stderr)) {
      message += "\n\n" +
"Looks like you are trying to run Meteor on an old Linux distribution.\n" +
"Meteor on Linux requires glibc version 2.9 or above. Try upgrading your\n" +
"distribution to the latest version.";
    }

    console.log(message);
    self._fail();
  },

  // Idempotent
  stop: function () {
    var self = this;

    if (self.shuttingDown)
      return;

    self.shuttingDown = true;

    self.errorTimer && clearTimeout(self.errorTimer);
    self.restartTimer && clearTimeout(self.restartTimer);

    if (self.handle) {
      self.handle.stop();
      self.handle = null;
    }
  },

  _allowStartupToReturn: function () {
    var self = this;
    if (self.startupFuture) {
      var startupFuture = self.startupFuture;
      self.startupFuture = null;
      startupFuture.return();
    }
  },

  _fail: function () {
    var self = this;
    self.stop();
    self.onFailure && self.onFailure();
    self._allowStartupToReturn();
  },

  _mongoHosts: function () {
    var self = this;
    var ports = [self.port];
    if (self.multiple) {
      ports.push(self.port + 1, self.port + 2);
    }
    return _.map(ports, function (port) {
      return "127.0.0.1:" + port;
    }).join(",");
  },

  mongoUrl: function () {
    var self = this;
    return "mongodb://" + self._mongoHosts() + "/meteor";
  },

  oplogUrl: function () {
    var self = this;
    return "mongodb://" + self._mongoHosts() + "/local";
  }
});


exports.findOrientDBPort = findOrientDBPort;
exports.MongoRunner = MongoRunner;
exports.findOrientDBAndKillItDead = findOrientDBAndKillItDead;
