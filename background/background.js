var logToObject   = false,
    serviceType   = '_capi._tcp.local',
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

chrome.runtime.onMessageExternal.addListener(function(message, sender) {
  if(recipients.indexOf(sender.id) == -1) {
    recipients.push(sender.id);
    sendMessage([sender.id], services);
  }
});

chrome.mdns.onServiceList.addListener(function(services) {
  var mappedServices;

  if(services.length === 0) {
    return;
  }

  mappedServices = services.map(transformTxtToKeys);

  console.log('Found %o:', mappedServices.length, mappedServices);
  sendMessage(recipients, mappedServices);
}, {'serviceType': serviceType});

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

  service.api  = 'capi';
  service.host = service.serviceName.replace('.'+serviceType, '');
  service.address = service.ipAddress;
  service.port = service.serviceHostPort.split(':')[1];

  if(service.serviceData && service.serviceData.map) {
    service.serviceData.forEach(function (txt) {
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

  service.uri  = 'ws://' + service.serviceHostPort + service.txt.Path;

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

