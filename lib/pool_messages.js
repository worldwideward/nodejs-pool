"use strict";

const util = require('util');
const debugging = global.config.debugging;

module.exports = {
	
	// Server/Client communication Handling
	messageHandler: function(message, cluster) {

		const poolUtils = require('./pool_utils.js');

		//console.log("[INFO] Cluster", cluster);

		//if (debugging == true) console.debug("[DEBUG] Handle message: " + util.inspect(message, { depth: null }))
		let threadId = "thread-" + process.pid;
        	let threadName = global.cache.getCache(threadId);

		switch (message.type) {

			case 'banIP':
				if (debugging == true) console.debug("[DEBUG] " + threadName + "Received ban IP update from nodes");

				if (cluster.isMaster) {
					sendToWorkers(message);
				} else {
					if (!localhostCheck.test(message.data)) bannedTmpIPs[message.data] = 1;
					else if (message.wallet) bannedTmpWallets[message.wallet] = 1;
				}
				break;

			case 'newBlockTemplate':
				if (debugging == true) console.debug("[DEBUG] " + threadName + "Received new block template");

				poolUtils.setNewBlockTemplate(message.data, cluster, threadName);
				break;

			case 'newCoinHashFactor':
				if (debugging == true) console.debug("[DEBUG] " + threadName + "Received new coin hash factor");
				poolUtils.setNewCoinHashFactor(true, message.data.coin, message.data.coinHashFactor, 0, cluster);
				break;

			case 'minerPortCount':
				if (cluster.isMaster) {
					let minerCount = global.cache.getCache("minerCount");
					minerCount[message.data.worker_id] = message.data.ports;
					global.cache.setCache("minerCount", minerCount);
				}
				break;

			case 'sendRemote':
				if (cluster.isMaster) {
					global.database.sendQueue.push({body: Buffer.from(message.body, 'hex')});
				}
				break;

			case 'trustedShare':
				++ trustedShares;
				++ totalShares;
				break;

			case 'normalShare':
				++ normalShares;
				++ totalShares;
				break;

			case 'invalidShare':
				++ invalidShares;
				++ totalShares;
				break;

			case 'outdatedShare':
				++ outdatedShares;
				// total shares will be also increased separately as part of share type above
				break;

			case 'throttledShare':
				++ throttledShares;
				++ totalShares;
				break;
		}
	}
};
