"use strict";
const poolUtils = require('./pool_utils.js');
const poolCache = require('./pool_cache.js');
const debugging = global.config.debugging;

// Private functions

function process_rpc_template(rpc_template, coin, port, coinHashFactor, isHashFactorChange) {

        let blockTemplate = Object.assign({}, rpc_template);

        blockTemplate.coin               = coin;
        blockTemplate.port               = parseInt(port);
        blockTemplate.coinHashFactor     = coinHashFactor;
        blockTemplate.isHashFactorChange = isHashFactorChange;

        return blockTemplate;
};

function templateUpdate2(coin, port, isHashChange, coinHashFactor, isHashFactorChange, body_header, times_failed, cluster) {

	let newCoinHashFactor = coinHashFactor;
	let lastBlockHeight   = {};
	let lastBlockKeepTime = {}
	let lastBlockReward   = {};

	// templateUpdate2 is only called in master thread (except the beginning of a worker thread)

	if (debugging == true) {

		console.log("[DEBUG] Template Update 2")
		console.log("[DEBUG] TU2 Coin: " + coin)
		console.log("[DEBUG] TU2 Port: " + port)
		console.log("[DEBUG] TU2 Is Hash Change: " + isHashChange)
		console.log("[DEBUG] TU2 Is Hash Factor Change: " + isHashFactorChange)
		console.log("[DEBUG] TU2 coin Hash Factor: " + coinHashFactor)
		console.log("[DEBUG] TU2 times failed: " + times_failed)
		console.log("[DEBUG] TU2 body header:" + body_header)
	}

	global.coinFuncs.getPortBlockTemplate(port, function (body_block_template) {

		if (debugging == true) { console.debug("[DEBUG] TU2 - body block template: " + body_block_template) }

		if (!newCoinHashFactor[coin]) {
			console.error("[ERROR] Aborting " + port + " last block template request because " + coin + " already has zero hash factor");
			return;
		}

		if (body_header.height < lastBlockHeight[coin]) {
			console.error("[ERROR] TU2 - Ignore block template request attempt returned outdated template for " + port + " port (height " + (body_header.height+1) + " while " + (lastBlockHeight[coin]+1) + " height needed)");
			return;
		}

		times_failed = times_failed ? times_failed : 0;

		if (!body_block_template) {

			times_failed += 1;
			console.error("[ERROR] TU2 - Block template request attempt " + times_failed + " failed for port: " + port);

			if (times_failed <= 2) {
				setTimeout(module.exports.templateUpdate2, 500, coin, port, isHashChange, coinHashFactor, isHashFactorChange, body_header, times_failed, cluster);
			} else coinHashFactorUpdate(coin, 0);
			return;
		}

		const time_now = Date.now();
		const maxBlockKeepTime = ("maxBlockKeepTime" + coin in global.config.daemon ? global.config.daemon["maxBlockKeepTime" + coin] : 60*60) * 1000;
		const isTimeChange       = !(coin in lastBlockKeepTime) || time_now - lastBlockKeepTime[coin] > maxBlockKeepTime;
		const isRewardCheckReady = body_block_template.expected_reward && (coin in lastBlockReward) && lastBlockReward[coin];
		const isRewardChange     = isRewardCheckReady && body_block_template.expected_reward / lastBlockReward[coin] > 1.01;

		if (isHashChange || (isTimeChange && (!isRewardCheckReady || body_block_template.expected_reward !== lastBlockReward[coin])) || isRewardChange) {

			lastBlockKeepTime[coin] = time_now;
			lastBlockReward[coin]   = body_block_template.expected_reward;


			//return templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, body_block_template, cluster);

			const blockTemplate = process_rpc_template(body_block_template, coin, port, coinHashFactor, isHashFactorChange);

			if (debugging == true) { console.debug("[DEBUG] New block template found at " + blockTemplate.height + " height"); }
			poolUtils.sendToWorkers({type: 'newBlockTemplate', data: blockTemplate}, cluster);
			poolUtils.setNewBlockTemplate(blockTemplate, cluster);
		}
	});
};

//function templateUpdate3(coin, port, coinHashFactor, isHashFactorChange, body_block_template, cluster) {
//
//	// templateUpdate3 is only called in master thread (except the beginning of a worker thread)
//	const template = process_rpc_template(body_block_template, coin, port, coinHashFactor, isHashFactorChange);
//
//	if (debugging == true) { console.debug("[DEBUG] New block template found at " + template.height + " height"); }
//	poolUtils.sendToWorkers({type: 'newBlockTemplate', data: template}, cluster);
//	poolUtils.setNewBlockTemplate(template, cluster);
//};

