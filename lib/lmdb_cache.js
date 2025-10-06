"use strict";
let range = require('range');
let async = require('async');
let cleanShareInProgress = false;
let cleanShareStuckCount = 0;

function Cache(){
    this.lmdb = require('node-lmdb');
    this.env = null;
    this.cacheDB = null;

    this.initEnv = function(){
        global.cache.env = new this.lmdb.Env();
        global.cache.env.open({
            path: global.config.db_storage_path,
            maxDbs: 10,
            mapSize: global.config.general.dbSizeGB * 1024 * 1024 * 1024,
            useWritemap: true,
            maxReaders: 512
        });
        global.cache.cacheDB = this.env.openDbi({
            name: 'cache',
            create: true
        });
        //console.log("Database Worker: LMDB Env Initialized.");
    };

    this.incrementCacheData = function(key, data){
        let txn = this.env.beginTxn();
        let cached = txn.getString(this.cacheDB, key);
        if (cached !== null){
            cached = JSON.parse(cached);
            data.forEach(function(intDict){
                if (!cached.hasOwnProperty(intDict.location) || intDict.value === false){
                    cached[intDict.location] = 0;
                } else {
                    cached[intDict.location] += intDict.value;
                }
            });
            txn.putString(this.cacheDB, key, JSON.stringify(cached));
            txn.commit();
        } else {
            txn.abort();
        }
    };

    this.getCache = function(cacheKey){
        //console.log("Getting Key: "+cacheKey);
        try {
            let txn = this.env.beginTxn({readOnly: true});
            let cached = txn.getString(this.cacheDB, cacheKey);
            txn.abort();
            if (cached !== null){
                //console.log("Result for Key: " + cacheKey + " is: " + cached);
                return JSON.parse(cached);
            }
        } catch (e) {
            return false;
        }
        return false;
    };

    this.setCache = function(cacheKey, cacheData){
        //console.log("Setting Key: "+cacheKey+ " Data: " + JSON.stringify(cacheData));
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, cacheKey, JSON.stringify(cacheData));
        txn.commit();
    };

    this.bulkSetCache = function(cacheUpdates){
        let txn = this.env.beginTxn();
        txn.putString(this.cacheDB, 'cacheUpdate', 'cacheUpdate');
        txn.commit();
        //let size = 0;
        txn = this.env.beginTxn();
        for (const [key, value] of Object.entries(cacheUpdates)) {
          const value_str = JSON.stringify(value);
          txn.putString(this.cacheDB, key, value_str);
          //size += key.length + value_str.length;
        }
        txn.del(this.cacheDB, 'cacheUpdate');
        txn.commit();
    };
}

process.on('SIGINT', function() {
    //console.log("Closing DB");
    global.cache.env.close();
});


module.exports = Cache;
