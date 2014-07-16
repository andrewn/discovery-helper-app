/**
 * Construct a new ServiceFinder. This is a single-use object that does a DNS
 * multicast search on creation.
 * @constructor
 * @param {function} callback The callback to be invoked when this object is
 *                            updated, or when an error occurs (passes string).
 */
var ServiceFinder = function(callback, serviceType, config) {
  config = config || {};
  this.callback_ = callback;
  this.serviceInstances_ = [];
  this.expireRecords_ = config.expireRecords != null ? config.expireRecords : true;

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

  // Enumerate this host's interface addresses and bind
  // a UDP socket for each one. Store this promise so 
  // future network calls can send to all sockets.
  this.sockets = networkInterfaces()
                    .then(interfaceAddresses)
                     .then(validAddresses)
                     .then(createAndBindToAddresses);

  this.browseServices();

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

    console.log('addresses', addresses);
    // Also bind to multicast mDNS announcement port
    /*
      A compliant Multicast DNS querier, which implements the rules
      specified in this document, MUST send its Multicast DNS queries from
      UDP source port 5353 (the well-known port assigned to mDNS), and MUST
      listen for Multicast DNS replies sent to UDP destination port 5353 at
      the mDNS link-local multicast address (224.0.0.251 and/or its IPv6
      equivalent FF02::FB).

      https://groups.google.com/a/chromium.org/forum/#!topic/apps-dev/slnIoz6KOCk
    */
    var multicast = createAndBindToAddress('0.0.0.0', 5353);
    multicast.then(function (config) {
      console.log('created and bound to ', config);
      chrome.sockets.udp.joinGroup(
        config.socketId, 
        '224.0.0.251', //config.address, 
        function (result) { 
          if (result != 0) {
            chrome.sockets.udp.close(config.socketId);
            console.error('Error joining group', result); 
          } else {
            console.log('Joined group', result);
          }
        }
      );
    }, ServiceFinder.error);

    return Promise.all(promises);
  }

  /**
   * Creates UDP socket bound to the specified address
   * Resolves with object.socketId, object.address
   * Rejects with error object
   * @private
   * @param {string} address to bind to
   */
  function createAndBindToAddress(address, port) {
    var port = port || 0;
    console.log('bind to ', address, port);
    return new Promise(function (resolve, reject) {
      chrome.sockets.udp.create({}, function(createInfo) {
        chrome.sockets.udp.bind(
          createInfo.socketId, 
          address, 
          port,
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
    if (!this.serviceInstances_.length) {
      this.callback_('no mDNS services found!');
    }
  }.bind(this), 10 * 1000);
};

ServiceFinder.nextId = (function () {
  var id_ = 0;
  return function () {
    return id_++;
  };
})();

/*
 * Helper for logging message
 */
ServiceFinder.log = function log(value) {
  console.log(value);
}

/*
 * Helper for logging error
 */
ServiceFinder.error = function error(value) {
  console.error(value.stack);
}

/**
 * Returns the service instances found by this ServiceFinder
 */
ServiceFinder.prototype.instances = function() {
  return this.serviceInstances_;
};

/**
 * Triggers a service browsing on all sockets
 */
ServiceFinder.prototype.browseServices = function() {
  var self = this;

  // Broadcast an mDNS request for each address
  this.sockets
      .then(function (sockets) {
        sockets.forEach(function (socket) {
          console.log('Broadcast', socket);
          self.broadcast_(socket.socketId, socket.address);
        });
      })
      .then(null, ServiceFinder.error);
};

/**
 * Handles an incoming UDP packet.
 * @private
 */
ServiceFinder.prototype.onReceive_ = function(info) {

  console.log('udp', info);

  // Update our local database.
  // TODO: Resolve IPs using the dns extension.
  var packet = DNSPacket.parse(info.data);

  console.log('packet', packet);
  window.p = packet;

  // What is the QUESTION?
  var question = _.first( 
    _.where( packet.data_.qd, { type: DNSRecord.TYPES.PTR } )
  );

  // ANSWERS section
  // PTR records
  var ptr = _.first( _.where( packet.data_.an, { type: 12 } ) );
  console.log('PTRs', ptr);

  if (ptr) {
    var serviceInstance = this.parsePtr_(ptr);

    var id = serviceInstance.id;
    var instance = _.first( _.where(this.serviceInstances_, { id: id }) );

    // Expire record after TTL
    if (this.expireRecords_ && typeof ptr.ttl === 'number') {
      if (ptr.ttl === 0) {
        // Expire
      } else {
        window.setTimeout(
          function () {
            _.pull(this.serviceInstances_, instance);
            this.browseServices();
          }.bind(this),
          ptr.ttl * 1000
        );
      }
    }

    console.log('question: id: %o, instance: %o, rec: %o', id, instance, question);

    if (!instance) {
      instance = { id: id };
      this.serviceInstances_.push(instance);
    }
  }

  // SRV records
  var srvs = _.where( packet.data_.an, { type: 33 } )
              .concat( _.where( packet.data_.ar, { type: 33 } ) );
  console.log('SRVs', srvs);
  srvs.forEach(function (rec) {
    this.parseSrv_(instance, rec);
  }.bind(this));

  var txts = _.where( packet.data_.an, { type: 16 } )
              .concat( _.where( packet.data_.ar, { type: 16 } ) );
  console.log('TXTs', txts);
  txts.forEach(function (rec) {
    this.parseTxt_(instance, rec);
  }.bind(this));

  var as = _.where( packet.data_.an, { type: 1 } )
              .concat( _.where( packet.data_.ar, { type: 1 } ) );
  console.log('As', as);
  as.forEach(function (rec) {
    this.parseA_(instance, rec);
  }.bind(this));

  console.log('ptr %o, srvs %o, txts %o, as %o', ptr, srvs.length, txts.length, as.length);
  t = txts;

  // TODO: Resolve a service instance if SRV and TXT
  //       haven't been populated

  // Ping! Something new is here. Only update every 25ms.
  if (!this.callback_pending_) {
    console.log('set timeout');
    this.callback_pending_ = true;
    setTimeout(function() {
      console.log('timout callback');
      this.callback_pending_ = undefined;
      this.callback_();
    }.bind(this), 25);
  }
};

/**
 * Parse PTR
 * @private
 */
ServiceFinder.prototype.parsePtr_ = function(rec) {
  var ptr = rec.data.ptrdname;
  console.log('ptr %o, remoteAddress %o', ptr);

  var serviceInstance = {
    id  : ptr + '.' + this.serviceType_,
    name: ptr,
    type: this.serviceType_
  };

  return serviceInstance;
  // Perform resolution 
  // this.resolveServiceInstance(serviceInstance.id);    
};

ServiceFinder.prototype.parseSrv_ = function(instance, rec) {
  var srv = rec.data;
  console.log('srv', srv);
  _.assign(instance, srv);
};

ServiceFinder.prototype.parseTxt_ = function(instance, rec) {
  var data;

  // If name property is empty then this is the 
  // record we want
  if (!rec.name) {
    data = rec.data.txtdata;
  }

  // Add to existing record
  if (data) {
    instance.txt = data;
  }
};

ServiceFinder.prototype.parseA_ = function(instance, rec) {
  // If name property is empty then this is the 
  // record we want
  if (!rec.name) {
    instance.address = rec.data.address;
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
  var requestId = ServiceFinder.nextId();
  var packet = new DNSPacket(requestId);
  packet.push('qd', new DNSRecord(this.serviceType_, 12, 1));

  var raw = packet.serialize();
  chrome.sockets.udp.send(sock, raw, '224.0.0.251', 5353, function(sendInfo) {
    if (sendInfo.resultCode < 0)
      this.callback_('Could not send data to:' + address);
  });
};

/**
 * Given an instance name, resolves the SRV and TXT record for 
 * the instance. From the spec:
 *    The SRV record for a service gives the port number and
 *    target host name where the service may be found.  The TXT record
 *    gives additional information about the service, as described in
 *    Section 6, "Data Syntax for DNS-SD TXT Records".
 * 
 */
ServiceFinder.prototype.resolveServiceInstance = function(instanceName) {
  var self = this;
  this.sockets
      .then(function (sockets) {
        sockets.forEach(function (socket) {
          console.log('resolveForSocket', socket, instanceName);
          self.resolveServiceInstanceForSocket_(socket.socketId, instanceName);
        });
      });
};

/**
 * Given an instance name, resolves the SRV and TXT record for 
 * the instance. From the spec:
 *    The SRV record for a service gives the port number and
 *    target host name where the service may be found.  The TXT record
 *    gives additional information about the service, as described in
 *    Section 6, "Data Syntax for DNS-SD TXT Records".
 * 
 */
ServiceFinder.prototype.resolveServiceInstanceForSocket_ = function(sock, instanceName) {
  var packet = new DNSPacket();
  packet.push('qd', new DNSRecord(instanceName, 33, 1));
  packet.push('qd', new DNSRecord(instanceName, 16, 1));

  var raw = packet.serialize();
  console.log('packet %o, raw %o', packet, raw);

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
