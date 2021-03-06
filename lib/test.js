/*
 * Copyright (c) 2012-2016 Digital Bazaar, Inc. All rights reserved.
 */
var bedrock = require('bedrock');
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var temp = require('temp');
require('bedrock-requirejs');

// load config defaults
require('./config');

bedrock.events.on('bedrock-cli.test.configure', function(command) {
  command
    .option(
      '--protractor-test <files>',
      'A set of comma-delimited protractor test files to run.')
    .option(
      '--protractor-suite <files>',
      'A protractor test suite to run.')
    .option('--protractor-browser <browser>',
      'Run frontend tests on a specific browser (chrome, firefox)')
    .option('--protractor-chrome-binary <path>',
      'Binary path for Chrome.')
    .option('--protractor-firefox-binary <path>',
      'Binary path for Firefox.')
    .option('--protractor-troubleshoot',
      'Use protractor --troubleshoot option.')
    .option('--protractor-hide', 'Hide the browser window during tests')
    //.option('--protractor-display', 'The X display to use for frontend tests')
    .option('--sauce-config <files>',
      'A set of comma-delimited config filenames.')
    // FIXME: determine why build property is not being registered by SauceLabs
    // .option('--sauce-build <name>',
    //   'A name for the build.')
    .option('--sauce-name <name>',
      'A name for the test suite.')
    .option('--sauce-tag <tags>',
      'A set of comma-delimited tag strings.');
});

bedrock.events.on('bedrock.configure', function() {
  var command = bedrock.config.cli.command;
  if(command.name() !== 'test' ||
    !bedrock.test.shouldRunFramework('protractor')) {
    return;
  }

  // protractor tests are running; add pseudo-bower package
  // bedrock-protractor-unit
  bedrock.config.requirejs.bower.packages.push({
    path: path.join(__dirname, '../bedrock-protractor-unit'),
    manifest: path.join(__dirname, '../bedrock-protractor-unit/bower.json')
  });
});

bedrock.events.on('bedrock.tests.run', function(state, callback) {
  if(bedrock.test.shouldRunFramework('protractor')) {
    return run(state, callback);
  }
  callback();
});

function run(state, callback) {
  var remoteSelenium = false;
  var command = bedrock.config.cli.command;
  if(!command.protractorSuite &&
    !command.protractorTest &&
    !bedrock.config.protractor.config.specs &&
    Object.keys(bedrock.config.protractor.config.suites).length === 0) {
    // no tests to run
    console.log('No protractor tests to run.');
    // print eol
    console.log();
    return callback();
  }

  // handle options
  if(command.protractorBrowser) {
    bedrock.config.protractor.config.capabilities.browserName =
      command.protractorBrowser;
  }
  if(command.protractorChromeBinary) {
    var caps = bedrock.config.protractor.config.capabilities;
    caps.chromeOptions = caps.chromeOptions || {};
    caps.chromeOptions.binary = command.protractorChromeBinary;
  }
  if(command.protractorFirefoxBinary) {
    bedrock.config.protractor.config.firefoxPath =
      command.protractorFirefoxBinary;
  }
  // set hide window
  if(command.protractorHide) {
    bedrock.config.protractor.config.params.config.hideBrowser = true;
  }

  // TODO: allow selenium addr and port to be given instead to connect to a
  // different selenium server
  // browser-based system tests should connect to an X display
  /*if(!process.env.DISPLAY) {
    process.env.DISPLAY = program.display ? program.display : ':0';
  }*/

  if(command.sauceConfig) {
    remoteSelenium = true;
    if(!(process.env.SAUCE_USERNAME && process.env.SAUCE_ACCESS_KEY)) {
      return callback(new Error(
        'Missing environment variables: SAUCE_USERNAME, SAUCE_ACCESS_KEY'));
    }
    bedrock.config.protractor.meta = {
      build: command.sauceBuild || null,
      name: command.sauceName || null,
      tags: []
    };
    if(command.sauceTag) {
      bedrock.config.protractor.meta.tags.push.apply(
        bedrock.config.protractor.meta.tags, command.sauceTag.split(','));
    }
    bedrock.config.protractor.config.directConnect = false;
    bedrock.config.protractor.config.sauceUser = process.env.SAUCE_USERNAME;
    bedrock.config.protractor.config.sauceKey = process.env.SAUCE_ACCESS_KEY;
    // increase maxTimeout due to additional latency when using SauceLabs
    bedrock.config.protractor.config.params.config.maxTimeout = 30000;
    command.sauceConfig.split(',').forEach(function(c) {
      require(path.join(process.cwd(), c))(bedrock);
    });
  }

  // generate the protractor config
  var configFile = generateProtractorConfig();

  // run protractor
  var browser = bedrock.config.protractor.config.capabilities.browserName;
  console.log('Running tests via Protractor...');
  console.log('Server: ' + bedrock.config.server.baseUri);
  if(!remoteSelenium) {
    console.log('Browser: ' + browser);
    if(bedrock.config.protractor.config.capabilities.chromeOptions &&
      bedrock.config.protractor.config.capabilities.chromeOptions.binary) {
      console.log('Chrome binary: ' +
      bedrock.config.protractor.config.capabilities.chromeOptions.binary);
    }
    if(bedrock.config.protractor.config.firefoxPath) {
      console.log('Firefox binary: ' +
      bedrock.config.protractor.config.firefoxPath);
    }
  }
  console.log('Bootstrap config: ' + configFile);
  var cmd =
    path.join(require.resolve('protractor'), '..', '..', 'bin', 'protractor');
  var args = [];
  if(command.protractorTroubleshoot) {
    args.push('--troubleshoot');
  }
  args.push('--baseUrl', bedrock.config.server.baseUri);
  if(command.protractorSuite) {
    console.log('Suite: ' + command.protractorSuite);
    args.push('--suite');
    args.push(command.protractorSuite);
  }
  if(command.protractorTest) {
    console.log('Tests: ' + command.protractorTest);
    args.push('--specs');
    args.push(command.protractorTest);
  }
  args.push(configFile);
  // print eol
  console.log();
  var protractor = spawn(cmd, args);
  protractor.stderr.pipe(process.stderr);
  protractor.stdout.pipe(process.stdout);
  protractor.on('error', function(err) {
    console.log('Error', err);
  });
  protractor.on('close', function(code) {
    if(code) {
      state.pass = false;
      console.log('Protractor tests failed.');
      return callback();
    }
    console.log('All protractor tests passed.');
    callback();
  });
}

function generateProtractorConfig() {
  // write config file for protractor to load via a new process
  var config = bedrock.config.protractor.config;

  // clean up temp files at exit
  temp.track();

  var info = temp.openSync('bedrock-protractor.');
  var data = new Buffer(
    'exports.config = ' + JSON.stringify(config, null, 2) + ';\n', 'utf8');
  fs.writeSync(info.fd, data, 0, data.length, 0);
  fs.closeSync(info.fd);

  return info.path;
}
