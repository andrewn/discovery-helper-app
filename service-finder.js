/**
 * Construct a new ServiceFinder. This is a single-use object that does a DNS
 * multicast search on creation.
 * @constructor
 * @param {function} callback The callback to be invoked when this object is
 *                            updated, or when an error occurs (passes string).
 */
var ServiceFinder = function(callback, serviceType) {
  this.callback_ = callback;
  this.byIP_ = {};
  this.byService_ = {};
  this.serviceInstances_ = {};

  this.serviceType_ = serviceType || '_services._dns-sd._udp.local';

  // Set up receive handlers.
  this.onReceiveListener_ = this.onReceive_.bind(this);
  chrome.sockets.udp.onReceive.addListener(this.onReceiveListener_);
  this.onReceiveErrorListener_ = this.onReceiveError_.bind(this);
  chrome.sockets.udp.onReceiveError.addListener(this.onReceiveErrorListener_);

  // networkInterfaces       -> [ { name: 'v4', address: '1092103' }, { name: 'v6', address: '109:210:3' } ]
  // addresses               -> [ '1092103', '109:210:3' ]
  // validAddresses          -> [ '1092103' ]
  // createAndBindToAddress  -> [ { socketId: 'kldsjkl', address: '1092103' } ]
  // resolve -> this.broadcast(socketId, address);
  // reject  -> log error
  function log(value) {
    console.log(value);
  }

  function error(value) {
    console.error(value.stack);
  }

  // Enumerate this host's interface addresses and bind
  // a UDP socket for each one
  // Broadcast an mDNS request for each address
  var self = this;
  networkInterfaces().then(interfaceAddresses)
                     .then(validAddresses)
                     .then(createAndBindToAddresses)
                     .then(function (sockets) {
                        sockets.forEach(function (socket) {
                          console.log('Broadcast', socket);
                          self.broadcast_(socket.socketId, socket.address);
                        });
                     })
                     .then(null, error);

  /**
   * Fetch a list of network interfaces 
   * Resolves with an array of network interface descriptions
   * Fails with an error message
   */
  function networkInterfaces() {
    return new Promise(function (resolve, reject){
      chrome.system.network.getNetworkInterfaces(function(networkInterfaces) {
        if (!networkInterfaces.length) {
          reject( new Error('no network available!') );
        } else {
          resolve(networkInterfaces);
        }
      });
    });
  }

  /**
   * Extract IP addresses from a list of network interface descriptions
   * Resolves with an array of addresses or an empty array
   * @param {array} 
   */
  function interfaceAddresses(interfaces) {
    return Promise.resolve(
      interfaces.map(
        function (interfaces) {
          return interfaces.address;
        }
      )
    );
  }

  /**
   * Remove unsupported IP address types
   * Resolves with an array of valid addresses
   * @param {Array[string]} array of addresses
   */
  function validAddresses(addresses) {
    return Promise.resolve(
      addresses.filter(function (address) {
        if (address.indexOf(':') != -1) {
          // TODO: ipv6.
          console.warn('IPv6 address unsupported', address);
          return false;
        } else {
          return true;
        }
      })
    );
  }

  /**
   * Create UDP socket and bind to addresses
   * Resolves with an array of Object.socketId, Object.address
   * @param {Array[string]} array of addresses to bind to
   */
  function createAndBindToAddresses(addresses) {
    var promises = addresses.map(createAndBindToAddress);
    return Promise.all(promises);
  }

  /**
   * Creates UDP socket bound to the specified address
   * Resolves with object.socketId, object.address
   * Rejects with error object
   * @private
   * @param {string} address to bind to
   */
  function createAndBindToAddress(address) {
    return new Promise(function (resolve, reject) {
      chrome.sockets.udp.create({}, function(createInfo) {
        chrome.sockets.udp.bind(
          createInfo.socketId, 
          address, 
          0,
          function(result) {
            if (result >= 0) {
              resolve({ socketId: createInfo.socketId, address: address });
            } else {
              reject( new Error('Could not bind to socket') );
            }
          }
        );
      });
    });
  }

  // After a short time, if our database is empty, report an error.
  setTimeout(function() {
    if (!Object.keys(this.byIP_).length) {
      this.callback_('no mDNS services found!');
    }
  }.bind(this), 10 * 1000);
};

