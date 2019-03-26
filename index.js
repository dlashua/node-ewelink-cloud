/* jshint -W030, -W069, esversion: 6 */
let WebSocket = require('ws');
let http = require('http');
let url = require('url');
let request = require('request-json');
let nonce = require('nonce')();
var EventEmitter = require('emmett');
var Logger = require('logger');
var inherits = require('util').inherits;
var Queue = require('better-queue');

// Platform constructor
function eWeLink(config) {
    EventEmitter.call(this);

    if(!config || (!config['authenticationToken'] && ((!config['phoneNumber'] && !config['email']) || !config['password'] || !config['imei']))){
        log("Initialization skipped. Missing configuration data.");
        return;
    }

    if (!config['apiHost']) {
        config['apiHost'] = 'us-api.coolkit.cc:8080';
    }
    if (!config['webSocketApi']) {
        config['webSocketApi'] = 'us-pconnect3.coolkit.cc';
    }

    this.config = config;
    this.authenticationToken = config['authenticationToken'];
    this.devicesFromApi = new Map();
    this.logger = Logger.createLogger();
        
    this.logger.info("Intialising eWeLink");

    this.cache = {};

    this.readyForNextCommand = true;
    this.readyTimer = false;

    this.sendQ = new Queue((batch, cb) => {
            this.makeBusy();
            
            this._setData(batch.deviceid, batch.data);
            cb(null, true);
        },
        {
            merge: (oldTask, newTask, cb) => {
                cb(null, Object.assign(oldTask, newTask));
            },
            precondition: (cb) => {
                if (this.readyForNextCommand) {
                    cb(null, true);
                } else {
                    cb(null, false);
                }
            },
            preconditionRetryTimeout: 500,
            id: "deviceid",
            batchSize: 1,
            batchDelay: 0,
            concurrent: 1,

        }
    );

    this.sendQ.on('task_started',(d) => console.log('TASK STARTED',d));
    this.sendQ.on('task_finish',(d) => console.log('TASK FINISHED',d));
    this.sendQ.on('task_failed',(d) => console.log('TASK FAILED',d));


    this.login();
    
    this.on('authed', function () {
        this.getAllDevices();
        this.setupWebSocket();
    });

}

inherits(eWeLink,EventEmitter);

eWeLink.prototype.emitDevice = function(deviceId, data) {
    if (!this.cache.hasOwnProperty(deviceId)) {
        this.cache[deviceId] = {};
    }

    Object.keys(data).forEach(key => {
        this.cache[deviceId][key] = data[key]
    });

    this.emit('state:'+deviceId,this.cache[deviceId]);
}

eWeLink.prototype.setupWebSocket = function() {
    let platform = this;

    let url = 'wss://' + platform.config['webSocketApi'] + ':8080/api/ws';

    platform.logger.info("Connecting to the WebSocket API at [%s]", url);

    platform.wsc = new WebSocketClient();

    platform.wsc.open(url);

    platform.wsc.onmessage = function(message) {

        // Heartbeat response can be safely ignored
        if (message == 'pong') {
            return;
        }

        platform.logger.info("WebSocket messge received: ", message);

        let json;
        try {
            json = JSON.parse(message);
        } catch (e) {
            return;
        }

        // if(json.hasOwnProperty("from") && json.from == "device") {
        //     platform.makeReady();
        // }

        if (json.hasOwnProperty("action")) {

            if(json.action == 'update') {
                platform.emitDevice(json.deviceid,json.params);
                platform.makeReady();
            } else {
                platform.logger.debug("UNKNOWN ACTION: ",json);
            }

        } else if (json.hasOwnProperty('config')) {
            if (json.config.hb && json.config.hbInterval) {
                if (!platform.hbInterval) {
                    platform.hbInterval = setInterval(function () {
                        platform.wsc.send('ping');
                    }, json.config.hbInterval * 1000);
                }
            }
            if(json.hasOwnProperty('deviceid')) {
                platform.emitDevice(json.deviceid,json.config);
                platform.makeReady();
            }
        }

    };

    platform.wsc.onopen = function(e) {

        platform.isSocketOpen = true;

        // We need to authenticate upon opening the connection

        let time_stamp = new Date() / 1000;
        let ts = Math.floor(time_stamp);

        // Here's the eWeLink payload as discovered via Charles
        let payload = {};
        payload.action = "userOnline";
        payload.userAgent = 'app';
        payload.version = 6;
        payload.nonce = '' + nonce();
        payload.apkVesrion = "1.8";
        payload.os = 'ios';
        payload.at = platform.config.authenticationToken;
        payload.apikey = platform.apiKey;
        payload.ts = '' + ts;
        payload.model = 'iPhone10,6';
        payload.romVersion = '11.1.2';
        payload.sequence = platform.getSequence();

        let string = JSON.stringify(payload);

        platform.logger.info('Sending login request [%s]', string);

        platform.wsc.send(string);

    };

    platform.wsc.onclose = function(e) {
        platform.logger.info("WebSocket was closed. Reason [%s]", e);
        platform.isSocketOpen = false;
        if (platform.hbInterval) {
            clearInterval(platform.hbInterval);
            platform.hbInterval = null;
        }
    };

}

