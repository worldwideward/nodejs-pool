"use strict";
const crypto = require('crypto');
const bignum = require('bignum');
const cluster = require('cluster');
const btcValidator = require('wallet-address-validator');
const async = require('async');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const child_process = require('child_process');
const util = require('util')

const poolUtils = require('./pool_utils.js');
const poolMessages = require('./pool_messages.js');
const poolBlockTemplates = require('./pool_block_templates.js');
const poolMiner = require('./pool_miner.js');
const lmcache = require('./lmdb_cache');

//const httpResponse   = ' 200 OK\nContent-Type: text/plain\nContent-Length: 18\n\nMining Pool Online';
const hexMatch       = new RegExp("^(?:[0-9a-f][0-9a-f])+$");
const localhostCheck = new RegExp(/127\.0\.0\.1$/);
const baseDiff       = global.coinFuncs.baseDiff();

const debugging = global.config.debugging;

const BLOCK_NOTIFY_PORT = 2223;
const DAEMON_POLL_MS = 500;

let uniqueWorkerId;
let uniqueWorkerIdBits;

let bannedTmpIPs = {};        // ip banned for short time
let bannedTmpWallets = {};    // wallets banned for short time
let bannedBigTmpWallets = {}; // wallets banned for a long time
let bannedAddresses = {};     // forever banned wallets
let notifyAddresses = {};     // wallet notifications

//let lastBlockHash        = {}; // coin key
//let lastBlockHeight      = {}; // coin key
//let lastBlockTime        = {}; // coin key
//let lastBlockKeepTime    = {}; // coin key
//let lastBlockReward      = {}; // coin key
let pastBlockTemplates   = {}; // coin key -> global.support.circularBuffer -> activeBlockTemplates

let newCoinHashFactor  = {}; // coin key, current individual coin hash factor, set in updateCoinHashFactor
let lastCoinHashFactor = {}; // coin key, last set individual coin hash factor, set in setNewCoinHashFactor

let lastBlockFixTime  = {}; // time when blocks were checked to be in line with other nodes or when fix_daemon_sh was attempted
let lastBlockFixCount = {}; // number of times fix_daemon_sh was run

let threadName;
let totalShares = 0, trustedShares = 0, normalShares = 0, invalidShares = 0, outdatedShares = 0, throttledShares = 0;

// wallet -> { connectTime, count (miner), hashes, last_ver_shares }
// this is need to thottle down some high share count miners

Buffer.prototype.toByteArray = function () {
    return Array.prototype.slice.call(this, 0);
};

// init LMDB based cache
global.cache = new lmcache();
global.cache.initEnv();

global.cache.setCache("minerWallets", {});
global.cache.setCache("walletTrust", {});
global.cache.setCache("walletLastSeeTime", {});
global.cache.setCache("notifyAddresses", {});
global.cache.setCache("proxyMiners", {});
global.cache.setCache("minerCount", []);

let minerWallets = global.cache.getCache("minerWallets");
let walletTrust = global.cache.getCache("walletTrust");
let walletLastSeeTime = global.cache.getCache("walletLastSeeTime");
let minerCount = global.cache.getCache("minerCount");

// Pool Daemon

if (cluster.isMaster) {

	let threadName = "[Master] ";

	let threadId = "thread-" + process.pid;
	global.cache.setCache(threadId, threadName);

	setInterval(function () {

		let trustedSharesPercent   = (totalShares ? trustedShares   / totalShares * 100 : 0).toFixed(2);
		let normalSharesPercent    = (totalShares ? normalShares    / totalShares * 100 : 0).toFixed(2);
		let invalidSharesPercent   = (totalShares ? invalidShares   / totalShares * 100 : 0).toFixed(2);
		let outdatedSharesPercent  = (totalShares ? outdatedShares  / totalShares * 100 : 0).toFixed(2);
		let throttledSharesPercent = (totalShares ? throttledShares / totalShares * 100 : 0).toFixed(2);

		console.log(
			`[INFO] Share Report: Trusted=${trustedShares}(${trustedSharesPercent}%) / Validated=${normalShares}(${normalSharesPercent}%) / Invalid=${invalidShares}(${invalidSharesPercent}%) / Outdated=${outdatedShares}(${outdatedSharesPercent}%) / Throttled=${throttledShares}(${throttledSharesPercent}%) / Total=${totalShares} shares`
		);

		totalShares     = 0;
		trustedShares   = 0;
		normalShares    = 0;
		invalidShares   = 0;
		outdatedShares  = 0;
		throttledShares = 0;

	}, 30*1000);

} else {

	threadName = "[Worker " + process.env['WORKER_ID'] + " - " + process.pid + "] ";

	let threadId = "thread-" + process.pid;
	global.cache.setCache(threadId, threadName);

	// reset last verified share counters
	setInterval(function () {

		for (let wallet in minerWallets) {

			minerWallets[wallet].last_ver_shares = 0;
		}
	}, global.config.miner_throttle_share_window_seconds*1000);
}

