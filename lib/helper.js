/*
 * Copyright (c) 2012-2015 Digital Bazaar, Inc. All rights reserved.
 */
var EventEmitter = require('events').EventEmitter;
var chai = require('chai');
var chaiAsPromised = require('chai-as-promised');
var util = require('util');
var _ = require('underscore');

chai.use(chaiAsPromised);
GLOBAL.expect = chai.expect;

var browser = GLOBAL.browser;
var by = GLOBAL.by;

function Helper() {
  EventEmitter.call(this);

  this.config = browser.params.config;
  this.browser = browser;
  this.baseUrl = browser.baseUrl;
}
util.inherits(Helper, EventEmitter);

var api = GLOBAL.bedrock = new Helper();
module.exports = api;

// called by onPrepare in config script
Helper.prototype.init = function() {
  if(this.config.hideBrowser) {
    // move window out of way (currently no way to minimize)
    browser.driver.manage().window().setPosition(-2000, 0);
  }
  this.get('/');
  this.emit('init');
};

// gets a URL that returns an AngularJS page and waits for it to bootstrap
Helper.prototype.get = function(url) {
  var fullUrl = url;
  if(url.indexOf('http') !== 0) {
    fullUrl = this.baseUrl + url;
  }
  // wait for ng-app to appear
  browser.driver.get(fullUrl);
  this.waitForUrl(url);
  return this.waitForAngular();
};

// runs a script in the browser's context
// pass fn($injector) for a sync script, fn($injector, callback) for async
Helper.prototype.run = function(fn) {
  fn = fn.toString();
  var isAsync = (fn.split('\n')[0].indexOf(',') !== -1);
  var execute = isAsync ? browser.executeAsyncScript : browser.executeScript;
  return execute(
    "var $injector = angular.element('" + browser.rootEl + "')" +
      ".data('$injector');" +
    "var callback = arguments[arguments.length - 1];" +
    'return (' + fn + ')($injector, callback);');
};

// waits for AngularJS to be bootstrapped
Helper.prototype.waitForAngular = function() {
  return browser.driver.wait(function() {
    return browser.driver.isElementPresent(by.tagName(browser.rootEl))
      .then(function(present) {
        if(!present) {
          return false;
        }
        return browser.driver.findElement(by.tagName(browser.rootEl))
          .then(function(root) {
            return root.getAttribute('ng-app').then(function(value) {
              return !!value;
            });
          });
      });
  });
};

// waits for an element to be displayed
Helper.prototype.waitForElementToShow = function(el) {
  return browser.wait(function() {
    return el.isDisplayed();
  });
};

// waits for an attribute to meet a certain criteria
Helper.prototype.waitForAttribute = function(el, attr, fn) {
  return browser.wait(function() {
    return el.getAttribute(attr).then(function(value) {
      return fn(value);
    });
  });
};

// waits for a particular URL to load (via a URL value or a function that takes
// the current URL to compare against and returns true for success)
Helper.prototype.waitForUrl = function(url) {
  var filter;
  if(typeof url === 'function') {
    filter = url;
  } else {
    if(url.indexOf('http') !== 0) {
      url = this.baseUrl + url;
    }
    filter = function(currentUrl) {
      return currentUrl === url;
    };
  }
  return browser.wait(function() {
    return browser.driver.getCurrentUrl().then(filter);
  });
};

// waits for a client-side script to return true
// eg: can check angular.element('.foo').scope().model.bar against some value
Helper.prototype.waitForScript = function(fn) {
  var self = this;
  return browser.wait(function() {
    return self.run(fn);
  });
};

// waits for a model animation to complete
Helper.prototype.waitForModalTransition = function() {
  return browser.wait(function() {
    return browser.driver.findElements(by.css('.stackable.ng-animate'))
      .then(function(result) {
        return result.length === 0;
      });
  });
};

// gets a random alphabetical string
Helper.prototype.randomString = function(length) {
  var idx_A = 'A'.charCodeAt(0);
  var idx_a = 'a'.charCodeAt(0) - 26;
  length = length || 10;
  var rval = '';
  while(rval.length < length) {
    var code = Math.floor(Math.random() * 52);
    code += (code < 26) ? idx_A : idx_a;
    rval += String.fromCharCode(code);
  }
  return rval;
};

// uses AngularJS to format a date
Helper.prototype.formatDate = function(date, format) {
  return this.run(['function($injector, callback) {',
    'var filter = $injector.get("dateFilter");',
    'var date = new Date("' + date + '");',
    'var format = "' + format + '";',
    'return callback(filter(date, format));',
  '}'].join(''));
};

// performs a simple equality-based query on an array of items
Helper.prototype.find = function(items, query) {
  return Array.prototype.filter.call(items, _.matches(query));
};

// performs a simple equality-based query on an array of items
Helper.prototype.findOne = function(items, query) {
  items = this.find(items, query);
  if(items.length > 0) {
    return items[0];
  }
  return null;
};

// gets data from a loaded angular service
// pass service name or path (dot-delimited) to specific data
Helper.prototype.getServiceData = function(service) {
  return GLOBAL.element(by.tagName(browser.rootEl)).evaluate(
    'app.services.' + service);
};

// find a row in a repeater by evaluating an expression in its scope
// and checking its value via the given function
Helper.prototype.findRowByEval = function(repeater, expr, fn, parent) {
  parent = parent || GLOBAL.element(by.css('document'));
  var match = null;
  if(typeof fn !== 'function') {
    var y = fn;
    fn = function(x) {return x === y;};
  }
  return parent.all(by.repeater(repeater))
    .map(function(row, index) {
      return row.evaluate(expr).then(fn).then(function(result) {
        if(result) {
          match = index;
        }
      });
    })
    .then(function() {
      if(match === null) {
        return null;
      }
      return parent.element(by.repeater(repeater).row(match));
    });
};

// escape JSON to be transferred to browser
Helper.prototype.escapeJson = function(json) {
  return json
    .replace(/\\n/g, '\\\\n')
    .replace(/\\r/g, '\\\\r')
    .replace(/\"/g, "\\\"")
    .replace(/'/g, "\\'");
};

// clones 'x' via JSON serialization/deserialization
Helper.prototype.clone = function(x) {
  return JSON.parse(JSON.stringify(x));
};

api.on('init', function() {
  // locate elements by controller
  by.addLocator('controller', function(value, parent) {
    var using = parent || document;
    var query = "ng-controller^='" + value + "']";
    query = '[' + query + ', [data-' + query;
    return using.querySelectorAll(query);
  });

  // locate elements via an attribute value
  by.addLocator('attribute', function(attr, value, parent) {
    if(value && value.querySelectorAll) {
      parent = value;
      value = undefined;
    }
    var using = parent || document;
    var query = attr;
    if(value !== undefined) {
      query += "='" + value + "'";
    }
    query += ']';
    query = '[' + query + ', [data-' + query;
    return using.querySelectorAll(query);
  });
});