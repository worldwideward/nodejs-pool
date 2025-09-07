"use strict";
const bignum = require('bignum');
const cnUtil = require('cryptoforknote-util');
const multiHashing = require('cryptonight-hashing');
const crypto = require('crypto');
const debug = require('debug')('coinFuncs');
const process = require('process');
const fs = require('fs');
const net = require('net');
const async = require('async');
const child_process = require('child_process');

const reXMRig     = /XMRig(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\./; // 2.8.0
const reXMRSTAKRX = /\w+-stak-rx\/(\d+)\.(\d+)\.(\d+)/; // 1.0.1
const reXMRSTAK   = /\w+-stak(?:-[a-zA-Z]+)?\/(\d+)\.(\d+)\.(\d+)/; // 2.5.0
const reXNP       = /xmr-node-proxy\/(\d+)\.(\d+)\.(\d+)/; // 0.3.2
const reCAST      = /cast_xmr\/(\d+)\.(\d+)\.(\d+)/; // 1.5.0
const reSRB       = /SRBMiner Cryptonight AMD GPU miner\/(\d+)\.(\d+)\.(\d+)/; // 1.6.8
const reSRBMULTI  = /SRBMiner-MULTI\/(\d+)\.(\d+)\.(\d+)/; // 0.1.5

const pool_nonce_size = 16+1; // 1 extra byte for old XMR and new TRTL daemon bugs
const port2coin = {
  "31081": "",
};
const port2blob_num = {
  "31081": 0,   // XMR
};

const port2algo = {
  "31081": "rx/0",          // XMR
};

const debugging = global.config.debugging;

const extra_nonce_template_hex    = "02" + (pool_nonce_size + 0x100).toString(16).substr(-2) + "00".repeat(pool_nonce_size);

function get_coin2port(port2coin) {
    let coin2port = {};
    for (let port in port2coin) coin2port[port2coin[port]] = parseInt(port);
    return coin2port;
}
const coin2port = get_coin2port(port2coin);
function get_coins(port2coin) {
    let coins = [];
    for (let port in port2coin) if (port2coin[port] != "") coins.push(port2coin[port]);
    return coins;
}
const ports = Object.keys(port2coin);
const coins = get_coins(port2coin);

function get_algos() {
    let algos = {};
    for (let port in port2algo) algos[port2algo[port]] = 1;
    return algos;
}
const all_algos = get_algos();

let miner_address_verify = {}; // store miner address and number of its shares currently in flight for verification
let shareVerifyQueue = [];
let shareVerifyQueueErrorTime = [];
let shareVerifyQueueErrorCount = [];

// Verify shares submitted by miners?
if (global.config.verify_shares_host) global.config.verify_shares_host.forEach(function(verify_shares_host, index) {

    shareVerifyQueueErrorTime[index]  = 0;
    shareVerifyQueueErrorCount[index] = 0;
    shareVerifyQueue[index] = async.queue(function (task, queueCB) {

        if (task.miner_address in miner_address_verify) -- miner_address_verify[task.miner_address];
        const cb = task.cb;
        if (Date.now() - task.time > 1*60*1000) {
            cb(null);
            return queueCB();
        }

        const jsonInput = task.jsonInput;

        let socket = new net.Socket();
        let is_cb = false;
        let return_cb = function(result) {
            if (is_cb) return;
            is_cb = true;
            cb(result);
            return queueCB();
        }

        let timer = setTimeout(function() {
            socket.destroy();
            if (shareVerifyQueueErrorCount[index] > 100) {
                const err_str = "[ERROR] Server " + global.config.hostname + " timeouted share verification to " + verify_shares_host;
                console.error(err_str);
		// Disable sending emails
                //global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
            }
            shareVerifyQueueErrorTime[index] = Date.now();
            ++ shareVerifyQueueErrorCount[index];
            return return_cb(false);
        }, 60*1000);

        socket.connect(2222, verify_shares_host, function () {
            socket.write(JSON.stringify(jsonInput) + "\n");
        });

        let buff = "";
        socket.on('data', function (buff1) {
           buff += buff1;
        });

        socket.on("end", function () {
            clearTimeout(timer);
            timer = null;
            try {
                const jsonOutput = JSON.parse(buff.toString());
                if (!("result" in jsonOutput)) return return_cb(false);
                shareVerifyQueueErrorCount[index] = 0;
                return return_cb(jsonOutput.result);
            } catch (e) {
                if (shareVerifyQueueErrorCount[index] > 100) {
                    const err_str = "[ERROR] Server " + global.config.hostname + " got wrong JSON from " + verify_shares_host;
                    console.error(err_str);
		    // Disable sending emails
                    //global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
                }
                shareVerifyQueueErrorTime[index] = Date.now();
                ++ shareVerifyQueueErrorCount[index];
                return return_cb(false);
            }
        });

        socket.on('error', function() {
            socket.destroy();
            if (shareVerifyQueueErrorCount[index] > 100) {
                const err_str = "[ERROR] Server " + global.config.hostname + " got socket error from " + verify_shares_host;
                console.error(err_str);
		// Disable sending emails
                //global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't verify share", err_str);
            }
            shareVerifyQueueErrorTime[index] = Date.now();
            ++ shareVerifyQueueErrorCount[index];
            return return_cb(false);
        });
    }, 16);

    setInterval(function(queue_obj, index){
        if (queue_obj.length() >= 1000) {
            let miner_address = {};
            queue_obj.remove(function(task) {
                const d = task.data;
                if (!(d.miner_address in miner_address)) miner_address[d.miner_address] = 1;
                else ++ miner_address[d.miner_address];
                if (Date.now() - d.time > 1*60*1000) {
                   d.cb(null);
                   return true;
                }
                return false;
            });
            console.error("[INFO] " + global.database.thread_id + "Share verify queue " + index + " state: " + queue_obj.length() + " items in the queue " + queue_obj.running() + " items being processed");
            Object.keys(miner_address).forEach(function(key) {
                const value = miner_address[key];
                if (value > 100) console.error("[ERROR] Too many shares from " + key + ": " + value);
            });
        }
    }, 30*1000, shareVerifyQueue[index], index);
});

function Coin(data){
    this.uniqueWorkerId = 0;
    this.uniqueWorkerIdBits = 0;

    this.bestExchange = global.config.payout.bestExchange;
    this.data = data;
    let instanceId = Buffer.alloc(4);
    instanceId.writeUInt32LE( (((global.config.pool_id % (1<<10)) << 22) + (process.pid % (1<<22))) >>> 0 );
    console.log("[INFO] Generated instanceId: " + instanceId.toString('hex'));

    this.coinDevAddress = global.config.monero_developers_address;  // Monero Developers Address
    this.poolDevAddress = global.config.pool_developers_address;  // MoneroOcean Address

    this.blockedAddresses = [
        this.coinDevAddress,
        this.poolDevAddress,
    ];

    this.exchangeAddresses = [
        "abc" // Poloniex
    ]; // These are addresses that MUST have a paymentID to perform logins with.

    this.prefix = 18;
    this.subPrefix = 42;
    this.intPrefix = 19;

    if (global.config.general.testnet === true){
        this.prefix = 53;
        this.subPrefix = 63;
        this.intPrefix = 54;
    }

    this.supportsAutoExchange = true;

    this.niceHashDiff = 400000;

    this.getPortBlockHeaderByID = function(port, blockId, callback){
        global.support.rpcPortDaemon(port, 'getblockheaderbyheight', {"height": blockId}, function (body) {
            if (body && body.hasOwnProperty('result')) {
                return callback(null, body.result.block_header);
            } else {
                console.error("[ERROR] getPortBlockHeaderByID(" + port + ", " + blockId + "): " + JSON.stringify(body));
                return callback(true, body);
            }
        });
    };

    this.getBlockHeaderByID = function(blockId, callback){
        return this.getPortBlockHeaderByID(global.config.daemon.port, blockId, callback);
    };

    this.getPortAnyBlockHeaderByHash = function(port, blockHash, is_our_block, callback){

        if (typeof(body) === 'undefined' || !body.hasOwnProperty('result')) {
            console.error("getPortBlockHeaderByHash(" + port + ", " + blockHash + "): " + JSON.stringify(body));
            return callback(true, body);
        }

        body.result.block_header.reward = 0;

        let reward_check = 0;
        const blockJson = JSON.parse(body.result.json);
        const minerTx = blockJson.miner_tx;

        for (var i=0; i<minerTx.vout.length; i++) {
            if (minerTx.vout[i].amount > reward_check) {
                reward_check = minerTx.vout[i].amount;
            }
        }

        if (is_our_block && miner_tx_hash) global.support.rpcPortWalletShort(port + 1, "get_transfer_by_txid", {"txid": miner_tx_hash}, function (body2) {
            if (typeof(body2) === 'undefined' || body2.hasOwnProperty('error') || !body2.hasOwnProperty('result') || !body2.result.hasOwnProperty('transfer') || !body2.result.transfer.hasOwnProperty('amount')) {
                console.error(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": " + JSON.stringify(body2));
                return callback(true, body.result.block_header);
            }
            let reward = body2.result.transfer.amount;

            if (reward !== reward_check) {
                if (reward_check < reward) {
                    console.warn(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": using lesser block reward from block header " + reward_check + " instead of higher from incoming wallet tx " + reward);
                    reward = reward_check;
                } else {
                    console.warn(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": using lesser block reward from incoming tx " + reward + " instead of higher from block header " + reward_check);
                }
            }
            if (port != 38081 && reward == 0) { // MSR can have uncle block reward here
                console.error(port + ": block hash: " + blockHash + ": txid " + miner_tx_hash + ": both block header and incoming wallet tx rewards are zero: " + JSON.stringify(body) + "\n" + JSON.stringify(body2));
                return callback(true, body);
            }

            body.result.block_header.reward = reward;
            return callback(null, body.result.block_header);

        }); else {
            body.result.block_header.reward = reward_check;
            return callback(null, body.result.block_header);
        }
    };

    this.getPortBlockHeaderByHash = function(port, blockHash, callback){
        return this.getPortAnyBlockHeaderByHash(port, blockHash, true, callback);
    };

    this.getBlockHeaderByHash = function(blockHash, callback){
        return this.getPortBlockHeaderByHash(global.config.daemon.port, blockHash, callback);
    };

    this.getPortLastBlockHeader = function(port, callback, no_error_report) {

	if (debugging == true) console.debug("[DEBUG] getPortLastBlockHeader for port: " + port);
        global.support.rpcPortDaemon(port, 'getlastblockheader', [], function (body) {

	    if (debugging == true) console.debug("[DEBUG] getPortLastBlockHeader RPC Body: " + body.result);
	
            if (typeof(body) !== 'undefined' && body.hasOwnProperty('result')) {
                return callback(null, body.result.block_header);
            } else {
                if (!no_error_report) console.error("Last block header invalid: " + JSON.stringify(body));
                return callback(true, body);
            }
        });
    };

    this.getLastBlockHeader = function(callback) {
        return this.getPortLastBlockHeader(global.config.daemon.port, callback);
    };

    this.getPortLastBlockHeaderWithRewardDiff = function(port, callback, no_error_report) {
	global.coinFuncs.getPortLastBlockHeader(port, function (is_err, body) {
	    if (is_err) return callback(is_err, body);
	    return callback(is_err, body);
	}, no_error_report);
    };

    this.getPortBlockTemplate = function(port, callback) {

	if (debugging == true) console.debug("[DEBUG] Pool Wallet address: " + global.config.pool_wallet_address);

        global.support.rpcPortDaemon(port, 'getblocktemplate', {
            reserve_size: pool_nonce_size,
            wallet_address: global.config.pool_wallet_address
        }, function(body){
	    if (debugging == true) console.debug("[DEBUG] getPortBlockTemplate RPC Body: " + body.result);
            return callback(body && body.result ? body.result : null);
        });
    };

    this.getBlockTemplate = function(callback){
        return this.getPortBlockTemplate(global.config.daemon.port, callback);
    };

    this.baseDiff = cnUtil.baseDiff;

    this.validatePlainAddress = function(address){
        // This function should be able to be called from the async library, as we need to BLOCK ever so slightly to verify the address.
        address = Buffer.from(address);
        let code = cnUtil.address_decode(address);
        return code === this.prefix || code === this.subPrefix;
    };

    this.validateAddress = function(address){
        if (this.validatePlainAddress(address)) return true;
        // This function should be able to be called from the async library, as we need to BLOCK ever so slightly to verify the address.
        address = Buffer.from(address);
        return cnUtil.address_decode_integrated(address) === this.intPrefix;
    };

    this.portBlobType = function(port, version) { return port2blob_num[port]; }

    this.c29ProofSize = function(blob_type_num) {
        switch (blob_type_num) {
            case 10:  return 40;
            case 12:  return 48;
            case 107: return 42;
            default:  return 32;
        }
    }

    this.nonceSize = function(blob_type_num) {
        switch (blob_type_num) {
            case 7:
            case 101:           // RVN
            case 102:           // ETH
            case 103:           // ERG
	    case 107: return 8; // XTM_C
            default:  return 4;
        }
    }

    this.convertBlob = function(blobBuffer, port) {
        const blob_type_num = this.portBlobType(port, blobBuffer[0]);
        let blob;
        try {
            blob = cnUtil.convert_blob(blobBuffer, blob_type_num);
        } catch (e) {
            const err_str = "Can't do port " + port + " convert_blob " + blobBuffer.toString('hex') + " with blob type " + blob_type_num + ": " + e;
            console.error(err_str);
	    // Disable sending emails
            //global.support.sendEmail(global.config.general.adminEmail, "FYI: Can't convert_blob", err_str);
            return null;
        }
        return blob;
    };

    this.constructNewBlob = function(blockTemplateBuffer, params, port) {

        const blob_type_num = this.portBlobType(port, blockTemplateBuffer[0]);
        return cnUtil.construct_block_blob(blockTemplateBuffer, Buffer.from(params.nonce, 'hex'), blob_type_num);
    };

    this.getBlockID = function(blockBuffer, port){

        const blob_type_num = this.portBlobType(port, blockBuffer[0]);
        return cnUtil.get_block_id(blockBuffer, blob_type_num);
    };

    this.BlockTemplate = function(template) {
        // Generating a block template is a simple thing.  Ask for a boatload of information, and go from there.
        // Important things to consider.
        // The reserved space is 16 bytes long now in the following format:
        // Assuming that the extraNonce starts at byte 130:
        // |130-133|134-137|138-141|142-145|
        // |minerNonce/extraNonce - 4 bytes|instanceId - 4 bytes|clientPoolNonce - 4 bytes|clientNonce - 4 bytes|
        // This is designed to allow a single block template to be used on up to 4 billion poolSlaves (clientPoolNonce)
        // Each with 4 billion clients. (clientNonce)
        // While being unique to this particular pool thread (instanceId)
        // With up to 4 billion clients (minerNonce/extraNonce)
        // Overkill? Sure. But that's what we do here. Overkill.

        // Set these params equal to values we get from upstream (if they are set)
        // DERO-HE case, where mbl is miniblock
        this.difficulty         = template.mbl_difficulty ? template.mbl_difficulty : template.difficulty;
        // Needed to get XMR diff from TARI merge block template
        this.xmr_difficulty     = template.wide_difficulty ? parseInt(template.wide_difficulty, 16) : this.difficulty;
	//const aux_chain_xtm     = global.coinFuncs.getAuxChainXTM(template);
        //if (aux_chain_xtm) {
        //    this.xtm_height     = parseInt(aux_chain_xtm.height);
        //    this.xtm_difficulty = parseInt(aux_chain_xtm.difficulty);
        //}
	//this.xtm_t_block        = template.xtm_t_block;
        this.height             = template.height;
        this.bits               = template.bits;
        this.seed_hash          = template.seed_hash;
        this.coin               = template.coin;
        this.port               = template.port;

        const port_blob_num  = port2blob_num[this.port];

        if (template.blocktemplate_blob) {
            this.blocktemplate_blob = template.blocktemplate_blob;
        } else if (template.blob) {
            this.blocktemplate_blob = template.blob;
        } else {
            const isExtraNonceBT = global.coinFuncs.blobTypeEth(port_blob_num) || global.coinFuncs.blobTypeErg(port_blob_num);
            if (isExtraNonceBT) {
                const hash = template.hash;
                this.hash          = this.idHash = hash;
                this.hash2         = template.hash2;
                this.block_version = 0;
                this.nextBlobHex   = function () { return hash; };
                return;
            } else {
                console.error("INTERNAL ERROR: No blob in " + this.port + " port block template: " + JSON.stringify(template));
                this.blocktemplate_blob = extra_nonce_mm_template_hex; // to avoid hard crash
            }
        }

        const is_mm = "child_template" in template;

        if (is_mm) {
            this.child_template        = template.child_template;
            this.child_template_buffer = template.child_template_buffer;
        }

        const blob = this.blocktemplate_blob;

        this.idHash = crypto.createHash('md5').update(blob).digest('hex');

        // Set this.buffer to the binary decoded version of the BT blob
        this.buffer = Buffer.from(blob, 'hex');
        this.block_version = this.buffer[0];

        const template_hex = extra_nonce_template_hex;
        const found_reserved_offset_template = blob.indexOf(template_hex);

        if (found_reserved_offset_template !== -1) {
            const found_reserved_offset = (found_reserved_offset_template >> 1) + 2;
            if (is_mm) {
                this.reserved_offset = found_reserved_offset;
            } else {
                if (template.reserved_offset && !template._aux) { // _aux is part of TARI merged mining block template
                    // here we are OK with +1 difference because we put extra byte into pool_nonce_size
                    if (found_reserved_offset != template.reserved_offset && found_reserved_offset + 1 != template.reserved_offset) {
                        console.error("INTERNAL ERROR: Found reserved offset " + found_reserved_offset + " do not match " + template.reserved_offset + " reported by daemon in " + this.port + " block " + ": " + blob);
                    }
                    this.reserved_offset = template.reserved_offset;
                } else if (template.reservedOffset) {
                    // here we are OK with +1 difference because we put extra byte into pool_nonce_size
                    if (found_reserved_offset != template.reservedOffset && found_reserved_offset + 1 != template.reservedOffset) {
                        console.error("INTERNAL ERROR: Found reserved offset " + found_reserved_offset + " do not match " + template.reservedOffset + " reported by daemon in " + this.port + " block " + ": " + blob);
                    }
                    this.reserved_offset = template.reservedOffset;
                } else {
                    this.reserved_offset = found_reserved_offset;
                }
            }
        } else {
            //console.error("INTERNAL ERROR: Can not find reserved offset template '" + template_hex + "' in " + this.port + " block " + ": " + blob);
            this.reserved_offset = template.reserved_offset ? template.reserved_offset : template.reservedOffset;
        }

        if (this.reserved_offset === undefined) {
            console.error("INTERNAL ERROR: No reserved offset in " + this.port + " port block template: " + JSON.stringify(template));
            this.reserved_offset = 0; // to avoid hard crash
        }

        if (template.bt_nonce_size === undefined || template.bt_nonce_size >= 16) {
          // Copy the Instance ID to the reserve offset + 4 bytes deeper.  Copy in 4 bytes.
          instanceId.copy(this.buffer, this.reserved_offset + 4, 0, 4);
          // Reset the Nonce - this is the per-miner/pool nonce
          this.extraNonce = 0;
          // The clientNonceLocation is the location at which the client pools should set the nonces for each of their clients.
          this.clientNonceLocation = this.reserved_offset + 12;
          // The clientPoolLocation is for multi-thread/multi-server pools to handle the nonce for each of their tiers.
          this.clientPoolLocation = this.reserved_offset + 8;

          this.nextBlobHex = function () {
              // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
              this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
              // Convert the buffer into something hashable.
              const blob = global.coinFuncs.convertBlob(this.buffer, this.port);
              return blob ? blob.toString('hex') : null;
          };
          // Make it so you can get the raw block buffer out.
          this.nextBlobWithChildNonceHex = function () {
              // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
              this.buffer.writeUInt32BE(++this.extraNonce, this.reserved_offset);
              // Don't convert the buffer to something hashable.  You bad.
              return this.buffer.toString('hex');
          };
        } else { // compact nonce management
          this.extraNonce = 0;
          this.extraNonce2 = 0; // internal counter not wrapped by 1<< (32-global.coinFuncs.uniqueWorkerIdBits)
          this.nextBlobHex = function () {
              const blob = global.coinFuncs.convertBlob(this.buffer, this.port);
              return blob ? blob.toString('hex') : null;
          };
          this.nextBlobWithChildNonceHex = function () { // not supported
              return null;
          };
	}
    };

    this.getPORTS          = function() { return ports; }
    this.getCOINS          = function() { return coins; }
    this.PORT2COIN         = function(port) { return port2coin[port]; }
    this.PORT2COIN_FULL    = function(port) { const coin = port2coin[port]; return coin == "" ? "XMR" : coin; }
    this.COIN2PORT         = function(coin) { return coin2port[coin]; }

    this.getDefaultAlgos = function() {
        return [ "rx/0" ];
    }

    this.getDefaultAlgosPerf = function() {
        return { "rx/0": 1 };
    }

    this.getPrevAlgosPerf = function() {
        return { "cn/r": 1, "cn/half": 1.9, "cn/rwz": 1.3, "cn/zls": 1.3, "cn/double": 0.5 };
    }

    this.convertAlgosToCoinPerf = function(algos_perf) {
        let coin_perf = { "": 1 };

        return coin_perf;
    }

    // returns true if algo set reported by miner is for main algo
    this.algoMainCheck = function(algos) {
        if ("rx/0" in algos) return true;
        return false;
    }
    // returns true if algo set reported by miner is one of previous main algos
    this.algoPrevMainCheck = function(algos) {
        if ("cn/r" in algos) return true;
        return false;
    }
    // returns true if algo set reported by miner is OK or error string otherwise
    this.algoCheck = function(algos) {
        if (this.algoMainCheck(algos)) return true;
        for (let algo in all_algos) if (algo in algos) return true;
        return "algo array must include at least one supported pool algo: [" + Object.keys(algos).join(", ") + "]";
    }

    this.slowHashBuff = function(convertedBlob, blockTemplate, nonce, mixhash) {
        switch (blockTemplate.port) {
            case 18081: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 0);	   // XMR
            case 31081: return multiHashing.randomx(convertedBlob, Buffer.from(blockTemplate.seed_hash, 'hex'), 0);	   // XMR
            default:
		console.error("Unknown " + blockTemplate.port + " port for Cryptonight PoW type");
		return multiHashing.cryptonight(convertedBlob, 13, blockTemplate.height);
        }
    }

    this.slowHash = function(convertedBlob, blockTemplate, nonce, mixhash) {
        return this.slowHashBuff(convertedBlob, blockTemplate, nonce, mixhash).toString("hex");
    }

    this.verify_share_host_index = 0;

    this.slowHashAsync = function(convertedBlob, blockTemplate, miner_address, cb) {
        if (!global.config.verify_shares_host) return cb(this.slowHash(convertedBlob, blockTemplate));
        if (miner_address in miner_address_verify) {
          if (miner_address_verify[miner_address] > 100) return cb(null);
          ++ miner_address_verify[miner_address];
        } else miner_address_verify[miner_address] = 1;
        let jsonInput;
        switch (blockTemplate.port) {
            case 31081:
            default:
                jsonInput = { "algo": port2algo[blockTemplate.port], "blob": convertedBlob.toString('hex') };
        }
        const time_now     = Date.now();
        let best_index     = null;
        let min_queue_size = null;
        let max_noerr_time = null;
        shareVerifyQueue.forEach(function(queue_obj, index) {
            if (time_now - shareVerifyQueueErrorTime[index] < 1*60*1000 && shareVerifyQueueErrorCount[index] > 100 && global.config.verify_shares_host[index] !== "127.0.0.1") return;
            const qlength = queue_obj.length() + queue_obj.running();
            if (min_queue_size === null || qlength < min_queue_size) {
                best_index     = index;
                min_queue_size = qlength;
            }
        });
        if (best_index === null) shareVerifyQueueErrorTime.forEach(function(last_error_time, index) {
            const noerr_time = time_now - last_error_time;
            if (max_noerr_time === null || noerr_time > max_noerr_time) {
                best_index     = index;
                max_noerr_time = noerr_time;
            }
        });
        return shareVerifyQueue[best_index].unshift({
            jsonInput:     jsonInput,
            cb:            cb,
            time:          time_now,
            miner_address: miner_address
        });
    }

    this.c29 = function(header, ring, port) {
        switch (port) {
            default:
		console.error("Unknown " + port + " port for Cuckaroo PoW type");
		return multiHashing.c29s(header, ring);
        }
    }

    this.c29_packed_edges = function(ring, blob_type_num) {
        switch (blob_type_num) {
            case 10:  return multiHashing.c29b_packed_edges(ring);
            case 12:  return multiHashing.c29i_packed_edges(ring);
            case 107: return multiHashing.c29_packed_edges(ring);
            default:  return multiHashing.c29s_packed_edges(ring);
        }
    }

    this.c29_cycle_hash = function(packed_edges) {
        return multiHashing.c29_cycle_hash(packed_edges);
    }

    this.blobTypeStr = function(port, version) {
        switch (port) {
            case 31081:  return "cryptonote"; // XMR
            default:    return "cryptonote";
        }
    }

    this.algoShortTypeStr = function(port, version) {
        if (port in port2algo) return port2algo[port];
        console.error("Unknown " + port + " port for PoW type on " + version + " version");
	return "rx/0";
    }

    this.isMinerSupportAlgo = function(algo, algos) {
        if (algo in algos) return true;
        if (algo === "cn-heavy/0" && "cn-heavy" in algos) return true;
        return false;
    }

    this.get_miner_agent_warning_notification = function(agent) {
        let m;
        if (m = reXMRig.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            if (majorv + minorv < 30200) {
                return "Please update your XMRig miner (" + agent + ") to v3.2.0+ to support new rx/0 Monero algo";
            }
            if (majorv + minorv >= 40000 && majorv + minorv < 40200) {
                return "Please update your XMRig miner (" + agent + ") to v4.2.0+ to support new rx/0 Monero algo";
            }
        } else if (m = reXMRSTAKRX.exec(agent)) {
            return false;
        } else if (m = reXMRSTAK.exec(agent)) {
            return "Please update your xmr-stak miner (" + agent + ") to xmr-stak-rx miner to support new rx/0 Monero algo";
        } else if (m = reXNP.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            const minorv2 = parseInt(m[3]);
            const version = majorv + minorv + minorv2;
            if (version < 1400) {
                 return "Please update your xmr-node-proxy (" + agent + ") to version v0.14.0+ by doing 'cd xmr-node-proxy && ./update.sh' (or check https://github.com/MoneroOcean/xmr-node-proxy repo) to support new rx/0 Monero algo";
            }
        } else if (m = reSRBMULTI.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            const minorv2 = parseInt(m[3]);
            if (majorv + minorv + minorv2 < 105) {
                 return "Please update your SRBminer-MULTI (" + agent + ") to version v0.1.5+ to support new rx/0 Monero algo";
            }
        }
        return false;
    };

    this.is_miner_agent_no_haven_support = function(agent) {
        let m;
        if (m = reXMRig.exec(agent)) {
            const majorv = parseInt(m[1]) * 10000;
            const minorv = parseInt(m[2]) * 100;
            if (majorv + minorv < 60300) {
                return true;
            }
        }
        return false;
    };

    this.get_miner_agent_not_supported_algo = function(agent) {
        let m;
        if (m = reXMRSTAKRX.exec(agent)) {
            return "rx/0";
        } else if (m = reXMRSTAK.exec(agent)) {
            return "cn/r";
        }
        return false;
    };
};

module.exports = Coin;
