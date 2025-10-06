"use strict";

const debugging = global.config.debugging;

module.exports = {

	// Miner model

	Miner: function(id, login, pass, rigid, ipAddress, startingDiff, pushMessage, protoVersion, portType, port, agent, algos, algos_perf, algo_min_time, activeBlockTemplates) {

		// Username Layout: monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number]
		// Password Layout: worker_name[:email_or_pass[:monero_address]][~algo_name]
		// If email_or_pass is email then miners will get email notifications about payments and offline workers

		console.log("[INFO] Miner ID: " + id)

		const login_diff_split      = login.split("+");
		const login_div_split       = login_diff_split[0].split("%");
		const login_paymentid_split = login_div_split[0].split(".");
		const pass_algo_split       = pass.split("~");
		let   pass_split            = pass_algo_split[0].split(":");
		let   reEmail               = /^\S+@\S+\.\S+$/;
		let   wallet_debug          = global.config.debug_wallets != undefined ? global.config.debug_wallets : {};
		let   ip_whitelist          = global.config.ip_whitelist != undefined ? global.config.ip_whitelist : {};
		let   banned_wallets        = global.config.banned_wallets != undefined ? global.config.banned_wallets : {};
		let   banned_wallets_tmp    = global.config.banned_wallets_tmp != undefined ? global.config.banned_wallets_tmp : {};
		let   banned_wallets_long   = global.config.banned_wallets_long != undefined ? global.config.banned_wallets_long : {};

		// Workaround for a common mistake to put email without : before it
		// and also security measure to hide emails used as worker names

		if (pass_split.length === 1 && reEmail.test(pass_split[0])) {

			pass_split.push(pass_split[0]);
			pass_split[0] = "email";
		}

		// Set payout, identifier, email and logString

		this.payout = this.address = (pass_split.length === 3 ? pass_split[2] : login_paymentid_split[0]);
		this.paymentID = null;
		this.identifier = agent && agent.includes('MinerGate') ? "MinerGate" : (rigid ? rigid : pass_split[0]).substring(0, 64);

		if (typeof(login_paymentid_split[1]) !== 'undefined') {

			if (login_paymentid_split[1].length === 64 && hexMatch.test(login_paymentid_split[1]) && global.coinFuncs.validatePlainAddress(this.address)) {

				this.paymentID = login_paymentid_split[1];
				this.payout += "." + this.paymentID;

				if (typeof(login_paymentid_split[2]) !== 'undefined' && this.identifier === 'x') {
					this.identifier = login_paymentid_split[2].substring(0, 64);
				}
			} else if (this.identifier === 'x') {

				this.identifier = login_paymentid_split[1].substring(0, 64);
			}
		}

		this.debugMiner = this.payout in wallet_debug;
		this.whiteList  = ipAddress in ip_whitelist;

		this.email      = pass_split.length >= 2 ? pass_split[1] : "";
		this.logString  = this.payout.substr(this.payout.length - 10) + ":" + this.identifier + " (" + ipAddress + ")";
		this.agent      = agent;

		if (debugging == true) {

			console.log("[DEBUG] Miner Payout: " + this.payout)
			console.log("[DEBUG] Miner identifier: " + this.identifier)
			console.log("[DEBUG] Miner debugging: " + this.debugMiner)
			console.log("[DEBUG] Miner email: " + this.email)
			console.log("[DEBUG] Miner logstring: " + this.logString)
			console.log("[DEBUG] Miner agent: " + this.agent)
		}

		// Check the Monero address format

		if (login_diff_split.length > 2) {

			this.error = "Please use monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number] login/user format";
			this.valid_miner = false;
			console.error("[ERROR] Miner invalid: " + this.error)
			return;
		}

		if (Math.abs(login_div_split.length % 2) == 0 || login_div_split.length > 5) {

			this.error = "Please use monero_address[.payment_id][(%N%monero_address_95char)+][+difficulty_number] login/user format";
			this.valid_miner = false;
			console.error("[ERROR] Miner invalid: " + this.error)
			return;
		}

		// Check the payout status
		
		this.payout_div = {};
		let payout_percent_left = 100;

		for (let index = 1; index < login_div_split.length - 1; index += 2) {

			const percent = parseFloat(login_div_split[index]);

			if (isNaN(percent) || percent < 0.1) {
				this.error = "Your payment divide split " + percent + " is below 0.1% and can't be processed";
				this.valid_miner = false;
				return;
			}

			if (percent > 99.9) {
				this.error = "Your payment divide split " + percent + " is above 99.9% and can't be processed";
				this.valid_miner = false;
				return;
			}

			payout_percent_left -= percent;

			if (payout_percent_left < 0.1) {
				this.error = "Your summary payment divide split exceeds 99.9% and can't be processed";
				this.valid_miner = false;
				return;
			}

			const address = login_div_split[index + 1];

			if (address.length != 95 || !global.coinFuncs.validateAddress(address)) {
				this.error = "Invalid payment address provided: " + address + ". Please use 95_char_long_monero_wallet_address format";
				this.valid_miner = false;
				return;
			}

			if (address in banned_wallets) {
				this.error = "Permanently banned payment address " + address + " provided: " + banned_wallets[address];
				this.valid_miner = false;
				return;
			}

			if (address in banned_wallets_tmp) {
				this.error = "Temporary (10 minutes max) banned payment address " + address;
				this.valid_miner = false;
				return;
			}

			if (address in banned_wallets_long) {
				this.error = "Temporary (one hour max) ban since you connected too many workers. Please use XMRig Proxy (https://xmrig.com/proxy)";
				this.valid_miner = false;
				this.delay_reply = 600;
				return;
			}

			if (address in this.payout_div) {
				this.error = "You can't repeat payment split address " + address;
				this.valid_miner = false;
				return;
			}

			this.payout_div[address] = percent;
		}

		if (payout_percent_left === 100) {

			this.payout_div = null;
		} else {

			if (this.payout in this.payout_div) {

				this.error = "You can't repeat payment split address " + this.payout;
				this.valid_miner = false;
				return;
			}

			this.payout_div[this.payout] = payout_percent_left;
		}

		if (pass_split.length > 3) {

			this.error = "Please use worker_name[:email_or_pass[:monero_address]][~algo_name] password format";
			this.valid_miner = false;
			return;
		}

		if (this.payout in banned_wallets) {
			this.error = "Permanently banned payment address " + this.payout + " provided: " + banned_wallets[this.payout];
			this.valid_miner = false;
			return;
		}

		if (this.payout in banned_wallets_tmp) {
			this.error = "Temporary (10 minutes max) banned payment address " + this.payout;
			this.valid_miner = false;
			return;
		}

		if (this.payout in banned_wallets_long) {
			this.error = "Temporary (one hour max) ban since you connected too many workers. Please use XMRig Proxy (https://xmrig.com/proxy)";
			this.valid_miner = false;
			this.delay_reply = 600;
			return;
		}

		if (global.coinFuncs.exchangeAddresses.indexOf(this.address) !== -1 && !(this.paymentID)) {
			this.error = "Exchange addresses need 64 hex character long payment IDs. Please specify it after your wallet address as follows after dot: Wallet.PaymentID";
			this.valid_miner = false;
			return;
		}

		if (!global.coinFuncs.validateAddress(this.address)) {
			this.error = "Invalid payment address provided: " + this.address + ". Please use 95_char_long_monero_wallet_address format";
			this.valid_miner = false;
			return;
		}

		console.log("[INFO] Miner - active block templates: " + activeBlockTemplates)

		if (!("" in activeBlockTemplates)) {
			this.error = "No active block template";
			this.valid_miner = false;
			return;
		}

		// Set mining algorithms
		if (debugging == true) console.log("[DEBUG] Miner - Setting algorithms");

		this.setAlgos = function(algos, algos_perf, algo_min_time) {

			this.algos = {};

			for (let i in algos) this.algos[algos[i]] = 1;

			if (global.coinFuncs.is_miner_agent_no_haven_support(this.agent)) delete this.algos["cn-heavy/xhv"];

			if (this.algos["kawpow4"]) {
				this.algos["kawpow"] = 1;
				delete this.algos["kawpow4"];
			}

			const check = global.coinFuncs.algoCheck(this.algos);
			if (check !== true) return check;
			if ("cn-pico" in this.algos) this.algos["cn-pico/trtl"] = 1;

			if (!(algos_perf && algos_perf instanceof Object)) {

				if (global.coinFuncs.algoMainCheck(this.algos)) algos_perf = global.coinFuncs.getDefaultAlgosPerf();
				else algos_perf = global.coinFuncs.getPrevAlgosPerf();
			}

			let coin_perf = global.coinFuncs.convertAlgosToCoinPerf(algos_perf);

			if (coin_perf instanceof Object) {

				if (!("" in coin_perf && global.coinFuncs.algoMainCheck(this.algos))) coin_perf[""] = -1;
				this.coin_perf = coin_perf;
			} else {
				return coin_perf;
			}

			this.algo_min_time = algo_min_time ? algo_min_time : 60;
			return "";
		};

		if (pass_algo_split.length == 2) {

			const algo_name = pass_algo_split[1];
			algos         = [ algo_name ];
			algos_perf    = {};
			algos_perf[algo_name] = 1;
			algo_min_time = 60;

			if (debugging == true) console.log("[DEBUG] Miner algo name: " + algo_name);

		} else if (!(algos && algos instanceof Array && global.config.daemon.enableAlgoSwitching)) {

			const agent_algo = global.coinFuncs.get_miner_agent_not_supported_algo(agent);

			if (agent_algo) {
				algos  = [ agent_algo ];
			} else {
				algos  = global.coinFuncs.getDefaultAlgos();
			}

			algos_perf    = global.coinFuncs.getDefaultAlgosPerf();
			algo_min_time = 60;

			if (debugging == true) console.log("[DEBUG] Miner agent algo: " + agent_algo);
		}

		const status = this.setAlgos(algos, algos_perf, algo_min_time);

		if (status != "") {

			this.error = status;
			this.valid_miner = false;
			return;
		}

		// Initialize valid Miner
		if (debugging == true) console.debug("[DEBUG] Miner - Initialize valid miner");

		this.error = "";
		this.valid_miner = true;
		this.removed_miner = false;

		// General attributes

		this.proxy = agent && agent.includes('xmr-node-proxy');
		this.xmrig_proxy = agent && agent.includes('xmrig-proxy');
		this.id = id;
		this.ipAddress = ipAddress;
		this.pushMessage = pushMessage;
		this.connectTime = Date.now();
		this.heartbeat = function () { this.lastContact = Date.now(); };
		this.heartbeat();

		this.port = port;
		this.portType = portType;

		switch (portType) {
			case 'pplns': this.poolTypeEnum = global.protos.POOLTYPE.PPLNS; break;
			case 'pps':   this.poolTypeEnum = global.protos.POOLTYPE.PPS;   break;
			case 'solo':  this.poolTypeEnum = global.protos.POOLTYPE.SOLO;  break;
			case 'prop':  this.poolTypeEnum = global.protos.POOLTYPE.PROP;  break;
			default:      console.error("Wrong portType " + portType);
				this.poolTypeEnum = global.protos.POOLTYPE.PPLNS;
		}

		this.wallet_key = this.payout + " " + this.poolTypeEnum + " " + JSON.stringify(this.payout_div) + " ";

		// Difficulty calculation

		this.lastShareTime = Math.floor(Date.now() / 1000);
		this.validShares = 0;
		this.invalidShares = 0;
		this.hashes = 0;

		// Trust analysis
		
		if (global.config.pool.trustedMiners) {

			let walletTrust = global.cache.getCache("walletTrust");
			let walletLastSeeTime = global.cache.getCache("walletLastSeeTime");

			if (!(this.payout in walletTrust)) {
				walletTrust[this.payout] = 0;
				walletLastSeeTime[this.payout] = Date.now();
			}
			this.trust = {
				trust:        0,
				check_height: 0
			};
		}

		// Credential settings
		
		let email = this.email.trim();
		if (email != "") {
			// Need to do an initial registration call here.  Might as well do it right...
			let payoutAddress = this.payout;
			let time_now = Date.now();

			if (!(payoutAddress in walletLastCheckTime) || time_now - walletLastCheckTime[payoutAddress] > 60*1000) {

				global.mysql.query("SELECT id FROM users WHERE username = ? LIMIT 1", [payoutAddress]).then(function (rows) {
					if (rows.length > 0) return;
					if (global.coinFuncs.blockedAddresses.indexOf(payoutAddress) !== -1) return;

					global.mysql.query("INSERT INTO users (username, email) VALUES (?, ?)", [payoutAddress, email]).catch(function (error) {
						console.error("SQL query failed: " + error);
					});

					console.log("Setting password " + email + " for " + payoutAddress);
				}).catch(function (error) {
					console.error("SQL query failed: " + error);
				});

				walletLastCheckTime[payoutAddress] = time_now;
			}
		}

		if (debugging == true) {

			console.log("[DEBUG] Miner ID: " + this.id)
			console.log("[DEBUG] Miner Proxy: " + this.proxy)
			console.log("[DEBUG] Miner XMRig Proxy: " + this.xmrig_proxy)
			console.log("[DEBUG] Miner IP Address: " + this.ipAddress)
			console.log("[DEBUG] Miner connect time: " + this.connectTime)
			console.log("[DEBUG] Miner Port: " + this.port)
			console.log("[DEBUG] Miner Payout scheme: " + this.portType)
			console.log("[DEBUG] Miner wallet key: " + this.wallet_key)
			console.log("[DEBUG] Miner last share time: " + this.lastShareTime)
			console.log("[DEBUG] Miner Trust: " + this.trust)
		}

		// Share management
		this.validJobs = global.support.circularBuffer(10);
		this.cachedJob = null;

		this.storeInvalidShare = function() {

			const time_now = Date.now();
			if (this.invalidShareCount) ++ this.invalidShareCount;
			else this.invalidShareCount = 1;

			if (!this.lastInvalidShareTime || time_now - this.lastInvalidShareTime > 10*60*1000) {

				let _this = this;
				global.database.storeInvalidShare(global.protos.InvalidShare.encode({

					paymentAddress: _this.address,
					paymentID:      _this.paymentID,
					identifier:     _this.identifier,
					count:          _this.invalidShareCount
				}));

				this.lastInvalidShareTime = time_now;
				this.invalidShareCount = 0;
			}
		};

		this.setNewDiff = function (difficulty) {

			if (this.fixed_diff) return false;
			const newDiff = difficulty;
			this.newDiffRecommendation = newDiff;
			const ratio = Math.abs(newDiff - this.difficulty) / this.difficulty;
			if (ratio < 0.2) return false;
			this.newDiffToSet = newDiff;

			if (debugging == true) console.debug("[DEBUG] " + threadName + "Difficulty change to: " + this.newDiffToSet + " For: " + this.logString);

			if (this.hashes > 0) {

				if (debugging == true) console.debug("[DEBUG]" + threadName + "Hashes: " + this.hashes + " in: " + Math.floor((Date.now() - this.connectTime) / 1000) + " seconds gives: " +
					Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) + " hashes/second or: " +
					Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime + " difficulty versus: " + this.newDiffToSet);
			}
			return true;
		};

		// Adjust difficulty

		this.fixed_diff = false;
		this.difficulty = startingDiff;

		if (login_diff_split.length === 2) {

			this.fixed_diff = true;
			if (login_diff_split[1].substring(0, 4) === 'perf') {

				let perfDiff = 0;

				if (this.coin_perf[""] > 2) {
					perfDiff = Math.floor(this.coin_perf[""] * (global.config.pool.targetTime || 30));
				}

				if (login_diff_split[1].substring(4, 8) === 'auto' || perfDiff === 0) {
					this.fixed_diff = false;
				}
				this.difficulty = perfDiff || startingDiff;

			} else {
				this.difficulty = Number(login_diff_split[1]);
			}

			if (this.difficulty < global.config.pool.minDifficulty) {
				this.difficulty = global.config.pool.minDifficulty;
			}

			if (this.difficulty > global.config.pool.maxDifficulty) {
				this.difficulty = global.config.pool.maxDifficulty;
			}
		}

		this.curr_coin_hash_factor = 1;
		this.curr_coin_min_diff = global.config.pool.minDifficulty;
		this.curr_coin = "";

		if (debugging == true) console.log("[DEBUG] Miner current coin: " + this.curr_coin);

		if (agent && agent.includes('NiceHash')) {

			this.fixed_diff = true;
			let minNiceHashDiff;
			const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(this.curr_coin));

			if (global.coinFuncs.blobTypeRvn(blob_type_num) || global.coinFuncs.blobTypeEth(blob_type_num) || global.coinFuncs.blobTypeErg(blob_type_num)) {
				minNiceHashDiff = global.coinFuncs.niceHashDiff * 50;
			} else {
				minNiceHashDiff = global.coinFuncs.niceHashDiff;
			}

			if (this.difficulty < minNiceHashDiff) this.difficulty = minNiceHashDiff;
		}

		this.calcNewDiff = function () {

			let miner;
			let target;
			let min_diff;
			let history_time;

			const time_now = Date.now();
			const proxyMinerName = this.payout; // + ":" + this.identifier;

			let threadId = "thread-" + process.pid;
			let threadName = global.cache.getCache(threadId);
			let proxyMiners = global.cache.getCache("proxyMiners");
			let minerWallets = global.cache.getCache("minerWallets");

			let proxyMiner = proxyMiners[proxyMinerName];

			if (proxyMiner && proxyMiner.hashes / (time_now - proxyMiner.connectTime) > this.difficulty) {

				miner = proxyMiner;
				target = 15;
				min_diff = 10 * global.config.pool.minDifficulty;
				history_time = 5;

				if (this.debugMiner) console.log("[DEBUG] " + threadName + this.logString + " Calculating proxy miner difficulty: " + miner.hashes + " / " + ((time_now - miner.connectTime) / 1000));
			} else if (this.payout in minerWallets && minerWallets[this.payout].last_ver_shares >= global.config.pool.minerThrottleSharePerSec * global.config.pool.minerThrottleShareWindow) {

				miner = minerWallets[this.payout];
				target = 15;
				min_diff = 10 * global.config.pool.minDifficulty;
				history_time = 5;

				if (this.debugMiner) console.log("[DEBUG] " + threadName + this.logString + " Calculating throttled miner difficulty: " + miner.hashes + " / " + ((time_now - miner.connectTime) / 1000));
			} else {

				miner = this;
				target = this.proxy ? 15 : global.config.pool.targetTime;
				min_diff = this.proxy ? 10 * global.config.pool.minDifficulty : global.config.pool.minDifficulty;
				history_time = 60;

				if (this.debugMiner) console.log("[DEBUG] " + threadName + this.logString + " Calculating miner difficulty: " + miner.hashes + " / " + ((time_now - miner.connectTime) / 1000));
			}

			if (miner.connectTimeShift) {

				const timeSinceLastShift = time_now - miner.connectTimeShift;
				const timeWindow         = history_time * 60 * 1000;

				if (timeSinceLastShift > timeWindow) {
					if (timeSinceLastShift > 2 * timeWindow) { // forget all

						if (this.debugMiner) console.log("[DEBUG] " + threadName + this.logString + " Forget difficulty");
						miner.hashes = 0;
					} else {
						if (this.debugMiner) console.log("[DEBUG]" + threadName + this.logString + " Difficulty window shift from " + miner.connectTimeShift + " and " + miner.hashesShift + " hashes");
						miner.hashes -= miner.hashesShift;
					}

					miner.connectTime = miner.connectTimeShift;
					miner.connectTimeShift = time_now;
					miner.hashesShift = miner.hashes;
				}
			} else {
				miner.connectTimeShift = time_now;
				miner.hashesShift = miner.hashes;
			}

			let hashes = miner.hashes;
			let period = (time_now - miner.connectTime) / 1000;

			if (hashes === 0) {

				hashes = this.difficulty;
				target = 2 * global.config.pool.retargetTime;
				if (period < target) period = target;
			}

			const diff = hashes * target / period;
			return diff < min_diff ? min_diff : diff;
		};

		this.checkBan = function (validShare) {

			if (!global.config.pool.banEnabled) return;
			if (this.whiteList) return;

			// Valid stats are stored by the pool.
			if (validShare) {
				++ this.validShares;
			} else {
				++ this.invalidShares;
				if (this.validShares === 0) {
					console.error("[ERROR] " + threadName + "Suspended miner IP for submitting bad share with zero trust " + this.logString);
					removeMiner(this);
					process.send({type: 'banIP', data: this.ipAddress, wallet: this.payout});
					return;
				}
			}

			const shareCount = this.validShares + this.invalidShares;

			if (shareCount >= global.config.pool.banThreshold) {

				if (100 * this.invalidShares / shareCount >= global.config.pool.banPercent) {
					console.error("[ERROR] " + threadName + "Suspended miner IP for submitting too many bad shares recently " + this.logString);
					removeMiner(this);
					process.send({type: 'banIP', data: this.ipAddress, wallet: this.payout});
				} else {
					this.invalidShares = 0;
					this.validShares   = 0;
				}
			}
		};

		if (protoVersion === 1) {
			
			const poolUtils = require('./pool_utils.js');

			this.getCoinJob = function (coin, params) {

				const bt = params.bt;
				if (this.jobLastBlockHash === bt.idHash && !this.newDiffToSet && this.cachedJob !== null) return null;

				this.jobLastBlockHash = bt.idHash;
				if (debugging == true) console.debug("[DEBUG] Job last block hash: " + this.jobLastBlockHash)

				if (this.newDiffToSet) {

					this.difficulty            = this.newDiffToSet;
					this.newDiffToSet          = null;
					this.newDiffRecommendation = null;

				} else if (this.newDiffRecommendation) {

					this.difficulty            = this.newDiffRecommendation;
					this.newDiffRecommendation = null;
				}

				let coin_diff = this.difficulty / this.curr_coin_hash_factor;
				if (coin_diff < this.curr_coin_min_diff) coin_diff = this.curr_coin_min_diff;
				if (coin_diff > bt.difficulty) coin_diff = bt.difficulty;

				const blob_type_num = global.coinFuncs.portBlobType(bt.port);

				if (!this.proxy || isExtraNonceBT) {


					//const blob_hex = bt.nextBlobHex();
					const blob_hex = bt.blocktemplate_blob;
					if (!blob_hex) return null;

					const newJob = {
						id:             poolUtils.get_new_id(),
						coin:           coin,
						blob_type_num:  blob_type_num,
						blockHash:      bt.idHash,
						extraNonce:     bt.extraNonce,
						height:         bt.height,
						seed_hash:      bt.seed_hash,
						difficulty:     coin_diff,
						norm_diff:      coin_diff * this.curr_coin_hash_factor,
						coinHashFactor: params.coinHashFactor,
						submissions:    {}
					};

					this.validJobs.enq(newJob);

					this.cachedJob = {
						blob:       blob_hex,
						algo:       params.algo_name,
						height:     bt.height,
						seed_hash:  bt.seed_hash,
						job_id:     newJob.id,
						target:     poolUtils.getTargetHex(coin_diff, global.coinFuncs.nonceSize(blob_type_num)),
						id:         this.id
					};

				} else {

					//const blob_hex = bt.nextBlobWithChildNonceHex();
					const blob_hex = bt.blocktemplate_blob;
					const newJob = {

						id:                  poolUtils.get_new_id(),
						coin:                coin,
						blob_type_num:       blob_type_num,
						blockHash:           bt.idHash,
						extraNonce:          bt.extraNonce,
						height:              bt.height,
						seed_hash:           bt.seed_hash,
						difficulty:          coin_diff,
						norm_diff:           coin_diff * this.curr_coin_hash_factor,
						clientPoolLocation:  bt.clientPoolLocation,
						clientNonceLocation: bt.clientNonceLocation,
						coinHashFactor:      params.coinHashFactor,
						submissions:         {}
					};

					this.validJobs.enq(newJob);
					this.cachedJob = {

						blocktemplate_blob:  blob_hex,
						blob_type:           global.coinFuncs.blobTypeStr(bt.port, bt.block_version),
						algo:                params.algo_name,
						difficulty:          bt.difficulty,
						height:              bt.height,
						seed_hash:           bt.seed_hash,
						reserved_offset:     bt.reserved_offset,
						client_nonce_offset: bt.clientNonceLocation,
						client_pool_offset:  bt.clientPoolLocation,
						target_diff:         coin_diff,
						job_id:              newJob.id,
						id:                  this.id
					};
				}

				return this.cachedJob;
			};

			this.sendCoinJob = function(coin, params) {

				const job = this.getCoinJob(coin, params);
				if (job === null) return;
				const blob_type_num = global.coinFuncs.portBlobType(global.coinFuncs.COIN2PORT(coin));
				return this.pushMessage({method: "job", params: job});
			};

			this.sendSameCoinJob = function () {
				
				const coin = typeof(this.curr_coin) !== 'undefined' ? this.curr_coin : this.selectBestCoin();
				if (coin !== false) return this.sendCoinJob(coin, poolUtils.getCoinJobParams(coin));
			};

			this.getBestCoinJob = function() {

				const coin = this.selectBestCoin();
				if (coin !== false) return this.getCoinJob(coin, poolUtils.getCoinJobParams(coin));
			};

			this.sendBestCoinJob = function() {

				const coin = this.selectBestCoin();
				if (coin !== false) return this.sendCoinJob(coin, poolUtils.getCoinJobParams(coin));
			};
		}
		if (debugging == true) console.log("[DEBUG] Miner setup completed! ");
	}
};