eWeLink.prototype.getAllDevices = function() {
    let platform = this;

    let url = 'https://' + this.config['apiHost'];

    this.logger.info("Requesting a list of devices from eWeLink HTTPS API at [%s]", url);

    this.webClient = request.createClient(url);

    this.webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
    this.webClient.get('/api/user/device', function(err, res, body) {

        if (err){
            platform.logger.info("An error was encountered while requesting a list of devices. Error was [%s]", err);
            return;
        }

        if (!body || body.hasOwnProperty('error')) {

            let response = JSON.stringify(body);

            platform.logger.info("An error was encountered while requesting a list of devices. Response was [%s]", response);

            if (body && body.error === 401) {
                platform.logger.info("Verify that you have the correct authenticationToken specified in your configuration. The currently-configured token is [%s]", platform.authenticationToken);
            }

            return;
        }

        platform.logger.debug("DEVICES: ",body);

        let size = Object.keys(body).length;
        platform.logger.info("eWeLink HTTPS API reports that there are a total of [%s] devices registered", size);

        if (size === 0) {
            platform.logger.info("As there were no devices were found, all devices have been removed from the platorm's cache. Please regiester your devices using the eWeLink app and restart HomeBridge");
            return;
        }

        body.forEach((device) => {
            platform.apiKey = device.apikey;
            platform.devicesFromApi.set(device.deviceid, device);
            platform.emit('newDevice',device.deviceid);
            platform.emitDevice(device.deviceid, device.params);
        });

        platform.devices = body;

        platform.emit('getAllDevices',body);

    });

}

eWeLink.prototype.makeReady = function() {
    this.readyForNextCommand = true;
    if(this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = false;
    }

    this.emit('ready');
}

eWeLink.prototype.makeBusy = function() {
    this.readyForNextCommand = false;
    if(this.readyTimer) {
        clearTimeout(this.readyTimer);
    }

    this.readyTimer = setTimeout( () => {
        this.emit('force_ready');
        this.makeReady();
    }, 5000);

    this.emit('busy');
}

eWeLink.prototype.getSequence = function() {
    let time_stamp = new Date() / 1000;
    this.sequence = Math.floor(time_stamp * 1000);
    return this.sequence;
};

eWeLink.prototype.setData = function(deviceId, data) {
    this.sendQ.push({
        deviceid: deviceId,
        data: data,
    });
}

eWeLink.prototype._setData = function(deviceId, data) {
    let platform = this;
    let options = {};
    options.protocolVersion = 13;

    platform.logger.info("Setting Data ", deviceId, data);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = data;

    payload.apikey = '' + platform.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);
    platform.logger.info( string );

    if (platform.isSocketOpen) {

        setTimeout(function() {
            platform.wsc.send(string);
        }, 1);

    } 
};


