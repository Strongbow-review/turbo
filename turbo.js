#!/usr/bin/env node
var util = require('util');
var _ = require('underscore');
var async = require('async');
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var bunyan = require('bunyan');

process.on('uncaughtException', function(err) {
  console.error("Uncaught exception: ", util.inspect(err.stack || err));
  process.exit(1);
});

function usage() {
  console.log("turbo.js <test-dir-or-file>*");
  console.log("Available options: ");
  console.log("--series=<true|false>  run tests sequentially, default is false (i.e. run all tests in parallel)");
  console.log("--setUp=<file>         global setUp file (i.e. file containg an exported 'setUp' function)");
  console.log("--tearDown=<file>      global tearDown file (i.e. file containg an exported 'tearDown' function)");
  console.log("--level=<level>        logging level: fatal, error, warn, info, debug, trace. Default is fatal. Log output goes to stderr.");
  console.log("--help                 help");
  process.exit();
};

var log;

function fatal(err) {
  if (log) log.fatal(err);
  console.error(err);
  process.exit(1);
};

var rc = require('rc')('turbo', {series: false});
if (rc.help) usage();
var args = rc._;
if (args.length === 0) usage();

// set up logging
log = bunyan.createLogger({
  name: 'turbo',
  stream: process.stderr,
  src: true,
  level: rc.level || 'trace'
});

log.trace({options: rc}, 'options');

// do we run sequentially or parallel
var asyncMapFunc = 'map';
if (rc.series) asyncMapFunc = 'mapSeries';

if (rc.setUp) {
  if (!fs.existsSync(rc.setUp)) fatal("setUp file doesn't exist: " + rc.setUp);
  log.info('running setUp in file:', rc.setUp);
  var t = require(path.resolve(rc.setUp));
  if (!t['setUp']) fatal("setUp file doesn't contain a 'setUp' function!" + rc.tearDown);
  t.setUp(function(err){
    if (err) fatal(err);
    runAllTests();
  });
} else runAllTests();

// main entry point, run all our tests..
function runAllTests() {
  start(function(err, results) {
    if (err) {
      // test failure
      log.fatal(err);
      console.error(err);
      console.trace();
      process.exit();
    }
    log.trace({results: results}, 'runAllTests results');
    if (rc.tearDown) {
      log.info('running tearDown in file: ' + rc.tearDown);
      if (!fs.existsSync(rc.tearDown)) fatal("tearDown file doesn't exist: " + rc.tearDown);
      var t = require(path.resolve(rc.tearDown));
      if (!t['tearDown']) fatal("tearDown file doesn't contain a 'tearDown' function!" + rc.tearDown);
      t.tearDown(function(err){
        if (err) fatal(err);
        end();
      });
    }else end();

    function end() {
      // if we've gotten to here there are no errors.. (as we fail fast..)
      var tests = _.flatten(results);
      log.info({falttenedTestResults: tests});
      console.log(util.inspect(tests, true, null)); // TODO - tap output here or something..
    };
  });
};

// kick things off by processing all our dirs/files passed on the cli
function start(callback){
  async[asyncMapFunc](args, processArg, callback);

  function processArg(arg, cb) {
    log.info({processArg: arg});
    if (!fs.existsSync(arg)) {
      return cb("Dir/File doesn't exist: " + arg);
    }
    var tests = [];
    var stats = fs.statSync(arg);
    log.trace({stats: stats, arg: arg});
    if (stats.isDirectory()) {
      fs.readdir(arg, function(err, files) {
        if (err) fatal(err);
        files.forEach(function(file) {
          // TODO - refactor 'testcommon.js'
          if (file.indexOf('test') === 0 && file.indexOf('~') === -1) {
            tests.push(arg + '/' + file);
          }
        });
        async[asyncMapFunc](tests, testFile, cb);
      });
    }else {
      tests.push(arg);
      async[asyncMapFunc](tests, testFile, cb);
    }

    function testFile(file, cb) {
      log.info({test: file}, 'running test file: ' + file);
      var t = require(path.resolve(file));
      var tests = _.keys(t);

      function runTest(func, cb) {
        log.info({func: func, file: file}, 'Running test: ' + func);
        t[func](cb);
      }

      var runTearDown = false;
      if (_.contains(tests, 'setUp')) {
        runTest('setUp', function(err) {
          if (err) return cb(err);
          if (_.contains(tests, 'tearDown')) {
            runTearDown = true;
            tests = _.without(tests, 'setUp');
            tests = _.without(tests, 'tearDown');
          }
          runTests()
        });
      }else runTests();

      function runTests() {
        async[asyncMapFunc](tests, runTest, function(err, results) {
          if (err) return cb(err);

          var testResults = [];
          results.forEach(function(result, index) {
            var t = tests[index];
            var res = {
              test: t,
              file: file
            };
            if (result) res.error = result;
            testResults.push(res);
          });

          if (runTearDown) {
            runTest('tearDown', function(err) {
              if (err) return cb(err);
              return cb(null, testResults);
            });
          } else {
            return cb(null, testResults);
          }
        });
      };
    };
  };
};