global.database.thread_id = threadName;

const COINS = global.coinFuncs.getCOINS();

process.on('message', poolMessages.messageHandler);

// Start the pool process
//
console.log("[INFO] Debugging enabled: ", global.config.debugging)

if (debugging == true) {
	console.debug("[DEBUG] Cluster is Master? " + cluster.isMaster)
	console.debug("[DEBUG] Coins: " + COINS)
}


if (cluster.isMaster) {

	const numWorkers = global.config.worker_num ? global.config.worker_num : require('os').cpus().length;
	if (debugging == true) console.log("[DEBUG] Pool Master");

	for (let i = 1; i <= numWorkers; ++ i) {

		minerCount[i] = [];
		global.config.ports.forEach(function (portData) {
			minerCount[i][portData.port] = 0;
		});
		global.cache.setCache("minerCount", minerCount);
	}

	poolUtils.registerPool();

	setInterval(function () {

		let activeBlockTemplates = global.cache.getCache("activeBlockTemplates");

		if ("" in activeBlockTemplates) {

			global.mysql.query(
				"UPDATE pools SET last_checkin = ?, active = ?, blockIDTime = now(), blockID = ?, port = ? WHERE id = ?",
				[global.support.formatDate(Date.now()), true, activeBlockTemplates[""].height,
				activeBlockTemplates[""].port,
				global.config.pool_id]
			).catch(function (error) {
				console.error("SQL query failed: " + error);
			});
		} else {
			global.mysql.query(
				"UPDATE pools SET last_checkin = ?, active = ? WHERE id = ?",
				[global.support.formatDate(Date.now()), true, global.config.pool_id]
			).catch(function (error) {
				console.error("SQL query failed: " + error);
			});
		}

		global.config.ports.forEach(function (portData) {

			let miner_count = 0;

			for (let i = 1; i <= numWorkers; ++ i) miner_count += minerCount[i][portData.port];
			
			global.mysql.query(
				"UPDATE ports SET lastSeen = now(), miners = ? WHERE pool_id = ? AND network_port = ?",
				[miner_count, global.config.pool_id, portData.port]
			).catch(function (error) {
				console.error("SQL query failed: " + error);
			});
		});
	}, 30*1000);

	setInterval(function () {

		let activeBlockTemplates = global.cache.getCache("activeBlockTemplates");

		if (!("" in activeBlockTemplates)) return;

		global.mysql.query(
			"SELECT blockID, port FROM pools WHERE last_checkin > date_sub(now(), interval 30 minute)"
		).then(function (rows) {

			let top_height = 0;

			const port   = activeBlockTemplates[""].port;
			const height = activeBlockTemplates[""].height;

			rows.forEach(function (row) {

				if (row.port != port) return;
				if (row.blockID > top_height) top_height = row.blockID;
			});

			if (top_height) {

				if (height < top_height - 3) {

					console.error("!!! Current block height " + height + " is stuck compared to top height (" + top_height + ") amongst other leaf nodes for " + port + " port");

					if (!(port in lastBlockFixTime)) lastBlockFixTime[port] = Date.now();
					if (Date.now() - lastBlockFixTime[port] > 20*60*1000) {

						if (!(port in lastBlockFixCount)) lastBlockFixCount[port] = 1; else ++ lastBlockFixCount[port];

						if (lastBlockFixCount[port] > 5 && global.config.general.allowStuckPoolKill && port == global.config.daemon.port) {

							global.support.sendEmail(global.config.general.adminEmail,
								"Pool server " + global.config.hostname + " will be terminated",
								"The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + 
								" will be terminated due to main chain block template stuck"
							);

							console.error("Block height was not updated for a long time for main port. Check your monerod. Exiting...");
							fs.closeSync(fs.openSync("block_template_is_stuck", 'w'));

							setTimeout(function() { process.exit(); }, 30*1000); // need time for admin email sending
							return;
						}

						global.coinFuncs.fixDaemonIssue(height, top_height, port);
						lastBlockFixTime[port] = Date.now();
					}
				} else {

					if (height >= top_height + 3) {
						console.warn(
							"[WARN] Current block height " + height + " is somehow greater than top height (" + top_height + ") amongst other leaf nodes for " + port + " port");
					}

					lastBlockFixTime[port] = Date.now();
					lastBlockFixCount[port] = 0;
				}

			} else {

				console.error("Can't get top height amongst all leaf nodes for " + port + " port");
				lastBlockFixTime[port] = Date.now();
				lastBlockFixCount[port] = 0;
			}
		}).catch(function (error) {
			console.error("SQL query failed: " + error);
		});
	}, 60*1000);

	console.log('Master cluster setting up ' + numWorkers + ' workers...');

	let master_cluster_worker_id_map = {};

	for (let i = 0; i < numWorkers; i++) {

		let worker = cluster.fork({ WORKER_ID: master_cluster_worker_id_map[i + 1] = i + 1 });
		worker.on('message', (msg) => poolMessages.messageHandler(msg, cluster));
	}

	cluster.on('online', function (worker) {

		console.log('Worker ' + worker.process.pid + ' is online');
	});

	cluster.on('exit', function (worker, code, signal) {

		console.error('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
		console.log('Starting a new worker');

		const prev_worker_id = master_cluster_worker_id_map[worker.id];

		delete master_cluster_worker_id_map[worker.id];

		worker = cluster.fork({ WORKER_ID: prev_worker_id });
		master_cluster_worker_id_map[worker.id] = prev_worker_id;
		worker.on('message', (msg) => poolMessages.messageHandler(msg, cluster));

		global.support.sendEmail(global.config.general.adminEmail, "FYI: Started new worker " + prev_worker_id,
			"Hello,\r\nMaster thread of " + global.config.hostname + " starts new worker with id " + prev_worker_id);
	});

	// Set initial coin hash factor
	newCoinHashFactor[""] = lastCoinHashFactor[""] = 1;

	// Set inital block template
	if (debugging == true) console.debug("[DEBUG] Set initial block template for cluster:" + cluster);

	let block_template = poolBlockTemplates.templateUpdate("", false, cluster, newCoinHashFactor);

	if (debugging == true) console.debug("[DEBUG] Got initial block template: " + block_template);

	setTimeout(poolBlockTemplates.templateUpdate, DAEMON_POLL_MS, "", true, cluster);

	if (global.config.daemon.enableAlgoSwitching) {

		if (global.config.daemon.enableAlgoSwitching) COINS.forEach(function(coin) {

			newCoinHashFactor[coin] = lastCoinHashFactor[coin] = lastCoinHashFactorMM[coin] = 0;
			setInterval(poolUtils.updateCoinHashFactor, 5*1000, coin);
			poolBlockTemplates.templateUpdate(coin, true, cluster, newCoinHashFactor);
			setTimeout(poolBlockTemplates.templateUpdate, DAEMON_POLL_MS, coin, true, cluster, newCoinHashFactor);
		});

	} else {
		console.warn("[WARN] global.config.daemon.enableAlgoSwitching is not enabled");
	}

	// Do not send emails
	//global.support.sendEmail(global.config.general.adminEmail, "Pool server " + global.config.hostname + " online", "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");
	
	console.log("Pool server " + global.config.hostname + " online", "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");

	let block_notify_server = net.createServer(function (socket) {

		let timer = setTimeout(function() {
			console.error(threadName + "Timeout waiting for block notify input");
			socket.destroy();
		}, 3*1000);

		let buff = "";

		socket.on('data', function (buff1) {

			buff += buff1;
		});

		socket.on('end', function () {

			clearTimeout(timer);
			timer = null;

			const port = parseInt(buff.toString());
			const coin = global.coinFuncs.PORT2COIN(port);

			if (typeof(coin) === 'undefined') {

				console.error(threadName + "Block notify for unknown coin with " + port + " port");
			} else {
				console.log(threadName + "Block notify for coin " + coin + " with " + port + " port");
				poolBlockTemplates.templateUpdate(coin, false, cluster);
			}
		});

		socket.on('error', function() {

			console.error(threadName + "Socket error on block notify port");
			socket.destroy();
		});
	});

	block_notify_server.listen(BLOCK_NOTIFY_PORT, "127.0.0.1", function() {

		console.debug("[DEBUG] " + threadName + "Block notify server on " + BLOCK_NOTIFY_PORT + " port started");
	});

	// Pool Server started
	
} else poolUtils.getUniqueWorkerID(function(id, maxId) {

	let activeBlockTemplates = global.cache.getCache("activeBlockTemplates");

	uniqueWorkerId = id;
	uniqueWorkerIdBits = 0;

	while (maxId) { maxId >>= 1; ++ uniqueWorkerIdBits; }

	if (debugging == true) {

		console.log("[DEBUG] Pool Main Worker");
		console.log("[DEBUG] Active block templates: ", activeBlockTemplates);
		console.log("[DEBUG] " + threadName + "Starting pool worker with " + uniqueWorkerId + " unique id and " + uniqueWorkerIdBits + " reserved bits");
	}

	newCoinHashFactor[""] = lastCoinHashFactor[""] = 1;
	poolBlockTemplates.templateUpdate("", false, cluster);

	if (global.config.daemon.enableAlgoSwitching) COINS.forEach(function(coin) {

		poolUtils.newCoinHashFactor[coin] = lastCoinHashFactor[coin] = lastCoinHashFactorMM[coin] = 0;
		poolBlockTemplates.templateUpdate(coin, false, cluster);
	});
	

	poolUtils.anchorBlockUpdate(activeBlockTemplates);

	setInterval(poolUtils.anchorBlockUpdate, 3*1000, activeBlockTemplates);
	setInterval(poolUtils.checkAliveMiners, 60*1000, threadName);
	setInterval(poolUtils.retargetMiners, global.config.pool.retargetTime * 1000);
	setInterval(function () {

		bannedTmpIPs = {};
		bannedTmpWallets = {};
	}, 10*60*1000);

	setInterval(function () {

		bannedBigTmpWallets = {};
	}, 60*60*1000);

	function add_bans(is_show) {

		global.mysql.query("SELECT mining_address, reason FROM bans").then(function (rows) {

			bannedAddresses = {};
			rows.forEach(function (row) {

				bannedAddresses[row.mining_address] = row.reason;
				if (is_show) console.log("Added blocked address " + row.mining_address + ": " + row.reason);
			});
		}).catch(function (error) {

			console.error("SQL query failed: " + error);
		});

		global.mysql.query("SELECT mining_address, message FROM notifications").then(function (rows) {

			notifyAddresses = {};
			rows.forEach(function (row) {

				notifyAddresses[row.mining_address] = row.message;
				if (is_show) console.log("Added notify address " + row.mining_address + ": " + row.message);
			});
		}).catch(function (error) {
			console.error("SQL query failed: " + error);
		});
	}

	add_bans(true);
	setInterval(add_bans, 10*60*1000);

	// load merged wallet trust from files
	let numWorkers = require('os').cpus().length;

	for (let i = 1; i <= numWorkers; ++ i) {

		let fn = "wallet_trust_" + i.toString();
		let rs = fs.createReadStream(fn);

		rs.on('error', function() { 
			console.error("Can't open " + fn + " file"); 
		});

		let lineReader = require('readline').createInterface({ input: rs });

		lineReader.on('error', function() { 
			console.error("Can't read lines from " + fn + " file"); 
		});

		lineReader.on('line', function (line) {
			let parts = line.split(/\t/);

			if (parts.length != 3) {
				console.error("Error line " + line + " ignored from " + fn + " file");
				return;
			}

			let wallet = parts[0];
			let trust  = parseInt(parts[1], 10);
			let time   = parseInt(parts[2], 10);

			if (Date.now() - time < 24*60*60*1000 && (!(wallet in walletTrust) || trust < walletTrust[wallet])) {

				if (debugging == true) console.debug("[DEBUG] Adding " + trust.toString() + " trust for " + wallet + " wallet");

				walletTrust[wallet] = trust;
				walletLastSeeTime[wallet] = time;
			}
		});
	}

	// dump wallet trust and miner agents to file
	
	setInterval(function () {

		let str = "";
		for (let wallet in walletTrust) {

			let time = walletLastSeeTime[wallet];

			if (Date.now() - time < 24*60*60*1000) {

				str += wallet + "\t" + walletTrust[wallet].toString() + "\t" + time.toString() + "\n";
			} else {
				delete walletTrust[wallet];
				delete walletLastSeeTime[wallet];
			}
		}

		const fn = "wallet_trust_" + process.env['WORKER_ID'].toString();
		fs.writeFile(fn, str, function(err) { if (err) console.error("Error saving " + fn + " file"); });

		if (process.env['WORKER_ID'] == 1) {

			let str2 = "";
			for (let agent in minerAgents) { str2 += agent + "\n"; }

			const fn2 = "miner_agents";
			fs.writeFile(fn2, str2, function(err) { if (err) console.error("Error saving " + fn2 + " file"); });
		}

		//cacheTargetHex = {};
	}, 10*60*1000);

	// get extra wallets to check
	setInterval(function () {

		const extra_wallet_verify_fn = "extra_wallet_verify.txt";
		let extra_wallet_verify = {};
		fs.access(extra_wallet_verify_fn, fs.F_OK, function(err) {

			if (err) return;
			let rs = fs.createReadStream(extra_wallet_verify_fn);

			rs.on('error', function() { console.error("Can't open " + extra_wallet_verify_fn + " file"); });

			let lineReader = require('readline').createInterface({ input: rs });

			lineReader.on('line', function (line) {

				console.log(threadName + "[EXTRA CHECK] added: '" + line + "'");
				extra_wallet_verify[line] = 1;
			});

			const fn = "extra_verify_wallet_hashes_" + process.env['WORKER_ID'].toString();

			fs.writeFile(fn, extra_verify_wallet_hashes.join("\n"), function(err) { if (err) console.error("Error saving " + fn + " file"); });
			extra_verify_wallet_hashes = [];
		});

		const wallet_debug_fn = "wallet_debug.txt";
		let wallet_debug = {};

		fs.access(wallet_debug_fn, fs.F_OK, function(err) {

			if (err) return;
			let rs = fs.createReadStream(wallet_debug_fn);

			rs.on('error', function() { console.error("Can't open " + wallet_debug_fn + " file"); });
			let lineReader = require('readline').createInterface({ input: rs });

			lineReader.on('line', function (line) {

				console.log(threadName + "[WALLET DEBUG] added: '" + line + "'");
				wallet_debug[line] = 1;
			});
		});

		const ip_whitelist_fn = "ip_whitelist.txt";
		let ip_whitelist = {};

		fs.access(ip_whitelist_fn, fs.F_OK, function(err) {

			if (err) return;

			let rs = fs.createReadStream(ip_whitelist_fn);

			rs.on('error', function() { console.error("Can't open " + ip_whitelist_fn + " file"); });
			let lineReader = require('readline').createInterface({ input: rs });

			lineReader.on('line', function (line) {

				console.log(threadName + "[IP WHITELIST]: '" + line + "'");
				ip_whitelist[line] = 1;
			});
		});
	}, 5*60*1000);

	//let lastGarbageFromIpTime = {};
	
	async.each(global.config.ports, function (portData) {

		if (global.config[portData.portType].enable !== true) {
			return;
		}

		let handleMessage = function (socket, jsonData, pushMessage) {

			if (!jsonData.id) {

				console.warn('[WARN] Miner RPC request missing RPC id');
				return;

			} else if (!jsonData.method) {

				console.warn('[WARN] Miner RPC request missing RPC method');
				return;
			}

			let sendReply = function (error, result) {

				if (!socket.writable) return;

				let reply = {

					jsonrpc: "2.0",
					id: jsonData.id,
					error: error ? {code: -1, message: error} : null,
					result: result
				};

				if (jsonData.id === "Stratum") reply.method = jsonData.method;
				if (socket.debugMiner) console.log("[DEBUG] Miner - " + threadName + " pool reply " + JSON.stringify(reply));
				socket.write(JSON.stringify(reply) + "\n");
			};

			let sendReplyFinal = function (error, timeout) {

				setTimeout(function() {

					if (!socket.writable) return;

					let reply = {
						jsonrpc: "2.0",
						id: jsonData.id,
						error: {code: -1, message: error},
						result: null
					};

					if (jsonData.id === "Stratum") reply.method = jsonData.method;
					console.debug("[MINER] FINAL REPLY TO MINER: " + JSON.stringify(reply));
					if (socket.debugMiner) console.log(threadName + " [WALLET DEBUG] final reply " + JSON.stringify(reply));
					socket.end(JSON.stringify(reply) + "\n");
				}, (timeout ? timeout : 9) * 1000);
			};

			console.log("[INFO] Handle message to handle miner data")
			console.log("[INFO] JSON Data ID:" + jsonData.id)
			console.log("[INFO] JSON Data Method:" + jsonData.method)
			console.log("[INFO] JSON Data Params:" + jsonData.params)
			console.log("[INFO] Socket remote address:" + socket.remoteAddress)
			console.log("[INFO] Active block templates:" + activeBlockTemplates)

			poolUtils.handleMinerData(socket, jsonData.id, jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, sendReplyFinal, pushMessage, bannedTmpIPs, activeBlockTemplates);
			console.log("[INFO] Resuming work")

			if (socket.debugMiner) console.log("[DEBUG] Miner - " + threadName + " pool received: " + JSON.stringify(jsonData));
		};

		function socketConn(socket) {

			socket.setKeepAlive(true);
			socket.setEncoding('utf8');

			if (debugging == true) console.debug("[DEBUG] Opening Socket: " + socket);
			let dataBuffer = '';

			let pushMessage = function (body) {

				if (!socket.writable) return;
				body.jsonrpc = "2.0";
				if (socket.debugMiner) console.log("[DEBUG] Miner -" + threadName + " [WALLET DEBUG] push " + JSON.stringify(body));
				socket.write(JSON.stringify(body) + "\n");
			};

			socket.on('data', function (d) {

				dataBuffer += d;

				if (Buffer.byteLength(dataBuffer, 'utf8') > 102400) { //100KB

					dataBuffer = null;
					console.warn(threadName + 'Excessive packet size from: ' + socket.remoteAddress);
					socket.destroy();
					return;
				}

				if (dataBuffer.indexOf('\n') !== -1) {

					let messages = dataBuffer.split('\n');
					let incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();

					for (let i = 0; i < messages.length; i++) {

						let message = messages[i];
						if (message.trim() === '') {

							continue;
						}
						let jsonData;

						try {
							jsonData = JSON.parse(message);
						} catch (e) {
							console.error("[ERROR] Socket Error Parsing JSON data: " + e)
							socket.destroy();
							break;
						}

						console.log("[INFO] Socket to handle message")
						handleMessage(socket, jsonData, pushMessage);
					}

					dataBuffer = incomplete;
				}
			}).on('error', function (err) {

				if (debugging == true) console.debug("[DEBUG] Miner Socket error: " + err.code + "socket: " + socket);

			}).on('close', function () {

				if (debugging == true) console.debug("[DEBUG] Miner Socket closed");
				pushMessage = function () {};
				
				let minersFromCache = global.cache.getCache("activeMiners");
				let activeMiners = new Map(Object.entries(minersFromCache));
				if (debugging == true) console.log("[DEBUG] Active Miners", activeMiners);
				if (socket.miner_id) activeMiners.get(socket.miner_id);
			});
		}

		if ('ssl' in portData && portData.ssl === true) {

			let server = tls.createServer({

				key: fs.readFileSync('cert.key'),
				cert: fs.readFileSync('cert.pem')
			}, socketConn);

			server.listen(portData.port, global.config.bind_ip, function (error) {

				if (error) {
					console.error("[ERROR] " + threadName + "Unable to start server on: " + portData.port + " Message: " + error);
					return;
				}

				console.log("[INFO] " + threadName + "Started server on port: " + portData.port);
			});

			server.on('error', function (error) {
				console.error("[ERRPR] Can't bind server to " + portData.port + " SSL port!");
			});
		} else {

			let server = net.createServer(socketConn);
			server.listen(portData.port, global.config.bind_ip, function (error) {

				if (error) {

					console.error("[ERROR] " + threadName + "Unable to start server on: " + portData.port + " Message: " + error);
					return;
				}
				console.log("[INFO] " + threadName + "Started server on port: " + portData.port);
			});

			server.on('error', function (error) {
				console.error("[ERROR] Can't bind server to " + portData.port + " port!");
			});
		}
	});
});