eWeLink.prototype.login = function() {
    if (!this.config.phoneNumber && !this.config.email || !this.config.password || !this.config.imei) {
        var msg = "phoneNumber / email / password / imei not found in config, skipping login";
        this.logger.info(msg);
        this.emit('error',msg);
        this.emit('connection','no_auth');
        return;
    }
    
    var data = {};
    if (this.config.phoneNumber) {
        data.phoneNumber = this.config.phoneNumber;
    } else if (this.config.email) {
        data.email = this.config.email;
    }
    data.password = this.config.password;
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';
    
    let json = JSON.stringify(data);
    this.logger.info('Sending login request with user credentials: %s', json);
    
    //let appSecret = "248,208,180,108,132,92,172,184,256,152,256,144,48,172,220,56,100,124,144,160,148,88,28,100,120,152,244,244,120,236,164,204";
    //let f = "ab!@#$ijklmcdefghBCWXYZ01234DEFGHnopqrstuvwxyzAIJKLMNOPQRSTUV56789%^&*()";
    //let decrypt = function(r){var n="";return r.split(',').forEach(function(r){var t=parseInt(r)>>2,e=f.charAt(t);n+=e}),n.trim()};
    let decryptedAppSecret = '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM'; //decrypt(appSecret);
    let sign = require('crypto').createHmac('sha256', decryptedAppSecret).update(json).digest('base64');
    this.logger.info('Login signature: %s', sign);
    
    let webClient = request.createClient('https://' + this.config.apiHost);
    webClient.headers['Authorization'] = 'Sign ' + sign;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.post('/api/user/login', data , function(err, res, body) {
        if (err) {
            this.logger.info("An error was encountered while logging in. Error was [%s]", err);
            this.emit('error',"An error was encountered while logging in.");
            this.emit('connection','no_auth');
            return;
        }
        
        // If we receive 301 error, switch to new region and try again
        if (body.hasOwnProperty('error') && body.error == 301 && body.hasOwnProperty('region')) {
            let idx = this.config.apiHost.indexOf('-');
            if (idx == -1) {
                this.logger.info("Received new region [%s]. However we cannot construct the new API host url.", body.region);
                this.emit('error',"New region received. Unable to make new API host url.");
                this.emit('connection','no_auth');
                return;
            }
            let newApiHost = body.region + this.config.apiHost.substring(idx);
            if (this.config.apiHost != newApiHost) {
                this.logger.info("Received new region [%s], updating API host to [%s].", body.region, newApiHost);
                this.config.apiHost = newApiHost;
                return this.login();
            }
        }
        
        if (!body.at) {
            let response = JSON.stringify(body);
            this.logger.info("Server did not response with an authentication token. Response was [%s]", response);
            this.emit('error',"Server did not response with an authentication token.");
            this.emit('connection','no_auth');
            return;
        }
        
        this.logger.info('Authentication token received [%s]', body.at);

        this.authenticationToken = body.at;
        this.config.authenticationToken = body.at;
        this.webClient = request.createClient('https://' + this.config['apiHost']);
        this.webClient.headers['Authorization'] = 'Bearer ' + body.at;
        
        this.getWebSocketHost();
        this.emit('connection','authed');
        this.emit('authed');
    }.bind(this));
};

eWeLink.prototype.getWebSocketHost = function () {
    var data = {};
    data.accept = 'mqtt,ws';
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';
    
    let webClient = request.createClient('https://' + this.config.apiHost.replace('-api', '-disp'));
    webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.post('/dispatch/app', data , function(err, res, body) {
        if (err) {
            this.logger.info("An error was encountered while getting websocket host. Error was [%s]", err);
            return;
        }
        
        if (!body.domain) {
            let response = JSON.stringify(body);
            this.logger.info("Server did not response with a websocket host. Response was [%s]", response);
            return;
        }
        
        this.logger.info('WebSocket host received [%s]', body.domain);
        this.config['webSocketApi'] = body.domain;
        if (this.wsc) {
            this.wsc.url = 'wss://' + body.domain + ':8080/api/ws';
        }
    }.bind(this));
};

eWeLink.prototype.getDeviceTypeByUiid = function (uiid) {
    const MAPPING = {
        1: "SOCKET",
        2: "SOCKET_2",
        3: "SOCKET_3",
        4: "SOCKET_4",
        5: "SOCKET_POWER",
        6: "SWITCH",
        7: "SWITCH_2",
        8: "SWITCH_3",
        9: "SWITCH_4",
        10: "OSPF",
        11: "CURTAIN",
        12: "EW-RE",
        13: "FIREPLACE",
        14: "SWITCH_CHANGE",
        15: "THERMOSTAT",
        16: "COLD_WARM_LED",
        17: "THREE_GEAR_FAN",
        18: "SENSORS_CENTER",
        19: "HUMIDIFIER",
        22: "RGB_BALL_LIGHT",
        23: "NEST_THERMOSTAT",
        24: "GSM_SOCKET",
        25: "AROMATHERAPY",
        26: "BJ_THERMOSTAT",
        27: "GSM_UNLIMIT_SOCKET",
        28: "RF_BRIDGE",
        29: "GSM_SOCKET_2",
        30: "GSM_SOCKET_3",
        31: "GSM_SOCKET_4",
        32: "POWER_DETECTION_SOCKET",
        33: "LIGHT_BELT",
        34: "FAN_LIGHT",
        35: "EZVIZ_CAMERA",
        36: "SINGLE_CHANNEL_DIMMER_SWITCH",
        38: "HOME_KIT_BRIDGE",
        40: "FUJIN_OPS",
        41: "CUN_YOU_DOOR",
        42: "SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT",
        43: "",
        44: "",
        45: "DOWN_CEILING_LIGHT",
        46: "AIR_CLEANER",
        49: "MACHINE_BED",
        51: "COLD_WARM_DESK_LIGHT",
        52: "DOUBLE_COLOR_DEMO_LIGHT",
        53: "ELECTRIC_FAN_WITH_LAMP",
        55: "SWEEPING_ROBOT",
        56: "RGB_BALL_LIGHT_4",
        57: "MONOCHROMATIC_BALL_LIGHT",
        59: "MEARICAMERA",
        1001: "BLADELESS_FAN",
        1002: "NEW_HUMIDIFIER",
        1003: "WARM_AIR_BLOWER"
    };
    return MAPPING[uiid] || "";
};