// Public functions

module.exports = {

	templateUpdate: function(coin = "", repeating = false, cluster = false, coinHashFactor = 0) {

		// templateUpdate is only called in master thread (except the beginning of a worker thread)

		const port                = global.coinFuncs.COIN2PORT(coin);
		const timeoutMilliseconds = global.config.defaultTimeoutMilliseconds;
		const newCoinHashFactor   = coinHashFactor;
		const lastCoinHashFactor  = coinHashFactor;
		let lastBlockHash        = {};
		let lastBlockTime        = {};
		let lastBlockHeight      = {};

		if (debugging == true) {

			console.log("[DEBUG] TemplateUpdate")
			console.log("[DEBUG] TemplateUpdate Port: " + port)
			console.log("[DEBUG] TemplateUpdate Coin: " + coin)
			console.log("[DEBUG] TemplateUpdate Repeating: " + repeating)
			console.log("[DEBUG] TemplateUpdate Coin hashfactor: " + coinHashFactor)
		}

		if (coinHashFactor) {

			if (debugging == true) console.log("[DEBUG] CoinHashFactor: ", coinHashFactor);

			global.coinFuncs.getPortLastBlockHeader(port, function (err, body) {

				if (!newCoinHashFactor[coin]) {
			
					if (debugging == true) console.log("[DEBUG] IF:", newCoinHashFactor);

					console.log(threadName + "Aborting " + port + " last block header request because " + coin + " already has zero hash factor");

					if (repeating === true) setTimeout(module.exports.templateUpdate, timeoutMilliseconds, coin, repeating, cluster, coinHashFactor);

				} else if (err === null && body.hash) {

					if (debugging == true) console.log("[DEBUG] ELSE IF:", body.hash);

					const isHashFactorChange = Math.abs(lastCoinHashFactor[coin] - coinHashFactor) / coinHashFactor > 0.05;
					const pollBlockInterval = "pollBlockInterval" + coin in global.config.daemon ? global.config.daemon["pollBlockInterval" + coin] : 60*60*1000;
					const time_now = Date.now();
					const isHashChange   = !(coin in lastBlockHash) || body.hash !== lastBlockHash[coin];
					const isTimeChange   = !(coin in lastBlockTime) || time_now - lastBlockTime[coin] > pollBlockInterval;

					if (debugging == true) {

						console.log("[DEBUG] Template Update - Block header request successful: " + body.hash)
						console.log("[DEBUG] Is Hash Factor change: " + isHashFactorChange)
						console.log("[DEBUG] Is Hash change: " + isHashChange)
						console.log("[DEBUG] Is Time change: " + isTimeChange)
						console.log("[DEBUG] Poll block interval: " + pollBlockInterval)
					}

					if ( isHashChange || isTimeChange ) {

						lastBlockHash[coin]   = body.hash;
						lastBlockHeight[coin] = body.height;
						lastBlockTime[coin]   = time_now;

						if (debugging == true) console.debug("[DEBUG] Performing call to 'templateUpdate2'");
						templateUpdate2(coin, port, isHashChange, coinHashFactor, isHashFactorChange, body, 0, cluster);

					} else if (isHashFactorChange) {

						if (debugging == true) console.debug("[DEBUG] Performing call to 'coinHashFactorUpdate'");
						coinHashFactorUpdate(coin, coinHashFactor);
					}

					if (debugging == true) console.debug("[DEBUG] Call to SetTimeout with templateUpdate");
					if (repeating === true) setTimeout(module.exports.templateUpdate, timeoutMilliseconds, coin, repeating, cluster, coinHashFactor);


				} else {
					if (debugging == true) console.log("[DEBUG] ELSE:", newCoinHashFactor);
					console.error(threadName + "Last block header request for " + port + " port failed! error: " + err);
					coinHashFactorUpdate(coin, 0);
					if (repeating !== false) setTimeout(module.exports.templateUpdate, timeoutMilliseconds, coin, repeating, cluster, coinHashFactor);
				}
			});
			return 0

		} else if (cluster.isMaster) {
			if (repeating !== false) setTimeout(module.exports.templateUpdate, timeoutMilliseconds, coin, repeating, cluster, coinHashFactor);
		}
	},
};