/**
 * Sorts the passed list of string IPs in-place.
 * @private
 */
ServiceFinder.sortIps_ = function(arg) {
  arg.sort(ServiceFinder.sortIps_.sort);
  return arg;
};
ServiceFinder.sortIps_.sort = function(l, r) {
  // TODO: support v6.
  var lp = l.split('.').map(ServiceFinder.sortIps_.toInt_);
  var rp = r.split('.').map(ServiceFinder.sortIps_.toInt_);
  for (var i = 0; i < Math.min(lp.length, rp.length); ++i) {
    if (lp[i] < rp[i]) {
      return -1;
    } else if (lp[i] > rp[i]) {
      return +1;
    }
  }
  return 0;
};
ServiceFinder.sortIps_.toInt_ = function(i) { return +i };

/**
 * Returns the services found by this ServiceFinder, optionally filtered by IP.
 */
ServiceFinder.prototype.services = function(opt_ip) {
  var k = Object.keys(opt_ip ? this.byIP_[opt_ip] : this.byService_);
  k.sort();
  return k;
};

/**
 * Returns the IPs found by this ServiceFinder, optionally filtered by service.
 */
ServiceFinder.prototype.ips = function(opt_service) {
  var k = Object.keys(opt_service ? this.byService_[opt_service] : this.byIP_);
  return ServiceFinder.sortIps_(k);
};

/**
 * Returns the service instances found by this ServiceFinder
 */
ServiceFinder.prototype.instances = function() {
  return Object.keys(this.serviceInstances_)
               .map(function(key) { return this.serviceInstances_[key]; }.bind(this));
};

/**
 * Handles an incoming UDP packet.
 * @private
 */
ServiceFinder.prototype.onReceive_ = function(info) {
  var getDefault_ = function(o, k, def) {
    (k in o) || false == (o[k] = def);
    return o[k];
  };

  console.log('udp', info);

  // Update our local database.
  // TODO: Resolve IPs using the dns extension.
  var packet = DNSPacket.parse(info.data);
  var byIP = getDefault_(this.byIP_, info.remoteAddress, {});

  console.log('packet', packet);

  packet.each('an', 12, function(rec) {
    var ptr = rec.asName();
    var byService = getDefault_(this.byService_, ptr, {});
    console.log('ptr %o, remoteAddress:remotePort %o:%o', ptr, info.remoteAddress, info.remotePort);
    byService[info.remoteAddress] = true;
    byIP[ptr] = true;

    var serviceInstance = {
      id  : ptr + '.' + this.serviceType_,
      name: ptr,
      type: this.serviceType_,
      host: info.remoteAddress,
      port: info.remotePort
    };

    this.serviceInstances_[ serviceInstance.id ] = serviceInstance;

  }.bind(this));

  // Ping! Something new is here. Only update every 25ms.
  if (!this.callback_pending_) {
    this.callback_pending_ = true;
    setTimeout(function() {
      this.callback_pending_ = undefined;
      this.callback_();
    }.bind(this), 25);
  }
};

/**
 * Handles network error occured while waiting for data.
 * @private
 */
ServiceFinder.prototype.onReceiveError_ = function(info) {
  this.callback_(info.resultCode);
  return true;
}

/**
 * Broadcasts for services on the given socket/address.
 * @private
 */
ServiceFinder.prototype.broadcast_ = function(sock, address) {
  var packet = new DNSPacket();
  packet.push('qd', new DNSRecord(this.serviceType_, 12, 1));

  var raw = packet.serialize();
  chrome.sockets.udp.send(sock, raw, '224.0.0.251', 5353, function(sendInfo) {
    if (sendInfo.resultCode < 0)
      this.callback_('Could not send data to:' + address);
  });
};

ServiceFinder.prototype.shutdown = function() {
  // Remove event listeners.
  chrome.sockets.udp.onReceive.removeListener(this.onReceiveListener_);
  chrome.sockets.udp.onReceiveError.removeListener(this.onReceiveErrorListener_);
  // Close opened sockets.
  chrome.sockets.udp.getSockets(function(sockets) {
    sockets.forEach(function(sock) {
      chrome.sockets.udp.close(sock.socketId);
    });
  });
}