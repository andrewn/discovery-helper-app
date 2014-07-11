console.log('init', new Date());

var serviceType = '_radiodan-http._tcp.local',
    serviceFinder;

serviceFinder = new ServiceFinder(handleServicesFound, serviceType);

function handleServicesFound(error) {
  var services = [];

  if (error) {
    console.error(error);
  } else {
    services = serviceFinder.ips();
  }

  console.log('Found %o:', services.length, services);
}

// chrome.app.runtime.onLaunched.addListener(function() {
//   chrome.app.window.create('main.html', {
//     id: 'mainWindow',
//     frame: 'none',
//     bounds: {
//       width: 440,
//       height: 440,
//     },
//     minWidth: 440,
//     minHeight: 200,
//   });
// });
