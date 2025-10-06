// pool_utils.js
"use strict";
const util = require('util')
const poolMiner = require('./pool_miner.js');
const poolMessages = require('./pool_messages.js');
const lmcache = require('./lmdb_cache.js');

const debugging = global.config.debugging;
const baseDiff  = global.coinFuncs.baseDiff();

const nonceCheck32   = new RegExp("^[0-9a-f]{8}$");
const nonceCheck64   = new RegExp("^[0-9a-f]{16}$");
const hashCheck32    = new RegExp("^[0-9a-f]{64}$");


let activeMiners = new Map();

module.exports = {

	get_new_id: function(decId = 0) {
		if (++decId > 999999999999999) decId = 0;
		return decId.toString(10);
	},

	pad_hex: function(str, bytes) {
		const bytes2 = bytes * 2;
		return ("00".repeat(bytes) + str.substr(0, bytes2)).substr(-bytes2);
	},

	registerPool: function () {
		global.mysql.query("INSERT INTO pools (id, ip, last_checkin, active, hostname) VALUES (?, ?, now(), ?, ?) ON DUPLICATE KEY UPDATE last_checkin=now(), active=?",
			[global.config.pool_id, global.config.bind_ip, true, global.config.hostname, true]);
		global.mysql.query("DELETE FROM ports WHERE pool_id = ?", [global.config.pool_id]).then(function () {

			global.config.ports.forEach(function (port) {
				if ('ssl' in port && port.ssl === true) {
					global.mysql.query("INSERT INTO ports (pool_id, network_port, starting_diff, port_type, description, hidden, ip_address, ssl_port) values (?, ?, ?, ?, ?, ?, ?, 1)",
						[global.config.pool_id, port.port, port.difficulty, port.portType, port.desc, port.hidden, global.config.bind_ip]);
				} else {
					global.mysql.query("INSERT INTO ports (pool_id, network_port, starting_diff, port_type, description, hidden, ip_address, ssl_port) values (?, ?, ?, ?, ?, ?, ?, 0)",
						[global.config.pool_id, port.port, port.difficulty, port.portType, port.desc, port.hidden, global.config.bind_ip]);
				}
			});
		});
		console.info("[INFO] Pool registered");
	},

	sendToWorkers: function(data, cluster) {
		if (debugging == true) {
			console.debug("[DEBUG] Send to Workers - Block hashing blob: ", data.data.blockhashing_blob)
			console.debug("[DEBUG] Send to Workers - workers: ", cluster.workers)
		}
		try {
			Object.keys(cluster.workers).forEach(function(key) {
				cluster.workers[key].send(data);
			});
		} catch(error) {
			console.error("[ERROR] No such worker: " + error)
		}
	},

	adjustMinerDiff: function(miner) {
		if (miner.fixed_diff) {
			const newDiff = miner.calcNewDiff();
			if (miner.difficulty * 10 < newDiff) {
				console.log("[INFO] Dropped low fixed diff " + miner.difficulty + " for " + miner.logString + " miner to " + newDiff + " dynamic diff");
				miner.fixed_diff = false;
				if (miner.setNewDiff(newDiff)) return true;
			}
		} else if (miner.setNewDiff(miner.calcNewDiff())) {
			return true;
		}
		return false;
	},

	retargetMiners: function() {
		let minerCount = global.cache.getCache("minerCount");
		if (debugging == true) console.debug("[DEBUG] " + threadName + "Performing difficulty check on miners");
		global.config.ports.forEach(function (portData) { minerCount[portData.port] = 0; });
		const time_before = Date.now();

		for (var [minerId, miner] of activeMiners) {
			if (module.exports.adjustMinerDiff(miner)) miner.sendSameCoinJob();
			++ minerCount[miner.port];
		}

		const elapsed = Date.now() - time_before;
		if (elapsed > 50) console.error(threadName + "retargetMiners() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
		process.send({type: 'minerPortCount', data: { worker_id: process.env['WORKER_ID'], ports: minerCount } });
	},

	addProxyMiner: function(miner) {

		let proxyMiners = global.cache.getCache("proxyMiners");

		if (miner.proxyMinerName && miner.proxyMinerName in proxyMiners) return;

		const wallet = miner.payout;
		const proxyMinerName = wallet; //+ ":" + miner.identifier;
		miner.proxyMinerName = proxyMinerName;

		if (!(proxyMinerName in proxyMiners)) {

			proxyMiners[proxyMinerName] = {};
			proxyMiners[proxyMinerName].connectTime = Date.now();
			proxyMiners[proxyMinerName].count = 1;
			proxyMiners[proxyMinerName].hashes = 0;
		
			let proxyMiners = global.cache.setCache("proxyMiners", proxyMiners);

			console.log("[INFO] Starting to calculate high diff for " + proxyMinerName + " proxy");
		} else {

			if (++ proxyMiners[proxyMinerName].count > global.config.pool.workerMax && !miner.xmrig_proxy) {

				console.error("[ERROR] " + threadName + "Starting to long ban  " + wallet + " miner address");
				bannedBigTmpWallets[wallet] = 1;

				for (var [minerId2, miner2] of activeMiners) if (miner2.payout === wallet) removeMiner(miner2);
				return false;
			}
		}
		return true;
	},

	removeMiner: function(miner) {

		let proxyMiners = global.cache.getCache("proxyMiners");

		if (!miner || miner.removed_miner) return;
		const proxyMinerName = miner.proxyMinerName;

		if (proxyMinerName && proxyMinerName in proxyMiners && --proxyMiners[proxyMinerName].count <= 0) delete proxyMiners[proxyMinerName];
		if (miner.payout in minerWallets && --minerWallets[miner.payout].count <= 0) delete minerWallets[miner.payout];

		activeMiners.delete(miner.id);
		miner.removed_miner = true;
	},

	checkAliveMiners: function(threadName) {

		if (debugging == true) console.debug("[DEBUG] " + threadName + "Verifying if miners are still alive");
		const time_before = Date.now();
		const deadline = time_before - global.config.pool.minerTimeout * 1000;

		for (var [minerId, miner] of activeMiners) if (miner.lastContact < deadline) removeMiner(miner);
		const elapsed = Date.now() - time_before;
		if (elapsed > 50) console.error(threadName + "checkAliveMiners() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
	},

	// coin hash factor is only updated in master thread
	updateCoinHashFactor: function(coin) {

		if (coin == "XTM") coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);

		else global.support.getCoinHashFactor(coin, function (coinHashFactor) {

			if (coinHashFactor === null) {
				console.error("Error getting coinHashFactor for " + coin + " coin");
				coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);

			} else if (!coinHashFactor) {
				coinHashFactorUpdate(coin, newCoinHashFactor[coin] = 0);

			} else {
				newCoinHashFactor[coin] = coinHashFactor;
			}
		});
	},

	coinHashFactorUpdate: function(coin, coinHashFactor) {

		if (coin === "") return;
		if (coinHashFactor === 0 && lastCoinHashFactor[coin] === 0) return;

		if (cluster.isMaster) {

			console.log('[INFO] New ' + coin + ' coin hash factor is set from ' + newCoinHashFactor[coin] + ' to ' + coinHashFactor);
			let data = { coin: coin, coinHashFactor: coinHashFactor };
			sendToWorkers({type: 'newCoinHashFactor', data: data});
		}
		module.exports.setNewCoinHashFactor(true, coin, coinHashFactor, 0, cluster);
	},

	process_rpc_template: function(rpc_template, coin, port, coinHashFactor, isHashFactorChange) {

		let template = Object.assign({}, rpc_template);

		template.coin               = coin;
		template.port               = parseInt(port);
		template.coinHashFactor     = coinHashFactor;
		template.isHashFactorChange = isHashFactorChange;

		return template;
	},

	// update main chain anchor block height for alt chain block
	// anchorBlockUpdate is only called in worker threads
	anchorBlockUpdate: function(activeBlockTemplates, debugging = false) {

		let anchorBlockHeight;
		let anchorBlockPrevHeight;

		if (("" in activeBlockTemplates) && global.config.daemon.port == activeBlockTemplates[""].port) return;

		// only need to do that separately if we mine alt chain
		global.coinFuncs.getLastBlockHeader(function (err, body) {
			if (err === null) {
				anchorBlockHeight = body.height + 1;

				if (!anchorBlockPrevHeight || anchorBlockPrevHeight != anchorBlockHeight) {
					anchorBlockPrevHeight = anchorBlockHeight;
					if (debugging == true) console.debug("[DEBUG] Anchor block was changed to " + anchorBlockHeight);
				}
			} else {
				console.error("[ERROR] Anchor last block header request failed!");
			}
		});
	},

	getCoinJobParams: function(coin) {

		let activeBlockTemplates = global.cache.getCache("activeBlockTemplates");
		let lastCoinHashFactorMM = { "" : 0 };

		let params = {};
		params.bt             = activeBlockTemplates[coin];
		params.coinHashFactor = lastCoinHashFactorMM[coin];
		params.algo_name      = global.coinFuncs.algoShortTypeStr(params.bt.port, params.bt.block_version);

		if (debugging == true) console.log("[DEBUG] Got Coin Job Params: " + util.inspect(params, { depth: null }));
		return params;
	},

	setNewCoinHashFactor: function(isHashFactorChange, coin, coinHashFactor, check_height, cluster) {

		console.log("[INFO] Setting new coin hash factor")

		let threadId = "thread-" + process.pid;
        	let threadName = global.cache.getCache(threadId);

		let activeBlockTemplates = global.cache.getCache("activeBlockTemplates");

		if (isHashFactorChange) lastCoinHashFactor[coin] = coinHashFactor;

		//const prevCoinHashFactorMM = lastCoinHashFactorMM[coin];
		//lastCoinHashFactorMM[coin] = coinHashFactor; // used in miner.selectBestCoin
		let lastCoinHashFactor = 0;

		const port = global.coinFuncs.COIN2PORT(coin);

		console.log("[INFO] New coin hash factor - port: " + port)

		if (cluster.isMaster && coin !== "") {
			console.log('[INFO] New ' + coin + ' coin hash factor is set from ' + lastCoinHashFactor + ' to ' + coinHashFactor);
		}

		if (!(coin in activeBlockTemplates)) return;

		// update parent coins if current coin was updated now
		if (isHashFactorChange) if (port in global.coinFuncs.getMM_CHILD_PORTS()) {

			const parent_ports = global.coinFuncs.getMM_CHILD_PORTS()[port];

			for (let parent_port in parent_ports) {

				const parent_coin = global.coinFuncs.PORT2COIN(parent_port);
				module.exports.setNewCoinHashFactor(true, parent_coin, lastCoinHashFactor[parent_coin], 0);
			}
		}

		const time_before = Date.now();
		let strLogPrefix;

		if (isHashFactorChange) {

			const port          = activeBlockTemplates[coin].port;
			const block_version = activeBlockTemplates[coin].block_version;
			const algo          = global.coinFuncs.algoShortTypeStr(port, block_version);

			strLogPrefix = "Full Block Template update for coin " + coin;
			if (cluster.isMaster) console.log("[INFO] " + threadName + strLogPrefix + " with hash factor changed to " + lastCoinHashFactor[coin]);

			if (check_height) {
				for (var [minerId, miner] of activeMiners) {
					if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
					miner.trust.check_height = check_height;
					miner.sendBestCoinJob();
				}
			} else {
				for (var [minerId, miner] of activeMiners) {
					if (!global.coinFuncs.isMinerSupportAlgo(algo, miner.algos)) continue;
					miner.sendBestCoinJob();
				}
			}
		} else {
			strLogPrefix = "Fast Block Template update for coin " + coin;

			if (cluster.isMaster) console.log("[INFO] " + threadName + strLogPrefix + " with the same " + lastCoinHashFactor[coin] + " hash factor");
			const params = module.exports.getCoinJobParams(coin);

			//let activeMiners = global.cache.getCache("activeMiners");

			console.log("[DEBUG] Active Miners", activeMiners);

			if (check_height) {
				for (var [minerId, miner] of activeMiners) {
					if (miner.curr_coin !== coin) continue;
					miner.trust.check_height = check_height;
					miner.sendCoinJob(coin, params);
				}
			} else {
				for (var [minerId, miner] of activeMiners) {
					if (miner.curr_coin !== coin) continue;
					miner.sendCoinJob(coin, params);
				}
			}
		}
		const elapsed = Date.now() - time_before;
		if (elapsed > 50) console.error(threadName + strLogPrefix + " setNewCoinHashFactor() consumed " + elapsed + " ms for " + activeMiners.size + " miners");
	},

	setNewBlockTemplate: function(template, cluster, threadName) {

		let pastBlockTemplates = {};
		let activeBlockTemplates = global.cache.getCache("activeBlockTemplates");
		let anchorBlockHeight;

		if (debugging == true) console.debug("[DEBUG] Setting new Block template: ", activeBlockTemplates);

		const coin = template.coin;
		let isExtraCheck = false;

		if (coin in activeBlockTemplates) {
			
			if (debugging == true) console.debug("[DEBUG] Found Coin in Active block templates: ", coin);

			if (coin in pastBlockTemplates) {
			
				pastBlockTemplates[coin].get(0).timeoutTime = Date.now() + 4*1000;
				if (debugging == true) console.debug("[DEBUG] Found Coin in Past block templates: ", coin);
			} else {
				pastBlockTemplates[coin] = global.support.circularBuffer(10);
				if (debugging == true) console.debug("[DEBUG] Did not find Coin in Past block templates: ", pastBlockTemplates);
			}

			if (debugging == true) console.debug("[DEBUG] Past block templates: ", pastBlockTemplates);
			pastBlockTemplates[coin].enq(activeBlockTemplates[coin]);
			if (activeBlockTemplates[coin].port != template.port && global.config.pool.trustedMiners) isExtraCheck = true;
		}

		activeBlockTemplates[coin] = new global.coinFuncs.BlockTemplate(template);
		activeBlockTemplates[coin].timeCreated = Date.now();

		const height = activeBlockTemplates[coin].height;

		if (debugging == true) console.debug("[DEBUG] New Block template: ", activeBlockTemplates);
		
		global.cache.setCache("activeBlockTemplates", activeBlockTemplates);

		if (coin === "" && global.config.daemon.port == activeBlockTemplates[""].port) anchorBlockHeight = height;

		module.exports.setNewCoinHashFactor(template.isHashFactorChange, coin, template.coinHashFactor, isExtraCheck ? height : 0, cluster);
	},

	getTargetHex: function(diff, size) {
		return module.exports.pad_hex(baseDiff.div(diff).toBuffer({endian: 'little', size: size}).toString('hex'), size); 
	},

	storeShareDiv: function(miner, share_reward, share_reward2, share_num, worker_name, bt_port, bt_height, bt_difficulty, isBlockCandidate, isTrustedShare) {

		const time_now = Date.now();

		if (miner.payout_div === null) {
			global.database.storeShare(bt_height, global.protos.Share.encode({
				paymentAddress: miner.address,
				paymentID:      miner.paymentID,
				raw_shares:     share_reward,
				shares2:        share_reward2,
				share_num:      share_num,
				identifier:     worker_name,
				port:           bt_port,
				blockHeight:    bt_height,
				blockDiff:      bt_difficulty,
				poolType:       miner.poolTypeEnum,
				foundBlock:     isBlockCandidate,
				trustedShare:   isTrustedShare,
				poolID:         global.config.pool_id,
				timestamp:      time_now
			}));
			if (debugging == true) console.debug("[DEBUG] Stored new share in database for miner: " + miner.address);
		} else {
			for (let payout in miner.payout_div) {
				const payout_split   = payout.split(".");
				const paymentAddress = payout_split[0];
				const paymentID      = payout_split.length === 2 ? payout_split[1] : null;
				const payoutPercent  = miner.payout_div[payout];
				const shares         = share_reward * payoutPercent / 100;
				const shares2        = Math.floor(share_reward2 * payoutPercent / 100);

				global.database.storeShare(bt_height, global.protos.Share.encode({
					paymentAddress: paymentAddress,
					paymentID:      paymentID,
					raw_shares:     shares,
					shares2:        shares2,
					share_num:      share_num,
					identifier:     worker_name,
					port:           bt_port,
					blockHeight:    bt_height,
					blockDiff:      bt_difficulty,
					poolType:       miner.poolTypeEnum,
					foundBlock:     isBlockCandidate,
					trustedShare:   isTrustedShare,
					poolID:         global.config.pool_id,
					timestamp:      time_now
				}));
			}
			if (debugging == true) console.debug("[DEBUG] Stored share in database for miner: " + miner.address + "at percentage: " + payoutPercent );
		}
	},

	walletAccFinalizer: function(wallet_key, bt_port) {

		if (debugging == true) console.debug("[DEBUG] Scanning for old worker names: " + wallet_key );

		let wallet = walletAcc[wallet_key];
		let is_something_left = false;
		let time_now = Date.now();

		for (let worker_name in wallet) {
			let worker = wallet[worker_name];

			if (time_now - worker.time > global.config.pool.shareAccTime*1000) {

				let acc = worker.acc;
				if (acc != 0) {
					let height = worker.height;
					if (debugging == true) console.debug("[DEBUG] " + time_now + " Worker: " + worker_name + " Wallet key: " + wallet_key + " - storing old worker share: " + height + " Difficulty: " + worker.difficulty + " " + acc );
					storeShareDiv(miner, acc, worker.acc2, worker.share_num, worker_name, bt_port, height, worker.difficulty, false, true);
				}

				if (debugging == true) console.debug("[DEBUG] Removing old worker: " + worker_name + " Wallet Key:" + wallet_key);
				if (worker_name !== "all_other_workers") -- walletWorkerCount[wallet_key];
				delete wallet[worker_name];
			} else {
				is_something_left = true;
			}
		}

		if (is_something_left) {
			setTimeout(walletAccFinalizer, global.config.pool.shareAccTime*1000, wallet_key, miner, bt_port);
		} else {
			is_walletAccFinalizer[wallet_key] = false;
		}
	},

	recordShareData: function(miner, job, isTrustedShare, blockTemplate) {

		let proxyMiners = global.cache.getCache("proxyMiners");

		miner.hashes += job.norm_diff;
		let proxyMinerName = miner.payout; // + ":" + miner.identifier;

		if (proxyMinerName in proxyMiners) proxyMiners[proxyMinerName].hashes += job.norm_diff;

		const time_now = Date.now();
		let wallet_key = miner.wallet_key + blockTemplate.port;

		if (!(wallet_key in walletAcc)) {

			walletAcc[wallet_key] = {};
			walletWorkerCount[wallet_key] = 0;
			is_walletAccFinalizer[wallet_key] = false;
		}

		const db_job_height = global.config.daemon.port == blockTemplate.port ? blockTemplate.height : anchorBlockHeight;

		let wallet = walletAcc[wallet_key];
		const worker_name = miner.identifier in wallet || walletWorkerCount[wallet_key] < 50 ? miner.identifier : "all_other_workers";

		if (!(worker_name in wallet)) {
			if (worker_name !== "all_other_workers") ++ walletWorkerCount[wallet_key];
			if (debugging == true) console.debug("[DEBUG] Wallet key: " + wallet_key + ": adding new worker " + worker_name + " (num " + walletWorkerCount[wallet_key] + ")");

			wallet[worker_name] = {};
			let worker = wallet[worker_name];
			worker.height     = db_job_height;
			worker.difficulty = blockTemplate.difficulty;
			worker.time       = time_now;
			worker.acc        = 0;
			worker.acc2       = 0;
			worker.share_num  = 0;
		}

		let worker = wallet[worker_name];
		let height     = worker.height;
		let difficulty = worker.difficulty;
		let acc        = worker.acc;
		let acc2       = worker.acc2;
		let share_num  = worker.share_num;

		if (time_now - worker.time > global.config.pool.shareAccTime*1000 || acc >= 100000000) {

			if (acc != 0) {
				if (debugging == true) console.debug("[DEBUG] Wallet key: " + wallet_key + " / " + worker_name  + ": storing share " + height + " " + difficulty + " " + time_now + " " + acc);
				storeShareDiv(miner, acc, acc2, share_num, worker_name, blockTemplate.port, height, difficulty, false, isTrustedShare);
			}

			worker.height     = db_job_height;
			worker.difficulty = blockTemplate.difficulty;
			worker.time       = time_now;
			worker.acc        = job.rewarded_difficulty;
			worker.acc2       = job.rewarded_difficulty2;
			worker.share_num  = 1;
		} else {
			worker.acc  += job.rewarded_difficulty;
			worker.acc2 += job.rewarded_difficulty2;
			++ worker.share_num;
		}

		if (debugging == true) console.debug("[DEBUG] Wallet key: " + wallet_key + " / " + worker_name  + ": accumulating share " + db_job_height + " " + blockTemplate.difficulty + " " + worker.time + " " + worker.acc + " (+" +  job.rewarded_difficulty + ")");

		if (is_walletAccFinalizer[wallet_key] === false) {
			is_walletAccFinalizer[wallet_key] = true;
			setTimeout(walletAccFinalizer, global.config.pool.shareAccTime*1000, wallet_key, miner, blockTemplate.port);
		}

		if (isTrustedShare) {

			let message = "[DEBUG] " + threadName + "Accepted trusted share at difficulty: " + job.difficulty + "/" + job.rewarded_difficulty + " from: " + miner.logString

			process.send({type: 'trustedShare'});
			if (debugging == true) console.debug(message);
		} else {
			process.send({type: 'normalShare'});
			if (debugging == true) console.debug(message);
		}

		if (activeBlockTemplates[job.coin].idHash !== blockTemplate.idHash) {

			process.send({type: 'outdatedShare'});
		}
	},

	getShareBuffer: function(miner, job, blockTemplate, params) {

		try {
			let template = Buffer.alloc(blockTemplate.buffer.length);
			blockTemplate.buffer.copy(template);
			template.writeUInt32BE(job.extraNonce, blockTemplate.reserved_offset);

			if (miner.proxy) {
				template.writeUInt32BE(params.poolNonce,   job.clientPoolLocation);
				template.writeUInt32BE(params.workerNonce, job.clientNonceLocation);
			}

			return global.coinFuncs.constructNewBlob(template, params, blockTemplate.port);

		} catch (e) {
			const err_str = "Can't constructNewBlob of " + blockTemplate.port + " port with " + JSON.stringify(params) + " params from " + miner.logString + ": " + e;
			console.error(err_str);
			global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't constructNewBlob", err_str);

			return null;
		}
	},

	invalid_share: function(miner) {

		let walletTrust = global.cache.getCache("walletTrust");

		process.send({type: 'invalidShare'});
		miner.sendSameCoinJob();
		walletTrust[miner.payout] = 0;

		return false;
	},

	submit_block: function(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, portUsedToSubmit, submit_blockCB) {

		const is_main_port = global.config.daemon.port == blockTemplate.port;

		let reply_fn = function (rpcResult, rpcStatus, port, submit_blockCB) {

			const is_tari_port = (port === global.config.daemon.port);
			const report_coin = is_tari_port ? "XTM" : blockTemplate.coin;
			const report_diff = is_tari_port ? blockTemplate.xtm_difficulty : blockTemplate.difficulty;
			const report_port = is_tari_port ? 18144 : blockTemplate.port;
			const report_height = is_tari_port ? blockTemplate.xtm_height : blockTemplate.height;
			const active_height = is_tari_port ? activeBlockTemplates[blockTemplate.coin].xtm_height : activeBlockTemplates[blockTemplate.coin].height;
			const blockDataStr = Buffer.isBuffer(blockData) ? blockData.toString('hex') : JSON.stringify(blockData);
			const blob_type_num = global.coinFuncs.portBlobType(blockTemplate.port, blockTemplate.block_version);

			// did not manage to submit a block
			if (rpcResult && (rpcResult.error || rpcResult.result === "high-hash" || rpcResult.result === "bad-txnmrklroot" || rpcResult.result === "bad-cbtx-mnmerkleroot")) {
				let isNotifyAdmin = true;
				if (isParentBlock && isTrustedShare) {
					const convertedBlob = global.coinFuncs.convertBlob(blockData, blockTemplate.port);
					const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
					if (!buff.equals(resultBuff)) isNotifyAdmin = false;
				}

				console.error("[ERROR] " + threadName + "Error submitting " + report_coin + " (port " + report_port + ") block at height " + report_height + " (active block template height: " + active_height + ") from " + miner.logString + ", isTrustedShare: " + isTrustedShare + ", valid: " + isNotifyAdmin + ", rpcStatus: " + rpcStatus + ", error: " + JSON.stringify(rpcResult) + ", block hex: \n" + blockDataStr);

				// only alert if block height is not changed in the nearest time
				if (isNotifyAdmin) setTimeout(function() {

					global.coinFuncs.getPortLastBlockHeader(blockTemplate.port, function(err, body) {

						if (err !== null) {
							console.error("[ERROR] Last block header request failed for " + blockTemplate.port + " port!");
							return;
						}

						if (blockTemplate.height == body.height + 1) global.support.sendEmail(global.config.general.adminEmail,
							"FYI: Can't submit " + report_coin + " block to deamon on " + report_port + " port",
							"The pool server: " + global.config.hostname + " can't submit block to deamon on " + report_port + " port\n" +
							"Input: " + blockDataStr + "\n" + threadName + "Error submitting " + report_coin + " block at " + report_height + " height from " + miner.logString +
							", isTrustedShare: " + isTrustedShare + " error ): " + JSON.stringify(rpcResult));
					});
				}, 2*1000);

				if (global.config.pool.trustedMiners) {
					if (debugging == true) console.debug("[DEBUG]" + threadName + "Share trust broken by " + miner.logString);
					miner.trust.trust         = 0;
					walletTrust[miner.payout] = 0;
					let walletTrust = global.cache.setCache("walletTrust");
				}

				if (submit_blockCB) return submit_blockCB(false);

			// Success! Submitted a block without an issue.
			} else if (   rpcResult && (
				( is_main_port && typeof(rpcResult.result) === 'object' && rpcResult.result && rpcResult.result.status === "OK" ) || // XMR
				( !is_main_port && typeof(rpcResult.result) !== 'undefined' ) ||
				( rpcResult.response !== 'rejected' && global.coinFuncs.blobTypeErg(blob_type_num) ) || // ERG
				( typeof rpcResult === 'string' && rpcStatus == 202 && blockTemplate.port == 11898 ) // TRTL
				)
			) {
				const get_block_id = function(cb) {
					if (global.coinFuncs.blobTypeDero(blob_type_num)) {
						return cb(rpcResult.result.blid);
					} else if (global.coinFuncs.blobTypeRvn(blob_type_num)) {
						return cb(resultBuff.toString('hex'));
					} else if (global.coinFuncs.blobTypeErg(blob_type_num)) {
						setTimeout(global.coinFuncs.getPortBlockHeaderByID, 10*1000, blockTemplate.port, blockTemplate.height, function(err, body) {

							if (err === null && body.powSolutions.pk === blockTemplate.hash2) return cb(body.id);
							return cb("0000000000000000000000000000000000000000000000000000000000000000");
						});

					} else if (global.coinFuncs.blobTypeEth(blob_type_num)) {

						setTimeout(global.coinFuncs.ethBlockFind, 30*1000, blockTemplate.port, blockData[0], function(block_hash) {
							return cb(block_hash ? block_hash.substr(2) : "0000000000000000000000000000000000000000000000000000000000000000");
						});
					} else if ( is_tari_port && typeof (rpcResult.result) === 'object' && rpcResult.result && global.coinFuncs.getAuxChainXTM(rpcResult.result)) {
						return cb(rpcResult.result._aux.chains[0].block_hash);

					} else if (global.coinFuncs.blobTypeXTM_T(blob_type_num)) {
						return cb(Buffer.from(rpcResult.result.block_hash).toString('hex'));
					} else {
						return cb(global.coinFuncs.getBlockID(blockData, blockTemplate.port).toString('hex'));
					}
				};

				get_block_id(function(newBlockHash) {

					console.log(threadName + "New " + report_coin + " (port " + report_port + ") block " + newBlockHash + " found at height " + report_height + " by " + miner.logString +
						", isTrustedShare: " + isTrustedShare + " - submit result: " + JSON.stringify(rpcResult) + ", block hex: \n" + blockDataStr);

					const time_now = Date.now();

					if (is_main_port && !is_tari_port) {

						global.database.storeBlock(blockTemplate.height, global.protos.Block.encode({
							hash:       newBlockHash,
							difficulty: blockTemplate.xmr_difficulty,
							shares:     0,
							timestamp:  time_now,
							poolType:   miner.poolTypeEnum,
							unlocked:   false,
							valid:      true
						}));
					} else {
						global.database.storeAltBlock(Math.floor(time_now / 1000), global.protos.AltBlock.encode({

							hash:          newBlockHash,
							difficulty:    report_diff,
							shares:        0,
							timestamp:     time_now,
							poolType:      miner.poolTypeEnum,
							unlocked:      false,
							valid:         true,
							port:          report_port,
							height:        report_height,
							anchor_height: anchorBlockHeight
						}));
					}

					if (submit_blockCB) return submit_blockCB(true);
				});

			// something unexpected happened
			} else {

				if (!portUsedToSubmit) {

					console.error(threadName + "Unknown error submitting " + report_coin + " (port " + report_port + ") block at height " +
						report_height + " (active block template height: " + active_height + ") from " +
						miner.logString + ", isTrustedShare: " + isTrustedShare + ", rpcStatus: " + rpcStatus + ", error (" + (typeof rpcResult) + "): " + JSON.stringify(rpcResult) +
						", block hex: \n" + blockDataStr
					);
					return setTimeout(submit_block, 500, miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, isParentBlock, port, submit_blockCB);
				} else {
					// RPC bombed out massively.
					console.error(threadName + "RPC Error. Please check logs for details");
					global.support.sendEmail(global.config.general.adminEmail,
						"FYI: Can't submit block to deamon on " + blockTemplate.port + " port",
						"Input: " + blockDataStr + "\n" +
						"The pool server: " + global.config.hostname + " can't submit block to deamon on " + blockTemplate.port + " port\n" +
						"RPC Error. Please check logs for details");
					if (submit_blockCB) return submit_blockCB(false);
				}
			}
		};

		let std_reply_fn = function (rpcResult, rpcStatus) {
			return reply_fn(rpcResult, rpcStatus, blockTemplate.port, submit_blockCB);
		};

		if (blockTemplate.port == 11898) {
			global.support.rpcPortDaemon2(blockTemplate.port, "block", blockData.toString('hex'), std_reply_fn);

		} else if (is_main_port) { // XMR + XTM
			const is_xmr = parseInt(hashDiff) >= blockTemplate.xmr_difficulty;
			const is_xtm = parseInt(hashDiff) >= blockTemplate.xtm_difficulty;
			// We assume XMR daemon is on +2 port here
			if (is_xmr && (!portUsedToSubmit || portUsedToSubmit === blockTemplate.port + 2)) global.support.rpcPortDaemon(blockTemplate.port+2, "submitblock", [ blockData.toString('hex') ], function (rpcResult, rpcStatus) {
				return reply_fn(rpcResult, rpcStatus, blockTemplate.port + 2, submit_blockCB);
			});

			if (is_xtm && (!portUsedToSubmit || portUsedToSubmit === blockTemplate.port)) global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [ blockData.toString('hex') ], function (rpcResult, rpcStatus) {
				return reply_fn(rpcResult, rpcStatus, blockTemplate.port, is_xmr ? null : submit_blockCB); // Ignore XTM result and use XMR as main result here
			});

			if (!is_xmr && !is_xtm) {

				global.support.sendEmail(global.config.general.adminEmail,
					"FYI: Can't submit low diff block to deamon on " + blockTemplate.port + " port",
					"The pool server: " + global.config.hostname + " can't submit low diff block to deamon on " + blockTemplate.port + " port");

				// submit this garbage anyway to all places
				global.support.rpcPortDaemon(blockTemplate.port+2, "submitblock", [ blockData.toString('hex') ], function (rpcResult, rpcStatus) {

					return reply_fn(rpcResult, rpcStatus, blockTemplate.port + 2, submit_blockCB);
				});

				global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [ blockData.toString('hex') ], function (rpcResult, rpcStatus) {
					return reply_fn(rpcResult, rpcStatus, blockTemplate.port, null);
				});
			}
		} else {
			global.support.rpcPortDaemon(blockTemplate.port, "submitblock", [ blockData.toString('hex') ], std_reply_fn);
		}
	},

	is_safe_to_trust: function(reward_diff, miner_wallet, miner_trust) {

		const reward_diff2 = reward_diff * global.config.pool.trustThreshold;

		let walletTrust = global.cache.getCache("walletTrust");

		return reward_diff < 400000 && miner_trust != 0 && (
			(miner_wallet in walletTrust && 
			reward_diff2 * global.config.pool.trustThreshold < walletTrust[miner_wallet] &&
			crypto.randomBytes(1).readUIntBE(0, 1) > global.config.pool.trustMin
			) || (
			reward_diff2 < miner_trust &&
			crypto.randomBytes(1).readUIntBE(0, 1) > Math.max(256 - miner_trust / reward_diff / 2, global.config.pool.trustMin)
			));
	},

	hashBuffDiff: function(hash) {

		bignum = baseDiff.div(bignum.fromBuffer(hash, {endian: 'little', size: 32}));
		return bignum
	},

	ge: function(l, r) {
		// will work for numbers and bignum
		if (typeof l === 'object') return l.ge(r);
		if (typeof r === 'object') return !r.lt(l);
		return l >= r;
	},

	report_miner_share: function(miner, job) {

		const time_now = Date.now();

		if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
			console.error(threadName + "Bad " + job.coin + " coin share from miner (diff " + job.difficulty + ") " + miner.logString);
			lastMinerLogTime[miner.payout] = time_now;
		}
	},

	processShare: function(miner, job, blockTemplate, params, processShareCB) {

		const port          = blockTemplate.port;
		const blob_type_num = job.blob_type_num;

		if (miner.payout in minerWallets) minerWallets[miner.payout].hashes += job.norm_diff;

		walletLastSeeTime[miner.payout] = Date.now();

		let shareThrottled = function(processShareCB) {

			if (miner.payout in minerWallets) {

				const last_ver_shares = ++minerWallets[miner.payout].last_ver_shares;
				const threshold = global.config.pool.minerThrottleSharePerSec * global.config.pool.minerThrottleShareWindow;

				if (last_ver_shares > threshold) {
					if (last_ver_shares == threshold) {

						console.error("[ERROR] " + threadName + "Throttled down miner share (diff " + job.rewarded_difficulty2 + ") submission from " + miner.logString);
					} else if (job.rewarded_difficulty2 >= 10000000 && last_ver_shares > 10 * threshold) { 

						// too much will invalidate share
						console.error("[ERROR] " + threadName + "Throttled down miner share as invalid (diff " + job.rewarded_difficulty2 + ") submission from " + miner.logString);
						invalid_share(miner);
						processShareCB(false); // invalid share
						return true;
					}
					process.send({type: 'throttledShare'});

					if (addProxyMiner(miner)) {
						const proxyMinerName = miner.payout; // + ":" + miner.identifier;
						proxyMiners[proxyMinerName].hashes += job.norm_diff;
						module.exports.adjustMinerDiff(miner);
					}
					processShareCB(null); // throttle share
					return true;
				}
			}
			return false;
		}

		let verifyShare = function(verifyShareCB) {

			const resultHash = params.result;
			let resultBuff;

			try {
				resultBuff = Buffer.from(resultHash, 'hex');
			} catch(e) {
				return processShareCB(invalid_share(miner));
			}

			const hashDiff = hashBuffDiff(resultBuff);

			if ( global.config.pool.trustedMiners && is_safe_to_trust(job.rewarded_difficulty2, miner.payout, miner.trust.trust) && miner.trust.check_height !== job.height ) {

				let blockData = null;
				if (miner.payout in extra_wallet_verify) {

					blockData = getShareBuffer(miner, job, blockTemplate, params);

					if (blockData !== null) {

						const convertedBlob = global.coinFuncs.convertBlob(blockData, port);

						global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function(hash) {

							if (hash === null || hash === false) {
								console.error(threadName + "[EXTRA CHECK] Can't verify share remotely!");
							} else if (hash !== resultHash) {
								console.error(threadName + miner.logString + " [EXTRA CHECK] INVALID SHARE OF " + job.rewarded_difficulty2 + " REWARD HASHES");
							} else {
								extra_verify_wallet_hashes.push(miner.payout + " " + convertedBlob.toString('hex') + " " + resultHash + " " + global.coinFuncs.algoShortTypeStr(port) + " " + blockTemplate.height + " " + blockTemplate.seed_hash);
							}
						});
					} else {
						console.error(threadName + miner.logString + " [EXTRA CHECK] CAN'T MAKE SHARE BUFFER");
					}
				}

				if (miner.lastSlowHashAsyncDelay) {
					
					setTimeout(function() { return verifyShareCB(hashDiff, resultBuff, blockData, true, true); }, miner.lastSlowHashAsyncDelay);
					if (debugging == true) console.debug("[DEBUG] Miner - Delay " + miner.lastSlowHashAsyncDelay);
				} else {
					return verifyShareCB(hashDiff, resultBuff, blockData, true, true);
				}
			} else { 
				// verify share
				if (miner.debugMiner) console.log(threadName + miner.logString + " [WALLET DEBUG] verify share");
				if (shareThrottled(processShareCB)) return;
				const blockData = getShareBuffer(miner, job, blockTemplate, params);

				if (blockData === null) return processShareCB(invalid_share(miner));
				const convertedBlob = global.coinFuncs.convertBlob(blockData, port);
				const isBlockDiffMatched = ge(hashDiff, blockTemplate.difficulty);

				if (isBlockDiffMatched) {
					if (miner.validShares || (miner.payout in minerWallets && minerWallets[miner.payout].hashes)) {
						submit_block(miner, job, blockTemplate, blockData, resultBuff, hashDiff, true, true, null, function(block_submit_result) {
							if (!block_submit_result) {
								const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
								if (!buff.equals(resultBuff)) {
									report_miner_share(miner, job);
									return processShareCB(invalid_share(miner));
								}
							}
							walletTrust[miner.payout] += job.rewarded_difficulty2;
							return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
						});
					} else {
						const buff = global.coinFuncs.slowHashBuff(convertedBlob, blockTemplate);
						if (!buff.equals(resultBuff)) {
							report_miner_share(miner, job);
							return processShareCB(invalid_share(miner));
						}
						walletTrust[miner.payout] += job.rewarded_difficulty2;
						return verifyShareCB(hashDiff, resultBuff, blockData, false, true);
					}
				} else {
					const time_now = Date.now();
					global.coinFuncs.slowHashAsync(convertedBlob, blockTemplate, miner.payout, function(hash) {
						if (hash === null) {
							return processShareCB(null);
						}
						if (hash !== resultHash) {
							report_miner_share(miner, job);
							return processShareCB(invalid_share(miner));
						}

						miner.lastSlowHashAsyncDelay = Date.now() - time_now;
						if (miner.lastSlowHashAsyncDelay > 1000) miner.lastSlowHashAsyncDelay = 1000;
						walletTrust[miner.payout] += job.rewarded_difficulty2;
						return verifyShareCB(hashDiff, resultBuff, blockData, false, false);
					});
				}
			}
		// end verifyShare
		};

		verifyShare(function(hashDiff, resultBuff, blockData, isTrustedShare, isNeedCheckBlockDiff) {

			if (isNeedCheckBlockDiff && ge(hashDiff, blockTemplate.difficulty)) {

				// Submit block to the RPC Daemon.
				if (!blockData) {
					blockData = getShareBuffer(miner, job, blockTemplate, params);
					if (!blockData) return processShareCB(invalid_share(miner));
				}
				submit_block(miner, job, blockTemplate, blockData, resultBuff, hashDiff, isTrustedShare, true, null);
			}

			// TODO: Probably needs to be integrated into submit_block as well for more uniform processing logic
			const is_mm = "child_template" in blockTemplate;
			if (is_mm && ge(hashDiff, blockTemplate.child_template.difficulty)) {

				// Submit child block to the RPC Daemon.
				if (!blockData) {
					blockData = getShareBuffer(miner, job, blockTemplate, params);
					if (!blockData) return processShareCB(invalid_share(miner));
				}

				// need to properly restore child template buffer here since it went via message string and was restored not correctly
				blockTemplate.child_template_buffer = Buffer.from(blockTemplate.child_template_buffer);
				let shareBuffer2 = null;

				try {
					shareBuffer2 = global.coinFuncs.constructMMChildBlockBlob(blockData, port, blockTemplate.child_template_buffer);
				} catch (e) {

					const err_str = "Can't construct_mm_child_block_blob with " + blockData.toString('hex') + " parent block and " + blockTemplate.child_template_buffer.toString('hex') + " child block share buffers from " + miner.logString + ": " + e;

					console.error(err_str);
					//global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't construct_mm_child_block_blob", err_str);
					return processShareCB(invalid_share(miner));
				}

				if (shareBuffer2 === null) return processShareCB(invalid_share(miner));
				submit_block(miner, job, blockTemplate.child_template, shareBuffer2, resultBuff, hashDiff, isTrustedShare, false, null);
			}

			if (!ge(hashDiff, job.difficulty)) {

				let time_now = Date.now();
				if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {
					console.warn("[WARN] " + threadName + "Rejected low diff (" + hashDiff + " < " + job.difficulty + ") share from miner " + miner.logString);
					lastMinerLogTime[miner.payout] = time_now;
				}

				return processShareCB(invalid_share(miner));
			} else {
				recordShareData(miner, job, isTrustedShare, blockTemplate);
				// record child proc share for rewarded_difficulty effort calcs status but with 0 rewards (all included in parent share)

				if (is_mm) {
					job.rewarded_difficulty2 = 0;
					recordShareData(miner, job, isTrustedShare, blockTemplate.child_template);
				}
				return processShareCB(true);
			}
		});
	},

	get_miner_notification: function(payout) {

		let notifyAddresses = global.cache.getCache("notifyAddresses");

		if (payout in notifyAddresses) return notifyAddresses[payout];
		return false;
	},

	handleMinerData: function(socket, id, method, params, ip, portData, sendReply, sendReplyFinal, pushMessage, bannedTmpIPs = {}, activeBlockTemplates) {

		if (debugging == true) console.debug("[DEBUG] Handle miner data");

		let minerAgents = {};
		let lastMinerLogTime = {};

		switch (method) {

			case 'login': {
				if (debugging == true) console.log("[DEBUG] Handle Miner data: LOGIN");
				if (ip in bannedTmpIPs) {
					sendReplyFinal("New connections from this IP address are temporarily suspended from mining (10 minutes max)");
					console.error("[ERROR] IP temp banned")
					return;
				}

				if (!params) {
					process.send({type: 'banIP', data: ip});
					sendReplyFinal("No params specified");
					console.error("[ERROR] No parameters specified")
					return;
				}

				if (!params.login) {
					process.send({type: 'banIP', data: ip});
					sendReplyFinal("No login specified");
					console.error("[ERROR] No login specified")
					return;
				}

				if (socket.miner_id) {
					process.send({type: 'banIP', data: ip});
					sendReplyFinal("No double login is allowed");
					console.error("[ERROR] Double login detected")
					return;
				}

				if (!params.pass) params.pass = "x";

				const difficulty = portData.difficulty;
				const minerId = module.exports.get_new_id();

				if (debugging == true) console.log("[DEBUG] Initializing Miner: " + minerId);

				let miner = new poolMiner.Miner(
					minerId, params.login, params.pass, params.rigid, ip, difficulty, pushMessage, 1, portData.portType, portData.port, params.agent,
					params.algo, params["algo-perf"], params["algo-min-time"], activeBlockTemplates
				);

				if (miner.debugMiner) socket.debugMiner = 1;
				if (debugging == true) console.log("[DEBUG] Miner: " + util.inspect(miner, {depth: null}));

				if (method === 'mining.authorize') {

					const new_id = socket.eth_extranonce_id ? socket.eth_extranonce_id : get_new_eth_extranonce_id();
					if (new_id !== null) {

						socket.eth_extranonce_id = new_id;
						miner.eth_extranonce     = eth_extranonce(new_id);
					} else {

						miner.valid_miner = false;
						miner.error = "Not enough extranoces. Switch to other pool node.";
					}
				}

				if (params.agent && process.env['WORKER_ID'] == 1) minerAgents[params.agent] = 1;
				let time_now = Date.now();

				if (!miner.valid_miner) {

					if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 10*60*1000) {
						console.log("Invalid miner " + miner.logString + " [" + miner.email + "], disconnecting due to: " + miner.error);
						lastMinerLogTime[miner.payout] = time_now;
					}
					console.log("[DEBUG] Send final reply")
					return sendReplyFinal(miner.error, miner.delay_reply);
				}

				const miner_agent_notification = !global.coinFuncs.algoMainCheck(miner.algos) && global.coinFuncs.algoPrevMainCheck(miner.algos) ? global.coinFuncs.get_miner_agent_warning_notification(params.agent) : false;
				const miner_notification = miner_agent_notification ? miner_agent_notification : module.exports.get_miner_notification(miner.payout);
				console.log("[INFO] Miner notification: " + miner_notification)

				if (miner_notification) {
					if (!(miner.payout in lastMinerNotifyTime) || time_now - lastMinerNotifyTime[miner.payout] > 60*60*1000) {

						lastMinerNotifyTime[miner.payout] = time_now;
						console.error("Sent notification to " + miner.logString + ": " + miner_notification);
						return sendReplyFinal(miner_notification + " (miner will connect after several attempts)");
					}
				}

				if (!miner.proxy) {

					let proxyMiners = global.cache.getCache("proxyMiners");
					let proxyMinerName = miner.payout; // + ":" + miner.identifier;
					if ((params.agent && params.agent.includes('proxy')) || (proxyMinerName in proxyMiners)) {

						if (!addProxyMiner(miner)) {
							return sendReplyFinal("Temporary (one hour max) mining ban since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
						}

						if (proxyMiners[proxyMinerName].hashes) module.exports.adjustMinerDiff(miner);
					} else {
						let minerWallets = global.cache.getCache("minerWallets");
						if (!(miner.payout in minerWallets)) {

							minerWallets[miner.payout] = {};
							minerWallets[miner.payout].connectTime = Date.now();
							minerWallets[miner.payout].count = 1;
							minerWallets[miner.payout].hashes = 0;
							minerWallets[miner.payout].last_ver_shares = 0;
						} else {
							if (++ minerWallets[miner.payout].count > global.config.pool.workerMax) {
								bannedBigTmpWallets[miner.payout] = 1;
								return sendReplyFinal("Temporary (one hour max) ban on new miner connections since you connected too many workers. Please use proxy (https://github.com/MoneroOcean/xmrig-proxy)", 600);
							}
						}
					}
				}

				socket.miner_id = minerId;
				activeMiners.set(minerId, miner);
				const minersToCache = Object.fromEntries(activeMiners);
				global.cache.setCache("activeMiners", minersToCache);
				//console.log("[INFO] ActiveMiners Map", activeMiners)
				console.log("[INFO] XMRig connected")

				const coin = "";
				console.log("[INFO] XMRig Coin selected: " + coin)

				if (coin !== false) {

					const params = module.exports.getCoinJobParams(coin);
					const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(coin));

					sendReply(null, { id: minerId, job: miner.getCoinJob(coin, params), status: 'OK' });
				} else {
					sendReplyFinal("No block template yet. Please wait.");
				}

				miner.protocol = "default";
				if (debugging == true) console.log("[DEBUG] Taking a break");
				break;
			}

			case 'getjob': {

				if (!params) {
					sendReplyFinal("No params specified");
					return;
				}

				let miner = activeMiners.get(params.id);

				if (!miner) {
					sendReplyFinal("Unauthenticated");
					return;
				}

				miner.heartbeat();

				if (params.algo && params.algo instanceof Array && params["algo-perf"] && params["algo-perf"] instanceof Object) {

					const status = miner.setAlgos(params.algo, params["algo-perf"], params["algo-min-time"]);

					if (status != "") {

						sendReply(status);
						return;
					}
				}

				sendReply(null, miner.getBestCoinJob());
				break;
			}

			case 'mining.submit':

				if (!params || !(params instanceof Array)) {

					sendReply("No array params specified");
					return;
				}

				for (const param of params) if (typeof param !== 'string') {

					sendReply("Not correct params specified");
					return;
				}

				if (params.length >= 3) params = {
					job_id:      params[1],
					raw_params:  params
				}; else {
					sendReply("Not correct params specified");
					return;
				}

				// continue to normal login

			case 'submit': { // grin and default

				if (!params) {

					sendReplyFinal("No params specified");
					return;
				}

				const minerId = params.id ? params.id : (socket.miner_id ? socket.miner_id : "");
				let miner = activeMiners.get(minerId);

				if (!miner) {
					sendReplyFinal("Unauthenticated");
					return;
				}

				miner.heartbeat();
				if (typeof (params.job_id) === 'number') params.job_id = params.job_id.toString(); // for grin miner

				let job = miner.validJobs.toarray().filter(function (job) {

					return job.id === params.job_id;
				})[0];

				if (!job) {
					sendReply("Invalid job id");
					return;
				}

				const blob_type_num = job.blob_type_num;

				if (method === 'mining.submit') {
					if (global.coinFuncs.blobTypeEth(blob_type_num) || global.coinFuncs.blobTypeErg(blob_type_num)) {

						params.nonce       = params.raw_params[2];
					} else if (global.coinFuncs.blobTypeRvn(blob_type_num) && params.raw_params.length >= 5) {

						params.nonce       = params.raw_params[2].substr(2);
						params.header_hash = params.raw_params[3].substr(2);
						params.mixhash     = params.raw_params[4].substr(2);
					} else {
						sendReply("Invalid job params");
						return;
					}
				}

				const nonce_sanity_check = function(blob_type_num, params) {

					if (typeof params.nonce !== 'string') return false;
					if (global.coinFuncs.nonceSize(blob_type_num) == 8) {

						const isExtraNonceBT = global.coinFuncs.blobTypeEth(blob_type_num) || global.coinFuncs.blobTypeErg(blob_type_num);

						if (isExtraNonceBT) params.nonce = job.extraNonce + params.nonce;
						if (!nonceCheck64.test(params.nonce)) return false;

						if (global.coinFuncs.blobTypeRvn(blob_type_num)) {

							if (!hashCheck32.test(params.mixhash)) return false;
							if (!hashCheck32.test(params.header_hash)) return false;

						} else if (!isExtraNonceBT) {

							if (!hashCheck32.test(params.result)) return false;
						}
					} else {
						if (!nonceCheck32.test(params.nonce)) return false;
						if (!hashCheck32.test(params.result)) return false;
					}
					return true;
				};

				if (!nonce_sanity_check(blob_type_num, params)) {

					console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
					miner.checkBan(false);
					sendReply("Duplicate share");
					miner.storeInvalidShare();
					return;
				}

				let nonce_test;

				if (miner.proxy) {

					if (!Number.isInteger(params.poolNonce) || !Number.isInteger(params.workerNonce)) {

						console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
						miner.checkBan(false);
						sendReply("Duplicate share");
						miner.storeInvalidShare();
						return;
					}

					nonce_test = global.coinFuncs.blobTypeGrin(blob_type_num) ? params.pow.join(':') + `_${params.poolNonce}_${params.workerNonce}` : `${params.nonce}_${params.poolNonce}_${params.workerNonce}`;
				} else {
					nonce_test = params.nonce;
				}

				if (nonce_test in job.submissions) {

					console.warn(threadName + 'Duplicate miner share with ' + nonce_test + ' nonce from ' + miner.logString);
					miner.checkBan(false);
					sendReply("Duplicate share");
					miner.storeInvalidShare();
					return;
				}

				job.submissions[nonce_test] = 1;
				let blockTemplate;
				job.rewarded_difficulty = job.difficulty;

				if (activeBlockTemplates[job.coin].idHash !== job.blockHash) {

					blockTemplate = pastBlockTemplates[job.coin].toarray().filter(function (t) {
						return t.idHash === job.blockHash;
					})[0];

					let is_outdated = false;

					if (blockTemplate && blockTemplate.timeoutTime) {

						const late_time = Date.now() - blockTemplate.timeoutTime;

						if (late_time > 0) {

							const max_late_time = global.config.pool.targetTime * 1000;

							if (late_time < max_late_time) {

								let factor = (max_late_time - late_time) / max_late_time;
								job.rewarded_difficulty = job.difficulty * Math.pow(factor, 6); //Math.floor(job.difficulty * Math.pow(factor, 6));
								//if (job.rewarded_difficulty === 0) job.rewarded_difficulty = 1;
								} else {
									is_outdated = true;
								}
						}
					}

					if (!blockTemplate || is_outdated) {

						const err_str = blockTemplate ? "Block outdated" : "Block expired";
						const time_now = Date.now();

						if (!(miner.payout in lastMinerLogTime) || time_now - lastMinerLogTime[miner.payout] > 30*1000) {

							console.warn(threadName + err_str + ', Height: ' + job.height + ' (diff ' + job.difficulty + ') from ' + miner.logString);
							lastMinerLogTime[miner.payout] = time_now;
						}

						miner.sendSameCoinJob();
						sendReply(err_str);
						miner.storeInvalidShare();
						return;
					}
				} else {

					blockTemplate = activeBlockTemplates[job.coin];
					// kill miner if it mines block template for disabled coin for more than some time
					if (!lastCoinHashFactorMM[job.coin] && Date.now() - blockTemplate.timeCreated > 60*60*1000) {
						sendReplyFinal("This algo was temporary disabled due to coin daemon issues. Consider using https://github.com/MoneroOcean/meta-miner to allow your miner auto algo switch in this case.");
						return;
					}
				}

				job.rewarded_difficulty2 = job.rewarded_difficulty * job.coinHashFactor;
				//job.rewarded_difficulty = Math.floor(job.rewarded_difficulty);
				//if (job.rewarded_difficulty === 0) job.rewarded_difficulty = 1;

				processShare(miner, job, blockTemplate, params, function(shareAccepted) {

					if (miner.removed_miner) return;
					if (shareAccepted === null) {

						sendReply('Throttled down share submission (please increase difficulty)');
						return;
					}

					miner.checkBan(shareAccepted);

					if (global.config.pool.trustedMiners) {

						if (shareAccepted) {

							miner.trust.trust += job.rewarded_difficulty2;
							miner.trust.check_height = 0;

						} else {

							if (debugging == true) console.debug("[DEBUG] " + threadName + "Share trust broken by " + miner.logString);
							miner.storeInvalidShare();
							miner.trust.trust = 0;
						}
					}

					if (!shareAccepted) {

						sendReply("Low difficulty share");
						return;
					}

					miner.lastShareTime = Date.now() / 1000 || 0;
					sendReply(null, true);
				});

				break;
			}

			case 'keepalive':

			case 'keepalived': {

				if (!params) {

					sendReplyFinal("No params specified");
					return;
				}

				const minerId = params.id ? params.id : (socket.miner_id ? socket.miner_id : "");
				let miner = activeMiners.get(minerId);

				if (!miner) {

					sendReplyFinal("Unauthenticated");
					return;
				}

				miner.heartbeat();
				sendReply(null, { status: 'KEEPALIVED' });
				break;
			}
		}
	},

	blockTemplateIsStuck: function() {

		if (global.config.general.allowStuckPoolKill && fs.existsSync("block_template_is_stuck")) {

			console.error("Stuck block template was detected on previous run. Please fix monerod and remove block_template_is_stuck file after that. Exiting...");
			setTimeout(function() { process.exit(); }, 5*1000);
			return;
		}
	},


	//setInterval(function dump_vars() {}, 60*1000);
	dump_vars: function() {

		const fn = "dump" + (cluster.isMaster ? "" : "_" + process.env['WORKER_ID'].toString());
		console.debug("[DEBUG] setInterval FN: " + fn)
		fs.access(fn, fs.F_OK, function(err) {

			if (!err) return;
			console.log("DUMPING VARS TO " + fn + " FILE");
			let s = fs.createWriteStream(fn, {'flags': 'a'});

			s.write("activeMiners:\n");

			for (var [minerId, miner] of activeMiners) s.write(minerId + ": " + JSON.stringify(miner, null, '\t') + "\n");

			s.write("\n\n\npastBlockTemplates:\n");
			s.write(JSON.stringify(pastBlockTemplates, null, '\t') + "\n");

			s.write("\n\n\nlastBlockHash:\n");
			s.write(JSON.stringify(lastBlockHash, null, '\t') + "\n");

			s.write("\n\n\nlastBlockHeight:\n");
			s.write(JSON.stringify(lastBlockHeight, null, '\t') + "\n");

			s.write("\n\n\nlastBlockHashMM:\n");
			s.write(JSON.stringify(lastBlockHashMM, null, '\t') + "\n");

			s.write("\n\n\nlastBlockHeightMM:\n");
			s.write(JSON.stringify(lastBlockHeightMM, null, '\t') + "\n");

			s.write("\n\n\nlastCoinHashFactor:\n");
			s.write(JSON.stringify(lastCoinHashFactor, null, '\t') + "\n");

			s.write("\n\n\nnewCoinHashFactor:\n");
			s.write(JSON.stringify(newCoinHashFactor, null, '\t') + "\n");

			s.write("\n\n\nlastCoinHashFactorMM:\n");
			s.write(JSON.stringify(lastCoinHashFactorMM, null, '\t') + "\n");

			s.write("\n\n\nactiveBlockTemplates:\n");
			s.write(JSON.stringify(activeBlockTemplates, null, '\t') + "\n");

			s.write("\n\n\nproxyMiners:\n");
			s.write(JSON.stringify(proxyMiners, null, '\t') + "\n");

			s.write("\n\n\nanchorBlockHeight: " + anchorBlockHeight + "\n");
			s.write("\n\n\nanchorBlockPrevHeight: " + anchorBlockPrevHeight + "\n");

			s.write("\n\n\nwalletTrust:\n");
			s.write(JSON.stringify(walletTrust, null, '\t') + "\n");

			s.write("\n\n\nwalletLastSeeTime:\n");
			s.write(JSON.stringify(walletLastSeeTime, null, '\t') + "\n");
			
			s.write("\n\n\nwalletAcc:\n");
			s.write(JSON.stringify(walletAcc, null, '\t') + "\n");

			s.write("\n\n\nwalletWorkerCount:\n");
			s.write(JSON.stringify(walletWorkerCount, null, '\t') + "\n");

			s.write("\n\n\nis_walletAccFinalizer:\n");
			s.write(JSON.stringify(is_walletAccFinalizer, null, '\t') + "\n");

			s.write("\n\n\nbannedTmpIPs:\n");
			s.write(JSON.stringify(bannedTmpIPs, null, '\t') + "\n");

			s.write("\n\n\nbannedTmpWallets:\n");
			s.write(JSON.stringify(bannedTmpWallets, null, '\t') + "\n");

			s.write("\n\n\nbannedBigTmpWallets:\n");
			s.write(JSON.stringify(bannedBigTmpWallets, null, '\t') + "\n");
			s.end();
		});
	},

	getUniqueWorkerID: function(cb) {

		if (!global.config.eth_pool_support) return cb(0, 1);

		global.mysql.query("SELECT id FROM pool_workers WHERE pool_id = ? AND worker_id = ?", [global.config.pool_id, process.env['WORKER_ID']]).then(function (rows) {

			if (rows.length === 0) {

				global.mysql.query("INSERT INTO pool_workers (pool_id, worker_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=id", [global.config.pool_id, process.env['WORKER_ID']]).then(function() {
					return getUniqueWorkerID(cb);
				}).catch(function(err) {

					console.error("Can't register unique pool worker for " + global.config.pool_id + " pool_id and " + process.env['WORKER_ID'] + " worker_id");
					process.exit(1);
				});

			} else if (rows.length !== 1) {

				console.error("Can't get unique pool worker for " + global.config.pool_id + " pool_id and " + process.env['WORKER_ID'] + " worker_id");
				process.exit(1);

			} else global.mysql.query("SELECT MAX(id) as maxId FROM pool_workers").then(function (rows_max) {

				if (rows_max.length !== 1) {

					console.error("Can't get max id from pool_workers table");
					process.exit(1);
				}

				if (global.config.max_pool_worker_num && rows_max[0].maxId > global.config.max_pool_worker_num) {

					console.error("Prease recreate pool_workers table");
					process.exit(1);
				}

				return cb(rows[0].id - 1, (global.config.max_pool_worker_num ? global.config.max_pool_worker_num : rows_max[0].maxId) - 1);
			});
		});
	}
};
