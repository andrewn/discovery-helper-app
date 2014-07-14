var serviceType   = '_radiodan-http._tcp.local',
    serviceFinder = new ServiceFinder(handleServicesFound, serviceType),
    services      = [],
    recipients    = [],
    pollingInterval = 10000;

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

  console.log('Found %o:', services.length, services);
  sendMessage(recipients, services);
}

function sendMessage(recievers, message) {
  recievers.forEach(function(recipient) {
    console.log('sending', recipient, message);
    chrome.runtime.sendMessage(
      recipient, message
    );
  });
}

