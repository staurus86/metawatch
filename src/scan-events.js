const EventEmitter = require('events');

const scanEmitter = new EventEmitter();
scanEmitter.setMaxListeners(100);

// Track whether a scan is currently in progress
let scanRunning = false;

function isScanRunning() { return scanRunning; }
function setScanRunning(v) { scanRunning = v; }

module.exports = { scanEmitter, isScanRunning, setScanRunning };