eWeLink.prototype.getDeviceChannelCountByType = function (deviceType) {
    const DEVICE_CHANNEL_LENGTH = {
        SOCKET: 1,
        SWITCH_CHANGE: 1,
        GSM_UNLIMIT_SOCKET: 1,
        SWITCH: 1,
        THERMOSTAT: 1,
        SOCKET_POWER: 1,
        GSM_SOCKET: 1,
        POWER_DETECTION_SOCKET: 1,
        SOCKET_2: 2,
        GSM_SOCKET_2: 2,
        SWITCH_2: 2,
        SOCKET_3: 3,
        GSM_SOCKET_3: 3,
        SWITCH_3: 3,
        SOCKET_4: 4,
        GSM_SOCKET_4: 4,
        SWITCH_4: 4,
        CUN_YOU_DOOR: 4
    };
    return DEVICE_CHANNEL_LENGTH[deviceType] || 0;
};

eWeLink.prototype.getDeviceChannelCount = function (device) {
    let deviceType = this.getDeviceTypeByUiid(device.uiid);
    //this.logger.info('Device type for %s is %s', device.uiid, deviceType);
    let channels = this.getDeviceChannelCountByType(deviceType);
    return channels;
};

/* WEB SOCKET STUFF */

function WebSocketClient() {
    this.number = 0; // Message number
    this.autoReconnectInterval = 5 * 1000; // ms
    this.pendingReconnect = false;
}
WebSocketClient.prototype.open = function(url) {
    this.url = url;
    this.instance = new WebSocket(this.url);
    this.instance.on('open', () => {
        this.onopen();
    });

    this.instance.on('message', (data, flags) => {
        this.number++;
        this.onmessage(data, flags, this.number);
    });

    this.instance.on('close', (e) => {
        switch (e) {
            case 1000: // CLOSE_NORMAL
                // console.log("WebSocket: closed");
                break;
            default: // Abnormal closure
                this.reconnect(e);
                break;
        }
        this.onclose(e);
    });
    this.instance.on('error', (e) => {
        switch (e.code) {
            case 'ECONNREFUSED':
                this.reconnect(e);
                break;
            default:
                this.onerror(e);
                break;
        }
    });
};
WebSocketClient.prototype.send = function(data, option) {
    try {
        this.instance.send(data, option);
    } catch (e) {
        this.instance.emit('error', e);
    }
};
WebSocketClient.prototype.reconnect = function(e) {
    // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);

    if (this.pendingReconnect) return;
    this.pendingReconnect = true;

    this.instance.removeAllListeners();

    let platform = this;
    setTimeout(function() {
        platform.pendingReconnect = false;
        console.log("WebSocketClient: reconnecting...");
        platform.open(platform.url);
    }, this.autoReconnectInterval);
};
WebSocketClient.prototype.onopen = function(e) {
    // console.log("WebSocketClient: open", arguments);
};
WebSocketClient.prototype.onmessage = function(data, flags, number) {
    // console.log("WebSocketClient: message", arguments);
};
WebSocketClient.prototype.onerror = function(e) {
    console.log("WebSocketClient: error", arguments);
};
WebSocketClient.prototype.onclose = function(e) {
    // console.log("WebSocketClient: closed", arguments);
};


module.exports = eWeLink;