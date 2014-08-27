var logToObject   = true,
    pollingInterval = 10000,  // how often to do service enumeration
    expireRecords = true,     // expire PTR records based on their TTL
    serviceType   = '_mediascape-http._tcp.local',
    serviceFinder = new ServiceFinder(handleServicesFound, serviceType, { expireRecords: expireRecords }),
    services      = [],
    recipients    = [];

// Override some logging functions
// to add to an array
var Logger = function (override, limit) {
  var logger = [];

  ['log', 'warn', 'error'].forEach(function(name) {
    override[name] = function () {
      logger.push(arguments);

      if (logger.length > limit) {
        logger.splice(0, logger.length - limit);
      }
    };
  });

  return logger;
};

if (logToObject) {
  var logger = Logger(console, 500);
}

if (pollingInterval) {
  window.setInterval(function () {
    serviceFinder.browseServices();
  }, pollingInterval);
}

chrome.runtime.onMessageExternal.addListener(function(message, sender) {
  if(recipients.indexOf(sender.id) == -1) {
    recipients.push(sender.id);
    sendMessage([sender.id], services);
  }
});

function handleServicesFound(error) {
  services = [];

  if (error) {
    console.error(error);
  } else {
    services = serviceFinder.instances();
  }

  services = services.map(transformTxtToKeys);

  console.log('Found %o:', services.length, services);
  sendMessage(recipients, services);
}

/*
  Parse a services TXT record values into 
  key/value pairs on the `txt` object.
  e.g.  service.txt = ['id=15']
        => service.txt.id = 15

  Also attempts to parse JSON
  e.g.  service.txt = ['player={ id:15, name="dave"}']
        => service.txt.player.id = 15
           service.txt.player.name = "dave"
*/
function transformTxtToKeys(service) {
  var obj = {};
  if (service.txt && service.txt.map) {
    service.txt.forEach(function (txt) {
      var parts = txt.split('='),
          key   = parts[0],
          value = parts[1] || true;

      try {
        value = JSON.parse(value);
      } catch (e) {
        // Value isn't JSON
      }

      obj[key] = value;
    });
    service.txt = obj;
  }
  return service;
}

function sendMessage(recievers, message) {
  recievers.forEach(function(recipient) {
    console.log('sending', recipient, message);
    chrome.runtime.sendMessage(
      recipient, message
    );
  });
}

